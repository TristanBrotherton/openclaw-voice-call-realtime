"""Timing metrics from the two channels (plus the scenario timeline when there is one).

All times are ms from answer (sample 0 of the recording).
"""
from __future__ import annotations

from typing import Dict, List, Optional

from .audio import (Segment, clip_segments, detect_dtmf, dtmf_windows, overlap_ms, subtract_windows,
                    vad_segments)
from .inputs import Call, steps_timeline

DEAD_AIR_MS = 3000


def _first_onset_after(segs: List[Segment], t: int, before: Optional[int] = None) -> Optional[int]:
    for s, _ in segs:
        if s >= t and (before is None or s < before):
            return s
    return None


def _covering(segs: List[Segment], t: int) -> Optional[Segment]:
    for s, e in segs:
        if s <= t < e:
            return (s, e)
    return None


def party_turns(call: Call, party: List[Segment], steps: List[dict]) -> List[dict]:
    """Party turns that ask the bot for a reply, with speech start/end."""
    turns = []
    if steps:
        audible = [s for s in steps if s["kind"] in ("say", "play")]
        for st in steps:
            if not st["reply"]:
                continue
            segs = clip_segments(party, st["start"], st["end"] + 100)
            start = segs[0][0] if segs else st.get("speech_start")
            end = segs[-1][1] if segs else st.get("speech_end")
            if end is None:
                continue
            nxt = next((a["start"] for a in audible if a["start"] > st["start"]), None)
            hang = next((s["start"] for s in steps if s["kind"] == "hangup" and s["start"] > st["start"]), None)
            limit = min(x for x in (nxt, hang, call.duration_ms) if x is not None)
            turns.append({"step": st["id"], "start": start, "end": end, "window_end": limit,
                          "barge_in": st["gate"] == "during_bot_speech", "expect": st["expect"]})
        return turns
    # No scenario: every party utterance (segments merged across < 1.2 s pauses) owes a reply.
    merged: List[List[int]] = []
    for s, e in party:
        if merged and s - merged[-1][1] < 1200:
            merged[-1][1] = e
        else:
            merged.append([s, e])
    for i, (s, e) in enumerate(merged):
        nxt = merged[i + 1][0] if i + 1 < len(merged) else call.duration_ms
        turns.append({"step": f"u{i + 1}", "start": s, "end": e, "window_end": nxt, "barge_in": False, "expect": {}})
    return turns


