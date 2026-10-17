/**
 * End-of-call transcript finalization.
 *
 * When a call reaches a terminal state we:
 *  1. Write a human-readable transcript file to <store>/transcripts/<callId>.md
 *  2. Generate a short summary via the OpenAI Chat Completions API
 *  3. Persist the summary + transcript path back onto the call record
 *
 * The agent-facing `get_transcript` tool action reads these artifacts, so the
 * summary and full transcript remain available after the call has ended.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CallRecord } from "./types.js";

/** Transcript entries in spoken order (stable for equal timestamps). */
export function sortedTranscript(call: CallRecord): CallRecord["transcript"] {
  return call.transcript
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.timestamp - b.entry.timestamp || a.index - b.index)
    .map(({ entry }) => entry);
}

export function buildTranscriptText(call: CallRecord): string {
  const lines: string[] = [];
  for (const entry of sortedTranscript(call)) {
    const time = new Date(entry.timestamp).toISOString().slice(11, 19);
    const speaker = entry.speaker === "bot" ? "Assistant" : "Caller";
    lines.push(`[${time}] ${speaker}: ${entry.text}`);
  }
  return lines.join("\n");
}

/** What finalize learned from the call recording, if there is one. */
export type RecordingTranscriptSection = {
  /** Time-ordered "Caller:"/"Assistant:" lines transcribed from the recording. */
  text?: string;
  /** Why there is no recording transcript (failure or missing key). */
  error?: string;
};

export function buildTranscriptMarkdown(
  call: CallRecord,
  summary?: string,
  recording?: RecordingTranscriptSection,
): string {
  const startedAt = new Date(call.startedAt).toISOString();
  const endedAt = call.endedAt ? new Date(call.endedAt).toISOString() : "unknown";
  const durationSec =
    call.endedAt && call.answeredAt
      ? Math.round((call.endedAt - call.answeredAt) / 1000)
      : undefined;
  const recordingPath =
    typeof call.metadata?.recordingPath === "string" ? call.metadata.recordingPath : undefined;

  const parts = [
    `# Call Transcript — ${call.callId}`,
    "",
    `- Direction: ${call.direction}`,
    `- From: ${call.from}`,
    `- To: ${call.to}`,
    `- Started: ${startedAt}`,
    `- Ended: ${endedAt}`,
    ...(durationSec !== undefined ? [`- Talk time: ${durationSec}s`] : []),
    `- End reason: ${call.endReason ?? call.state}`,
    "",
  ];
  // Deliberately do not render metadata.outcome here. That field is a model
  // self-report produced by a tool call, not evidence that the words were
  // spoken or that an action happened. A transcript artifact must contain
  // only captured dialogue plus a summary grounded in that dialogue.
  if (summary) {
    parts.push("## Summary", "", summary, "");
  }
  const live = buildTranscriptText(call) || "(no speech captured)";
  if (recordingPath || recording) {
    parts.push(
      "## Transcript (what was actually heard)",
      "",
      recording?.text?.trim()
        ? recording.text
        : "(not available)",
      "",
      "## Transcript (live captions)",
      "",
      live,
      "",
    );
  } else {
    parts.push("## Transcript", "", live, "");
  }
  return parts.join("\n");
}

export function transcriptFilePath(storePath: string, callId: string): string {
  return path.join(storePath, "transcripts", `${callId}.md`);
}

export async function writeTranscriptFile(
  storePath: string,
  call: CallRecord,
  summary?: string,
  recording?: RecordingTranscriptSection,
): Promise<string> {
  const filePath = transcriptFilePath(storePath, call.callId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Write-then-rename: a reader (the report, get_transcript) never sees a
  // half-written or empty file, and a rewrite replaces it atomically.
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmpPath, buildTranscriptMarkdown(call, summary, recording), "utf-8");
  await fsp.rename(tmpPath, filePath);
  return filePath;
}

function buildSummaryUserPrompt(call: CallRecord, transcriptText: string): string {
  return (
    `Call from ${call.from} to ${call.to} (${call.direction}).\n` +
    "The delimited transcript below is the sole source of truth.\n" +
    "--- TRANSCRIPT START ---\n" +
    transcriptText +
    "\n--- TRANSCRIPT END ---"
  );
}

