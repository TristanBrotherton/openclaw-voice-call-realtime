import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sockets: FakeWs[] = [];

class FakeWs extends EventEmitter {
  static OPEN = 1;
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  constructor() {
    super();
    sockets.push(this);
  }
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }
  drop(code = 1006): void {
    this.readyState = 3;
    this.emit("close", code, Buffer.from(""));
  }
  serverEvent(event: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(event)));
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.readyState = 3;
  }
  terminate(): void {
    this.readyState = 3;
  }
}

vi.mock("ws", () => ({ default: FakeWs }));

const { OpenAIRealtimeConversationProvider } = await import("./openai-realtime-conversation.js");

function newSession() {
  return new OpenAIRealtimeConversationProvider({ apiKey: "test-key" }).createSession();
}

beforeEach(() => {
  sockets.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("interrupted bot lines", () => {
  it("emits the partial transcript of a cancelled response with [interrupted]", async () => {
    const session = newSession();
    const lines: string[] = [];
    session.onResponseTranscriptDone((t) => lines.push(t));
    const connecting = session.connect();
    sockets[0]!.open();
    await connecting;

    const ws = sockets[0]!;
    ws.serverEvent({ type: "response.created" });
    ws.serverEvent({ type: "response.output_audio_transcript.delta", delta: "Your appointment " });
    ws.serverEvent({ type: "response.output_audio_transcript.delta", delta: "is on" });
    ws.serverEvent({ type: "input_audio_buffer.speech_started" });
    expect(ws.sent.some((e) => e.type === "response.cancel")).toBe(true);
    ws.serverEvent({ type: "response.done", response: { status: "cancelled" } });

    expect(lines).toEqual(["Your appointment is on [interrupted]"]);

    // A normal completed response is unaffected.
    ws.serverEvent({ type: "response.created" });
    ws.serverEvent({ type: "response.output_audio_transcript.delta", delta: "Hi" });
    ws.serverEvent({ type: "response.output_audio_transcript.done", transcript: "Hi there." });
    ws.serverEvent({ type: "response.done", response: { status: "completed" } });
    expect(lines).toEqual(["Your appointment is on [interrupted]", "Hi there."]);
    session.close();
  });

  it("flushes an orphaned partial on the next speech start", async () => {
    const session = newSession();
    const lines: string[] = [];
    session.onResponseTranscriptDone((t) => lines.push(t));
    const connecting = session.connect();
    sockets[0]!.open();
    await connecting;
    const ws = sockets[0]!;
    ws.serverEvent({ type: "response.created" });
    ws.serverEvent({ type: "response.output_audio_transcript.delta", delta: "Half a sentence" });
    ws.serverEvent({ type: "response.done", response: { status: "incomplete" } });
    ws.serverEvent({ type: "input_audio_buffer.speech_started" });
    expect(lines).toEqual(["Half a sentence [interrupted]"]);
    session.close();
  });
});

describe("reconnect limit", () => {
  it("gives up when sockets keep dropping right after opening", async () => {
    vi.useFakeTimers();
    const session = newSession();
    const failures: string[] = [];
    session.onFailure((r) => failures.push(r));
    const connecting = session.connect();
    sockets[0]!.open();
    await connecting;

    for (let i = 0; i < 5; i++) {
      sockets[sockets.length - 1]!.drop();
      await vi.advanceTimersByTimeAsync(1000 * 2 ** i); // backoff, then a new socket
      expect(sockets).toHaveLength(i + 2);
      sockets[sockets.length - 1]!.open();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(failures).toEqual([]);
    sockets[sockets.length - 1]!.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(failures).toEqual(["reconnect_exhausted"]);
    session.close();
  });

  it("resets the attempt counter after a session stayed up 30 s", async () => {
    vi.useFakeTimers();
    const session = newSession();
    const failures: string[] = [];
    session.onFailure((r) => failures.push(r));
    const connecting = session.connect();
    sockets[0]!.open();
    await connecting;

    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(31_000); // stable for > 30 s
      sockets[sockets.length - 1]!.drop();
      await vi.advanceTimersByTimeAsync(1_000);
      sockets[sockets.length - 1]!.open();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(failures).toEqual([]);
    expect(sockets).toHaveLength(11);
    session.close();
  });
});
