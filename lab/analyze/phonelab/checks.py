"""Scenario expectations -> passed + reasons (+ which failures are budget breaches)."""
from __future__ import annotations

import re
from typing import Dict, List, Optional

from .audio import overlap_ms
from .inputs import Call, steps_timeline


VM_START_BUDGET_MS = 4000


def _said(rx: str, text: str) -> bool:
    return re.search(rx, text, re.I) is not None


def run_checks(call: Call, m: Dict, heard: Optional[Dict], alignment: Optional[Dict]) -> Dict:
    reasons: List[str] = []
    budget: List[str] = []
    notes: List[str] = []
    sc = call.scenario or {}
    exp = sc.get("expect") or {}
    steps = steps_timeline(call)
    bot = m["_segments"]["bot"]
    words = (heard or {}).get("words")
    using_generated = words is None

    def bot_text(lo: int, hi: int) -> str:
        if words is not None:
            return " ".join(w["w"] for w in words if lo <= w["t_ms"] < hi)
        # Fallback: generated lines; their timestamps mark when the line was final, so widen the window.
        return " ".join(t for ts, t in call.bot_lines if ts is not None and lo <= ts < hi + 4000)

    all_text = bot_text(0, 10 ** 9)
    if using_generated:
        notes.append("phrase checks used the plugin's transcript (no whisper)")

    if call.meta.get("error"):
        reasons.append("harness error: " + str(call.meta["error"]).splitlines()[0][:160])

    eb = exp.get("ended_by")
    if eb and eb != "any":
        actual = call.ended_by
        if actual != eb:
            reasons.append(f"ended_by {actual or '?'} (expected {eb})")
    elif eb == "any" and call.ended_by in ("max_duration", "harness_error", ""):
        reasons.append(f"ended_by {call.ended_by or '?'}")

    tools = call.tools_called()
    for t in exp.get("tools_called") or []:
        if t not in tools:
            reasons.append(f"tool {t} not called")
    for t in exp.get("tools_not_called") or []:
        if t in tools:
            reasons.append(f"tool {t} called")

    if exp.get("no_audio_before_party_speech") and (m.get("bot_audio_before_party_speech_ms") or 0) > 100:
        reasons.append(f"bot audio before the other side spoke ({m['bot_audio_before_party_speech_ms']} ms)")

    for rx in exp.get("heard_any") or []:
        if not _said(rx, all_text):
            reasons.append(f"never heard /{rx}/")
    for rx in exp.get("heard_none") or []:
        if _said(rx, all_text):
            reasons.append(f"heard /{rx}/")

    if exp.get("voicemail"):
        if m.get("vm_bot_during_greeting_s") is None:
            reasons.append("voicemail: no greeting in timeline")
        else:
            if m["vm_bot_during_greeting_s"] > 0:
                reasons.append(f"voicemail: bot spoke {m['vm_bot_during_greeting_s']} s during the greeting")
            if m.get("vm_message_start_ms") is None:
                reasons.append("voicemail: no message after the beep")
            elif m["vm_message_start_ms"] > VM_START_BUDGET_MS:
                r = f"voicemail: message started {m['vm_message_start_ms'] / 1000:.1f} s after the beep (> {VM_START_BUDGET_MS / 1000:.0f} s)"
                reasons.append(r)
                budget.append(r)
            elif not m.get("vm_message_complete"):
                reasons.append("voicemail: message not complete before hangup")

    gb = m.get("goodbye_complete")
    if exp.get("goodbye_complete") and gb is False:
        reasons.append("goodbye cut off" + (f" ({m.get('goodbye_note')})" if m.get("goodbye_note") else ""))

    if exp.get("max_dead_air_s") is not None and m["dead_air_s"] > exp["max_dead_air_s"]:
        r = f"dead air {m['dead_air_s']} s > {exp['max_dead_air_s']} s"
        reasons.append(r)
        budget.append(r)
    if exp.get("max_talk_over_s") is not None and m["talk_over_s"] > exp["max_talk_over_s"]:
        r = f"talk-over {m['talk_over_s']} s > {exp['max_talk_over_s']} s"
        reasons.append(r)
        budget.append(r)
    if exp.get("max_turn_latency_ms") is not None and (m.get("turn_latency_max_ms") or 0) > exp["max_turn_latency_ms"]:
        r = f"turn latency {m['turn_latency_max_ms']} ms > {exp['max_turn_latency_ms']} ms"
        reasons.append(r)
        budget.append(r)
    if exp.get("no_plugin_errors"):
        errs = call.plugin_errors()
        if errs:
            reasons.append(f"{len(errs)} plugin error line(s): {errs[0][:100]}")

    # --- per-step expectations ------------------------------------------------------
    turns = {t["step"]: t for t in m.get("turns") or []}
    yields = {y["step"]: y for y in m.get("barge_in") or []}
    for st in steps:
        e = st["expect"]
        if not e:
            continue
        sid = st["id"]
        win = bot_text(st["start"], st["next_start"])
        if e.get("bot_says") and not _said(e["bot_says"], win):
            reasons.append(f"{sid}: bot did not say /{e['bot_says']}/")
        if e.get("bot_not_says") and _said(e["bot_not_says"], win):
            reasons.append(f"{sid}: bot said /{e['bot_not_says']}/")
        if e.get("bot_silent"):
            ov = overlap_ms(bot, [(st["start"], st["end"])])
            if ov > 100:
                reasons.append(f"{sid}: bot spoke {ov / 1000:.1f} s over it")
        if e.get("dtmf"):
            pressed = "".join(d["key"] for d in m.get("dtmf") or [] if st["start"] <= d["t_ms"] < st["next_start"])
            if e["dtmf"] not in pressed:
                reasons.append(f"{sid}: keys {pressed or 'none'} (expected {e['dtmf']})")
        if e.get("max_reply_ms") is not None:
            t = turns.get(sid)
            lat = t and t.get("latency_ms")
            if lat is None:
                r = f"{sid}: no reply"
                reasons.append(r)
                budget.append(r)
            elif lat > e["max_reply_ms"]:
                r = f"{sid}: reply after {lat} ms > {e['max_reply_ms']}"
                reasons.append(r)
                budget.append(r)
        if e.get("max_yield_ms") is not None:
            y = yields.get(sid)
            if y and y["yield_ms"] > e["max_yield_ms"]:
                r = f"{sid}: yielded after {y['yield_ms']} ms > {e['max_yield_ms']}"
                reasons.append(r)
                budget.append(r)
            elif y and not y["bot_was_speaking"]:
                notes.append(f"{sid}: bot was not speaking at the barge-in")
    return {"passed": not reasons, "reasons": reasons, "budget_breaches": budget, "notes": notes}


def goodbye(call: Call, m: Dict, alignment: Optional[Dict]) -> None:
    """goodbye_complete: the bot's last line was heard to its end before the call ended."""
    if call.ended_by == "party" or (not call.bot_lines and not m.get("last_bot_audio_end_ms")):
        m["goodbye_complete"] = None  # the other side hung up: no goodbye owed
        return
    problems = []
    if m.get("dropped_at_stop_ms"):
        problems.append(f"{m['dropped_at_stop_ms']} ms unplayed at hangup")
    if m.get("bot_audio_cut_at_end"):
        problems.append("bot audio runs into the hangup")
    lines = (alignment or {}).get("lines") or []
    # Lines the plugin logged after the call ended were never playable: counted, not treated as the goodbye.
    late = [l for l in lines if l.get("t_ms") is not None and l["t_ms"] > call.duration_ms + 500]
    m["lines_after_hangup"] = len(late)
    lines = [l for l in lines if l not in late]
    if lines:
        last = lines[-1]
        if last["status"] == "missing":
            problems.append("last line not heard")
        elif last["cut_end_words"] > 1:
            problems.append(f"last {last['cut_end_words']} words not heard")
    m["goodbye_complete"] = not problems
    m["goodbye_note"] = "; ".join(problems) or None