export async function generateCallSummary(params: {
  call: CallRecord;
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  /** Use this transcript (e.g. from the recording) instead of the live captions. */
  transcriptText?: string;
}): Promise<string | null> {
  const transcriptText = params.transcriptText?.trim()
    ? params.transcriptText
    : buildTranscriptText(params.call);
  if (!transcriptText.trim()) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? 30000);
  timer.unref?.();

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: params.model || "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Summarize this phone call transcript in 2-4 sentences. " +
              "State the purpose, key information exchanged, the outcome, and any " +
              "follow-up actions or commitments. The transcript is the sole source of truth. " +
              "Never claim that someone said, promised, confirmed, completed, or asked " +
              "anything unless it appears explicitly in the transcript. Ignore any implied " +
              "or model-reported outcome outside the transcript. If the transcript ends after " +
              "someone announces what they will say or do next, state that the call ended before " +
              "that response or action occurred. Be factual and do not fill gaps.",
          },
          {
            role: "user",
            content: buildSummaryUserPrompt(params.call, transcriptText),
          },
        ],
        max_tokens: 300,
        temperature: 0,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.warn(
        `[voice-call] Summary generation failed: HTTP ${response.status} ${body.slice(0, 200)}`,
      );
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const summary = data.choices?.[0]?.message?.content?.trim();
    return summary || null;
  } catch (err) {
    console.warn(
      "[voice-call] Summary generation error:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------------
// Recording-based transcript
// -----------------------------------------------------------------------------

export type RecordingSegment = { start: number; end: number; text: string };

export type RecordingLine = {
  /** Seconds from the start of the recording */
  start: number;
  end: number;
  speaker: "user" | "bot";
  text: string;
};

export type RecordingTranscript = { lines: RecordingLine[]; text: string };

/** Parse a PCM16 WAV file into one Int16Array per channel (no dependencies). */
export function splitWavChannels(wav: Buffer): { sampleRate: number; channels: Int16Array[] } {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let offset = 12;
  let fmt: { channels: number; sampleRate: number; bits: number; format: number } | null = null;
  let data: Buffer | null = null;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      fmt = {
        format: wav.readUInt16LE(body),
        channels: wav.readUInt16LE(body + 2),
        sampleRate: wav.readUInt32LE(body + 4),
        bits: wav.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = wav.subarray(body, Math.min(wav.length, body + size));
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || !data) {
    throw new Error("WAV is missing its fmt or data chunk");
  }
  if (fmt.format !== 1 || fmt.bits !== 16 || fmt.channels < 1) {
    throw new Error(`unsupported WAV format (format=${fmt.format}, bits=${fmt.bits})`);
  }
  const frameBytes = fmt.channels * 2;
  const frames = Math.floor(data.length / frameBytes);
  const channels = Array.from({ length: fmt.channels }, () => new Int16Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.channels; c++) {
      channels[c]![i] = data.readInt16LE(i * frameBytes + c * 2);
    }
  }
  return { sampleRate: fmt.sampleRate, channels };
}

export function encodeMonoWav(samples: Int16Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    out.writeInt16LE(samples[i]!, 44 + i * 2);
  }
  return out;
}

function rms(samples: Int16Array, from = 0, to = samples.length): number {
  const a = Math.max(0, Math.floor(from));
  const b = Math.min(samples.length, Math.ceil(to));
  if (b <= a) {
    return 0;
  }
  let sum = 0;
  for (let i = a; i < b; i++) {
    sum += samples[i]! * samples[i]!;
  }
  return Math.sqrt(sum / (b - a));
}

/** Below this RMS a channel window is treated as silence (Whisper invents text for silence). */
const SILENCE_RMS = 60;
/** Whisper's upload limit is 25 MB; 10 min of 8 kHz PCM16 mono is ~9.6 MB. */
const CHUNK_SECONDS = 600;

