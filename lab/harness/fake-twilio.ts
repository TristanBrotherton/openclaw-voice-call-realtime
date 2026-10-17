/**
 * Fake Twilio Media Streams client. Connects to the plugin's stream
 * WebSocket like Twilio does, sends the party's audio as 20 ms mu-law frames
 * in real time, and plays the bot's audio through a simulated Twilio playout
 * buffer: real-time drain, `clear` empties it, `mark`s are echoed back when
 * playout reaches them (and immediately for cleared marks), as Twilio does.
 */
import { WebSocket } from "ws";
import { FRAME_SAMPLES, MULAW_SILENCE } from "./audio.ts";

type Item = { kind: "audio"; buf: Buffer; pos: number } | { kind: "mark"; name: string };

/** Twilio's outbound playout buffer, as a pure data structure. */
export class PlayoutBuffer {
  private items: Item[] = [];
  private bytes = 0;

  /** ms of bot audio queued but not yet played. */
  get bufferedMs(): number {
    return this.bytes / 8;
  }

  pushAudio(buf: Buffer): void {
    if (buf.length === 0) return;
    this.items.push({ kind: "audio", buf, pos: 0 });
    this.bytes += buf.length;
  }

  /**
   * Queue a mark behind the audio already buffered. Returns true when nothing
   * is buffered ahead of it, i.e. Twilio would echo it right away.
   */
  pushMark(name: string): boolean {
    if (this.items.length === 0) return true;
    this.items.push({ kind: "mark", name });
    return false;
  }

  /** Empty the buffer. Returns the marks that were pending (Twilio echoes them) and the ms dropped. */
  clear(): { marks: string[]; droppedMs: number; droppedAudibleMs: number } {
    const marks = this.items.filter((i) => i.kind === "mark").map((i) => (i as { name: string }).name);
    const droppedMs = this.bufferedMs;
    const droppedAudibleMs = this.audibleBufferedMs();
    this.items = [];
    this.bytes = 0;
    return { marks, droppedMs, droppedAudibleMs };
  }

  /** ms of queued audio that is audible (20 ms windows with real signal), i.e. speech a hangup would cut. */
  audibleBufferedMs(): number {
    const bytes = Buffer.concat(
      this.items.filter((i) => i.kind === "audio").map((i) => (i as { buf: Buffer; pos: number }).buf.subarray((i as { pos: number }).pos)),
    );
    let audible = 0;
    for (let off = 0; off < bytes.length; off += 160) {
      const win = bytes.subarray(off, off + 160);
      // mu-law: small magnitudes sit near 0xFF / 0x7F; a byte with (~b & 0x70) >= 0x30 is roughly |x| > 400.
      let loud = 0;
      for (const b of win) if (((~b & 0x7f) >> 4) >= 3) loud++;
      if (loud > win.length / 8) audible += win.length / 8;
    }
    return audible;
  }

  /** Play one 20 ms frame: returns the audio heard and the marks reached by the end of it. */
  pull(): { frame: Buffer; marks: string[]; audioBytes: number } {
    const frame = Buffer.alloc(FRAME_SAMPLES, MULAW_SILENCE);
    const marks: string[] = [];
    let filled = 0;
    const drainMarks = () => {
      while (this.items[0]?.kind === "mark") marks.push((this.items.shift() as { name: string }).name);
    };
    drainMarks();
    while (filled < FRAME_SAMPLES && this.items.length > 0) {
      const head = this.items[0];
      if (head.kind === "mark") {
        // A mark mid-frame: reached once the audio before it has played.
        marks.push(head.name);
        this.items.shift();
        continue;
      }
      const n = Math.min(FRAME_SAMPLES - filled, head.buf.length - head.pos);
      head.buf.copy(frame, filled, head.pos, head.pos + n);
      head.pos += n;
      filled += n;
      this.bytes -= n;
      if (head.pos >= head.buf.length) this.items.shift();
    }
    drainMarks();
    return { frame, marks, audioBytes: filled };
  }
}

export type FakeTwilioEvent = { type: string; [k: string]: unknown };

