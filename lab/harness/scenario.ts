/**
 * Scenario format (YAML files in lab/scenarios/). See lab/README.md.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export type Gate =
  | { at_ms: number }
  | { after_bot_done: { quiet_ms?: number; require_speech?: boolean } | true }
  | { during_bot_speech: { offset_ms?: number } | true }
  | { after_step: { offset_ms?: number } | true }
  | { on_dtmf: { digits: string; offset_ms?: number } };

export type StepExpect = {
  /** Regex (case-insensitive) the bot must be heard saying between this step's start and the next step's start. */
  bot_says?: string;
  /** Regex that must NOT be heard in that window. */
  bot_not_says?: string;
  /** No bot audio while this step plays (start..end). */
  bot_silent?: boolean;
  /** DTMF digits the bot must press in the window. */
  dtmf?: string;
  /** Max ms from this step's speech end to the bot's first audio (turn latency budget). */
  max_reply_ms?: number;
  /** Max ms from this step's speech onset to the bot going quiet (barge-in steps). */
  max_yield_ms?: number;
};

type StepBase = {
  id?: string;
  gate?: Gate;
  /** If the gate has not opened after this long (ms since the step became pending), start anyway. */
  gate_timeout_ms?: number;
  expect?: StepExpect;
  /** false: this step does not ask for a reply (greeting machines, IVR prompts, hold). Default true for `say`. */
  reply?: boolean;
  /** Part of an answering machine / screener prompt the bot must not talk over. */
  machine?: boolean;
};

export type SayStep = StepBase & {
  say: string;
  voice?: string;
  /** gpt-4o-mini-tts style instructions (accent, pace, tone). */
  instructions?: string;
  speed?: number;
  gain_db?: number;
  /** Mix white noise into this clip at this level (dBFS). */
  noise_db?: number;
};

export type PlaySpec =
  | { beep: { freq?: number; ms?: number } | true }
  | { dtmf: string }
  | { hold_music: { ms: number } }
  | { silence: { ms: number } }
  | { noise: { ms: number; db?: number } };

export type PlayStep = StepBase & { play: PlaySpec };
export type WaitStep = StepBase & { wait_silence: number };
export type HangupStep = StepBase & { hangup: true };

export type Step = SayStep | PlayStep | WaitStep | HangupStep;

export type AmdVerdict =
  | "human"
  | "machine_end_beep"
  | "machine_end_silence"
  | "machine_end_other"
  | "unknown"
  | "none";

export type Scenario = {
  id: string;
  class: string;
  description?: string;
  direction: "outbound" | "inbound";
  call: {
    /** Outbound: initial message (purpose) handed to the bot. */
    message?: string;
    talking_points?: string[];
    call_party?: "first-party" | "third-party";
    caller_identity?: string;
    /** Replaces the bot's system prompt for this scenario (default: the profile's prompt). */
    persona?: string;
    /** Inbound: who is calling. */
    caller?: "owner" | "trusted" | "unknown";
  };
  amd?: { verdict: AmdVerdict; at_ms?: number; after_step?: string; offset_ms?: number };
  /** Constant background on the party line, mixed into every party frame. */
  line?: { noise_db?: number };
  /** "real": owner tools go through the real Voice PE bridge (real OpenClaw turns, read-only explain). */
  bridge?: "real";
  stubs?: {
    assistant?: Array<{ match: string; answer: string; delay_ms?: number }>;
    owner_reply?: { text: string; after_ms?: number };
  };
  steps: Step[];
  limits?: {
    max_duration_ms?: number;
    /** After the party's last step, end the call when the bot has been quiet this long. */
    idle_end_ms?: number;
  };
  expect?: {
    /** Who should end the call. */
    ended_by?: "bot" | "party" | "any";
    tools_called?: string[];
    tools_not_called?: string[];
    /** Bot must not make a sound before the party's first speech (outbound pickup etiquette). */
    no_audio_before_party_speech?: boolean;
    heard_any?: string[];
    heard_none?: string[];
    voicemail?: boolean;
    goodbye_complete?: boolean;
    max_dead_air_s?: number;
    max_talk_over_s?: number;
    max_turn_latency_ms?: number;
    no_plugin_errors?: boolean;
  };
};

export function stepKind(step: Step): "say" | "play" | "wait" | "hangup" {
  if ("say" in step) return "say";
  if ("play" in step) return "play";
  if ("wait_silence" in step) return "wait";
  return "hangup";
}

export function loadScenario(file: string): Scenario {
  const raw = YAML.parse(fs.readFileSync(file, "utf8")) as Scenario;
  validateScenario(raw, path.basename(file));
  raw.steps.forEach((s, i) => {
    if (!s.id) s.id = `s${i + 1}`;
  });
  return raw;
}

export function validateScenario(s: Scenario, label = s?.id ?? "?"): void {
  const errs: string[] = [];
  if (!s || typeof s !== "object") throw new Error(`${label}: not an object`);
  if (!s.id) errs.push("id required");
  if (!s.class) errs.push("class required");
  if (s.direction !== "outbound" && s.direction !== "inbound") errs.push("direction must be outbound|inbound");
  if (!Array.isArray(s.steps) || s.steps.length === 0) errs.push("steps required");
  for (const [i, step] of (s.steps ?? []).entries()) {
    const kinds = ["say", "play", "wait_silence", "hangup"].filter((k) => k in step);
    if (kinds.length !== 1) errs.push(`step ${i + 1}: exactly one of say/play/wait_silence/hangup`);
  }
  if (s.amd && !["human", "machine_end_beep", "machine_end_silence", "machine_end_other", "unknown", "none"].includes(s.amd.verdict)) {
    errs.push("amd.verdict invalid");
  }
  if (s.amd && s.amd.verdict !== "none" && s.amd.at_ms === undefined && !s.amd.after_step) {
    errs.push("amd needs at_ms or after_step");
  }
  if (errs.length) throw new Error(`${label}: ${errs.join("; ")}`);
}
