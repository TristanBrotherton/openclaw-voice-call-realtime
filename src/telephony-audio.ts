const TELEPHONY_SAMPLE_RATE = 8000;

function clamp16(value: number): number {
  return Math.max(-32768, Math.min(32767, value));
}

/**
 * Resample 16-bit PCM (little-endian mono) to 8kHz using linear interpolation.
 */
export function resamplePcmTo8k(input: Buffer, inputSampleRate: number): Buffer {
  if (inputSampleRate === TELEPHONY_SAMPLE_RATE) {
    return input;
  }
  const inputSamples = Math.floor(input.length / 2);
  if (inputSamples === 0) {
    return Buffer.alloc(0);
  }

  const ratio = inputSampleRate / TELEPHONY_SAMPLE_RATE;
  const outputSamples = Math.floor(inputSamples / ratio);
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i * ratio;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;

    const s0 = input.readInt16LE(srcIndex * 2);
    const s1Index = Math.min(srcIndex + 1, inputSamples - 1);
    const s1 = input.readInt16LE(s1Index * 2);

    const sample = Math.round(s0 + frac * (s1 - s0));
    output.writeInt16LE(clamp16(sample), i * 2);
  }

  return output;
}

/**
 * Convert 16-bit PCM to 8-bit mu-law (G.711).
 */
export function pcmToMulaw(pcm: Buffer): Buffer {
  const samples = Math.floor(pcm.length / 2);
  const mulaw = Buffer.alloc(samples);

  for (let i = 0; i < samples; i++) {
    const sample = pcm.readInt16LE(i * 2);
    mulaw[i] = linearToMulaw(sample);
  }

  return mulaw;
}

export function convertPcmToMulaw8k(pcm: Buffer, inputSampleRate: number): Buffer {
  const pcm8k = resamplePcmTo8k(pcm, inputSampleRate);
  return pcmToMulaw(pcm8k);
}

/**
 * Chunk audio buffer into 20ms frames for streaming (8kHz mono mu-law).
 */
export function chunkAudio(audio: Buffer, chunkSize = 160): Generator<Buffer, void, unknown> {
  return (function* () {
    for (let i = 0; i < audio.length; i += chunkSize) {
      yield audio.subarray(i, Math.min(i + chunkSize, audio.length));
    }
  })();
}

/**
 * Convert 8-bit mu-law (G.711) to 16-bit PCM.
 */
export function mulawToPcm(mulaw: Buffer): Buffer {
  const pcm = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) {
    pcm.writeInt16LE(MULAW_DECODE[mulaw[i]!]!, i * 2);
  }
  return pcm;
}

const MULAW_DECODE: Int16Array = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    const magnitude = (((mantissa << 3) + 132) << exponent) - 132;
    table[i] = sign ? -magnitude : magnitude;
  }
  return table;
})();

/**
 * Windowed-sinc low-pass FIR taps (Blackman), unity DC gain times `gain`.
 * `cutoff` is a fraction of the sample rate (0..0.5).
 */
function lowPassTaps(count: number, cutoff: number, gain: number): Float64Array {
  const taps = new Float64Array(count);
  const mid = (count - 1) / 2;
  let sum = 0;
  for (let n = 0; n < count; n++) {
    const x = n - mid;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const window =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * n) / (count - 1)) +
      0.08 * Math.cos((4 * Math.PI * n) / (count - 1));
    taps[n] = sinc * window;
    sum += taps[n]!;
  }
  for (let n = 0; n < count; n++) {
    taps[n] = (taps[n]! / sum) * gain;
  }
  return taps;
}

/** 63 taps at 24 kHz: flat to ~3.4 kHz, well down by 4 kHz (telephone band). */
const BAND_TAPS = lowPassTaps(63, 3700 / 24000, 1);

/**
 * Streaming 8 kHz -> 24 kHz PCM16 upsampler (zero-stuff x3 + low-pass).
 * Keeps filter history across chunks, so 20 ms frames join without clicks.
 */
export class Upsampler8kTo24k {
  private history = new Float64Array(BAND_TAPS.length);
  private pos = 0;

  process(pcm8k: Buffer): Buffer {
    const inSamples = Math.floor(pcm8k.length / 2);
    const out = Buffer.alloc(inSamples * 3 * 2);
    const taps = BAND_TAPS;
    const len = taps.length;
    let o = 0;
    for (let i = 0; i < inSamples; i++) {
      const s = pcm8k.readInt16LE(i * 2);
      for (let k = 0; k < 3; k++) {
        // Zero-stuffed input: one real sample then two zeros; gain 3 restores level.
        this.history[this.pos] = k === 0 ? s * 3 : 0;
        let acc = 0;
        let h = this.pos;
        for (let t = 0; t < len; t++) {
          acc += taps[t]! * this.history[h]!;
          h = h === 0 ? len - 1 : h - 1;
        }
        this.pos = (this.pos + 1) % len;
        out.writeInt16LE(clamp16(Math.round(acc)), o);
        o += 2;
      }
    }
    return out;
  }
}

/**
 * Streaming 24 kHz -> 8 kHz PCM16 downsampler (low-pass + keep every 3rd).
 * Chunks need not be a multiple of 3 samples; the decimation phase carries over.
 */
export class Downsampler24kTo8k {
  private history = new Float64Array(BAND_TAPS.length);
  private pos = 0;
  private phase = 0;

  process(pcm24k: Buffer): Buffer {
    const inSamples = Math.floor(pcm24k.length / 2);
    const out: number[] = [];
    const taps = BAND_TAPS;
    const len = taps.length;
    for (let i = 0; i < inSamples; i++) {
      this.history[this.pos] = pcm24k.readInt16LE(i * 2);
      if (this.phase === 0) {
        let acc = 0;
        let h = this.pos;
        for (let t = 0; t < len; t++) {
          acc += taps[t]! * this.history[h]!;
          h = h === 0 ? len - 1 : h - 1;
        }
        out.push(clamp16(Math.round(acc)));
      }
      this.pos = (this.pos + 1) % len;
      this.phase = (this.phase + 1) % 3;
    }
    const buf = Buffer.alloc(out.length * 2);
    for (let i = 0; i < out.length; i++) {
      buf.writeInt16LE(out[i]!, i * 2);
    }
    return buf;
  }
}

/** Peak absolute sample of a PCM16 buffer. */
export function pcmPeak(pcm: Buffer): number {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = Math.abs(pcm.readInt16LE(i));
    if (v > peak) {
      peak = v;
    }
  }
  return peak;
}

/** RMS of a PCM16 buffer. */
export function pcmRms(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

function linearToMulaw(sample: number): number {
  const BIAS = 132;
  const CLIP = 32635;

  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) {
    sample = -sample;
  }
  if (sample > CLIP) {
    sample = CLIP;
  }

  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--) {
    expMask >>= 1;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}
