import ical from "node-ical";
import { describe, expect, it } from "vitest";
import { collectBusyIntervals, describeAvailability } from "./calendar.js";

describe("calendar event status", () => {
  const from = new Date("2026-07-15T00:00:00Z");
  const to = new Date("2026-07-16T00:00:00Z");

  function calendar(properties: string[]): ical.CalendarResponse {
    return ical.sync.parseICS([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Voice Call Tests//EN",
      "BEGIN:VEVENT",
      "UID:availability-test",
      "DTSTAMP:20260701T000000Z",
      "DTSTART:20260715T090000Z",
      "DTEND:20260715T100000Z",
      ...properties,
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n"));
  }

  it.each([
    ["single event", []],
    ["recurring series", ["RRULE:FREQ=DAILY;COUNT=3"]],
  ])("does not reserve time for a cancelled %s", (_name, recurrence) => {
    const busy = collectBusyIntervals(calendar(["STATUS:CANCELLED", ...recurrence]), from, to);

    expect(busy).toEqual([]);
    expect(describeAvailability(busy, from, from, 8, 21)).toContain("free all day");
  });

  it.each([
    ["confirmed", ["STATUS:CONFIRMED"]],
    ["tentative", ["STATUS:TENTATIVE"]],
    ["unspecified", []],
  ])("keeps %s events busy", (_name, status) => {
    expect(collectBusyIntervals(calendar(status), from, to)).toEqual([
      { start: new Date("2026-07-15T09:00:00Z"), end: new Date("2026-07-15T10:00:00Z") },
    ]);
  });
});
