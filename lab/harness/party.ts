/**
 * The scripted party: a transport-agnostic scenario engine. Once per 20 ms
 * frame it is given the bot audio that was audible at that moment and
 * returns the party audio for the same moment. It times its steps against
 * the bot's audible speech (energy VAD) and DTMF it hears. The same engine
 * drives the in-process fake Twilio (T1) and, later, a real Twilio leg (T2).
 */
import { FRAME_MS, FRAME_SAMPLES, rmsDbfs } from "./audio.ts";
import { DtmfDetector, noise } from "./fixtures.ts";
import type { RenderedStep } from "./render.ts";
import { type Scenario, type Step, stepKind } from "./scenario.ts";

export type PartyEvent = { t_ms: number; type: string; [k: string]: unknown };

export type PartyOptions = {
  onEvent?: (ev: PartyEvent) => void;
  /** Bot frame counts as audible above this level. */
  botVadDbfs?: number;
  /** Bot speech run ends after this much quiet (only affects onset bookkeeping). */
  botHangoverMs?: number;
  defaultQuietMs?: number;
  defaultGateTimeoutMs?: number;
};

const DEFAULT_QUIET_MS = 800;
const DEFAULT_GATE_TIMEOUT_MS = 30000;

export class PartyEngine {
  private readonly opts: Required<Omit<PartyOptions, "onEvent">> & Pick<PartyOptions, "onEvent">;
  private pending = 0;
  private pendingSince = 0;
  /** Start of the most recent step (keys pressed while it played count for an on_dtmf gate after it). */
  private lastStepStart = 0;
  private active: { index: number; startedAt: number; offset: number } | null = null;
  private hungUpAt: number | null = null;

  // Bot VAD state
  private botSpeaking = false;
  private runStart: number | null = null;
  private activeRun = 0;
  private lastActiveEnd: number | null = null;
  private onsets: number[] = [];
  private firstBotAudio: number | null = null;

  private readonly dtmf = new DtmfDetector(2);
  private digits: Array<{ t: number; key: string }> = [];
  private lineNoise: Int16Array | null = null;
  private lineNoisePos = 0;

  constructor(
    private readonly scenario: Scenario,
    private readonly rendered: RenderedStep[],
    options: PartyOptions = {},
  ) {
    this.opts = {
      onEvent: options.onEvent,
      botVadDbfs: options.botVadDbfs ?? -45,
      botHangoverMs: options.botHangoverMs ?? 300,
      defaultQuietMs: options.defaultQuietMs ?? DEFAULT_QUIET_MS,
      defaultGateTimeoutMs: options.defaultGateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
    };
    if (scenario.line?.noise_db !== undefined) {
      this.lineNoise = noise(10000, scenario.line.noise_db, 77);
    }
  }

  get done(): boolean {
    return this.pending >= this.scenario.steps.length && !this.active;
  }
  get hungUp(): boolean {
    return this.hungUpAt !== null;
  }
  get botQuietSinceMs(): number | null {
    return this.lastActiveEnd;
  }
  get botIsSpeaking(): boolean {
    return this.botSpeaking;
  }
  get firstBotAudioMs(): number | null {
    return this.firstBotAudio;
  }
  get pressedDigits(): string {
    return this.digits.map((d) => d.key).join("");
  }

  private emit(ev: PartyEvent): void {
    this.opts.onEvent?.(ev);
  }

  /** Advance one frame. `botFrame` is what the party heard during [t, t+20). */
  tick(t: number, botFrame: Int16Array): Int16Array {
    this.observeBot(t, botFrame);
    const out = new Int16Array(FRAME_SAMPLES);
    if (this.hungUp) return out;

    if (!this.active && this.pending < this.scenario.steps.length) {
      this.maybeStart(t);
    }
    if (this.active) {
      const { index } = this.active;
      const r = this.rendered[index];
      const kind = stepKind(this.scenario.steps[index]);
      if (kind === "say" || kind === "play") {
        const from = this.active.offset;
        const n = Math.min(FRAME_SAMPLES, r.pcm.length - from);
        if (n > 0) out.set(r.pcm.subarray(from, from + n));
        this.active.offset += FRAME_SAMPLES;
        if (this.active.offset >= r.pcm.length) this.finish(t + FRAME_MS);
      } else if (kind === "wait") {
        if (t + FRAME_MS - this.active.startedAt >= r.durationMs) this.finish(t + FRAME_MS);
      }
    }
    if (this.lineNoise) {
      for (let i = 0; i < FRAME_SAMPLES; i++) {
        out[i] = Math.max(-32768, Math.min(32767, out[i] + this.lineNoise[this.lineNoisePos]));
        this.lineNoisePos = (this.lineNoisePos + 1) % this.lineNoise.length;
      }
    }
    return out;
  }

