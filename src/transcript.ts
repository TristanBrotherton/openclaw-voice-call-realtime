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

export function buildTranscriptText(call: CallRecord): string {
  const lines: string[] = [];
  for (const entry of call.transcript) {
    const time = new Date(entry.timestamp).toISOString().slice(11, 19);
    const speaker = entry.speaker === "bot" ? "Assistant" : "Caller";
    lines.push(`[${time}] ${speaker}: ${entry.text}`);
  }
  return lines.join("\n");
}

export function buildTranscriptMarkdown(call: CallRecord, summary?: string): string {
  const startedAt = new Date(call.startedAt).toISOString();
  const endedAt = call.endedAt ? new Date(call.endedAt).toISOString() : "unknown";
  const durationSec =
    call.endedAt && call.answeredAt
      ? Math.round((call.endedAt - call.answeredAt) / 1000)
      : undefined;

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
  const outcome = call.metadata?.outcome as { status?: string; details?: string } | undefined;
  if (outcome?.details) {
    parts.push("## Reported Outcome", "", `**${outcome.status ?? "unknown"}** — ${outcome.details}`, "");
  }
  if (summary) {
    parts.push("## Summary", "", summary, "");
  }
  parts.push("## Transcript", "", buildTranscriptText(call) || "(no speech captured)", "");
  return parts.join("\n");
}

export function transcriptFilePath(storePath: string, callId: string): string {
  return path.join(storePath, "transcripts", `${callId}.md`);
}

export async function writeTranscriptFile(
  storePath: string,
  call: CallRecord,
  summary?: string,
): Promise<string> {
  const filePath = transcriptFilePath(storePath, call.callId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, buildTranscriptMarkdown(call, summary), "utf-8");
  return filePath;
}

function buildSummaryUserPrompt(call: CallRecord, transcriptText: string): string {
  const outcome = call.metadata?.outcome as { status?: string; details?: string } | undefined;
  const outcomeLine = outcome?.details
    ? `\nOutcome reported by the assistant during the call: [${outcome.status ?? "unknown"}] ${outcome.details}\n`
    : "";
  return `Call from ${call.from} to ${call.to} (${call.direction}).${outcomeLine}\n${transcriptText}`;
}

export async function generateCallSummary(params: {
  call: CallRecord;
  apiKey: string;
  model?: string;
  timeoutMs?: number;
}): Promise<string | null> {
  const transcriptText = buildTranscriptText(params.call);
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
              "follow-up actions or commitments. Be factual; do not invent details.",
          },
          {
            role: "user",
            content: buildSummaryUserPrompt(params.call, transcriptText),
          },
        ],
        max_tokens: 300,
        temperature: 0.2,
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
