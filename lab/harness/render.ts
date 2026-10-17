/**
 * Render a scenario's party audio: `say` steps via OpenAI TTS (cached by hash
 * in the state dir), `play` steps from synthesized fixtures.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyGainDb, downsample24kTo8k, speechExtent, SAMPLE_RATE } from "./audio.ts";
import { beep, dtmfTones, holdMusic, mixInto, noise, silence } from "./fixtures.ts";
import { type Scenario, type Step, stepKind } from "./scenario.ts";

export const TTS_MODEL = "gpt-4o-mini-tts";
/** Approximate gpt-4o-mini-tts price per minute of rendered audio (cached clips are free). */
export const TTS_USD_PER_MIN = 0.015;

export type RenderedStep = {
  /** 8 kHz PCM16 to play (empty for wait/hangup). */
  pcm: Int16Array;
  /** Speech extent inside pcm (ms), for say steps only. */
  speech?: { start_ms: number; end_ms: number };
  durationMs: number;
};

export type RenderResult = { steps: RenderedStep[]; ttsUsd: number; cacheHits: number; rendered: number };

export async function renderTts(params: {
  text: string;
  voice: string;
  instructions?: string;
  speed?: number;
  apiKey: string;
  cacheDir: string;
}): Promise<{ pcm24: Int16Array; cached: boolean }> {
  const key = crypto
    .createHash("sha256")
    .update(JSON.stringify([TTS_MODEL, params.voice, params.text, params.instructions ?? "", params.speed ?? 1]))
    .digest("hex")
    .slice(0, 32);
  fs.mkdirSync(params.cacheDir, { recursive: true });
  const file = path.join(params.cacheDir, `${key}.pcm24`);
  if (fs.existsSync(file)) {
    const b = fs.readFileSync(file);
    return { pcm24: new Int16Array(b.buffer, b.byteOffset, b.length / 2).slice(), cached: true };
  }
  const body: Record<string, unknown> = {
    model: TTS_MODEL,
    voice: params.voice,
    input: params.text,
    response_format: "pcm",
  };
  if (params.instructions) body.instructions = params.instructions;
  if (params.speed) body.speed = params.speed;
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${params.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const b = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(file, b);
      return { pcm24: new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2)).slice(), cached: false };
    }
    lastErr = `${res.status} ${(await res.text()).slice(0, 200)}`;
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  throw new Error(`TTS failed: ${lastErr}`);
}

function ms(samples: number): number {
  return Math.round((samples / SAMPLE_RATE) * 1000);
}

export async function renderScenario(
  scenario: Scenario,
  opts: { apiKey: string; cacheDir: string },
): Promise<RenderResult> {
  const steps: RenderedStep[] = [];
  let ttsUsd = 0;
  let cacheHits = 0;
  let rendered = 0;
  for (const [i, step] of scenario.steps.entries()) {
    steps.push(await renderStep(step, i));
  }
  return { steps, ttsUsd, cacheHits, rendered };

  async function renderStep(step: Step, index: number): Promise<RenderedStep> {
    switch (stepKind(step)) {
      case "say": {
        const s = step as Extract<Step, { say: string }>;
        const { pcm24, cached } = await renderTts({
          text: s.say,
          voice: s.voice ?? "coral",
          instructions: s.instructions,
          speed: s.speed,
          apiKey: opts.apiKey,
          cacheDir: opts.cacheDir,
        });
        let pcm = downsample24kTo8k(pcm24);
        if (cached) cacheHits++;
        else {
          rendered++;
          ttsUsd += (pcm.length / SAMPLE_RATE / 60) * TTS_USD_PER_MIN;
        }
        // Trim TTS lead/tail silence to 60 ms so gates and timing refer to speech.
        const ext = speechExtent(pcm);
        if (ext) {
          const pad = Math.round(0.06 * SAMPLE_RATE);
          pcm = pcm.slice(Math.max(0, ext.startSample - pad), Math.min(pcm.length, ext.endSample + pad));
        }
        const clean = speechExtent(pcm);
        if (s.gain_db) pcm = applyGainDb(pcm, s.gain_db);
        if (s.noise_db !== undefined) mixInto(pcm, noise(ms(pcm.length) + 20, s.noise_db, 1000 + index));
        return {
          pcm,
          speech: clean ? { start_ms: ms(clean.startSample), end_ms: ms(clean.endSample) } : undefined,
          durationMs: ms(pcm.length),
        };
      }
      case "play": {
        const spec = (step as Extract<Step, { play: unknown }>).play;
        let pcm: Int16Array;
        if ("beep" in spec) {
          const b = spec.beep === true ? {} : spec.beep;
          pcm = beep(b.freq ?? 1000, b.ms ?? 450);
        } else if ("dtmf" in spec) pcm = dtmfTones(spec.dtmf);
        else if ("hold_music" in spec) pcm = holdMusic(spec.hold_music.ms);
        else if ("silence" in spec) pcm = silence(spec.silence.ms);
        else if ("noise" in spec) pcm = noise(spec.noise.ms, spec.noise.db ?? -40, 2000 + index);
        else throw new Error(`unknown play spec in step ${index + 1}`);
        return { pcm, durationMs: ms(pcm.length) };
      }
      case "wait": {
        const w = (step as Extract<Step, { wait_silence: number }>).wait_silence;
        return { pcm: new Int16Array(0), durationMs: w };
      }
      case "hangup":
        return { pcm: new Int16Array(0), durationMs: 0 };
    }
  }
}
