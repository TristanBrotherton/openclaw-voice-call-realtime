import { describe, expect, it } from "vitest";
import { generateDtmfMulaw, isValidDtmfSequence } from "./dtmf.js";
import { buildTranscriptMarkdown } from "./transcript.js";
import { createManagerHarness, markCallAnswered } from "./manager.test-harness.js";

describe("DTMF generation", () => {
  it("validates key sequences", () => {
    expect(isValidDtmfSequence("123")).toBe(true);
    expect(isValidDtmfSequence("1,2*#0")).toBe(true);
    expect(isValidDtmfSequence("")).toBe(false);
    expect(isValidDtmfSequence("1a2")).toBe(true); // A-D are valid DTMF
    expect(isValidDtmfSequence("1x2")).toBe(false);
  });

  it("generates 8kHz mu-law audio of the expected duration", () => {
    // one key: 120ms tone + 80ms gap = 200ms = 1600 samples at 8kHz (1 byte each)
    const one = generateDtmfMulaw("5");
    expect(one.length).toBe(1600);

    // pause adds 500ms = 4000 samples
    const withPause = generateDtmfMulaw("5,5");
    expect(withPause.length).toBe(1600 + 4000 + 1600);
  });

  it("rejects invalid keys", () => {
    expect(() => generateDtmfMulaw("1z")).toThrow(/Invalid DTMF key/);
  });

  it("produces non-silent audio for tones", () => {
    const tone = generateDtmfMulaw("1");
    // mu-law silence is 0xFF/0x7F; a real tone must contain other values
    const distinct = new Set(tone.subarray(0, 800));
    expect(distinct.size).toBeGreaterThan(10);
  });
});

describe("call outcome recording", () => {
  it("stores outcome on the call and includes it in the transcript markdown", async () => {
    const { manager } = await createManagerHarness();
    const { callId } = await manager.initiateCall("+15550000009");
    markCallAnswered(manager, callId, "evt-outcome-1");

    const ok = manager.recordCallOutcome("request-uuid", {
      status: "success",
      details: "Table for 2 booked Friday 7pm under Tristan. Confirmation #4821.",
    });
    expect(ok).toBe(true);

    const call = manager.getCall(callId)!;
    expect((call.metadata?.outcome as { status: string }).status).toBe("success");

    const md = buildTranscriptMarkdown(call);
    expect(md).toContain("## Reported Outcome");
    expect(md).toContain("Confirmation #4821");
  });

  it("returns false for unknown calls", async () => {
    const { manager } = await createManagerHarness();
    expect(manager.recordCallOutcome("nope", { status: "success", details: "x" })).toBe(false);
  });

  it("keeps the outcome retrievable after the call ends", async () => {
    const { manager } = await createManagerHarness();
    const { callId } = await manager.initiateCall("+15550000010");
    markCallAnswered(manager, callId, "evt-outcome-2");
    manager.recordCallOutcome(callId, { status: "partial", details: "Open 9-5 weekdays" });

    await manager.endCall(callId);
    // persistCallRecord is a fire-and-forget append; poll until it lands.
    let transcript: Awaited<ReturnType<typeof manager.getTranscript>>;
    for (let i = 0; i < 50; i++) {
      transcript = await manager.getTranscript(callId);
      if (transcript?.outcome) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(transcript?.outcome?.details).toContain("9-5");
  });
});

describe("ending mode barge-in suppression", () => {
  it("ignores speech_started while ending so the goodbye is not flushed", async () => {
    const { OpenAIRealtimeConversationProvider } = await import(
      "./providers/openai-realtime-conversation.js"
    );
    const provider = new OpenAIRealtimeConversationProvider({ apiKey: "test-key" });
    const session = provider.createSession();

    let bargeIns = 0;
    session.onSpeechStart(() => bargeIns++);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = session as any;
    raw.handleEvent({ type: "input_audio_buffer.speech_started" });
    expect(bargeIns).toBe(1);

    session.setEndingMode(true);
    raw.handleEvent({ type: "input_audio_buffer.speech_started" });
    expect(bargeIns).toBe(1); // suppressed

    session.setEndingMode(false);
    raw.handleEvent({ type: "input_audio_buffer.speech_started" });
    expect(bargeIns).toBe(2);
  });
});
