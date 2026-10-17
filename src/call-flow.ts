/**
 * Per-call conversation flow decisions that do not depend on the voice runtime.
 *
 * PickupGate (outbound): the bot must not speak the moment the line connects.
 * A person says "Hello?" and waits; a voicemail greeting talks for 5-30 s; a
 * screener asks who is calling. Until the gate releases, the caller's audio is
 * held back from the model (the model hears silence) and kept for replay, so
 * the model answers what was actually said once we know who answered.
 *
 * SilenceWatch: on a phone line the only reliable "activity" is speech. When
 * nobody has spoken for a while, ask once whether they are still there, then
 * end the call politely instead of holding a dead line open.
 */

import type { SpeechEvent } from "./audio-pacing.js";

export type PickupRelease =
  | { reason: "greeting"; replay: true } // short "hello?" then quiet: a person
  | { reason: "silent-pickup"; replay: false } // nothing said: say hello first
  | { reason: "human"; replay: true } // AMD says human (or unknown)
  | { reason: "voicemail"; replay: false; answeredBy: string } // AMD: machine, at the beep
  | { reason: "machine"; replay: true; answeredBy: string } // AMD: some other machine (menu, recording)
  | { reason: "timeout"; replay: true }; // no verdict in time: treat as a person

export type PickupGateOptions = {
  amdEnabled: boolean;
  /** An opening utterance at most this long, followed by quiet, is a person's hello. */
  shortGreetingMs?: number;
  /** Nothing heard this long after answer: speak first. */
  silentPickupMs?: number;
  /** Longest wait for an AMD verdict once a long greeting was heard. */
  maxAmdWaitMs?: number;
};

export class PickupGate {
  private released: PickupRelease | null = null;
  private longGreeting = false;
  private readonly shortGreetingMs: number;
  private readonly silentPickupMs: number;
  private readonly maxAmdWaitMs: number;

  constructor(
    private readonly startedAt: number,
    private readonly opts: PickupGateOptions,
  ) {
    this.shortGreetingMs = opts.shortGreetingMs ?? 2500;
    this.silentPickupMs = opts.silentPickupMs ?? 2500;
    this.maxAmdWaitMs = opts.maxAmdWaitMs ?? 40_000;
  }

  get isReleased(): boolean {
    return this.released !== null;
  }

  get release(): PickupRelease | null {
    return this.released;
  }

  /** Feed caller speech events. */
  onSpeech(event: SpeechEvent, speechActive: boolean): PickupRelease | null {
    if (this.released) {
      return null;
    }
    if (event.type === "end") {
      if (!this.longGreeting && event.durationMs <= this.shortGreetingMs) {
        return this.settle({ reason: "greeting", replay: true });
      }
      this.longGreeting = true;
      if (!this.opts.amdEnabled) {
        // No machine detection: answer once the long opening has finished.
        return this.settle({ reason: "human", replay: true });
      }
    }
    void speechActive;
    return null;
  }

  /** Feed a Twilio AMD verdict (AnsweredBy). */
  onAmd(answeredBy: string): PickupRelease | null {
    if (this.released) {
      return null;
    }
    if (answeredBy === "machine_end_other") {
      // Not a clean voicemail ending: often a phone menu. Let the model hear it.
      return this.settle({ reason: "machine", replay: true, answeredBy });
    }
    if (answeredBy.startsWith("machine_end") || answeredBy === "fax") {
      return this.settle({ reason: "voicemail", replay: false, answeredBy });
    }
    if (answeredBy === "machine_start") {
      this.longGreeting = true;
      return null; // wait for the beep (machine_end_*)
    }
    // human, unknown: a person (or something we should talk to).
    return this.settle({ reason: "human", replay: true });
  }

  /** Call periodically (e.g. every 200 ms) with the caller's current speech state. */
  tick(now: number, callerHasSpoken: boolean, speechActive: boolean): PickupRelease | null {
    if (this.released) {
      return null;
    }
    const elapsed = now - this.startedAt;
    if (!callerHasSpoken && !speechActive && elapsed >= this.silentPickupMs) {
      return this.settle({ reason: "silent-pickup", replay: false });
    }
    if (elapsed >= this.maxAmdWaitMs) {
      return this.settle({ reason: "timeout", replay: true });
    }
    return null;
  }

  private settle(release: PickupRelease): PickupRelease {
    this.released = release;
    return release;
  }
}

export type SilenceAction = "check-in" | "end";

export type SilenceWatchOptions = {
  /** Quiet this long (nobody speaking, nothing pending) -> ask if they're there. */
  checkInMs?: number;
  /** Further quiet after the check-in -> end the call. */
  endAfterCheckInMs?: number;
};

export class SilenceWatch {
  private lastActivity: number;
  private checkedInAt: number | null = null;
  private suspendedUntil = 0;
  private readonly checkInMs: number;
  private readonly endAfterCheckInMs: number;

  constructor(now: number, opts: SilenceWatchOptions = {}) {
    this.lastActivity = now;
    this.checkInMs = opts.checkInMs ?? 15_000;
    this.endAfterCheckInMs = opts.endAfterCheckInMs ?? 12_000;
  }

  /**
   * Someone spoke, or a tool is still working. Only the other party can
   * answer a check-in: the bot's own speech (the check-in itself, or another
   * one) restarts the quiet timer but never resets a pending check-in, so an
   * unanswered "are you still there?" leads to ending the call instead of
   * repeating forever.
   */
  activity(now: number, source: "caller" | "bot" = "caller"): void {
    this.lastActivity = now;
    if (source === "caller") {
      this.checkedInAt = null;
    }
  }

  /** Pause the watch (e.g. on hold) until `until`. */
  suspend(until: number): void {
    this.suspendedUntil = until;
    this.checkedInAt = null;
  }

  resume(now: number): void {
    this.suspendedUntil = 0;
    this.activity(now);
  }

  tick(now: number): SilenceAction | null {
    if (now < this.suspendedUntil) {
      this.lastActivity = now;
      return null;
    }
    if (this.checkedInAt === null) {
      if (now - this.lastActivity >= this.checkInMs) {
        this.checkedInAt = now;
        return "check-in";
      }
      return null;
    }
    if (now - Math.max(this.checkedInAt, this.lastActivity) >= this.endAfterCheckInMs) {
      this.checkedInAt = Number.POSITIVE_INFINITY; // fire once
      return "end";
    }
    return null;
  }
}
