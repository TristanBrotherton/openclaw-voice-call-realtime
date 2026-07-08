import { describe, expect, it } from "vitest";
import {
  createAssistantBridge,
  extractAssistantText,
  type SubagentRuntime,
} from "./assistant-bridge.js";
import { collectBusyIntervals, describeAvailability, mergeIntervals } from "./calendar.js";

describe("extractAssistantText", () => {
  it("reads plain string content", () => {
    expect(
      extractAssistantText([
        { role: "user", content: "q" },
        { role: "assistant", content: "Wednesday 2pm is free." },
      ]),
    ).toBe("Wednesday 2pm is free.");
  });

  it("reads array content parts and takes the LAST assistant message", () => {
    expect(
      extractAssistantText([
        { role: "assistant", content: "old answer" },
        { role: "user", content: "q2" },
        { role: "assistant", content: [{ type: "text", text: "new answer" }] },
      ]),
    ).toBe("new answer");
  });

  it("returns undefined when there is no assistant text", () => {
    expect(extractAssistantText([{ role: "user", content: "q" }])).toBeUndefined();
  });
});

describe("createAssistantBridge", () => {
  const makeSubagent = (overrides: Partial<SubagentRuntime> = {}): {
    subagent: SubagentRuntime;
    calls: Record<string, unknown[]>;
  } => {
    const calls: Record<string, unknown[]> = { run: [], wait: [], get: [], del: [] };
    const subagent: SubagentRuntime = {
      run: async (p) => {
        calls.run.push(p);
        return { runId: "run-1" };
      },
      waitForRun: async (p) => {
        calls.wait.push(p);
        return { status: "ok" };
      },
      getSessionMessages: async (p) => {
        calls.get.push(p);
        return { messages: [{ role: "assistant", content: "Yes, 2pm works." }] };
      },
      deleteSession: async (p) => {
        calls.del.push(p);
      },
      ...overrides,
    };
    return { subagent, calls };
  };

  it("runs a scoped subagent turn and returns the answer", async () => {
    const { subagent, calls } = makeSubagent();
    const bridge = createAssistantBridge({ subagent });
    const answer = await bridge("Is Wednesday 2pm free?", "outbound call to +15550001111");
    expect(answer).toBe("Yes, 2pm works.");

    const run = calls.run[0] as { message: string; extraSystemPrompt: string };
    expect(run.message).toBe("Is Wednesday 2pm free?");
    expect(run.extraSystemPrompt).toContain("LIVE phone call");
    expect(run.extraSystemPrompt).toContain("outbound call to +15550001111");
    expect(calls.del.length).toBe(1); // session cleaned up
  });

  it("throws a useful error on timeout", async () => {
    const { subagent } = makeSubagent({
      waitForRun: async () => ({ status: "timeout" }),
    });
    const bridge = createAssistantBridge({ subagent, timeoutMs: 5000 });
    await expect(bridge("q", "ctx")).rejects.toThrow(/did not answer within 5s/);
  });

  it("truncates very long answers", async () => {
    const { subagent } = makeSubagent({
      getSessionMessages: async () => ({
        messages: [{ role: "assistant", content: "x".repeat(3000) }],
      }),
    });
    const bridge = createAssistantBridge({ subagent });
    const answer = await bridge("q", "ctx");
    expect(answer.length).toBeLessThanOrEqual(1501);
  });
});

describe("bridge action policy", () => {
  it("forbids actions on third-party calls", async () => {
    const { buildBridgeSystemPrompt } = await import("./assistant-bridge.js");
    const prompt = buildBridgeSystemPrompt("outbound call to +15550001111, party: third-party");
    expect(prompt).toContain("do NOT perform any state-changing action");
  });

  it("allows owner-requested actions on first-party calls", async () => {
    const { buildBridgeSystemPrompt } = await import("./assistant-bridge.js");
    const prompt = buildBridgeSystemPrompt("outbound call to +15550001111, party: first-party");
    expect(prompt).toContain("call is with the owner");
    expect(prompt).not.toContain("do NOT perform any state-changing action");
  });

  it("treats unknown parties as third-party", async () => {
    const { buildBridgeSystemPrompt } = await import("./assistant-bridge.js");
    const prompt = buildBridgeSystemPrompt("inbound call from +15550002222");
    expect(prompt).toContain("unverified");
    expect(prompt).toContain("do not perform state-changing actions");
  });
});

