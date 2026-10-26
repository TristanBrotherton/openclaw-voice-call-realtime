import ical from "node-ical";
import { describe, expect, it } from "vitest";
import { collectBusyIntervals, localDateLabel } from "./calendar.js";

const from = new Date("2026-07-13T00:00:00Z");
const to = new Date("2026-07-20T00:00:00Z");

function parse(...events: string[][]): ical.CalendarResponse {
  return ical.sync.parseICS(
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Voice Call Tests//EN",
      ...events.flatMap((lines) => ["BEGIN:VEVENT", "DTSTAMP:20260701T000000Z", ...lines, "END:VEVENT"]),
      "END:VCALENDAR",
    ].join("\r\n"),
  );
}

const busyStarts = (data: ical.CalendarResponse) =>
  collectBusyIntervals(data, from, to).map((b) => b.start.toISOString());

const single = (...extra: string[]) => [
  "UID:single",
  "DTSTART:20260715T090000Z",
  "DTEND:20260715T100000Z",
  ...extra,
];

const daily = (...extra: string[]) => [
  "UID:series",
  "DTSTART:20260713T090000Z",
  "DTEND:20260713T100000Z",
  "RRULE:FREQ=DAILY;COUNT=5",
  ...extra,
];

const override = (start: string, ...extra: string[]) => [
  "UID:series",
  "RECURRENCE-ID:20260715T090000Z",
  `DTSTART:${start}`,
  `DTEND:${start.replace(/T(\d\d)/, (_m, h) => `T${String(Number(h) + 1).padStart(2, "0")}`)}`,
  ...extra,
];

describe("calendar event status", () => {
  it.each([
    ["confirmed", ["STATUS:CONFIRMED"]],
    ["tentative", ["STATUS:TENTATIVE"]],
    ["unspecified", []],
  ])("keeps %s events busy", (_name, status) => {
    expect(busyStarts(parse(single(...status)))).toEqual(["2026-07-15T09:00:00.000Z"]);
  });

  it("does not reserve time for a cancelled event, in any letter case", () => {
    expect(busyStarts(parse(single("STATUS:CANCELLED")))).toEqual([]);
    expect(busyStarts(parse(single("STATUS:Cancelled")))).toEqual([]);
  });

  it("does not reserve time for a cancelled series", () => {
    expect(busyStarts(parse(daily("STATUS:CANCELLED")))).toEqual([]);
  });

  it("frees one cancelled occurrence and keeps the rest of the series", () => {
    const data = parse(daily("STATUS:CONFIRMED"), override("20260715T090000Z", "STATUS:CANCELLED"));
    expect(busyStarts(data)).toEqual([
      "2026-07-13T09:00:00.000Z",
      "2026-07-14T09:00:00.000Z",
      "2026-07-16T09:00:00.000Z",
      "2026-07-17T09:00:00.000Z",
    ]);
  });

  it("keeps the series busy when a cancelled occurrence comes before a master without STATUS", () => {
    // node-ical copies the override's STATUS onto the master in this order.
    const data = parse(override("20260715T090000Z", "STATUS:CANCELLED"), daily());
    expect(busyStarts(data)).toEqual([
      "2026-07-13T09:00:00.000Z",
      "2026-07-14T09:00:00.000Z",
      "2026-07-16T09:00:00.000Z",
      "2026-07-17T09:00:00.000Z",
    ]);
  });

  it("places a moved occurrence at its new time", () => {
    const busy = busyStarts(parse(daily(), override("20260715T140000Z")));
    expect(busy).toContain("2026-07-15T14:00:00.000Z");
    expect(busy).not.toContain("2026-07-15T09:00:00.000Z");
  });

  it("keeps a reinstated occurrence of a cancelled series busy", () => {
    const data = parse(daily("STATUS:CANCELLED"), override("20260715T090000Z", "STATUS:CONFIRMED"));
    expect(busyStarts(data)).toEqual(["2026-07-15T09:00:00.000Z"]);
  });

  it("counts a multi-day occurrence that started before the window", () => {
    const data = parse([
      "UID:oncall",
      "DTSTART:20260706T000000Z",
      "DTEND:20260709T000000Z",
      "RRULE:FREQ=WEEKLY",
    ]);
    const busy = collectBusyIntervals(data, new Date("2026-07-15T00:00:00Z"), new Date("2026-07-16T00:00:00Z"));
    expect(busy.map((b) => b.start.toISOString())).toEqual(["2026-07-13T00:00:00.000Z"]);
  });

  it("skips a rule that can't be expanded without breaking other events", () => {
    const data = parse(
      ["UID:never", "DTSTART:20260101T090000Z", "DTEND:20260101T100000Z", "RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30"],
      single(),
    );
    expect(busyStarts(data)).toEqual(["2026-07-15T09:00:00.000Z"]);
  });
});

describe("localDateLabel", () => {
  it("uses the local calendar day, not the UTC one", () => {
    const lateEvening = new Date(2026, 9, 26, 23, 30); // local time
    expect(localDateLabel(lateEvening)).toBe("Monday, 2026-10-26");
  });
});