/** One Media Streams WebSocket connection, Twilio side. */
export class FakeTwilioStream {
  readonly playout = new PlayoutBuffer();
  private ws: WebSocket | null = null;
  private seq = 0;
  private chunk = 0;
  private closed = false;
  stats = { mediaIn: 0, bytesIn: 0, marksIn: 0, marksEchoed: 0, clears: 0, clearedMs: 0 };

  constructor(
    private readonly params: {
      url: string;
      callSid: string;
      streamSid: string;
      accountSid?: string;
      customParameters?: Record<string, string>;
      onEvent?: (ev: FakeTwilioEvent) => void;
      onClose?: (code: number, reason: string) => void;
    },
  ) {}

  get isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN && !this.closed;
  }

  async connect(): Promise<void> {
    const ws = new WebSocket(this.params.url);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.on("message", (data) => this.onMessage(data.toString()));
    ws.on("close", (code, reason) => {
      this.closed = true;
      this.params.onClose?.(code, reason.toString());
    });
    this.send({ event: "connected", protocol: "Call", version: "1.0.0" });
    this.send({
      event: "start",
      sequenceNumber: String(++this.seq),
      streamSid: this.params.streamSid,
      start: {
        streamSid: this.params.streamSid,
        accountSid: this.params.accountSid ?? "AC00000000000000000000000000000000",
        callSid: this.params.callSid,
        tracks: ["inbound"],
        customParameters: this.params.customParameters ?? {},
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
      },
    });
  }

  private send(msg: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onMessage(raw: string): void {
    let msg: { event?: string; media?: { payload?: string }; mark?: { name?: string } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.event) {
      case "media": {
        const buf = Buffer.from(msg.media?.payload ?? "", "base64");
        this.stats.mediaIn++;
        this.stats.bytesIn += buf.length;
        this.playout.pushAudio(buf);
        break;
      }
      case "mark": {
        const name = msg.mark?.name ?? "";
        this.stats.marksIn++;
        this.params.onEvent?.({ type: "mark_received", name, buffered_ms: this.playout.bufferedMs });
        if (this.playout.pushMark(name)) this.echoMark(name);
        break;
      }
      case "clear": {
        const { marks, droppedMs } = this.playout.clear();
        this.stats.clears++;
        this.stats.clearedMs += droppedMs;
        this.params.onEvent?.({ type: "clear", dropped_ms: droppedMs, marks });
        for (const m of marks) this.echoMark(m);
        break;
      }
      default:
        this.params.onEvent?.({ type: "unexpected_message", event: msg.event });
    }
  }

  echoMark(name: string): void {
    this.stats.marksEchoed++;
    this.params.onEvent?.({ type: "mark_echoed", name });
    this.send({ event: "mark", sequenceNumber: String(++this.seq), streamSid: this.params.streamSid, mark: { name } });
  }

  /** Play one frame of bot audio out of the buffer; echoes marks reached. */
  playFrame(): { frame: Buffer; audioBytes: number } {
    const { frame, marks, audioBytes } = this.playout.pull();
    for (const m of marks) this.echoMark(m);
    return { frame, audioBytes };
  }

  sendMedia(frame: Buffer, timestampMs: number): void {
    this.send({
      event: "media",
      sequenceNumber: String(++this.seq),
      streamSid: this.params.streamSid,
      media: { track: "inbound", chunk: String(++this.chunk), timestamp: String(Math.round(timestampMs)), payload: frame.toString("base64") },
    });
  }

  /** Twilio ends the stream (call over): `stop`, then close. Unplayed bot audio is lost. */
  stop(): { droppedMs: number; droppedAudibleMs: number } {
    const droppedMs = this.playout.bufferedMs;
    const droppedAudibleMs = this.playout.audibleBufferedMs();
    if (!this.closed) {
      this.send({
        event: "stop",
        sequenceNumber: String(++this.seq),
        streamSid: this.params.streamSid,
        stop: { accountSid: "AC00000000000000000000000000000000", callSid: this.params.callSid },
      });
      this.closed = true;
      this.ws?.close(1000, "call ended");
    }
    return { droppedMs, droppedAudibleMs };
  }
}
