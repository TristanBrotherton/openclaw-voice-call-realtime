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
