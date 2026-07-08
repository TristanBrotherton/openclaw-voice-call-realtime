/**
 * Calendar availability for in-call scheduling.
 *
 * Reads the owner's calendar from a secret iCal (ICS) feed URL — supported by
 * Google Calendar, iCloud, Outlook, Fastmail, etc. — and computes free/busy
 * windows so the voice AI can answer "does Thursday at 3 work?" mid-call.
 *
 * Privacy: only busy intervals are computed and exposed. Event titles,
 * locations, attendees, and descriptions never reach the model.
 */

import { execFile } from "node:child_process";
import ical from "node-ical";

export type BusyInterval = { start: Date; end: Date };

export type CalendarAvailabilityConfig = {
  icsUrl: string;
  /** Day considered available between these local hours (0-23). */
  dayStartHour: number;
  dayEndHour: number;
  /** Cache TTL for the fetched feed. */
  cacheTtlMs: number;
};

type IcsCache = { fetchedAt: number; events: ical.CalendarResponse };

const caches = new Map<string, IcsCache>();

async function fetchCalendar(config: CalendarAvailabilityConfig): Promise<ical.CalendarResponse> {
  const cached = caches.get(config.icsUrl);
  if (cached && Date.now() - cached.fetchedAt < config.cacheTtlMs) {
    return cached.events;
  }
  const events = await ical.async.fromURL(config.icsUrl);
  caches.set(config.icsUrl, { fetchedAt: Date.now(), events });
  return events;
}

