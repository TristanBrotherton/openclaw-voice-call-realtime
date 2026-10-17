/**
 * Audio pacing and voice activity for phone calls.
 *
 * - PlayoutClock: how much audio Twilio has buffered ahead of real time. Twilio
 *   plays media frames in order at 8 kHz; everything sent ahead of the play
 *   position waits in its buffer (and is dropped by a `clear`).
 * - LiveOutputPacer: GPT-Live streams its voice at about real time (1.02-1.11x,
 *   frame gaps up to ~380 ms) and keeps streaming digital silence between
 *   replies. Forwarded as-is, Twilio's buffer would underrun mid-word on a gap
 *   and grow without bound over a long call. The pacer holds a short lead at
 *   each speech onset, then passes speech through, and drops silent frames
 *   while the lead is above target. Same idea as the Voice PE output lead
 *   buffer (voicepe-realtime app/output_lead_buffer.py), sized for the phone.
 * - SpeechDetector: energy VAD with an adaptive noise floor, used for the
 *   caller's side (pickup, silence checks) and the bot's side (speaking/quiet).
 */

import { pcmPeak, pcmRms } from "./telephony-audio.js";

export const FRAME_MS = 20;
/** Bytes in one 20 ms mu-law frame at 8 kHz. */
export const MULAW_FRAME_BYTES = 160;

export class PlayoutClock {
  /** Wall time (ms) at which the last queued audio finishes playing. */
  private queuedUntil = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Record `ms` of audio handed to Twilio now. */
  push(ms: number): void {
    this.queuedUntil = Math.max(this.queuedUntil, this.now()) + ms;
  }

  /** Audio buffered ahead of real time, in ms. */
  leadMs(): number {
    return Math.max(0, this.queuedUntil - this.now());
  }

  /** Twilio `clear`: the buffer is gone. */
  clear(): void {
    this.queuedUntil = this.now();
  }

  /** Wall time when everything queued so far has played. */
  drainedAt(): number {
    return Math.max(this.queuedUntil, this.now());
  }
}

export type PacerOptions = {
  /** Lead to build at each speech onset before releasing audio (ms). */
  onsetLeadMs?: number;
  /** While idle, silent frames are dropped once the lead exceeds this (ms). */
  maxIdleLeadMs?: number;
  /** PCM16 peak at or below which a frame counts as silent. */
  silencePeak?: number;
};

/**
 * Paces 8 kHz PCM16 frames from GPT-Live toward Twilio. Feed 20 ms frames in
 * arrival order; `emit` is called with the frames to send now.
 */
export class LiveOutputPacer {
  private readonly onsetLeadMs: number;
  private readonly maxIdleLeadMs: number;
  private readonly silencePeak: number;
  private held: Buffer[] = [];
  private speaking = false;
  private holding = false;

  constructor(
    private readonly clock: PlayoutClock,
    private readonly emit: (pcm8kFrame: Buffer) => void,
    opts: PacerOptions = {},
  ) {
    this.onsetLeadMs = opts.onsetLeadMs ?? 240;
    this.maxIdleLeadMs = opts.maxIdleLeadMs ?? 120;
    this.silencePeak = opts.silencePeak ?? 64;
  }

  push(frame: Buffer): void {
    const silent = pcmPeak(frame) <= this.silencePeak;
    if (this.holding) {
      this.held.push(frame);
      if (this.held.length * FRAME_MS >= this.onsetLeadMs) {
        this.release();
      }
      return;
    }
    if (silent) {
      if (this.speaking) {
        // A pause inside speech: keep it, it is part of the rhythm. Speech is
        // "over" for pacing purposes once the lead has drained to idle level.
        if (this.clock.leadMs() <= this.maxIdleLeadMs) {
          this.speaking = false;
        }
        this.send(frame);
        return;
      }
      if (this.clock.leadMs() > this.maxIdleLeadMs) {
        return; // drop idle silence beyond the target lead
      }
      this.send(frame);
      return;
    }
    if (!this.speaking && this.clock.leadMs() < this.onsetLeadMs) {
      this.holding = true;
      this.held = [frame];
      return;
    }
    this.speaking = true;
    this.send(frame);
  }