describe("resolveCallParty / trusted numbers", () => {
  it("marks allowlisted counterparties as trusted (outbound uses `to`)", async () => {
    const { resolveCallParty } = await import("./assistant-bridge.js");
    expect(
      resolveCallParty({
        direction: "outbound",
        to: "+15550003333",
        callParty: "third-party",
        trustedNumbers: ["+15550003333"],
      }),
    ).toBe("trusted-contact");
  });

  it("inbound caller ID grants trust only with STIR attestation A (or explicit opt-out)", async () => {
    const { resolveCallParty } = await import("./assistant-bridge.js");
    const base = { direction: "inbound", from: "+15550003333", trustedNumbers: ["+15550003333"] };
    // spoofable: no attestation -> unverified
    expect(resolveCallParty(base)).toBe("unverified");
    // attested caller ID -> trusted
    expect(resolveCallParty({ ...base, stirVerstat: "TN-Validation-Passed-A" })).toBe("trusted-contact");
    // failed/partial attestation -> unverified
    expect(resolveCallParty({ ...base, stirVerstat: "TN-Validation-Passed-B" })).toBe("unverified");
    // deployment opted out of the requirement
    expect(resolveCallParty({ ...base, trustStirA: false })).toBe("trusted-contact");
    // unknown number stays unverified regardless
    expect(
      resolveCallParty({ ...base, from: "+15550004444", stirVerstat: "TN-Validation-Passed-A" }),
    ).toBe("unverified");
  });

  it("owner numbers get first-party on attested inbound; passphrase outranks all", async () => {
    const { resolveCallParty } = await import("./assistant-bridge.js");
    expect(
      resolveCallParty({
        direction: "inbound",
        from: "+15550009999",
        trustedNumbers: [],
        ownerNumbers: ["+15550009999"],
        stirVerstat: "TN-Validation-Passed-A",
      }),
    ).toBe("first-party");
    // same call without attestation -> unverified
    expect(
      resolveCallParty({
        direction: "inbound",
        from: "+15550009999",
        trustedNumbers: [],
        ownerNumbers: ["+15550009999"],
      }),
    ).toBe("unverified");
    // verified passphrase -> first-party even from an unknown number
    expect(
      resolveCallParty({
        direction: "inbound",
        from: "+15550000000",
        trustedNumbers: [],
        verifiedOwner: true,
      }),
    ).toBe("first-party");
  });

  it("trusted tier permits actions with attribution", async () => {
    const { buildBridgeSystemPrompt } = await import("./assistant-bridge.js");
    const prompt = buildBridgeSystemPrompt("inbound call from +15550003333, party: trusted-contact");
    expect(prompt).toContain("trusted list");
    expect(prompt).toContain("requested by this");
    expect(prompt).not.toContain("do NOT perform any state-changing action");
  });
});

describe("calendar free/busy", () => {
  it("merges overlapping busy intervals", () => {
    const merged = mergeIntervals([
      { start: new Date("2026-07-15T10:00:00"), end: new Date("2026-07-15T11:00:00") },
      { start: new Date("2026-07-15T10:30:00"), end: new Date("2026-07-15T12:00:00") },
      { start: new Date("2026-07-15T14:00:00"), end: new Date("2026-07-15T15:00:00") },
    ]);
    expect(merged.length).toBe(2);
    expect(merged[0].end.getHours()).toBe(12);
  });

  it("collects plain events overlapping the window and skips transparent ones", () => {
    const data = {
      a: {
        type: "VEVENT",
        start: new Date("2026-07-15T09:00:00"),
        end: new Date("2026-07-15T10:00:00"),
      },
      b: {
        type: "VEVENT",
        start: new Date("2026-07-20T09:00:00"),
        end: new Date("2026-07-20T10:00:00"),
      },
      c: {
        type: "VEVENT",
        transparency: "TRANSPARENT",
        start: new Date("2026-07-15T13:00:00"),
        end: new Date("2026-07-15T14:00:00"),
      },
    } as never;
    const busy = collectBusyIntervals(
      data,
      new Date("2026-07-15T00:00:00"),
      new Date("2026-07-16T00:00:00"),
    );
    expect(busy.length).toBe(1);
    expect(busy[0].start.getHours()).toBe(9);
  });

  it("describes availability per day without event details", () => {
    const text = describeAvailability(
      [{ start: new Date("2026-07-15T09:00:00"), end: new Date("2026-07-15T10:30:00") }],
      new Date("2026-07-15T00:00:00"),
      new Date("2026-07-16T23:59:59"),
      8,
      21,
    );
    expect(text).toContain("busy");
    expect(text).toContain("free all day");
    expect(text.split("\n").length).toBe(2);
  });
});

describe("calendar command backend", () => {
  it("substitutes dates and returns bounded output", async () => {
    const { runCalendarCommand } = await import("./calendar.js");
    const out = await runCalendarCommand("echo events {start}..{end}", "2026-07-08", "2026-07-15");
    expect(out).toBe("events 2026-07-08..2026-07-15");
  });

  it("reports empty output gracefully", async () => {
    const { runCalendarCommand } = await import("./calendar.js");
    const out = await runCalendarCommand("true", "2026-07-08", "2026-07-08");
    expect(out).toBe("No events found in this range.");
  });

  it("surfaces command failure", async () => {
    const { runCalendarCommand } = await import("./calendar.js");
    await expect(
      runCalendarCommand("echo boom >&2; exit 1", "2026-07-08", "2026-07-08"),
    ).rejects.toThrow(/calendar command failed: boom/);
  });

  it("prefers command over ics in resolveAvailability", async () => {
    const { resolveAvailability } = await import("./calendar.js");
    const out = await resolveAvailability(
      { enabled: true, command: "echo CMD", icsUrl: "https://example.com/x.ics", dayStartHour: 8, dayEndHour: 21, cacheTtlMs: 1000 },
      "2026-07-08", "2026-07-08",
    );
    expect(out).toBe("CMD");
  });
});

describe("pickCalendarCommand", () => {
  it("uses the restricted variant for third-party and unverified calls", async () => {
    const { pickCalendarCommand } = await import("./calendar.js");
    const cfg = { command: "full", commandThirdParty: "busy-only" };
    expect(pickCalendarCommand(cfg, "first-party")).toBe("full");
    expect(pickCalendarCommand(cfg, "trusted-contact")).toBe("full");
    expect(pickCalendarCommand(cfg, "third-party")).toBe("busy-only");
    expect(pickCalendarCommand(cfg, "unverified")).toBe("busy-only");
    expect(pickCalendarCommand({ command: "full" }, "third-party")).toBe("full");
  });
});
