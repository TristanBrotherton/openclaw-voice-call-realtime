import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  LiveOutputPacer,
  PlayoutClock,
  SpeechDetector,
} from "./audio-pacing.js";
import { CallRecorder } from "./call-recorder.js";
import { PickupGate, SilenceWatch } from "./call-flow.js";
import {
  DelegationLedger,
  buildSessionStart,
  chunkText,
  historyToSessionInput,
} from "./providers/gpt-live-protocol.js";
import { GptLiveConversationSession } from "./providers/gpt-live-conversation.js";
import {
  Downsampler24kTo8k,
  Upsampler8kTo24k,
  mulawToPcm,
  pcmPeak,
  pcmRms,
  pcmToMulaw,
} from "./telephony-audio.js";

function tone(freq: number, rate: number, ms: number, amp = 8000): Buffer {
  const n = Math.round((rate * ms) / 1000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * freq * i) / rate)), i * 2);
  }
  return buf;
}

function steadyRms(pcm: Buffer): number {
  // Skip the filter warm-up.
  return pcmRms(pcm.subarray(Math.floor(pcm.length / 4)));
}

describe("telephony audio", () => {
  it("mu-law round trips within quantisation error", () => {
    const pcm = tone(440, 8000, 100);
    const back = mulawToPcm(pcmToMulaw(pcm));
    for (let i = 0; i < pcm.length; i += 2) {
      const a = pcm.readInt16LE(i);
      const b = back.readInt16LE(i);
      expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.max(16, Math.abs(a) * 0.07));
    }
  });

  it("upsamples 8k to 24k keeping a voice-band tone's level", () => {
    const up = new Upsampler8kTo24k();
    const input = tone(1000, 8000, 200);
    const out = Buffer.concat([up.process(input.subarray(0, 320)), up.process(input.subarray(320))]);
    expect(out.length).toBe(input.length * 3);
    expect(steadyRms(out) / steadyRms(input)).toBeGreaterThan(0.85);
    expect(steadyRms(out) / steadyRms(input)).toBeLessThan(1.15);
  });

  it("downsamples 24k to 8k, passing 1 kHz and rejecting 6 kHz (no aliasing)", () => {
    const pass = new Downsampler24kTo8k().process(tone(1000, 24000, 200));
    expect(pass.length).toBe(1600 * 2);
    expect(steadyRms(pass) / steadyRms(tone(1000, 24000, 200))).toBeGreaterThan(0.85);
    const stop = new Downsampler24kTo8k().process(tone(6000, 24000, 200));
    expect(steadyRms(stop)).toBeLessThan(steadyRms(tone(6000, 24000, 200)) * 0.05);
  });

  it("downsampler keeps phase across odd-sized chunks", () => {
    const input = tone(500, 24000, 100);
    const whole = new Downsampler24kTo8k().process(input);
    const d = new Downsampler24kTo8k();
    const parts = Buffer.concat([d.process(input.subarray(0, 1002)), d.process(input.subarray(1002))]);
    expect(parts.equals(whole)).toBe(true);
  });
});

describe("PlayoutClock and LiveOutputPacer", () => {
  it("holds a lead at speech onset, then releases it at once", () => {
    let now = 0;
    const clock = new PlayoutClock(() => now);
    const sent: Buffer[] = [];
    const pacer = new LiveOutputPacer(clock, (f) => sent.push(f), { onsetLeadMs: 100 });
    const speech = tone(300, 8000, 20);
    pacer.push(speech);
    pacer.push(speech);
    expect(sent.length).toBe(0);
    for (let i = 0; i < 3; i++) pacer.push(speech);
    expect(sent.length).toBe(5);
    expect(clock.leadMs()).toBe(100);
  });

  it("drops idle silence beyond the target lead, keeps pauses inside speech", () => {
    let now = 0;
    const clock = new PlayoutClock(() => now);
    const sent: Buffer[] = [];
    const pacer = new LiveOutputPacer(clock, (f) => sent.push(f), {
      onsetLeadMs: 40,
      maxIdleLeadMs: 40,
    });
    const silence = Buffer.alloc(320);
    for (let i = 0; i < 10; i++) pacer.push(silence); // idle, no time passes
    expect(sent.length).toBe(3); // only up to the idle lead (plus one frame)
    sent.length = 0;
    const speech = tone(300, 8000, 20);
    for (let i = 0; i < 5; i++) pacer.push(speech);
    pacer.push(silence); // a pause inside speech is kept
    expect(sent.length).toBe(6);
  });

  it("clear empties the lead", () => {
    let now = 1000;
    const clock = new PlayoutClock(() => now);
    clock.push(500);
    expect(clock.leadMs()).toBe(500);
    now += 200;
    expect(clock.leadMs()).toBe(300);
    clock.clear();
    expect(clock.leadMs()).toBe(0);
  });
});

