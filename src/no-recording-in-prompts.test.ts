import fs from "node:fs";
import { describe, expect, it } from "vitest";

// Call recordings are for the operator's debugging only. Nothing the voice
// model or the OpenClaw agent reads (prompts, tool descriptions, tool results,
// the post-call report, the transcript file) may mention them, so a call can
// never bring them up. Log lines are fine.
const FILES = [
  "webhook.ts",
  "providers/gpt-live-conversation.ts",
  "providers/openai-realtime-conversation.ts",
  "assistant-bridge.ts",
  "transcript.ts",
  "device-policy.ts",
  "menu-router.ts",
];

function stringLiterals(src: string): string[] {
  return [...src.matchAll(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)].map((m) => m[0]);
}

describe("prompts never mention call recording", () => {
  for (const file of FILES) {
    it(file, () => {
      const src = fs.readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      const offending = stringLiterals(src).filter(
        (s) => /\brecord(ing|ings|ed)?\b/i.test(s) && !/^["`]\[(voice-call|MediaStream|GptLive|RealtimeConversation)\]/.test(s),
      );
      expect(offending).toEqual([]);
    });
  }
});
