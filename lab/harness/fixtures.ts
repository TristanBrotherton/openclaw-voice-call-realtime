/**
 * Synthesized party-side fixtures (8 kHz PCM16) and a Goertzel DTMF detector
 * for the bot channel. Nothing here is recorded from a real line.
 */
import { FRAME_SAMPLES, SAMPLE_RATE, mulberry32 } from "./audio.ts";

const DTMF_LOW = [697, 770, 852, 941];
const DTMF_HIGH = [1209, 1336, 1477, 1633];
const KEYS = [
  ["1", "2", "3", "A"],
  ["4", "5", "6", "B"],
  ["7", "8", "9", "C"],
  ["*", "0", "#", "D"],
];

function samples(ms: number): number {
  return Math.round((SAMPLE_RATE * ms) / 1000);
}

export function tone(freqs: number[], ms: number, amplitude = 0.3): Int16Array {
  const n = samples(ms);
  const out = new Int16Array(n);
  const ramp = Math.min(samples(5), Math.floor(n / 2));
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const f of freqs) v += Math.sin((2 * Math.PI * f * i) / SAMPLE_RATE);
    const env = Math.min(1, i / Math.max(1, ramp), (n - 1 - i) / Math.max(1, ramp));
    out[i] = Math.round(((v * amplitude) / freqs.length) * env * 32767);
  }
  return out;
}

export function silence(ms: number): Int16Array {
  return new Int16Array(samples(ms));
}

export function beep(freq = 1000, ms = 450): Int16Array {
  return tone([freq], ms, 0.35);
}

export function dtmfTones(digits: string, toneMs = 120, gapMs = 80): Int16Array {
  const parts: Int16Array[] = [];
  for (const d of digits.toUpperCase()) {
    if (d === ",") {
      parts.push(silence(500));
      continue;
    }
    let found: [number, number] | null = null;
    KEYS.forEach((row, r) => row.forEach((k, c) => (k === d ? (found = [DTMF_LOW[r], DTMF_HIGH[c]]) : null)));
    if (!found) throw new Error(`bad DTMF key ${d}`);
    parts.push(tone(found, toneMs, 0.5), silence(gapMs));
  }
  return concat(parts);
}

/** White noise at the given RMS level (dBFS). */
export function noise(ms: number, db = -40, seed = 1): Int16Array {
  const rnd = mulberry32(seed);
  const n = samples(ms);
  const out = new Int16Array(n);
  const rms = 10 ** (db / 20) * 32768;
  const amp = rms * Math.sqrt(3); // uniform [-a,a] has rms a/sqrt(3)
  for (let i = 0; i < n; i++) out[i] = Math.round((rnd() * 2 - 1) * amp);
  return out;
}

/** Simple synthesized hold music: a repeating arpeggio with soft decay, ~-22 dBFS. */
export function holdMusic(ms: number): Int16Array {
  const n = samples(ms);
  const out = new Int16Array(n);
  const notes = [261.63, 329.63, 392.0, 523.25, 392.0, 329.63];
  const noteLen = samples(300);
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(i / noteLen) % notes.length;
    const pos = i % noteLen;
    const env = Math.exp(-pos / samples(180));
    const f = notes[idx];
    const v =
      Math.sin((2 * Math.PI * f * i) / SAMPLE_RATE) * 0.6 +
      Math.sin((2 * Math.PI * f * 2 * i) / SAMPLE_RATE) * 0.2 +
      Math.sin((2 * Math.PI * (f / 2) * i) / SAMPLE_RATE) * 0.2;
    out[i] = Math.round(v * env * 0.18 * 32767);
  }
  return out;
}

export function concat(parts: Int16Array[]): Int16Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Int16Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function mixInto(dst: Int16Array, src: Int16Array): void {
  for (let i = 0; i < dst.length && i < src.length; i++) {
    dst[i] = Math.max(-32768, Math.min(32767, dst[i] + src[i]));
  }
}

// --- Goertzel DTMF detection ---------------------------------------------------

function goertzelPower(frame: Int16Array, freq: number): number {
  const k = (2 * Math.cos((2 * Math.PI * freq) / SAMPLE_RATE));
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < frame.length; i++) {
    const s0 = frame[i] / 32768 + k * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - k * s1 * s2;
}

/** Classify one 20 ms frame: the DTMF key it carries, or null. */
export function classifyDtmfFrame(frame: Int16Array): string | null {
  let energy = 0;
  for (let i = 0; i < frame.length; i++) energy += (frame[i] / 32768) ** 2;
  if (energy / frame.length < 1e-4) return null; // below ~-40 dBFS
  const lows = DTMF_LOW.map((f) => goertzelPower(frame, f));
  const highs = DTMF_HIGH.map((f) => goertzelPower(frame, f));
  const li = lows.indexOf(Math.max(...lows));
  const hi = highs.indexOf(Math.max(...highs));
  const lowSorted = [...lows].sort((a, b) => b - a);
  const highSorted = [...highs].sort((a, b) => b - a);
  // Each tone must dominate its group, and the pair must carry most of the energy.
  if (lowSorted[0] < 6 * lowSorted[1] || highSorted[0] < 6 * highSorted[1]) return null;
  // Goertzel power of a full-scale sine over N samples ~ (N/2)^2 * a^2; normalise.
  const n = frame.length;
  const pairEnergy = ((lows[li] + highs[hi]) * 2) / (n * n);
  const frameEnergy = energy / n;
  if (pairEnergy < 0.6 * frameEnergy) return null;
  const twist = lows[li] / highs[hi];
  if (twist > 10 || twist < 0.1) return null;
  return KEYS[li][hi];
}

/**
 * Streaming DTMF detector: a key is reported once it has been present for
 * at least `minFrames` consecutive frames; it must disappear before the same
 * key can be reported again.
 */
export class DtmfDetector {
  private current: string | null = null;
  private run = 0;
  private reported = false;
  constructor(private readonly minFrames = 2) {}

  /** Feed one frame (FRAME_SAMPLES); returns a newly detected key or null. */
  push(frame: Int16Array): string | null {
    if (frame.length !== FRAME_SAMPLES) return null;
    const key = classifyDtmfFrame(frame);
    if (key && key === this.current) {
      this.run++;
    } else {
      this.current = key;
      this.run = key ? 1 : 0;
      this.reported = false;
    }
    if (key && !this.reported && this.run >= this.minFrames) {
      this.reported = true;
      return key;
    }
    return null;
  }
}
