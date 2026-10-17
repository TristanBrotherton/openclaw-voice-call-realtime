/**
 * Self-contained telephony audio helpers for the lab (kept separate from
 * src/ so plugin audio changes cannot silently change the test rig).
 * All PCM here is mono Int16 at 8 kHz unless noted.
 */

export const SAMPLE_RATE = 8000;
export const FRAME_MS = 20;
export const FRAME_SAMPLES = 160;

// --- G.711 mu-law -----------------------------------------------------------

const BIAS = 0x84;
const CLIP = 32635;

export function linearToMulaw(sample: number): number {
  let s = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {
    /* find segment */
  }
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

const MULAW_TABLE = (() => {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    let s = ((mantissa << 3) + BIAS) << exponent;
    s -= BIAS;
    t[i] = sign ? -s : s;
  }
  return t;
})();

export function mulawToLinear(byte: number): number {
  return MULAW_TABLE[byte & 0xff];
}

export function encodeMulaw(pcm: Int16Array): Buffer {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = linearToMulaw(pcm[i]);
  return out;
}

export function decodeMulaw(buf: Uint8Array): Int16Array {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = MULAW_TABLE[buf[i]];
  return out;
}

/** mu-law byte for digital silence. */
export const MULAW_SILENCE = 0xff;

export function silenceFrame(): Buffer {
  return Buffer.alloc(FRAME_SAMPLES, MULAW_SILENCE);
}

// --- Resampling ---------------------------------------------------------------

/** Windowed-sinc low-pass FIR taps. cutoff is a fraction of the input rate. */
function lowpassTaps(cutoff: number, taps: number): Float64Array {
  const h = new Float64Array(taps);
  const m = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - m;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1)); // Hamming
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  return h;
}

/** 24 kHz PCM16 -> 8 kHz PCM16 (low-pass at 3.4 kHz, decimate by 3). */
export function downsample24kTo8k(pcm24: Int16Array): Int16Array {
  const h = lowpassTaps(3400 / 24000, 63);
  const half = (h.length - 1) / 2;
  const outLen = Math.floor(pcm24.length / 3);
  const out = new Int16Array(outLen);
  for (let o = 0; o < outLen; o++) {
    const c = o * 3;
    let acc = 0;
    for (let k = 0; k < h.length; k++) {
      const idx = c + k - half;
      if (idx >= 0 && idx < pcm24.length) acc += pcm24[idx] * h[k];
    }
    out[o] = Math.max(-32768, Math.min(32767, Math.round(acc)));
  }
  return out;
}

// --- Levels -------------------------------------------------------------------

export function rmsDbfs(pcm: Int16Array, start = 0, end = pcm.length): number {
  if (end <= start) return -120;
  let acc = 0;
  for (let i = start; i < end; i++) acc += pcm[i] * pcm[i];
  const rms = Math.sqrt(acc / (end - start));
  return rms <= 0 ? -120 : 20 * Math.log10(rms / 32768);
}

export function applyGainDb(pcm: Int16Array, db: number): Int16Array {
  const g = 10 ** (db / 20);
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * g)));
  return out;
}

/** Deterministic PRNG so rendered fixtures are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Speech extent of a clip: first/last 20 ms frame above (peak frame - 35 dB) and above -50 dBFS. */
export function speechExtent(pcm: Int16Array): { startSample: number; endSample: number } | null {
  const frames = Math.floor(pcm.length / FRAME_SAMPLES);
  const levels: number[] = [];
  for (let f = 0; f < frames; f++) levels.push(rmsDbfs(pcm, f * FRAME_SAMPLES, (f + 1) * FRAME_SAMPLES));
  const peak = Math.max(-120, ...levels);
  const thr = Math.max(-50, peak - 35);
  const first = levels.findIndex((l) => l > thr);
  if (first < 0) return null;
  let last = first;
  for (let f = levels.length - 1; f >= 0; f--) {
    if (levels[f] > thr) {
      last = f;
      break;
    }
  }
  return { startSample: first * FRAME_SAMPLES, endSample: (last + 1) * FRAME_SAMPLES };
}

// --- WAV ------------------------------------------------------------------------

export function stereoWav(left: Int16Array, right: Int16Array, sampleRate = SAMPLE_RATE): Buffer {
  const n = Math.max(left.length, right.length);
  const data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(left[i] ?? 0, i * 4);
    data.writeInt16LE(right[i] ?? 0, i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
