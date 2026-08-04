/**
 * Fast local memory recall for the ask_assistant in-call tool.
 *
 * Modeled on upstream OpenClaw's realtime fast-context resolver: before
 * launching a full agent bridge turn (10-40s), grep the local OpenClaw
 * workspace memory files and, on a hit, hand the bounded lines straight to
 * the voice model (~instant). A miss falls through to the full bridge; a hit
 * that turns out not to answer the question escalates via ask_assistant's
 * escalate flag — so the slow path is never lost, only deferred.
 *
 * Offered ONLY on verified first-party / trusted-contact calls: this is a
 * judgment-free path into the owner's memory, so it must never be reachable
 * from third-party or unverified calls (same invariant as the Home Assistant
 * tools).
 */
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type FastRecallConfig = {
  enabled: boolean;
  maxLines: number;
  workspaceDir?: string;
};

const MAX_LINE_CHARS = 300;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_DAILY_FILES = 30;
const MIN_TERM_LENGTH = 3;

export function resolveWorkspaceDir(config: FastRecallConfig): string {
  return config.workspaceDir || join(homedir(), ".openclaw", "workspace");
}

/**
 * Deterministic recall: grep MEMORY.md and the most recent daily/person
 * memory files. The filename counts toward the match so person-files
 * (grandma.md) rank their detail lines above incidental mentions elsewhere.
 */
export function searchLocalMemory(query: string, config: FastRecallConfig): string[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9+]+/)
    .filter((t) => t.length >= MIN_TERM_LENGTH);
  if (!terms.length) {
    return [];
  }
  const workspace = resolveWorkspaceDir(config);
  const files = [join(workspace, "MEMORY.md")];
  try {
    const dailies = readdirSync(join(workspace, "memory"))
      .filter((f) => f.endsWith(".md"))
      .sort()
      .slice(-MAX_DAILY_FILES);
    files.push(...dailies.map((f) => join(workspace, "memory", f)));
  } catch {
    // no memory dir — MEMORY.md alone may still hit
  }
  const scored: Array<{ hits: number; line: string; src: string }> = [];
  for (const file of files) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (text.length > MAX_FILE_BYTES) {
      continue;
    }
    const fname = file.split("/").pop()?.toLowerCase() ?? "";
    for (const line of text.split("\n")) {
      const l = `${line.toLowerCase()} ${fname}`;
      const hits = terms.filter((t) => l.includes(t)).length;
      if (hits > 0 && line.trim().length > 3) {
        scored.push({ hits, line: line.trim().slice(0, MAX_LINE_CHARS), src: fname });
      }
    }
  }
  scored.sort((x, y) => y.hits - x.hits);
  // Bounded and deduped: every line lands in the realtime model's context,
  // and a spoken answer only ever uses a couple of them.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of scored) {
    if (seen.has(m.line)) {
      continue;
    }
    seen.add(m.line);
    out.push(`[${m.src}] ${m.line}`);
    if (out.length >= config.maxLines) {
      break;
    }
  }
  return out;
}

/** Tool reply carrying fast-recall hits plus escalation guidance. */
export function buildFastRecallReply(question: string, lines: string[]): string {
  return [
    "Quick memory lookup (internal — never read these lines aloud verbatim):",
    lines.join("\n"),
    `Question was: ${question}`,
    "If these lines answer the question, answer naturally from them now — no " +
      "need to mention any lookup. If they do NOT answer it, call " +
      "ask_assistant again with escalate set to true to ask the full " +
      "assistant (that takes 10-40 seconds — tell the other party you need " +
      "a moment first).",
  ].join("\n\n");
}