/** Exposed for tests. */
export function clearCalendarCache(): void {
  caches.clear();
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/**
 * Collect busy intervals from parsed ICS data within [from, to],
 * expanding recurring events.
 */
export function collectBusyIntervals(
  data: ical.CalendarResponse,
  from: Date,
  to: Date,
): BusyInterval[] {
  const busy: BusyInterval[] = [];

  for (const item of Object.values(data)) {
    if (!item || (item as { type?: string }).type !== "VEVENT") {
      continue;
    }
    const event = item as ical.VEvent;
    if (event.transparency === "TRANSPARENT") {
      continue; // marked "free" on the calendar
    }
    const durationMs =
      event.end && event.start ? event.end.getTime() - event.start.getTime() : 0;

    if (event.rrule) {
      // Expand recurrences; rrule works in UTC-naive dates, so pad the window
      // by a day on each side and filter precisely afterwards.
      const padded = event.rrule.between(
        new Date(from.getTime() - 86_400_000),
        new Date(to.getTime() + 86_400_000),
        true,
      );
      const exdates = new Set(
        Object.values(event.exdate ?? {}).map((d) => (d as Date).toDateString?.() ?? String(d)),
      );
      for (const occurrence of padded) {
        if (exdates.has(occurrence.toDateString())) {
          continue;
        }
        const start = occurrence;
        const end = new Date(start.getTime() + durationMs);
        if (overlaps(start, end, from, to)) {
          busy.push({ start, end });
        }
      }
      continue;
    }

    if (event.start && event.end && overlaps(event.start, event.end, from, to)) {
      busy.push({ start: event.start, end: event.end });
    }
  }

  return mergeIntervals(busy);
}

export function mergeIntervals(intervals: BusyInterval[]): BusyInterval[] {
  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: BusyInterval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      if (interval.end > last.end) {
        last.end = interval.end;
      }
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatDay(d: Date): string {
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * Build a per-day availability description for [from, to] (local time),
 * e.g. "Tue, Jul 14: busy 9:00 AM-10:30 AM; otherwise free 8 AM-9 PM".
 */
export function describeAvailability(
  busy: BusyInterval[],
  from: Date,
  to: Date,
  dayStartHour: number,
  dayEndHour: number,
): string {
  const lines: string[] = [];
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);

  while (cursor <= to) {
    const dayStart = new Date(cursor);
    dayStart.setHours(dayStartHour, 0, 0, 0);
    const dayEnd = new Date(cursor);
    dayEnd.setHours(dayEndHour, 0, 0, 0);

    const dayBusy = busy
      .filter((b) => overlaps(b.start, b.end, dayStart, dayEnd))
      .map((b) => ({
        start: b.start > dayStart ? b.start : dayStart,
        end: b.end < dayEnd ? b.end : dayEnd,
      }));

    if (dayBusy.length === 0) {
      lines.push(`${formatDay(cursor)}: free all day (${dayStartHour}:00-${dayEndHour}:00)`);
    } else {
      const busyText = dayBusy
        .map((b) => `${formatTime(b.start)}-${formatTime(b.end)}`)
        .join(", ");
      lines.push(`${formatDay(cursor)}: busy ${busyText}; otherwise free`);
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  return lines.join("\n");
}

/**
 * Fetch the calendar and describe free/busy for a local date range.
 * Dates are YYYY-MM-DD (inclusive).
 */
export async function getAvailability(
  config: CalendarAvailabilityConfig,
  startDate: string,
  endDate: string,
): Promise<string> {
  const from = new Date(`${startDate}T00:00:00`);
  const to = new Date(`${endDate}T23:59:59`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error("Dates must be YYYY-MM-DD");
  }
  if (to.getTime() - from.getTime() > 62 * 86_400_000) {
    throw new Error("Date range too large (max ~2 months)");
  }

  const data = await fetchCalendar(config);
  const busy = collectBusyIntervals(data, from, to);
  return describeAvailability(busy, from, to, config.dayStartHour, config.dayEndHour);
}

/**
 * Run a user-configured local command for calendar data. {start} and {end}
 * are replaced with YYYY-MM-DD dates. The command comes from the owner's own
 * config (same trust level as the credentials stored there); output is
 * passed to the voice model, so it may include event titles — unlike the ICS
 * backend, which is strictly free/busy.
 */
export function runCalendarCommand(
  command: string,
  startDate: string,
  endDate: string,
  timeoutMs = 15000,
): Promise<string> {
  const cmd = command.replaceAll("{start}", startDate).replaceAll("{end}", endDate);
  return new Promise((resolve, reject) => {
    execFile("/bin/sh", ["-c", cmd], { timeout: timeoutMs, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`calendar command failed: ${(stderr || err.message).slice(0, 200)}`));
        return;
      }
      const out = stdout.trim();
      if (!out) {
        resolve("No events found in this range.");
        return;
      }
      resolve(out.length > 4000 ? `${out.slice(0, 4000)}…` : out);
    });
  });
}

export type CalendarBackendConfig = {
  enabled: boolean;
  command?: string;
  icsUrl?: string;
  dayStartHour: number;
  dayEndHour: number;
  cacheTtlMs: number;
};

/** Resolve availability via the configured backend (command wins over ICS). */
export async function resolveAvailability(
  config: CalendarBackendConfig,
  startDate: string,
  endDate: string,
): Promise<string> {
  if (!config.enabled) {
    throw new Error("calendar is not enabled");
  }
  if (config.command) {
    return runCalendarCommand(config.command, startDate, endDate);
  }
  if (config.icsUrl) {
    return getAvailability(
      {
        icsUrl: config.icsUrl,
        dayStartHour: config.dayStartHour,
        dayEndHour: config.dayEndHour,
        cacheTtlMs: config.cacheTtlMs,
      },
      startDate,
      endDate,
    );
  }
  throw new Error("calendar has no backend configured (set command or icsUrl)");
}

/**
 * Pick the calendar command for a call party: third-party/unverified calls
 * use the privacy-reduced variant when configured.
 */
export function pickCalendarCommand(
  config: { command?: string; commandThirdParty?: string },
  party: string,
): string | undefined {
  const restricted = party === "third-party" || party === "unverified";
  if (restricted && config.commandThirdParty) {
    return config.commandThirdParty;
  }
  return config.command;
}
