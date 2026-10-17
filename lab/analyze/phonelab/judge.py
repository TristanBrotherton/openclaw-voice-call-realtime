"""LLM judge: a fixed rubric scored 1-5 per dimension. Tracked, never gating."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Optional

from .openai_api import ApiError, post_json

MODELS = ("gpt-5.4-mini", "gpt-4.1-mini")
# Approximate list prices, USD per 1M tokens (input, output). Used for the spend ledger only.
PRICES = {"gpt-5.4-mini": (0.75, 4.5), "gpt-4.1-mini": (0.4, 1.6)}
DIMENSIONS = ("pickup", "pacing", "filler_repetition", "tone", "recovery", "task_success")

RUBRIC = """You judge a phone call placed or answered by an AI voice assistant ("BOT") with a scripted other party ("PARTY").
You get the call's purpose, a timed transcript of what each side actually HEARD (times in seconds from answer),
and measured timing. Score each dimension from 1 (bad) to 5 (excellent):

- pickup: the opening. Waits for the other side (or the beep / end of a recorded greeting) before speaking,
  introduces itself and the purpose briefly and naturally; no talking over a greeting, no repeated openers.
- pacing: reply timing and length. Replies promptly (about 0.5-1.5 s), no long dead air, no rushing or
  talking over the party, turns are short enough for a phone call.
- filler_repetition: no needless filler ("one moment", "let me check") without reason, no repeating the same
  sentence or information, no restating what the party just said at length.
- tone: polite, natural, human-sounding phone manner suited to the situation; not robotic or over-apologetic.
- recovery: handles the unexpected (interruptions, silence, wrong person, menus, voicemail, screeners, bad
  line) sensibly. Score 5 if nothing unexpected happened and nothing went wrong.
- task_success: achieved the purpose (or did the right thing when it could not), confirmed key details, and
  ended the call cleanly with a complete goodbye.

Judge only what is in the transcript and timing. Be strict: 3 = acceptable with visible flaws.
Give a one-or-two sentence note naming the most important problem (or "clean" if none)."""

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {**{d: {"type": "integer"} for d in DIMENSIONS}, "note": {"type": "string"}},
    "required": list(DIMENSIONS) + ["note"],
}


def build_transcript(call, m: Dict, heard: Optional[Dict]) -> str:
    """Timed lines: PARTY from the scenario steps (what was played), BOT from the heard words."""
    from .inputs import steps_timeline

    items: List[tuple] = []
    for st in steps_timeline(call):
        spec = st["spec"]
        if st["kind"] == "say":
            items.append((st["start"], "PARTY", spec["say"]))
        elif st["kind"] == "play":
            items.append((st["start"], "PARTY", f"[{next(iter(spec['play']))} {round((st['end'] - st['start']) / 1000, 1)} s]"))
        elif st["kind"] == "wait":
            items.append((st["start"], "PARTY", f"[silent {round((st['end'] - st['start']) / 1000, 1)} s]"))
        elif st["kind"] == "hangup":
            items.append((st["start"], "PARTY", "[hangs up]"))
    words = (heard or {}).get("words")
    if words:
        # Group heard words into utterances on gaps > 700 ms.
        cur: List[dict] = []
        for w in words + [None]:
            if cur and (w is None or w["t_ms"] - cur[-1]["end_ms"] > 700):
                items.append((cur[0]["t_ms"], "BOT", " ".join(x["w"].strip() for x in cur)))
                cur = []
            if w is not None:
                cur.append(w)
    else:
        for t, text in call.bot_lines:
            items.append((t or 0, "BOT", text + " [plugin transcript; timing approximate]"))
    for d in m.get("dtmf") or []:
        items.append((d["t_ms"], "BOT", f"[presses key {d['key']}]"))
    items.sort(key=lambda x: x[0])
    lines = [f"{t / 1000:6.1f}  {who}: {text}" for t, who, text in items]
    lines.append(f"{call.duration_ms / 1000:6.1f}  [call ends; ended by {call.ended_by or '?'}]")
    return "\n".join(lines)


def judge(call, m: Dict, heard: Optional[Dict], key: str, cache: Optional[Path] = None) -> Dict:
    if cache and cache.exists():
        return json.loads(cache.read_text())
    sc = call.scenario or {}
    purpose = (sc.get("call") or {}).get("message") or ("inbound call" if sc.get("direction") == "inbound" else "unknown")
    timing = {k: m.get(k) for k in ("first_bot_audio_ms", "turn_latency_p50_ms", "turn_latency_max_ms", "dead_air_s",
                                    "talk_over_s", "bot_over_machine_s", "barge_in_yield_ms", "goodbye_complete")}
    user = (f"Direction: {sc.get('direction', '?')}. Situation: {sc.get('description', 'real call')}\n"
            f"Purpose given to the BOT: {purpose}\n"
            f"Tools the BOT called: {', '.join(call.tools_called()) or 'none'}\n"
            f"Measured timing: {json.dumps(timing)}\n\nTranscript (heard):\n{build_transcript(call, m, heard)}")
    last_err = None
    for model in MODELS:
        try:
            raw = post_json("responses", {
                "model": model,
                "input": [{"role": "system", "content": RUBRIC}, {"role": "user", "content": user}],
                "text": {"format": {"type": "json_schema", "name": "call_judgement", "schema": SCHEMA, "strict": True}},
            }, key)
        except ApiError as e:
            last_err = e
            if e.status in (400, 403, 404):
                continue
            raise
        text = _output_text(raw)
        scores = json.loads(text)
        for d in DIMENSIONS:
            scores[d] = min(5, max(1, int(scores[d])))
        usage = raw.get("usage") or {}
        pin, pout = PRICES.get(model, (1.0, 4.0))
        usd = (usage.get("input_tokens", 0) * pin + usage.get("output_tokens", 0) * pout) / 1e6
        res = {"model": model, "scores": {d: scores[d] for d in DIMENSIONS}, "note": scores.get("note", ""),
               "mean": round(sum(scores[d] for d in DIMENSIONS) / len(DIMENSIONS), 2), "usd": round(usd, 5)}
        if cache:
            cache.write_text(json.dumps(res, indent=1))
        return res
    raise last_err or RuntimeError("judge failed")


def _output_text(raw: Dict) -> str:
    if raw.get("output_text"):
        return raw["output_text"]
    for item in raw.get("output") or []:
        for c in item.get("content") or []:
            if c.get("type") in ("output_text", "text") and c.get("text"):
                return c["text"]
    raise ValueError("judge: no text in response")
