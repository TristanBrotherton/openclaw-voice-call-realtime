/**
 * Call recorder: one stereo 8 kHz PCM16 WAV per call.
 *
 * Left channel: the other party, as Twilio delivered it (placed by the media
 * frame's stream timestamp). Right channel: the bot, placed where Twilio
 * actually plays it — audio sent ahead of real time queues in Twilio's buffer,
 * and a `clear` drops what had not played yet, so the recording holds what the
 * other party heard, not what the model generated.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { mulawToPcm } from "./telephony-audio.js";

const RATE = 8000;
const MULAW_SILENCE = 0xff;

class MulawTrack {
  private data = new Uint8Array(RATE * 60);
  length = 0;

  /** Write samples at `offset`, growing (silence-filled) as needed. */
  write(offset: number, samples: Buffer): void {
    const end = offset + samples.length;
    this.ensure(end);
    if (offset > this.length) {
      this.data.fill(MULAW_SILENCE, this.length, offset);
    }
    this.data.set(samples, offset);
    this.length = Math.max(this.length, end);
  }

  truncate(length: number): void {
    if (length < this.length) {
      this.length = Math.max(0, length);
    }
  }

  sample(i: number): number {
    return i < this.length ? this.data[i]! : MULAW_SILENCE;
  }

  private ensure(size: number): void {
    if (size <= this.data.length) {
      return;
    }
    let next = this.data.length * 2;
    while (next < size) {
      next *= 2;
    }
    const grown = new Uint8Array(next);
    grown.set(this.data.subarray(0, this.length));
    this.data = grown;
  }
}

export type RecordingResult = {
  path: string;
  durationMs: number;
};

export class CallRecorder {
  private readonly remote = new MulawTrack();
  private readonly bot = new MulawTrack();
  private readonly startedAt: number;
  /** Sample offset (bot track) where the last queued bot audio ends. */
  private botCursor = 0;
  private remoteCursor = 0;
  private closed = false;

  constructor(
    readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  private nowOffset(): number {
    return Math.max(0, Math.round(((this.now() - this.startedAt) * RATE) / 1000));
  }

  /** A media frame from the other party. `timestampMs` is Twilio's media.timestamp. */
  addRemote(mulaw: Buffer, timestampMs?: number): void {
    if (this.closed) {
      return;
    }
    const offset =
      typeof timestampMs === "number" && Number.isFinite(timestampMs)
        ? Math.round((timestampMs * RATE) / 1000)
        : this.remoteCursor;
    this.remote.write(offset, mulaw);
    this.remoteCursor = offset + mulaw.length;
  }

  /** Bot audio handed to Twilio now; it plays after anything still queued. */
  addBot(mulaw: Buffer): void {
    if (this.closed) {
      return;
    }
    const offset = Math.max(this.botCursor, this.nowOffset());
    this.bot.write(offset, mulaw);
    this.botCursor = offset + mulaw.length;
  }

  /** Twilio `clear`: queued bot audio that had not played yet never will. */
  clearBot(): void {
    const now = this.nowOffset();
    if (this.botCursor > now) {
      this.bot.truncate(now);
      this.botCursor = now;
    }
  }

  async close(): Promise<RecordingResult | null> {
    if (this.closed) {
      return null;
    }
    this.closed = true;
    // Bot audio still queued at hangup was cut off by the hangup.
    this.clearBot();
    const frames = Math.max(this.remote.length, this.bot.length);
    if (frames === 0) {
      return null;
    }
    const left = mulawToPcm(Buffer.from(trackBytes(this.remote, frames)));
    const right = mulawToPcm(Buffer.from(trackBytes(this.bot, frames)));
    const pcm = Buffer.alloc(frames * 4);
    for (let i = 0; i < frames; i++) {
      pcm.writeInt16LE(left.readInt16LE(i * 2), i * 4);
      pcm.writeInt16LE(right.readInt16LE(i * 2), i * 4 + 2);
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    await fsp.writeFile(this.filePath, Buffer.concat([wavHeader(pcm.length, 2), pcm]));
    return { path: this.filePath, durationMs: Math.round((frames * 1000) / RATE) };
  }
}

function trackBytes(track: MulawTrack, frames: number): Uint8Array {
  const out = new Uint8Array(frames);
  for (let i = 0; i < frames; i++) {
    out[i] = track.sample(i);
  }
  return out;
}

function wavHeader(dataBytes: number, channels: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

export function recordingFilePath(storePath: string, callId: string): string {
  return path.join(storePath, "recordings", `${callId}.wav`);
}
