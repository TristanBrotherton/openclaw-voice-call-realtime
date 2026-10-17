import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCallReportMessage, type CallReport } from "./assistant-bridge.js";
import { VoiceCallConfigSchema } from "./config.js";
import { CallManager } from "./manager.js";
import {
  createManagerHarness,
  createTestStorePath,
  FakeProvider,
  makePersistedCall,
  markCallAnswered,
  writeCallsToStore,
} from "./manager.test-harness.js";
import {
  buildTranscriptMarkdown,
  buildTranscriptText,
  encodeMonoWav,
  mergeRecordingSegments,
  splitWavChannels,
  transcribeRecording,
  speechRegions,
  transcriptFilePath,
} from "./transcript.js";
import type { CallRecord } from "./types.js";
import { VoiceCallWebhookServer } from "./webhook.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const baseConfig = (overrides: Record<string, unknown> = {}) =>
  VoiceCallConfigSchema.parse({
    enabled: true,
    provider: "plivo",
    fromNumber: "+15550000000",
    ...overrides,
  });

function readStore(storePath: string): CallRecord[] {
  return fs
    .readFileSync(path.join(storePath, "calls.jsonl"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CallRecord);
}

function lastRecord(storePath: string, callId: string): CallRecord | undefined {
  return readStore(storePath)
    .filter((c) => c.callId === callId)
    .pop();
}

function stubOpenAiFetch(handler?: (url: string, init?: RequestInit) => Response | undefined) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const custom = handler?.(url, init);
    if (custom) return custom;
    return new Response(JSON.stringify({ choices: [{ message: { content: "A summary." } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function inboundCall(manager: CallManager, providerCallId = "CA-in-1") {
  manager.processEvent({
    id: `evt-in-${providerCallId}`,
    type: "call.initiated",
    callId: providerCallId,
    providerCallId,
    direction: "inbound",
    from: "+15550002222",
    to: "+15550000000",
    timestamp: Date.now(),
  });
  const call = manager.getCallByProviderCallId(providerCallId);
  if (!call) throw new Error("inbound call not created");
  return call;
}

// ---------------------------------------------------------------------------
// Fix 1: restart mid-call
// ---------------------------------------------------------------------------
describe("restore: calls that ended while the gateway was down", () => {
  it("finalizes calls the provider reports ended (transcript + terminal record), once", async () => {
    const storePath = createTestStorePath();
    const call = makePersistedCall({
      direction: "inbound",
      transcript: [{ timestamp: Date.now() - 20_000, speaker: "user", text: "Hello there", isFinal: true }],
    });
    writeCallsToStore(storePath, [call]);
    const provider = new FakeProvider();
    const endedAt = Date.now() - 10_000;
    provider.getCallStatusResult = { status: "completed", isTerminal: true, endedAt };
    const statusSpy = vi.spyOn(provider, "getCallStatus");

    const manager = new CallManager(baseConfig(), storePath);
    manager.setFinalizeTiming({ settleMs: 0 });
    await manager.initialize(provider, "https://example.com/voice/webhook");

    expect(manager.getActiveCalls()).toHaveLength(0);
    const md = transcriptFilePath(storePath, call.callId as string);
    await waitFor(() => fs.existsSync(md));
    expect(fs.readFileSync(md, "utf-8")).toContain("Hello there");
    await waitFor(() => lastRecord(storePath, call.callId as string)?.state === "hangup-user");
    const rec = lastRecord(storePath, call.callId as string)!;
    expect(rec.endReason).toBe("hangup-user");
    expect(rec.endedAt).toBe(endedAt);

    // A second start does not re-read (and re-verify) the stale record.
    statusSpy.mockClear();
    const again = new CallManager(baseConfig(), storePath);
    again.setFinalizeTiming({ settleMs: 0 });
    await again.initialize(provider, "https://example.com/voice/webhook");
    expect(statusSpy).not.toHaveBeenCalled();
  });

  it("ends calls older than maxDurationSeconds as timeout and writes their transcript", async () => {
    const storePath = createTestStorePath();
    const call = makePersistedCall({
      startedAt: Date.now() - 600_000,
      answeredAt: Date.now() - 590_000,
    });
    writeCallsToStore(storePath, [call]);
    const manager = new CallManager(baseConfig({ maxDurationSeconds: 300 }), storePath);
    manager.setFinalizeTiming({ settleMs: 0 });
    await manager.initialize(new FakeProvider(), "https://example.com/voice/webhook");

    await waitFor(() => fs.existsSync(transcriptFilePath(storePath, call.callId as string)));
    await waitFor(() => lastRecord(storePath, call.callId as string)?.endReason === "timeout");
  });

  it("startup sweep writes a missing transcript for an already-ended call", async () => {
    const storePath = createTestStorePath();
    const call = makePersistedCall({
      state: "completed",
      endReason: "completed",
      endedAt: Date.now() - 1000,
      transcript: [{ timestamp: Date.now() - 5000, speaker: "bot", text: "Swept line", isFinal: true }],
    });
    writeCallsToStore(storePath, [call]);
    const manager = new CallManager(baseConfig(), storePath);
    await manager.initialize(new FakeProvider(), "https://example.com/voice/webhook");
    const md = transcriptFilePath(storePath, call.callId as string);
    expect(fs.existsSync(md)).toBe(true);
    expect(fs.readFileSync(md, "utf-8")).toContain("Swept line");
  });
});

// ---------------------------------------------------------------------------
// Fix 2: inbound calls end from the stream stop
// ---------------------------------------------------------------------------
describe("inbound call end after the media stream stops", () => {
  it("sets answeredAt on stream start and ends with the provider's real reason/time", async () => {
    const provider = new FakeProvider("twilio");
    const { manager } = await createManagerHarness({ inboundPolicy: "open" }, provider);
    manager.setFinalizeTiming({ streamStopStatusDelaysMs: [0, 10] });
    const call = await inboundCall(manager);

    manager.onMediaStreamStarted("CA-in-1");
    expect(call.answeredAt).toBeTypeOf("number");

    const endedAt = Date.now() - 500;
    provider.getCallStatusResult = { status: "completed", isTerminal: true, endedAt };
    manager.onMediaStreamStopped("CA-in-1");
    await waitFor(() => manager.getActiveCalls().length === 0);
    expect(call.endReason).toBe("hangup-user");
    expect(call.endedAt).toBe(endedAt);
  });

  it("keeps the call while the provider says it is still live", async () => {
    const provider = new FakeProvider("twilio");
    const { manager } = await createManagerHarness({ inboundPolicy: "open" }, provider);
    manager.setFinalizeTiming({ streamStopStatusDelaysMs: [0] });
    await inboundCall(manager, "CA-in-2");
    manager.onMediaStreamStarted("CA-in-2");
    manager.onMediaStreamStopped("CA-in-2");
    await new Promise((r) => setTimeout(r, 30));
    expect(manager.getActiveCalls()).toHaveLength(1);
  });

  it("dates a grace-timer end at the stream stop, not at the hangup", async () => {
    const provider = new FakeProvider("twilio");
    const { manager } = await createManagerHarness({ inboundPolicy: "open" }, provider);
    manager.setFinalizeTiming({ streamStopStatusDelaysMs: [] });
    const call = await inboundCall(manager, "CA-in-3");
    manager.onMediaStreamStarted("CA-in-3");
    manager.onMediaStreamStopped("CA-in-3");
    const stoppedAt = call.metadata?.streamStoppedAt as number;
    await new Promise((r) => setTimeout(r, 30));
    await manager.endCall(call.callId);
    expect(call.endedAt).toBe(stoppedAt);
  });
});

// ---------------------------------------------------------------------------
// Fix 3: late transcript lines after the end
// ---------------------------------------------------------------------------
describe("late transcript lines", () => {
  it("appends lines that arrive during the settle window to the transcript file", async () => {
    const { manager } = await createManagerHarness();
    manager.setFinalizeTiming({ settleMs: 150 });
    const { callId } = await manager.initiateCall("+15550000101");
    markCallAnswered(manager, callId, "evt-late-ans");
    await manager.endCall(callId);

    expect(manager.getRecentCallByProviderCallId("request-uuid")?.callId).toBe(callId);
    manager.processEvent({
      id: "late-1",
      type: "call.speech",
      callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: "Wait, one more thing",
      isFinal: true,
    });

    const md = transcriptFilePath(manager.getStorePath(), callId);
    await waitFor(() => fs.existsSync(md));
    expect(fs.readFileSync(md, "utf-8")).toContain("Wait, one more thing");
  });

  it("rewrites the transcript file for a line that lands after finalize", async () => {
    const { manager } = await createManagerHarness();
    const { callId } = await manager.initiateCall("+15550000102");
    markCallAnswered(manager, callId, "evt-late-ans-2");
    await manager.endCall(callId);
    const md = transcriptFilePath(manager.getStorePath(), callId);
    await waitFor(
      () => !!manager.getRecentCallByProviderCallId("request-uuid")?.metadata?.transcriptPath,
    );

    manager.processEvent({
      id: "late-2",
      type: "call.speaking",
      callId: "request-uuid",
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      text: "Goodbye now",
    });
    await waitFor(() => fs.readFileSync(md, "utf-8").includes("Goodbye now"));
  });

  it("webhook routes late lines to the recently-ended call with unique ids and spoken-at times", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const { manager } = await createManagerHarness();
    manager.setFinalizeTiming({ settleMs: 300 });
    const { callId } = await manager.initiateCall("+15550000103");
    markCallAnswered(manager, callId, "evt-late-ans-3");
    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "mock",
      streaming: {
        enabled: true,
        sttProvider: "openai-realtime-conversation",
        openaiApiKey: "test-key",
      },
    });
    const server = new VoiceCallWebhookServer(config, manager, new FakeProvider());
    const cb = (
      server as unknown as {
        mediaStreamHandler: {
          config: {
            onTranscript: (id: string, text: string, spokenAt?: number) => void;
            onResponseTranscript: (id: string, text: string, spokenAt?: number) => void;
          };
        };
      }
    ).mediaStreamHandler.config;

    await manager.endCall(callId);
    const t0 = Date.now() - 5000;
    // Two lines in the same millisecond must both survive dedupe.
    cb.onResponseTranscript("request-uuid", "Second bot line", t0 + 2000);
    cb.onTranscript("request-uuid", "First caller line", t0 + 1000);
    cb.onTranscript("request-uuid", "Second caller line", t0 + 3000);

    const call = manager.getRecentCallByProviderCallId("request-uuid")!;
    expect(call.transcript.map((t) => t.text)).toEqual([
      "Second bot line",
      "First caller line",
      "Second caller line",
    ]);
    // Ordered by when spoken in the transcript text.
    expect(
      buildTranscriptText(call)
        .split("\n")
        .map((l) => l.replace(/^\[[^\]]+\] /, "")),
    ).toEqual(["Caller: First caller line", "Assistant: Second bot line", "Caller: Second caller line"]);
  });
});

// ---------------------------------------------------------------------------
// Fix 5: ordering
// ---------------------------------------------------------------------------
describe("transcript ordering", () => {
  it("uses the event timestamp as the spoken time and sorts by it", async () => {
    const { manager } = await createManagerHarness();
    const { callId } = await manager.initiateCall("+15550000104");
    markCallAnswered(manager, callId, "evt-ord-ans");
    const now = Date.now();
    manager.processEvent({
      id: "o-1",
      type: "call.speaking",
      callId,
      providerCallId: "request-uuid",
      timestamp: now + 500,
      text: "later",
    });
    manager.processEvent({
      id: "o-2",
      type: "call.speech",
      callId,
      providerCallId: "request-uuid",
      timestamp: now + 100,
      transcript: "earlier",
      isFinal: true,
    });
    const call = manager.getCall(callId)!;
    expect(call.transcript.map((t) => t.timestamp)).toEqual([now + 500, now + 100]);
    expect(buildTranscriptText(call).indexOf("earlier")).toBeLessThan(
      buildTranscriptText(call).indexOf("later"),
    );
  });
});

// ---------------------------------------------------------------------------
// Fix 6: notify message recorded
// ---------------------------------------------------------------------------
describe("notify mode", () => {
  it("records the TwiML <Say> message as a bot line in streaming conversation mode", async () => {
    const { manager, provider } = await createManagerHarness(
      { streaming: { enabled: true, sttProvider: "openai-realtime-conversation" } },
      new FakeProvider("twilio"),
    );
    const { callId } = await manager.initiateCall("+15550000105", undefined, {
      message: "Your package has arrived",
      mode: "notify",
    });
    markCallAnswered(manager, callId, "evt-notify-ans");
    markCallAnswered(manager, callId, "evt-notify-ans-dup");
    const call = manager.getCall(callId)!;
    expect(call.transcript.map((t) => [t.speaker, t.text])).toEqual([
      ["bot", "Your package has arrived"],
    ]);
    expect(provider.playTtsCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fix 7: get_transcript path
// ---------------------------------------------------------------------------
describe("getTranscript", () => {
  it("returns transcriptPath only once the file exists", async () => {
    const { manager } = await createManagerHarness();
    manager.setFinalizeTiming({ settleMs: 200 });
    const { callId } = await manager.initiateCall("+15550000106");
    expect((await manager.getTranscript(callId))?.transcriptPath).toBeUndefined();
    markCallAnswered(manager, callId, "evt-gt-ans");
    await manager.endCall(callId);
    const md = transcriptFilePath(manager.getStorePath(), callId);
    await waitFor(() => fs.existsSync(md));
    await waitFor(() => !!lastRecord(manager.getStorePath(), callId)?.metadata?.transcriptPath);
    expect((await manager.getTranscript(callId))?.transcriptPath).toBe(md);
  });
});

// ---------------------------------------------------------------------------
// Fix 8 + 9: report contents
// ---------------------------------------------------------------------------
describe("post-call report contents", () => {
  it("includes the transcript text, bounded, and the recording path", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const { manager } = await createManagerHarness();
    const reports: CallReport[] = [];
    manager.setPostCallReporter(async (r) => {
      reports.push(r);
    });
    const { callId } = await manager.initiateCall("+15550000107");
    markCallAnswered(manager, callId, "evt-rep-ans");
    const long = "x".repeat(13_000);
    manager.processEvent({
      id: "rep-1",
      type: "call.speech",
      callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: `Hello ${long}`,
      isFinal: true,
    });
    await manager.endCall(callId);
    await waitFor(() => reports.length === 1);
    const r = reports[0]!;
    expect(r.transcriptText?.length).toBe(12_000);
    expect(r.transcriptTruncated).toBe(true);
    expect(r.transcriptText).toContain("Caller: Hello");

    const msg = buildCallReportMessage(r);
    expect(msg).toContain("--- TRANSCRIPT START ---");
    expect(msg).toContain("Caller: Hello");
    expect(msg).toContain("the rest is in");
    // Recordings are for debugging only: the report never mentions them.
    expect(msg).not.toMatch(/recording|\.wav/i);
  });

  it("reports unanswered outbound calls with the outcome", async () => {
    const { manager } = await createManagerHarness();
    const reports: CallReport[] = [];
    manager.setPostCallReporter(async (r) => {
      reports.push(r);
    });
    const { callId } = await manager.initiateCall("+15550000108");
    manager.processEvent({
      id: "busy-1",
      type: "call.ended",
      callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      reason: "busy",
    });
    await waitFor(() => reports.length === 1);
    expect(reports[0]!.answered).toBe(false);
    const msg = buildCallReportMessage(reports[0]!);
    expect(msg).toContain("did not connect");
    expect(msg).toContain("the line was busy (busy)");
  });
});

// ---------------------------------------------------------------------------
// Fix 10: finalize barrier + recording transcript
// ---------------------------------------------------------------------------
function tone(seconds: number, rate = 8000, amp = 8000): Int16Array {
  const out = new Int16Array(seconds * rate);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * 440 * i) / rate));
  return out;
}

function stereoWav(left: Int16Array, right: Int16Array, rate = 8000): Buffer {
  const frames = Math.max(left.length, right.length);
  const h = encodeMonoWav(new Int16Array(0), rate);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(rate * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt32LE(36 + frames * 4, 4);
  h.writeUInt32LE(frames * 4, 40);
  const pcm = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    pcm.writeInt16LE(left[i] ?? 0, i * 4);
    pcm.writeInt16LE(right[i] ?? 0, i * 4 + 2);
  }
  return Buffer.concat([h, pcm]);
}

describe("recording transcript", () => {
  it("splits WAV channels", () => {
    const left = Int16Array.from([1, 2, 3]);
    const right = Int16Array.from([-1, -2, -3]);
    const { sampleRate, channels } = splitWavChannels(stereoWav(left, right));
    expect(sampleRate).toBe(8000);
    expect(Array.from(channels[0]!)).toEqual([1, 2, 3]);
    expect(Array.from(channels[1]!)).toEqual([-1, -2, -3]);
  });

  it("merges both channels into time-ordered lines", () => {
    const lines = mergeRecordingSegments(
      [
        { start: 0.5, end: 1.5, text: "Hi" },
        { start: 4, end: 5, text: "Thanks" },
        { start: 5.1, end: 6, text: "bye" },
      ],
      [{ start: 2, end: 3.5, text: "Hello, how can I help?" }],
    );
    expect(lines.map((l) => `${l.speaker}:${l.text}`)).toEqual([
      "user:Hi",
      "bot:Hello, how can I help?",
      "user:Thanks bye",
    ]);
  });

  it("transcribes each detected utterance and orders them by when they were spoken", async () => {
    const dir = createTestStorePath();
    fs.mkdirSync(dir, { recursive: true });
    const wavPath = path.join(dir, "rec.wav");
    // Caller speaks 0-1 s and 4-5 s; the bot speaks 1.5-3.5 s. Silent otherwise.
    const left = new Int16Array(6 * 8000);
    left.set(tone(1), 0);
    left.set(tone(1), 4 * 8000);
    const right = new Int16Array(6 * 8000);
    right.set(tone(2), 1.5 * 8000);
    fs.writeFileSync(wavPath, stereoWav(left, right));

    const durations: number[] = [];
    const fetchMock = stubOpenAiFetch((url, init) => {
      expect(url).toContain("/audio/transcriptions");
      const form = init?.body as FormData;
      expect(form.get("model")).toBe("gpt-4o-transcribe");
      const file = form.get("file") as Blob;
      durations.push(file.size);
      // Label each utterance by its length: 1 s clips are the caller's, 2 s the bot's.
      const seconds = (file.size - 44) / 16000;
      return new Response(JSON.stringify({ text: seconds > 1.8 ? "Bot words" : `Caller words ${durations.length}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const result = await transcribeRecording(wavPath, "test-key");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.lines.map((l) => `${l.speaker}@${Math.floor(l.start)}`)).toEqual(["user@0", "bot@1", "user@3"]);
    expect(result.text.split("\n")[1]).toBe("[00:01] Assistant: Bot words");
  });

  it("finds speech regions and ignores silence", () => {
    const x = new Int16Array(5 * 8000);
    x.set(tone(1), 1 * 8000);
    x.set(tone(1), 3 * 8000);
    const regions = speechRegions(x, 8000);
    expect(regions).toHaveLength(2);
    expect(regions[0]!.from / 8000).toBeCloseTo(0.8, 1);
    expect(speechRegions(new Int16Array(8000), 8000)).toEqual([]);
  });

  it("finalize waits for barriers and writes both transcript sections", async () => {
    stubOpenAiFetch((url) =>
      url.includes("/audio/transcriptions")
        ? new Response(
            JSON.stringify({ text: "Heard words" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        : undefined,
    );
    const { manager } = await createManagerHarness({
      streaming: { openaiApiKey: "test-key" },
    });
    const { callId } = await manager.initiateCall("+15550000109");
    markCallAnswered(manager, callId, "evt-bar-ans");
    manager.processEvent({
      id: "bar-1",
      type: "call.speaking",
      callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      text: "Live caption line",
    });
    const wavPath = path.join(manager.getStorePath(), "recordings", `${callId}.wav`);
    let release!: () => void;
    const saving = new Promise<void>((resolve) => {
      release = resolve;
    }).then(() => {
      fs.mkdirSync(path.dirname(wavPath), { recursive: true });
      const left = tone(2);
      fs.writeFileSync(wavPath, stereoWav(left, new Int16Array(left.length)));
      const c = manager.getCallByProviderCallId("request-uuid") ??
        manager.getRecentCallByProviderCallId("request-uuid");
      c!.metadata = { ...(c!.metadata ?? {}), recordingPath: wavPath };
    });
    manager.addFinalizeBarrier("request-uuid", saving);
    await manager.endCall(callId);

    const md = transcriptFilePath(manager.getStorePath(), callId);
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(md)).toBe(false); // still waiting on the barrier
    release();
    await waitFor(() => fs.existsSync(md));
    const content = fs.readFileSync(md, "utf-8");
    expect(content).not.toMatch(/recording|\.wav/i);
    expect(content).toContain("## Transcript (what was actually heard)");
    expect(content).toContain("Caller: Heard words");
    expect(content).toContain("## Transcript (live captions)");
    expect(content).toContain("Live caption line");
  });

  it("still writes the file when recording transcription fails", async () => {
    stubOpenAiFetch((url) =>
      url.includes("/audio/transcriptions") ? new Response("nope", { status: 500 }) : undefined,
    );
    const { manager } = await createManagerHarness({ streaming: { openaiApiKey: "test-key" } });
    const { callId } = await manager.initiateCall("+15550000110");
    markCallAnswered(manager, callId, "evt-fail-ans");
    const wavPath = path.join(manager.getStorePath(), "recordings", `${callId}.wav`);
    fs.mkdirSync(path.dirname(wavPath), { recursive: true });
    fs.writeFileSync(wavPath, stereoWav(tone(1), tone(1)));
    manager.getCall(callId)!.metadata!.recordingPath = wavPath;
    await manager.endCall(callId);
    const md = transcriptFilePath(manager.getStorePath(), callId);
    await waitFor(() => fs.existsSync(md));
    const failed = fs.readFileSync(md, "utf-8");
    expect(failed).toContain("## Transcript (what was actually heard)\n\n(not available)");
    expect(failed).toContain("## Transcript (live captions)");
  });

  it("finalize gives up on a barrier after the timeout", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const { manager } = await createManagerHarness();
    manager.setFinalizeTiming({ barrierTimeoutMs: 50 });
    const { callId } = await manager.initiateCall("+15550000111");
    markCallAnswered(manager, callId, "evt-bto-ans");
    manager.addFinalizeBarrier("request-uuid", new Promise(() => {}));
    await manager.endCall(callId);
    await waitFor(() => fs.existsSync(transcriptFilePath(manager.getStorePath(), callId)), 1000);
  });

  it("markdown keeps the plain Transcript heading without a recording", () => {
    const md = buildTranscriptMarkdown({
      callId: "c",
      provider: "mock",
      direction: "outbound",
      state: "completed",
      from: "+15550000000",
      to: "+15550000001",
      startedAt: 0,
      transcript: [],
      processedEventIds: [],
    } as CallRecord);
    expect(md).toContain("## Transcript\n");
    expect(md).not.toContain("live captions");
  });
});

// ---------------------------------------------------------------------------
// Lead request: max-duration end keeps "timeout"
// ---------------------------------------------------------------------------
describe("max-duration end reason", () => {
  it("keeps endReason timeout instead of overwriting it with hangup-bot", async () => {
    vi.useFakeTimers();
    try {
      const { manager } = await createManagerHarness({ maxDurationSeconds: 1 });
      const { callId } = await manager.initiateCall("+15550000112");
      markCallAnswered(manager, callId, "evt-max-ans");
      const call = manager.getCall(callId)!;
      await vi.advanceTimersByTimeAsync(1100);
      expect(call.endReason).toBe("timeout");
      expect(call.state).toBe("timeout");
      expect(manager.getActiveCalls()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("call files on request", () => {
  it("finds the last call's recording and transcript only when asked", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const { manager } = await createManagerHarness();
    const { callId } = await manager.initiateCall("+15550000120");
    markCallAnswered(manager, callId, "evt-files-ans");
    const wavPath = path.join(manager.getStorePath(), "recordings", `${callId}.wav`);
    fs.mkdirSync(path.dirname(wavPath), { recursive: true });
    fs.writeFileSync(wavPath, stereoWav(tone(1), tone(1)));
    await manager.endCall(callId);
    await waitFor(() => fs.existsSync(transcriptFilePath(manager.getStorePath(), callId)));
    const files = await manager.getCallFiles("last");
    expect(files).toMatchObject({ callId, recordingPath: wavPath });
    expect(files?.transcriptPath).toContain(callId);
    expect(await manager.getCallFiles(callId)).toMatchObject({ recordingPath: wavPath });
  });
});
