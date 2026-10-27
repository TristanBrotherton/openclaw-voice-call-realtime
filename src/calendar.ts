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
import ical, { type CalendarResponse, type EventInstance, type VEvent } from "node-ical";

export type BusyInterval = { start: Date; end: Date };

export type CalendarAvailabilityConfig = {
  icsUrl: string;
  /** Day considered available between these local hours (0-23). */
  dayStartHour: number;
  dayEndHour: number;
  /** Cache TTL for the fetched feed. */
  cacheTtlMs: number;
};

type IcsCache = { fetchedAt: number; events: CalendarResponse };

const caches = new Map<string, IcsCache>();
const FETCH_TIMEOUT_MS = 15_000;

async function fetchCalendar(config: CalendarAvailabilityConfig): Promise<CalendarResponse> {
  const cached = caches.get(config.icsUrl);
  if (cached && Date.now() - cached.fetchedAt < config.cacheTtlMs) {
    return cached.events;
  }
  // iCloud shares calendars as webcal:// links, which are plain HTTPS.
  const url = config.icsUrl.replace(/^webcals?:\/\//i, "https://");
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`calendar feed HTTP ${res.status}`);
  }
  const events = await ical.async.parseICS(await res.text());
  caches.set(config.icsUrl, { fetchedAt: Date.now(), events });
  return events;
}

/**
 * Today's date in the gateway's local time zone, the one availability is
 * computed in (a UTC date is tomorrow's in the US evening).
 */
export function localDateLabel(d: Date = new Date()): string {
  const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${weekday}, ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Exposed for tests. */
export function clearCalendarCache(): void {
  caches.clear();
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/** ICS enumerated values are case-insensitive and may carry parameters. */
function icsValue(value: unknown): string {
  const raw = (value as { val?: unknown } | undefined)?.val ?? value;
  return typeof raw === "string" ? raw.trim().toUpperCase() : "";
}

function isFree(event: VEvent): boolean {
  return icsValue(event.status) === "CANCELLED" || icsValue(event.transparency) === "TRANSPARENT";
}

const DAY_MS = 86_400_000;

/**
 * Collect busy intervals from parsed ICS data within [from, to],
 * expanding recurring events. Cancelled and transparent ("free") events
 * don't count; for a recurring event this is decided per occurrence, so a
 * cancelled or moved single occurrence is honoured.
 */
export function collectBusyIntervals(
  data: CalendarResponse,
  from: Date,
  to: Date,
): BusyInterval[] {
  const busy: BusyInterval[] = [];
  const add = (start: Date | undefined, end: Date | undefined) => {
    if (start && end && overlaps(start, end, from, to)) {
      busy.push({ start, end });
    }
  };

  for (const item of Object.values(data)) {
    if (!item || (item as { type?: string }).type !== "VEVENT") {
      continue;
    }
    const event = item as VEvent;
    const overrides = Object.values(event.recurrences ?? {}) as VEvent[];

    if (!event.rrule) {
      // A single event, or occurrences of a series whose master isn't in the
      // feed (node-ical keeps the first at the top and the rest in recurrences).
      for (const one of [event, ...overrides]) {
        if (!isFree(one)) {
          add(one.start, one.end);
        }
      }
      continue;
    }

    // node-ical can copy STATUS/TRANSP from a single-occurrence override onto
    // a master that doesn't set them, so a master-level "free" is only trusted
    // when no override says the same; otherwise the series stays busy.
    const masterFree =
      isFree(event) &&
      !overrides.some(
        (o) =>
          icsValue(o.status) === icsValue(event.status) &&
          icsValue(o.transparency) === icsValue(event.transparency),
      );

    let instances: EventInstance[];
    try {
      // Pad the window so overrides moved in from just outside it are seen.
      instances = ical.expandRecurringEvent(event, {
        from: new Date(from.getTime() - DAY_MS),
        to: new Date(to.getTime() + DAY_MS),
        expandOngoing: true,
      });
    } catch {
      continue; // a malformed rule must not break the whole calendar
    }
    for (const instance of instances) {
      const free = instance.isOverride ? isFree(instance.event) : masterFree;
      if (!free) {
        add(instance.start, instance.end);
      }
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
