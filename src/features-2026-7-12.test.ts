import { describe, expect, it } from "vitest";
import {
  buildCallReportMessage,
  createPostCallReporter,
  type SubagentRuntime,
} from "./assistant-bridge.js";
import { VoiceCallConfigSchema } from "./config.js";
import { createManagerHarness, markCallAnswered } from "./manager.test-harness.js";

describe("post-call report", () => {
  it("builds a complete report message", () => {
    const msg = buildCallReportMessage({
      callId: "c-1",
      direction: "outbound",
      counterparty: "+15550005555",
      durationSec: 95,
      endReason: "hangup-bot",
      answeredBy: "human",
      outcome: { status: "success", details: "Booked for 2, Friday 7pm" },
      summary: "Reservation confirmed.",
      transcriptPath: "/tmp/x.md",
    });
    expect(msg).toContain("outbound with +15550005555");
    expect(msg).toContain("[success] Booked for 2, Friday 7pm");
    expect(msg).toContain("Talk time: 95s");
    expect(msg).toContain("do it and mention that you did");
  });

  it("runs a subagent turn and cleans up the session", async () => {
    const calls: string[] = [];
    const subagent: SubagentRuntime = {
      run: async (p) => {
        calls.push("run:" + (p.extraSystemPrompt?.includes("post-call report") ? "scoped" : "unscoped"));
        return { runId: "r1" };
      },
      waitForRun: async () => ({ status: "ok" }),
      getSessionMessages: async () => ({ messages: [] }),
      deleteSession: async () => {
        calls.push("deleted");
      },
    };
    const reporter = createPostCallReporter({ subagent });
    await reporter({ callId: "c", direction: "outbound", counterparty: "+15550001111" });
    expect(calls).toEqual(["run:scoped", "deleted"]);
  });

  it("fires from finalizeCall for answered calls", async () => {
    const { manager } = await createManagerHarness();
    const reports: string[] = [];
    manager.setPostCallReporter(async (r) => {
      reports.push(r.callId);
    });
    const { callId } = await manager.initiateCall("+15550000030");
    markCallAnswered(manager, callId, "evt-report-1");
    await manager.endCall(callId);
    // finalize + report are async fire-and-forget
    for (let i = 0; i < 100 && reports.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(reports).toEqual([callId]);
  });
});

describe("AMD config and events", () => {
  it("parses the amd config block", () => {
    const cfg = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "mock",
      amd: { enabled: true, onMachine: "hangup" },
    });
    expect(cfg.amd.onMachine).toBe("hangup");
    // defaults
    const cfg2 = VoiceCallConfigSchema.parse({ enabled: true, provider: "mock" });
    expect(cfg2.amd.enabled).toBe(false);
    expect(cfg2.amd.onMachine).toBe("leave-message");
  });

  it("records answeredBy in call metadata from a call.amd event", async () => {
    const { manager } = await createManagerHarness();
    const { callId } = await manager.initiateCall("+15550000031");
    markCallAnswered(manager, callId, "evt-amd-1");
    manager.processEvent({
      id: "evt-amd-2",
      type: "call.amd",
      callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      answeredBy: "machine_end_beep",
    });
    expect(manager.getCall(callId)?.metadata?.answeredBy).toBe("machine_end_beep");
  });
});

describe("transfer + vad config", () => {
  it("parses transfer and turn detection config", () => {
    const cfg = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "mock",
      transfer: { enabled: true, number: "+15550009999" },
      streaming: { enabled: true, turnDetection: "semantic_vad", vadEagerness: "high" },
    });
    expect(cfg.transfer.number).toBe("+15550009999");
    expect(cfg.transfer.timeoutSec).toBe(25);
    expect(cfg.streaming.turnDetection).toBe("semantic_vad");
    expect(cfg.streaming.vadEagerness).toBe("high");
  });
});