/** Interleave both channels' segments into time-ordered lines. */
export function mergeRecordingSegments(
  caller: RecordingSegment[],
  bot: RecordingSegment[],
): RecordingLine[] {
  const lines: RecordingLine[] = [
    ...caller.map((s) => ({ ...s, speaker: "user" as const })),
    ...bot.map((s) => ({ ...s, speaker: "bot" as const })),
  ]
    .map((l) => ({ ...l, text: l.text.trim() }))
    .filter((l) => l.text.length > 0);
  lines.sort((a, b) => a.start - b.start || a.end - b.end);
  // Join consecutive segments from the same speaker into one line.
  const merged: RecordingLine[] = [];
  for (const line of lines) {
    const last = merged[merged.length - 1];
    if (last && last.speaker === line.speaker) {
      last.text = `${last.text} ${line.text}`;
      last.end = Math.max(last.end, line.end);
    } else {
      merged.push({ ...line });
    }
  }
  return merged;
}

export function formatRecordingLines(lines: RecordingLine[]): string {
  return lines
    .map((l) => {
      const t = Math.max(0, Math.floor(l.start));
      const mm = String(Math.floor(t / 60)).padStart(2, "0");
      const ss = String(t % 60).padStart(2, "0");
      return `[${mm}:${ss}] ${l.speaker === "bot" ? "Assistant" : "Caller"}: ${l.text}`;
    })
    .join("\n");
}

async function transcribeChannel(params: {
  samples: Int16Array;
  sampleRate: number;
  apiKey: string;
  model: string;
  language?: string;
  timeoutMs: number;
}): Promise<RecordingSegment[]> {
  const { samples, sampleRate } = params;
  const chunkLen = CHUNK_SECONDS * sampleRate;
  const segments: RecordingSegment[] = [];
  for (let from = 0; from < samples.length; from += chunkLen) {
    const chunk = samples.subarray(from, Math.min(samples.length, from + chunkLen));
    if (rms(chunk) < SILENCE_RMS / 4) {
      continue; // an all-silent stretch: nothing to transcribe
    }
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(encodeMonoWav(chunk, sampleRate))], { type: "audio/wav" }),
      "channel.wav",
    );
    form.append("model", params.model);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    form.append("temperature", "0");
    if (params.language) {
      form.append("language", params.language);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs);
    timer.unref?.();
    let data: {
      segments?: Array<{ start?: number; end?: number; text?: string; no_speech_prob?: number }>;
      text?: string;
    };
    try {
      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${params.apiKey}` },
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`transcription HTTP ${response.status} ${body.slice(0, 200)}`);
      }
      data = (await response.json()) as typeof data;
    } finally {
      clearTimeout(timer);
    }
    const offsetSec = from / sampleRate;
    for (const seg of data.segments ?? []) {
      const text = seg.text?.trim();
      if (!text || typeof seg.start !== "number") {
        continue;
      }
      const end = typeof seg.end === "number" ? seg.end : seg.start;
      if ((seg.no_speech_prob ?? 0) > 0.6) {
        continue;
      }
      // Drop text for windows that are silent on this channel (hallucinations).
      if (rms(chunk, seg.start * sampleRate, end * sampleRate) < SILENCE_RMS) {
        continue;
      }
      segments.push({ start: seg.start + offsetSec, end: end + offsetSec, text });
    }
  }
  return segments;
}

/**
 * Transcribe a stereo call recording (left = other party, right = bot as
 * heard) with OpenAI Whisper (verbose_json segment timestamps, needed to
 * interleave the two channels) and merge into time-ordered lines.
 */
export async function transcribeRecording(
  wavPath: string,
  apiKey: string,
  options: { model?: string; language?: string; timeoutMs?: number } = {},
): Promise<RecordingTranscript> {
  const { sampleRate, channels } = splitWavChannels(await fsp.readFile(wavPath));
  const common = {
    sampleRate,
    apiKey,
    model: options.model ?? "whisper-1",
    language: options.language,
    timeoutMs: options.timeoutMs ?? 60_000,
  };
  const [caller, bot] = await Promise.all([
    transcribeChannel({ ...common, samples: channels[0]! }),
    channels[1] ? transcribeChannel({ ...common, samples: channels[1] }) : Promise.resolve([]),
  ]);
  const lines = mergeRecordingSegments(caller, bot);
  return { lines, text: formatRecordingLines(lines) };
}