def compute(call: Call) -> Dict:
    a = call.audio
    party = vad_segments(a.party, a.rate)
    bot_raw = vad_segments(a.bot, a.rate)
    dtmf = detect_dtmf(a.bot, a.rate)
    # The party's live detector heard keys the offline pass can miss (tones
    # adjacent to speech): its events are ground truth for what was pressed.
    heard = [(int(e["t_ms"]), str(e["digit"])) for e in call.events if e.get("type") == "dtmf_detected"]
    for t, k in heard:
        if not any(abs(t - t2) < 400 and k == k2 for t2, k2 in dtmf):
            dtmf.append((t, k))
    dtmf.sort()
    # Key tones are not speech: keep them out of bot speech for timing metrics.
    bot = subtract_windows(bot_raw, dtmf_windows(dtmf)) if dtmf else bot_raw
    bot = [s for s in bot if s[1] - s[0] >= 60]
    steps = steps_timeline(call)
    dur = call.duration_ms
    m: Dict = {"duration_ms": dur}

    m["first_bot_audio_ms"] = bot[0][0] if bot else None
    m["first_party_audio_ms"] = party[0][0] if party else None
    say_steps = [s for s in steps if s["kind"] == "say"]
    first_party_speech = None
    if say_steps:
        segs = clip_segments(party, say_steps[0]["start"], say_steps[0]["end"] + 100)
        first_party_speech = segs[0][0] if segs else say_steps[0].get("speech_start")
    elif party:
        first_party_speech = party[0][0]
    m["first_party_speech_ms"] = first_party_speech
    m["bot_audio_before_party_speech_ms"] = (
        overlap_ms(bot, [(0, first_party_speech)]) if first_party_speech is not None else (sum(e - s for s, e in bot) if bot else 0))

    # --- turns: latency, dead air ------------------------------------------------
    turns = party_turns(call, party, steps)
    lat: List[int] = []
    dead: List[dict] = []
    turn_rows = []
    for t in turns:
        onset = _first_onset_after(bot, t["end"], t["window_end"])
        over_end = _covering(bot, t["end"] - 40) is not None
        row = {"step": t["step"], "speech_end_ms": t["end"], "bot_onset_ms": onset,
               "latency_ms": (onset - t["end"]) if onset is not None else None, "bot_talking_at_end": over_end}
        if onset is not None:
            lat.append(onset - t["end"])
            if onset - t["end"] > DEAD_AIR_MS:
                dead.append({"after_step": t["step"], "from_ms": t["end"], "gap_ms": onset - t["end"]})
        elif t["window_end"] - t["end"] > DEAD_AIR_MS:
            dead.append({"after_step": t["step"], "from_ms": t["end"], "gap_ms": t["window_end"] - t["end"], "no_reply": True})
        turn_rows.append(row)
    m["turns"] = turn_rows
    m["turn_latencies_ms"] = lat
    m["turn_latency_p50_ms"] = _pct(lat, 0.5)
    m["turn_latency_p90_ms"] = _pct(lat, 0.9)
    m["turn_latency_max_ms"] = max(lat) if lat else None
    m["dead_air"] = dead
    m["dead_air_s"] = round(sum(d["gap_ms"] for d in dead) / 1000, 2)
    m["dead_air_events"] = len(dead)

    # --- talk-over -------------------------------------------------------------------
    barge_windows = [(s["start"], s["end"] + 1500) for s in steps if s["gate"] == "during_bot_speech"]
    p_eff = subtract_windows(party, barge_windows)
    m["talk_over_s"] = round(overlap_ms(p_eff, bot) / 1000, 2)
    machine_windows = [(s["start"], s["end"]) for s in steps if s["machine"]]
    m["bot_over_machine_s"] = round(overlap_ms(bot, machine_windows) / 1000, 2) if machine_windows else None

    # --- barge-in yield -----------------------------------------------------------
    yields = []
    for s in steps:
        if s["gate"] != "during_bot_speech" or s["kind"] != "say":
            continue
        segs = clip_segments(party, s["start"], s["end"] + 100)
        onset = segs[0][0] if segs else s.get("speech_start") or s["start"]
        cov = _covering(bot, onset)
        yields.append({"step": s["id"], "yield_ms": (cov[1] - onset) if cov else 0, "bot_was_speaking": cov is not None})
    m["barge_in"] = yields
    m["barge_in_yield_ms"] = max((y["yield_ms"] for y in yields), default=None) if yields else None

    # --- voicemail ---------------------------------------------------------------
    vm = _voicemail(call, steps, bot, dur)
    if vm:
        m.update(vm)

    # --- end of call ---------------------------------------------------------------
    m["last_bot_audio_end_ms"] = bot[-1][1] if bot else None
    m["bot_audio_cut_at_end"] = bool(bot and bot[-1][1] >= dur - 60)
    m["dropped_at_stop_ms"] = call.meta.get("dropped_at_stop_ms")
    m["hangup_tail_ms"] = (dur - bot[-1][1]) if bot else None

    m["dtmf_pressed"] = "".join(k for _, k in dtmf)
    m["dtmf"] = [{"t_ms": t, "key": k} for t, k in dtmf]
    m["bot_speech_s"] = round(sum(e - s for s, e in bot) / 1000, 2)
    m["party_audio_s"] = round(sum(e - s for s, e in party) / 1000, 2)
    m["_segments"] = {"party": party, "bot": bot}
    return m


def _voicemail(call: Call, steps: List[dict], bot: List[Segment], dur: int) -> Optional[Dict]:
    sc = call.scenario or {}
    amd = (sc.get("amd") or {}).get("verdict", "")
    is_vm = bool((sc.get("expect") or {}).get("voicemail")) or amd.startswith("machine_end_beep") or amd == "machine_end_silence"
    machine = [s for s in steps if s["machine"]]
    if not is_vm or not machine:
        return None
    beeps = [s for s in steps if s["is_beep"]]
    greeting_start = machine[0]["start"]
    if beeps:
        msg_from = beeps[-1]["end"]
    else:
        msg_from = machine[-1]["end"]
        amd_ev = next((e for e in call.events if e.get("type") == "amd_injected"), None)
        if amd_ev:
            msg_from = max(msg_from, amd_ev["t_ms"])
    before = overlap_ms(bot, [(greeting_start, msg_from)])
    after = [s for s in bot if s[0] >= msg_from]
    out = {
        "vm_bot_during_greeting_s": round(before / 1000, 2),
        "vm_message_start_ms": (after[0][0] - msg_from) if after else None,
        "vm_message_s": round(sum(e - s for s, e in after) / 1000, 2) if after else 0,
        "vm_message_after_beep": bool(after) and before == 0,
    }
    complete = bool(after) and call.ended_by == "bot" and not (call.meta.get("dropped_at_stop_ms") or 0) and after[-1][1] < dur - 60
    out["vm_message_complete"] = complete
    return out


def _pct(vals, q):
    from .shared import pct
    return pct(vals, q)