  private finish(t: number): void {
    if (!this.active) return;
    const step = this.scenario.steps[this.active.index];
    this.emit({ t_ms: t, type: "step_end", step: step.id, index: this.active.index });
    this.active = null;
    this.pending++;
    this.pendingSince = t;
    if (this.pending >= this.scenario.steps.length) this.emit({ t_ms: t, type: "party_done" });
  }

  private observeBot(t: number, frame: Int16Array): void {
    const level = rmsDbfs(frame);
    const audible = level > this.opts.botVadDbfs;
    if (audible) {
      this.activeRun++;
      if (this.activeRun === 1) this.runStart = t;
      if (this.activeRun >= 2) {
        this.lastActiveEnd = t + FRAME_MS;
        if (!this.botSpeaking) {
          this.botSpeaking = true;
          const onset = this.runStart ?? t;
          this.onsets.push(onset);
          if (this.firstBotAudio === null) this.firstBotAudio = onset;
          this.emit({ t_ms: onset, type: "bot_speech_start" });
        }
      }
    } else {
      this.activeRun = 0;
      if (this.botSpeaking && this.lastActiveEnd !== null && t + FRAME_MS - this.lastActiveEnd >= this.opts.botHangoverMs) {
        this.botSpeaking = false;
        this.emit({ t_ms: this.lastActiveEnd, type: "bot_speech_end" });
      }
    }
    const key = this.dtmf.push(frame);
    if (key) {
      this.digits.push({ t, key });
      this.emit({ t_ms: t, type: "dtmf_detected", digit: key });
    }
  }

  private gateOpen(step: Step, t: number): { open: boolean; reason?: string } {
    const gate = step.gate ?? { after_step: true };
    if ("at_ms" in gate) return { open: t >= gate.at_ms };
    if ("after_step" in gate) {
      const off = gate.after_step === true ? 0 : (gate.after_step.offset_ms ?? 0);
      return { open: t >= this.pendingSince + off };
    }
    if ("after_bot_done" in gate) {
      const g = gate.after_bot_done === true ? {} : gate.after_bot_done;
      const quiet = g.quiet_ms ?? this.opts.defaultQuietMs;
      if (g.require_speech === false) {
        const ref = Math.max(this.pendingSince, this.lastActiveEnd ?? 0);
        return { open: !this.botSpeakingNow(t) && t - ref >= quiet };
      }
      const spokeSince =
        this.lastActiveEnd !== null && this.lastActiveEnd > this.pendingSince;
      return { open: spokeSince && t - (this.lastActiveEnd ?? 0) >= quiet };
    }
    if ("during_bot_speech" in gate) {
      const off = gate.during_bot_speech === true ? 0 : (gate.during_bot_speech.offset_ms ?? 0);
      let ref: number | undefined = this.onsets.find((o) => o >= this.pendingSince);
      if (ref === undefined && this.botSpeaking) ref = this.pendingSince;
      return { open: ref !== undefined && t >= ref + off };
    }
    if ("on_dtmf" in gate) {
      const since = this.digits.filter((d) => d.t >= this.lastStepStart);
      const seq = since.map((d) => d.key).join("");
      const idx = seq.indexOf(gate.on_dtmf.digits.toUpperCase());
      if (idx < 0) return { open: false };
      const hit = since[idx + gate.on_dtmf.digits.length - 1];
      return { open: t >= hit.t + (gate.on_dtmf.offset_ms ?? 0) };
    }
    return { open: true };
  }

  private botSpeakingNow(t: number): boolean {
    return this.lastActiveEnd !== null && t - this.lastActiveEnd < FRAME_MS * 2;
  }

  private maybeStart(t: number): void {
    const index = this.pending;
    const step = this.scenario.steps[index];
    let { open } = this.gateOpen(step, t);
    const timeout = step.gate_timeout_ms ?? this.opts.defaultGateTimeoutMs;
    if (!open && t - this.pendingSince >= timeout) {
      this.emit({ t_ms: t, type: "gate_timeout", step: step.id, index, waited_ms: t - this.pendingSince });
      open = true;
    }
    if (!open) return;
    const r = this.rendered[index];
    const kind = stepKind(step);
    const gateName = step.gate ? Object.keys(step.gate)[0] : "after_step";
    this.emit({
      t_ms: t,
      type: "step_start",
      step: step.id,
      index,
      kind,
      gate: gateName,
      duration_ms: r.durationMs,
      ...(r.speech ? { speech_start_ms: t + r.speech.start_ms, speech_end_ms: t + r.speech.end_ms } : {}),
      bot_speaking: this.botSpeaking,
    });
    if (kind === "hangup") {
      this.hungUpAt = t;
      this.pending++;
      this.emit({ t_ms: t, type: "party_hangup" });
      return;
    }
    this.lastStepStart = t;
    this.active = { index, startedAt: t, offset: 0 };
  }
}