describe("SpeechDetector", () => {
  it("finds one segment with its duration", () => {
    const vad = new SpeechDetector({ onsetMs: 40, hangoverMs: 200 });
    let t = 0;
    const events = [];
    const quiet = Buffer.alloc(320);
    const loud = tone(300, 8000, 20, 6000);
    for (let i = 0; i < 25; i++, t += 20) events.push(vad.push(quiet, t));
    for (let i = 0; i < 50; i++, t += 20) events.push(vad.push(loud, t));
    for (let i = 0; i < 20; i++, t += 20) events.push(vad.push(quiet, t));
    const real = events.filter(Boolean);
    expect(real.map((e) => e!.type)).toEqual(["start", "end"]);
    const end = real[1] as { durationMs: number };
    expect(end.durationMs).toBeGreaterThan(900);
    expect(end.durationMs).toBeLessThan(1100);
  });
});

describe("PickupGate", () => {
  it("releases on a short hello followed by quiet", () => {
    const gate = new PickupGate(0, { amdEnabled: true });
    expect(gate.onSpeech({ type: "end", at: 1500, durationMs: 700 }, false)).toEqual({
      reason: "greeting",
      replay: true,
    });
  });

  it("waits for AMD after a long greeting, then leaves voicemail at the beep", () => {
    const gate = new PickupGate(0, { amdEnabled: true });
    expect(gate.onSpeech({ type: "end", at: 9000, durationMs: 8000 }, false)).toBeNull();
    expect(gate.tick(10_000, true, false)).toBeNull();
    expect(gate.onAmd("machine_start")).toBeNull();
    expect(gate.onAmd("machine_end_beep")).toMatchObject({ reason: "voicemail" });
  });

  it("speaks first on a silent pickup", () => {
    const gate = new PickupGate(0, { amdEnabled: true, silentPickupMs: 2500 });
    expect(gate.tick(2000, false, false)).toBeNull();
    expect(gate.tick(2600, false, false)).toEqual({ reason: "silent-pickup", replay: false });
  });

  it("treats AMD unknown as a person and gives up waiting eventually", () => {
    expect(new PickupGate(0, { amdEnabled: true }).onAmd("unknown")).toMatchObject({ reason: "human" });
    const gate = new PickupGate(0, { amdEnabled: true, maxAmdWaitMs: 5000 });
    gate.onSpeech({ type: "end", at: 4000, durationMs: 3500 }, false);
    expect(gate.tick(5100, true, false)).toMatchObject({ reason: "timeout" });
  });

  it("without AMD a long opening releases when it ends", () => {
    const gate = new PickupGate(0, { amdEnabled: false });
    expect(gate.onSpeech({ type: "end", at: 4000, durationMs: 3500 }, false)).toMatchObject({
      reason: "human",
    });
  });
});

