/**
 * DTMF tone synthesis for in-call keypad input (IVR menu navigation).
 *
 * Generates standard dual-tone frequencies as 8kHz mu-law audio that can be
 * injected into the Twilio media stream. Twilio's Calls-API DTMF path
 * (TwiML <Play digits>) cannot be used in conversation mode because updating
 * TwiML replaces the active <Connect><Stream> and drops the call.
 */

import { pcmToMulaw } from "./telephony-audio.js";

const SAMPLE_RATE = 8000;
const TONE_MS = 120;
const GAP_MS = 80;
/** ITU-T Q.23 dual-tone frequency pairs [low, high] per key. */
const DTMF_FREQUENCIES: Record<string, [number, number]> = {
  "1": [697, 1209],
  "2": [697, 1336],
  "3": [697, 1477],
  A: [697, 1633],
  "4": [770, 1209],
  "5": [770, 1336],
  "6": [770, 1477],
  B: [770, 1633],
  "7": [852, 1209],
  "8": [852, 1336],
  "9": [852, 1477],
  C: [852, 1633],
  "*": [941, 1209],
  "0": [941, 1336],
  "#": [941, 1477],
  D: [941, 1633],
};

export function isValidDtmfSequence(digits: string): boolean {
  return digits.length > 0 && [...digits.toUpperCase()].every((d) => d in DTMF_FREQUENCIES || d === ",");
}

function generateTonePcm(low: number, high: number, durationMs: number): Buffer {
  const samples = Math.round((SAMPLE_RATE * durationMs) / 1000);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    // -6 dBFS per tone so the dual-tone sum stays well below clipping.
    const value =
      0.35 * Math.sin(2 * Math.PI * low * t) + 0.35 * Math.sin(2 * Math.PI * high * t);
    pcm.writeInt16LE(Math.round(value * 32767), i * 2);
  }
  return pcm;
}

function generateSilencePcm(durationMs: number): Buffer {
  return Buffer.alloc(Math.round((SAMPLE_RATE * durationMs) / 1000) * 2);
}

/**
 * Generate a mu-law audio buffer for a DTMF key sequence.
 * A "," in the sequence inserts a 500ms pause (useful for IVR pacing).
 */
export function generateDtmfMulaw(digits: string): Buffer {
  const parts: Buffer[] = [];
  for (const raw of digits.toUpperCase()) {
    if (raw === ",") {
      parts.push(generateSilencePcm(500));
      continue;
    }
    const freqs = DTMF_FREQUENCIES[raw];
    if (!freqs) {
      throw new Error(`Invalid DTMF key: ${raw}`);
    }
    parts.push(generateTonePcm(freqs[0], freqs[1], TONE_MS));
    parts.push(generateSilencePcm(GAP_MS));
  }
  return pcmToMulaw(Buffer.concat(parts));
}
