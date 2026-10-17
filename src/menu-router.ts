/**
 * Phone-menu router for GPT-Live calls.
 *
 * GPT-Live's voice decides on its own when to delegate, and in the lab it
 * talked to phone menus instead of delegating a keypress. Like the Voice PE
 * router (voicepe-realtime app/live_router.py), the app watches what the other
 * side says: when it sounds like a menu ("press 1 for…"), a small fast model
 * picks the key for the call's goal, the app presses it, and the voice is told
 * quietly what was pressed.
 */

const MENU_PATTERN =
  /\b(press|dial|enter|say)\s+(?:the\s+)?(?:\d|one|two|three|four|five|six|seven|eight|nine|zero|star|pound|hash)\b|\bfor\b.{0,40}\bpress\b/i;

/** Does this utterance look like an automated phone-menu prompt? */
export function looksLikeMenu(text: string): boolean {
  return MENU_PATTERN.test(text);
}

export type MenuDecision = { digits: string | null; reason: string };

export async function chooseMenuKeys(params: {
  apiKey: string;
  menuText: string;
  goal: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<MenuDecision> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const res = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${params.apiKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(params.timeoutMs ?? 6000),
    body: JSON.stringify({
      model: params.model ?? "gpt-4.1-mini",
      max_output_tokens: 60,
      input: [
        {
          role: "system",
          content:
            "You navigate automated phone menus for a caller. Given the caller's goal and what the " +
            "menu just said, answer with JSON only: {\"digits\": \"<keys to press, 0-9 * #>\" or null, " +
            "\"reason\": \"<few words>\"}. Choose the option that best serves the goal; if an option " +
            "reaches a person (operator, front desk, reservations) and nothing matches better, choose " +
            "it. Use null when the menu has not offered a choice yet or asks for something the caller " +
            "does not have (account numbers, PINs).",
        },
        { role: "user", content: `Goal: ${params.goal}\nMenu said: ${params.menuText}` },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`menu router: HTTP ${res.status}`);
  }
  const json = (await res.json()) as { output?: Array<{ content?: Array<{ text?: string }> }> };
  const text = json.output?.flatMap((o) => o.content ?? []).map((c) => c.text ?? "").join("") ?? "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return { digits: null, reason: "no decision" };
  }
  try {
    const parsed = JSON.parse(match[0]) as { digits?: unknown; reason?: unknown };
    const digits = typeof parsed.digits === "string" && /^[0-9*#]{1,8}$/.test(parsed.digits) ? parsed.digits : null;
    return { digits, reason: String(parsed.reason ?? "") };
  } catch {
    return { digits: null, reason: "unparseable" };
  }
}