  /** Barge-in or interruption: forget anything held. */
  reset(): void {
    this.held = [];
    this.holding = false;
    this.speaking = false;
  }

  /** Flush held audio now (end of stream). */
  flush(): void {
    if (this.holding) {
      this.release();
    }
  }

  private release(): void {
    const frames = this.held;
    this.held = [];
    this.holding = false;
    this.speaking = true;
    for (const f of frames) {
      this.send(f);
    }
  }

  private send(frame: Buffer): void {
    this.clock.push((frame.length / 2 / 8000) * 1000);
    this.emit(frame);
  }
}

export type SpeechDetectorOptions = {
  /** Speech must stay above threshold this long to start a segment (ms). */
  onsetMs?: number;
  /** Quiet this long ends a segment (ms). */
  hangoverMs?: number;
  /** Absolute RMS floor below which nothing is speech. */
  minRms?: number;
  /** Speech threshold as a multiple of the tracked noise floor. */
  snr?: number;
};

export type SpeechEvent =
  | { type: "start"; at: number }
  | { type: "end"; at: number; durationMs: number };

/**
 * Frame-level energy VAD with an adaptive noise floor. Feed PCM16 frames with
 * their wall-clock time; returns a start/end event when a segment opens/closes.
 */
export class SpeechDetector {
  private readonly onsetMs: number;
  private readonly hangoverMs: number;
  private readonly minRms: number;
  private readonly snr: number;
  private noiseFloor = 0;
  private aboveMs = 0;
  private belowMs = 0;
  private active = false;
  private startedAt = 0;
  private lastSpeechAt = 0;
  private everSpoke = false;

  constructor(opts: SpeechDetectorOptions = {}) {
    this.onsetMs = opts.onsetMs ?? 100;
    this.hangoverMs = opts.hangoverMs ?? 500;
    this.minRms = opts.minRms ?? 300;
    this.snr = opts.snr ?? 3;
  }

  push(frame: Buffer, at: number): SpeechEvent | null {
    const frameMs = (frame.length / 2 / 8000) * 1000;
    const rms = pcmRms(frame);
    const threshold = Math.max(this.minRms, this.noiseFloor * this.snr);
    const loud = rms > threshold;
    if (!loud) {
      // Track the floor on quiet frames only, slowly upward, quickly down.
      this.noiseFloor =
        this.noiseFloor === 0
          ? rms
          : rms < this.noiseFloor
            ? this.noiseFloor * 0.8 + rms * 0.2
            : this.noiseFloor * 0.995 + rms * 0.005;
    }
    if (loud) {
      this.aboveMs += frameMs;
      this.belowMs = 0;
      this.lastSpeechAt = at;
      if (!this.active && this.aboveMs >= this.onsetMs) {
        this.active = true;
        this.everSpoke = true;
        this.startedAt = at - this.aboveMs + frameMs;
        return { type: "start", at: this.startedAt };
      }
      return null;
    }
    this.aboveMs = 0;
    if (this.active) {
      this.belowMs += frameMs;
      if (this.belowMs >= this.hangoverMs) {
        this.active = false;
        const end = this.lastSpeechAt + frameMs;
        return { type: "end", at: end, durationMs: end - this.startedAt };
      }
    }
    return null;
  }

  isActive(): boolean {
    return this.active;
  }

  /** How long the current speech segment has lasted (0 when quiet). */
  activeForMs(now: number): number {
    return this.active ? now - this.startedAt : 0;
  }

  hasSpoken(): boolean {
    return this.everSpoke;
  }

  /** Wall time of the last loud frame (0 if none). */
  lastSpeech(): number {
    return this.lastSpeechAt;
  }
}
