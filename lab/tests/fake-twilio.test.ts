import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { FRAME_SAMPLES, MULAW_SILENCE } from "../harness/audio.ts";
import { FakeTwilioStream, PlayoutBuffer } from "../harness/fake-twilio.ts";

const audio = (bytes: number, value = 0x10) => Buffer.alloc(bytes, value);

describe("PlayoutBuffer", () => {
  it("drains in real time, 160 bytes (20 ms) per frame, padding with silence", () => {
    const b = new PlayoutBuffer();
    b.pushAudio(audio(400));
    expect(b.bufferedMs).toBe(50);
    const f1 = b.pull();
    expect(f1.audioBytes).toBe(FRAME_SAMPLES);
    b.pull();
    const f3 = b.pull();
    expect(f3.audioBytes).toBe(80);
    expect(f3.frame[79]).toBe(0x10);
    expect(f3.frame[80]).toBe(MULAW_SILENCE);
    expect(b.bufferedMs).toBe(0);
    expect(b.pull().audioBytes).toBe(0);
  });

  it("echoes a mark only once the audio queued before it has played", () => {
    const b = new PlayoutBuffer();
    b.pushAudio(audio(320));
    expect(b.pushMark("m1")).toBe(false);
    b.pushAudio(audio(160));
    expect(b.pull().marks).toEqual([]);
    expect(b.pull().marks).toEqual(["m1"]);
    expect(b.pull().marks).toEqual([]);
  });

  it("a mark on an empty buffer is echoed at once", () => {
    expect(new PlayoutBuffer().pushMark("now")).toBe(true);
  });

  it("clear drops queued audio and returns pending marks", () => {
    const b = new PlayoutBuffer();
    b.pushAudio(audio(800));
    b.pushMark("a");
    b.pushAudio(audio(800));
    b.pushMark("b");
    b.pull();
    const res = b.clear();
    expect(res.marks).toEqual(["a", "b"]);
    expect(res.droppedMs).toBe(180);
    expect(b.bufferedMs).toBe(0);
    expect(b.pull().audioBytes).toBe(0);
  });
});

describe("FakeTwilioStream", () => {
  let wss: WebSocketServer | null = null;
  afterEach(async () => {
    await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()));
    wss = null;
  });

  async function setup() {
    wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((r) => wss!.once("listening", () => r()));
    const port = (wss.address() as { port: number }).port;
    const received: Array<Record<string, any>> = [];
    let server: WebSocket | null = null;
    const connected = new Promise<void>((resolve) =>
      wss!.on("connection", (ws) => {
        server = ws;
        ws.on("message", (d) => received.push(JSON.parse(d.toString())));
        resolve();
      }),
    );
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const s = new FakeTwilioStream({ url: `ws://127.0.0.1:${port}`, callSid: "CA1", streamSid: "MZ1", onEvent: (e) => events.push(e) });
    await s.connect();
    await connected;
    const send = (m: unknown) => server!.send(JSON.stringify(m));
    const settle = () => new Promise((r) => setTimeout(r, 30));
    return { s, received, events, send, settle };
  }

  it("sends connected + start, then media frames like Twilio", async () => {
    const { s, received, settle } = await setup();
    s.sendMedia(Buffer.alloc(160, MULAW_SILENCE), 0);
    await settle();
    expect(received.map((m) => m.event)).toEqual(["connected", "start", "media"]);
    expect(received[1].start.callSid).toBe("CA1");
    expect(received[2].media.track).toBe("inbound");
    s.stop();
  });

  it("plays bot media, echoes marks at playout, and on clear echoes pending marks immediately", async () => {
    const { s, received, events, send, settle } = await setup();
    send({ event: "media", streamSid: "MZ1", media: { payload: audio(320).toString("base64") } });
    send({ event: "mark", streamSid: "MZ1", mark: { name: "after-two-frames" } });
    send({ event: "media", streamSid: "MZ1", media: { payload: audio(1600).toString("base64") } });
    send({ event: "mark", streamSid: "MZ1", mark: { name: "pending" } });
    await settle();
    expect(s.playout.bufferedMs).toBe(240);
    s.playFrame();
    await settle();
    expect(received.filter((m) => m.event === "mark")).toHaveLength(0);
    s.playFrame();
    await settle();
    expect(received.filter((m) => m.event === "mark").map((m) => m.mark.name)).toEqual(["after-two-frames"]);
    send({ event: "clear", streamSid: "MZ1" });
    await settle();
    expect(received.filter((m) => m.event === "mark").map((m) => m.mark.name)).toEqual(["after-two-frames", "pending"]);
    const clear = events.find((e) => e.type === "clear");
    expect(clear?.dropped_ms).toBe(200);
    expect(s.playout.bufferedMs).toBe(0);
    const stop = s.stop();
    expect(stop.droppedMs).toBe(0);
    await settle();
    expect(received.at(-1)?.event).toBe("stop");
  });
});
