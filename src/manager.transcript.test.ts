import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { createManagerHarness, markCallAnswered } from "./manager.test-harness.js";

const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe("call transcript finalization", () => {
  it("records bot speech from call.speaking events", async () => {
    const { manager } = await createManagerHarness();
    const { callId } = await manager.initiateCall("+15550000001");
    markCallAnswered(manager, callId, "evt-answered");

    manager.processEvent({
      id: "evt-speaking",
      type: "call.speaking",
      callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      text: "Hello, this is the assistant.",
    });
    manager.processEvent({
      id: "evt-speech",
      type: "call.speech",
      callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: "Hi assistant, this is the caller.",
      isFinal: true,
    });

    const call = manager.getCall(callId);
    expect(call?.transcript.map((t) => [t.speaker, t.text])).toEqual([
      ["bot", "Hello, this is the assistant."],
      ["user", "Hi assistant, this is the caller."],
    ]);
  });

  it("writes a transcript file and keeps transcript retrievable after call end", async () => {
    const { manager } = await createManagerHarness();
    const { callId } = await manager.initiateCall("+15550000002");
    markCallAnswered(manager, callId, "evt-answered-2");

    manager.processEvent({
      id: "evt-speaking-2",
      type: "call.speaking",
      callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      text: "Reminder: your appointment is at 3pm.",
    });
    manager.processEvent({
      id: "evt-ended-2",
      type: "call.ended",
      callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      reason: "completed",
    });

    // Call is gone from active state...
    expect(manager.getCall(callId)).toBeUndefined();

    // ...but transcript stays retrievable (store fallback) and file is written.
    const result = await manager.getTranscript(callId);
    expect(result).toBeDefined();
    expect(result?.transcript.some((t) => t.text.includes("appointment"))).toBe(true);
    expect(result?.transcriptPath).toContain(callId);

    await waitFor(() => fs.existsSync(result!.transcriptPath!));
    const content = fs.readFileSync(result!.transcriptPath!, "utf-8");
    expect(content).toContain("Reminder: your appointment is at 3pm.");
    expect(content).toContain("## Transcript");
  });

  it("finalizes via endCall (bot hangup) exactly once", async () => {
    const { manager, provider } = await createManagerHarness();
    const { callId } = await manager.initiateCall("+15550000003");
    markCallAnswered(manager, callId, "evt-answered-3");

    const result = await manager.endCall(callId);
    expect(result.success).toBe(true);
    expect(provider.hangupCalls.length).toBe(1);

    // persistCallRecord is a fire-and-forget append; poll until the terminal
    // record lands in the store.
    let transcript: Awaited<ReturnType<typeof manager.getTranscript>>;
    for (let i = 0; i < 50; i++) {
      transcript = await manager.getTranscript(callId);
      if (transcript?.state === "hangup-bot") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(transcript).toBeDefined();
    expect(transcript?.state).toBe("hangup-bot");
  });
});