describe("SilenceWatch", () => {
  it("checks in once, then ends; speech resets it", () => {
    const w = new SilenceWatch(0, { checkInMs: 10_000, endAfterCheckInMs: 5_000 });
    expect(w.tick(9_000)).toBeNull();
    expect(w.tick(10_000)).toBe("check-in");
    expect(w.tick(12_000)).toBeNull();
    w.activity(12_000);
    expect(w.tick(21_000)).toBeNull();
    expect(w.tick(22_000)).toBe("check-in");
    expect(w.tick(27_000)).toBe("end");
    expect(w.tick(40_000)).toBeNull();
  });

  it("is suspended while on hold", () => {
    const w = new SilenceWatch(0, { checkInMs: 1000 });
    w.suspend(60_000);
    expect(w.tick(30_000)).toBeNull();
    w.resume(60_000);
    expect(w.tick(60_500)).toBeNull();
    expect(w.tick(61_000)).toBe("check-in");
  });
});

describe("GPT-Live protocol", () => {
  it("builds session.start with responses delegation", () => {
    const start = buildSessionStart({
      model: "gpt-live-1",
      instructions: "hi",
      backendModel: "gpt-6-luna",
      backendInstructions: "b",
      tools: [{ name: "end_call", description: "d", parameters: { type: "object" } }],
      voice: "cedar",
      serviceTier: "priority",
    }) as { type: string; session: Record<string, any> };
    expect(start.type).toBe("session.start");
    expect(start.session.audio).toEqual({ output: { voice: "cedar" } });
    expect(start.session.delegation.type).toBe("responses");
    expect(start.session.delegation.responses.tools[0]).toMatchObject({ type: "function", name: "end_call" });
  });

  it("chunks long context under the token cap", () => {
    const long = "This is a sentence. ".repeat(400);
    const chunks = chunkText(long, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(400);
  });

  it("keeps the newest history items", () => {
    const items = historyToSessionInput(
      Array.from({ length: 200 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `t${i}` }) as const),
    );
    expect(items.length).toBe(128);
    expect(items.at(-1)!.content[0]!.text).toBe("t199");
  });

  it("ledger: response.create only after the response finished and results are in", () => {
    const ledger = new DelegationLedger();
    const env = (inner: Record<string, unknown>) => ({ type: "response.event", delegation_id: "d1", event: inner });
    ledger.observe(env({ type: "response.created", response: { id: "r1" } }));
    const { call } = ledger.observe(
      env({
        type: "response.output_item.done",
        response_id: "r1",
        item: { type: "function_call", status: "completed", call_id: "c1", name: "x", arguments: "{\"a\":1}" },
      }),
    );
    expect(call).toMatchObject({ callId: "c1", name: "x", arguments: { a: 1 } });
    expect(ledger.busy).toBe(true);
    expect(ledger.observe(env({ type: "response.completed", response: { id: "r1" } })).continueNow).toBe(false);
    expect(ledger.complete("c1")).toBe(true);
    expect(ledger.busy).toBe(false);
  });
});

class FakeWs extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  sent: Array<Record<string, any>> = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  terminate() {
    this.readyState = 3;
  }
  close() {
    this.readyState = 3;
  }
  serverSend(evt: Record<string, unknown>) {
    this.emit("message", Buffer.from(JSON.stringify(evt)));
  }
}

