import { describe, expect, it } from "vitest";
import { FRAME_MS, FRAME_SAMPLES } from "../harness/audio.ts";
import { dtmfTones, tone } from "../harness/fixtures.ts";
import { PartyEngine, type PartyEvent } from "../harness/party.ts";
import type { RenderedStep } from "../harness/render.ts";
import { type Scenario, type Step, validateScenario } from "../harness/scenario.ts";

const SILENT = new Int16Array(FRAME_SAMPLES);
const LOUD = tone([440], FRAME_MS, 0.3);

function clip(ms: number): RenderedStep {
  const pcm = tone([300], ms, 0.2);
  return { pcm, durationMs: ms, speech: { start_ms: 0, end_ms: ms } };
}

function scenario(steps: Step[]): Scenario {
  const s: Scenario = { id: "t", class: "test", direction: "outbound", call: {}, steps };
  steps.forEach((st, i) => (st.id ??= `s${i + 1}`));
  validateScenario(s);
  return s;
}

/** Drive the engine; botAudio(t) returns the bot frame heard at t. */
function drive(engine: PartyEngine, untilMs: number, botAudio: (t: number) => Int16Array) {
  const out: Int16Array[] = [];
  for (let t = 0; t < untilMs; t += FRAME_MS) out.push(engine.tick(t, botAudio(t)));
  return out;
}

const starts = (ev: PartyEvent[]) =>
  Object.fromEntries(ev.filter((e) => e.type === "step_start").map((e) => [e.step as string, e.t_ms]));

describe("PartyEngine gates", () => {
  it("at_ms, then after_bot_done waits for the bot to speak and go quiet", () => {
    const ev: PartyEvent[] = [];
    const sc = scenario([
      { say: "hello", gate: { at_ms: 100 } },
      { say: "reply", gate: { after_bot_done: { quiet_ms: 400 } } },
    ]);
    const e = new PartyEngine(sc, [clip(200), clip(200)], { onEvent: (x) => ev.push(x) });
    const party = drive(e, 3000, (t) => (t >= 1000 && t < 1600 ? LOUD : SILENT));
    const st = starts(ev);
    expect(st.s1).toBe(100);
    // Bot audible 1000..1600 -> quiet 400 ms -> 2000.
    expect(st.s2).toBe(2000);
    expect(ev.find((x) => x.type === "bot_speech_start")?.t_ms).toBe(1000);
    expect(ev.find((x) => x.type === "bot_speech_end")?.t_ms).toBe(1600);
    // The party actually played audio for step 1 at 100..300.
    expect(party[100 / FRAME_MS].some((v) => v !== 0)).toBe(true);
    expect(party[400 / FRAME_MS].every((v) => v === 0)).toBe(true);
    expect(e.done).toBe(true);
  });

  it("after_bot_done does not open on quiet alone (bot must have spoken), but times out", () => {
    const ev: PartyEvent[] = [];
    const sc = scenario([
      { say: "hello", gate: { at_ms: 0 } },
      { say: "again", gate: { after_bot_done: true }, gate_timeout_ms: 1500 },
    ]);
    const e = new PartyEngine(sc, [clip(200), clip(200)], { onEvent: (x) => ev.push(x) });
    drive(e, 3000, () => SILENT);
    expect(ev.some((x) => x.type === "gate_timeout" && x.step === "s2")).toBe(true);
    expect(starts(ev).s2).toBe(1700);
  });

  it("during_bot_speech starts offset_ms after the bot's onset (barge-in)", () => {
    const ev: PartyEvent[] = [];
    const sc = scenario([
      { say: "hello", gate: { at_ms: 0 } },
      { say: "interrupt", gate: { during_bot_speech: { offset_ms: 500 } } },
    ]);
    const e = new PartyEngine(sc, [clip(200), clip(200)], { onEvent: (x) => ev.push(x) });
    drive(e, 3000, (t) => (t >= 800 && t < 2500 ? LOUD : SILENT));
    expect(starts(ev).s2).toBe(1300);
    expect(ev.find((x) => x.type === "step_start" && x.step === "s2")?.bot_speaking).toBe(true);
  });

  it("on_dtmf opens on keys the bot pressed, including during the previous step", () => {
    const ev: PartyEvent[] = [];
    const sc = scenario([
      { say: "menu", gate: { at_ms: 0 }, machine: true, reply: false },
      { say: "connecting", gate: { on_dtmf: { digits: "1", offset_ms: 200 } } },
    ]);
    const e = new PartyEngine(sc, [clip(1000), clip(200)], { onEvent: (x) => ev.push(x) });
    const keys = dtmfTones("1");
    drive(e, 2500, (t) => {
      const i = ((t - 600) / FRAME_MS) * FRAME_SAMPLES;
      if (t < 600 || i >= keys.length) return SILENT;
      const f = new Int16Array(FRAME_SAMPLES);
      f.set(keys.subarray(i, i + FRAME_SAMPLES));
      return f;
    });
    expect(e.pressedDigits).toBe("1");
    const key = ev.find((x) => x.type === "dtmf_detected");
    expect(key?.t_ms).toBeGreaterThanOrEqual(600);
    // Pressed at ~600 ms while the menu (0..1000) was still playing; gate opens after the menu ends.
    expect(starts(ev).s2).toBe(1000);
  });

  it("hangup ends the party; wait_silence holds for its duration", () => {
    const ev: PartyEvent[] = [];
    const sc = scenario([{ wait_silence: 600, gate: { at_ms: 0 } }, { hangup: true }]);
    const e = new PartyEngine(sc, [{ pcm: new Int16Array(0), durationMs: 600 }, { pcm: new Int16Array(0), durationMs: 0 }], {
      onEvent: (x) => ev.push(x),
    });
    drive(e, 1000, () => SILENT);
    expect(e.hungUp).toBe(true);
    expect(ev.find((x) => x.type === "party_hangup")?.t_ms).toBe(600);
  });

  it("mixes constant line noise into every frame", () => {
    const sc = scenario([{ wait_silence: 100, gate: { at_ms: 0 } }]);
    sc.line = { noise_db: -40 };
    const e = new PartyEngine(sc, [{ pcm: new Int16Array(0), durationMs: 100 }]);
    const out = drive(e, 200, () => SILENT);
    expect(out.every((f) => f.some((v) => v !== 0))).toBe(true);
  });
});