describe("GptLiveConversationSession", () => {
  function make(opts: { now?: () => number } = {}) {
    const ws = new FakeWs();
    const session = new GptLiveConversationSession({
      apiKey: "k",
      model: "gpt-live-1",
      backendModel: "gpt-6-luna",
      systemPrompt: "base",
      tools: [{ name: "end_call", description: "end", parameters: { type: "object", properties: {} } }],
      connectWs: () => ws as never,
      now: opts.now,
    });
    return { ws, session };
  }

  it("defers session.start until the call prompt arrives and replays early audio", async () => {
    const { ws, session } = make();
    const p = session.connect();
    ws.emit("open");
    await p;
    // Caller audio before start is held.
    for (let i = 0; i < 4; i++) session.sendAudio(Buffer.alloc(160, 0xff));
    expect(ws.sent.filter((e) => e.type === "session.start")).toHaveLength(0);
    session.updateInstructions("call prompt");
    const start = ws.sent.find((e) => e.type === "session.start")!;
    expect(start.session.instructions).toContain("call prompt");
    expect(start.session.instructions).toContain("HOW ACTIONS WORK");
    expect(start.session.delegation.responses.instructions).toContain("call prompt");
    expect(ws.sent.some((e) => e.type === "session.input_audio.append")).toBe(false);
    ws.serverSend({ type: "session.started", session: {} });
    expect(ws.sent.filter((e) => e.type === "session.input_audio.append").length).toBeGreaterThan(0);
    session.close();
  });

  it("runs a delegated tool and continues the backend response", async () => {
    const { ws, session } = make();
    const p = session.connect();
    ws.emit("open");
    await p;
    session.updateInstructions("x");
    const handler = vi.fn(async () => "done");
    session.onToolCall(handler);
    const env = (inner: Record<string, unknown>) => ({ type: "response.event", delegation_id: "d", event: inner });
    ws.serverSend(env({ type: "response.created", response: { id: "r" } }));
    ws.serverSend(
      env({
        type: "response.output_item.done",
        response_id: "r",
        item: { type: "function_call", status: "completed", call_id: "c", name: "end_call", arguments: "{}" },
      }),
    );
    ws.serverSend(env({ type: "response.completed", response: { id: "r" } }));
    await vi.waitFor(() => expect(ws.sent.some((e) => e.type === "response.create")).toBe(true));
    expect(handler).toHaveBeenCalledWith("end_call", {});
    const out = ws.sent.find((e) => e.type === "response.item.create")!;
    expect(out.item).toMatchObject({ type: "function_call_output", call_id: "c", output: "done" });
    session.close();
  });

  it("emits paced mu-law audio and closes the bot line when the voice goes quiet", async () => {
    vi.useFakeTimers();
    try {
      const { ws, session } = make({ now: () => Date.now() });
      const p = session.connect();
      ws.emit("open");
      await p;
      session.updateInstructions("x");
      const audio: Buffer[] = [];
      const lines: string[] = [];
      let done = 0;
      session.onAudioDelta((c) => audio.push(c));
      session.onResponseTranscriptDone((t) => lines.push(t));
      session.onResponseDone(() => done++);
      ws.serverSend({ type: "session.output_transcript.delta", delta: "Hello there." });
      ws.serverSend({
        type: "session.output_audio.delta",
        delta: tone(300, 24000, 400).toString("base64"),
      });
      expect(audio.length).toBeGreaterThan(0);
      expect(pcmPeak(mulawToPcm(audio[0]!))).toBeGreaterThan(1000);
      expect(session.isResponseActive()).toBe(true);
      vi.advanceTimersByTime(2000);
      expect(lines).toEqual(["Hello there."]);
      expect(done).toBe(1);
      expect(session.isResponseActive()).toBe(false);
      session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("collects caller transcript deltas into one line after a gap", async () => {
    vi.useFakeTimers();
    try {
      const { ws, session } = make();
      const p = session.connect();
      ws.emit("open");
      await p;
      const lines: string[] = [];
      let starts = 0;
      session.onTranscriptDone((t) => lines.push(t));
      session.onSpeechStart(() => starts++);
      ws.serverSend({ type: "session.input_transcript.delta", delta: " Hi," });
      ws.serverSend({ type: "session.input_transcript.delta", delta: " who is this?" });
      vi.advanceTimersByTime(900);
      expect(lines).toEqual(["Hi, who is this?"]);
      expect(starts).toBe(1);
      session.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CallRecorder", () => {
  it("places bot audio at playout time and drops what a clear cut off", async () => {
    let now = 0;
    const dir = await import("node:fs/promises").then((m) => m.mkdtemp("/tmp/rec-"));
    const rec = new CallRecorder(`${dir}/a.wav`, () => now);
    const frame = Buffer.alloc(160, 0x00); // loud-ish mu-law
    for (let i = 0; i < 50; i++) rec.addRemote(Buffer.alloc(160, 0xff), i * 20);
    for (let i = 0; i < 25; i++) rec.addBot(frame); // 500 ms queued at t=0
    now = 200;
    rec.clearBot(); // only 200 ms played
    now = 1000;
    const result = await rec.close();
    expect(result).not.toBeNull();
    const fs = await import("node:fs");
    const wav = fs.readFileSync(result!.path);
    const pcm = wav.subarray(44);
    const right = (i: number) => pcm.readInt16LE(i * 4 + 2);
    expect(Math.abs(right(100))).toBeGreaterThan(1000); // within the first 200 ms
    expect(right(1700)).toBe(0); // after the clear point: silence
    expect(result!.durationMs).toBe(1000);
  });
});

describe("isGoodbyeLine", () => {
  it("recognises closing lines only", async () => {
    const { isGoodbyeLine } = await import("./webhook.js");
    expect(isGoodbyeLine("All right, take care. Goodbye.")).toBe(true);
    expect(isGoodbyeLine("Thanks so much, bye!")).toBe(true);
    expect(isGoodbyeLine("Have a lovely evening.")).toBe(true);
    expect(isGoodbyeLine("Goodbye is not what I meant, can you check the time?")).toBe(false);
    expect(isGoodbyeLine("I'd like to book a table.")).toBe(false);
  });
});

describe("menu router", () => {
  it("spots menu prompts", async () => {
    const { looksLikeMenu } = await import("./menu-router.js");
    expect(looksLikeMenu("For reservations, press 1. For hours, press 2.")).toBe(true);
    expect(looksLikeMenu("Please say or enter your account number.")).toBe(false);
    expect(looksLikeMenu("Hi, this is Maria, how can I help?")).toBe(false);
  });

  it("parses the model's choice", async () => {
    const { chooseMenuKeys } = await import("./menu-router.js");
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ output: [{ content: [{ text: '{"digits":"1","reason":"reservations"}' }] }] }))) as unknown as typeof fetch;
    expect(await chooseMenuKeys({ apiKey: "k", menuText: "press 1", goal: "book", fetchImpl })).toEqual({ digits: "1", reason: "reservations" });
  });
});

describe("toolsForParty", () => {
  it("gives owner-only tools and explain mode to the owner only", async () => {
    const { toolsForParty } = await import("./webhook.js");
    const tools = [
      { name: "end_call", description: "", parameters: { type: "object", properties: {} } },
      { name: "ask_assistant", description: "", parameters: { type: "object", properties: { question: {}, mode: {} } } },
      { name: "deliver_by_text", description: "", parameters: { type: "object", properties: {} } },
      { name: "open_discussion", description: "", parameters: { type: "object", properties: {} } },
    ];
    expect(toolsForParty(tools, "first-party").map((t) => t.name)).toEqual(["end_call", "ask_assistant", "deliver_by_text", "open_discussion"]);
    for (const party of ["trusted-contact", "third-party", "unverified"]) {
      const other = toolsForParty(tools, party);
      expect(other.map((t) => t.name)).toEqual(["end_call", "ask_assistant"]);
      expect(Object.keys((other[1]!.parameters as any).properties)).toEqual(["question"]);
    }
  });
});

describe("looksLikeProjectQuestion", () => {
  it("routes project status and how-it-works questions to explain", async () => {
    const { looksLikeProjectQuestion } = await import("./webhook.js");
    expect(looksLikeProjectQuestion("What's the latest on the dev system project?")).toBe(true);
    expect(looksLikeProjectQuestion("How does our voice bridge work?")).toBe(true);
    expect(looksLikeProjectQuestion("What's on my calendar tomorrow?")).toBe(false);
    expect(looksLikeProjectQuestion("Turn on the kitchen lights")).toBe(false);
  });
});

describe("SilenceWatch check-in is answered only by the caller", () => {
  it("ends after an unanswered check-in even though the bot spoke it", () => {
    const w = new SilenceWatch(0, { checkInMs: 10_000, endAfterCheckInMs: 5_000 });
    expect(w.tick(10_000)).toBe("check-in");
    w.activity(11_000, "bot"); // the check-in itself
    expect(w.tick(15_000)).toBeNull();
    expect(w.tick(16_000)).toBe("end");
  });
});
