"""Heard vs generated: transcribe the bot channel (what the party actually
heard) with whisper-1 and align it with the plugin's own bot transcript.

Only the bot's audible segments are sent (joined by short silences, with a
time map back to the call), which saves cost and keeps whisper from
hallucinating words into long silences.
"""
from __future__ import annotations

import difflib
import io
import json
import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np

from .audio import Segment, write_mono_wav
from .openai_api import post_multipart

WHISPER_USD_PER_MIN = 0.006
PAD_MS = 250
GAP_MS = 600

_SMALL = ("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen "
          "sixteen seventeen eighteen nineteen").split()
_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def _num_words(n: int) -> List[str]:
    if n < 20:
        return [_SMALL[n]]
    if n < 100:
        return [_TENS[n // 10]] + ([_SMALL[n % 10]] if n % 10 else [])
    if n < 1000:
        return [_SMALL[n // 100], "hundred"] + (_num_words(n % 100) if n % 100 else [])
    return list(str(n))


def normalize_words(text: str) -> List[str]:
    t = text.lower().replace("’", "'")
    t = re.sub(r"(\d+):(\d\d)", lambda m: f"{m.group(1)} {m.group(2) if m.group(2) != '00' else ''}", t)
    t = re.sub(r"(\d)(am|pm)\b", r"\1 \2", t)
    t = re.sub(r"\b([ap])\.m\.", r"\1m", t)
    t = re.sub(r"[^a-z0-9' ]+", " ", t)
    words: List[str] = []
    for w in t.split():
        w = w.strip("'")
        if not w:
            continue
        if w.isdigit():
            words.extend(_num_words(int(w)) if len(w) <= 3 else list(w))
        else:
            words.append(w)
    return words


def compress(bot: np.ndarray, rate: int, segs: List[Segment]) -> Tuple[np.ndarray, List[Tuple[int, int, int]]]:
    """Concatenate padded bot segments. Returns audio and a map [(out_start_ms, src_start_ms, len_ms)]."""
    spans: List[List[int]] = []
    dur = int(len(bot) * 1000 / rate)
    for s, e in segs:
        s, e = max(0, s - PAD_MS), min(dur, e + PAD_MS)
        if spans and s <= spans[-1][1]:
            spans[-1][1] = max(spans[-1][1], e)
        else:
            spans.append([s, e])
    chunks, tmap, out_ms = [], [], 0
    gap = np.zeros(rate * GAP_MS // 1000, dtype=np.int16)
    for s, e in spans:
        chunks.append(bot[s * rate // 1000:e * rate // 1000])
        tmap.append((out_ms, s, e - s))
        out_ms += e - s
        chunks.append(gap)
        out_ms += GAP_MS
    return (np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.int16)), tmap


def map_time(t_out_ms: float, tmap: List[Tuple[int, int, int]]) -> Optional[int]:
    for out_s, src_s, ln in tmap:
        if out_s - 50 <= t_out_ms <= out_s + ln + 50:
            return int(src_s + min(max(t_out_ms - out_s, 0), ln))
    return None


def transcribe_bot(call, segs: List[Segment], key: str, cache: Optional[Path] = None) -> Dict:
    """{'words': [{'w','t_ms','end_ms'}], 'text', 'seconds', 'usd'}; cached in whisper.json."""
    if cache and cache.exists():
        return json.loads(cache.read_text())
    a = call.audio
    audio, tmap = compress(a.bot, a.rate, segs)
    if len(audio) < a.rate // 2:
        res = {"words": [], "text": "", "seconds": 0.0, "usd": 0.0}
    else:
        buf = io.BytesIO()
        write_mono_wav(buf, audio, a.rate)
        raw = post_multipart("audio/transcriptions",
                             # No language hint: forcing one makes whisper translate speech in another language.
                             [("model", "whisper-1"), ("response_format", "verbose_json"),
                              ("timestamp_granularities[]", "word"), ("timestamp_granularities[]", "segment")],
                             "file", "bot.wav", buf.getvalue(), key)
        words = []
        for w in raw.get("words") or []:
            t = map_time(w["start"] * 1000, tmap)
            if t is None:
                continue  # falls inside an inserted gap: hallucination
            te = map_time(w["end"] * 1000, tmap) or t
            words.append({"w": w["word"], "t_ms": t, "end_ms": te})
        secs = len(audio) / a.rate
        res = {"words": words, "text": raw.get("text", ""), "seconds": round(secs, 1),
               "usd": round(secs / 60 * WHISPER_USD_PER_MIN, 5)}
    if cache:
        cache.write_text(json.dumps(res, indent=1))
    return res


def align(generated: List[Tuple[Optional[int], str]], heard_words: List[Dict]) -> Dict:
    """Compare generated bot lines with heard words.

    Per line: fraction of its words heard, leading words not heard (clipped
    start), trailing words not heard (cut end). Heard runs of >= 3 words that
    match no generated line are 'extra'."""
    gen: List[Tuple[int, str]] = []
    for li, (_, text) in enumerate(generated):
        gen += [(li, w) for w in normalize_words(text)]
    heard: List[Tuple[int, str]] = []
    for hi, w in enumerate(heard_words):
        heard += [(hi, x) for x in normalize_words(w["w"])]
    sm = difflib.SequenceMatcher(None, [w for _, w in gen], [w for _, w in heard], autojunk=False)
    gen_hit = [False] * len(gen)
    heard_hit = [False] * len(heard)
    for b in sm.get_matching_blocks():
        for k in range(b.size):
            gen_hit[b.a + k] = True
            heard_hit[b.b + k] = True
    lines = []
    for li, (t, text) in enumerate(generated):
        idx = [i for i, (l, _) in enumerate(gen) if l == li]
        hits = [gen_hit[i] for i in idx]
        if not idx:
            continue
        frac = sum(hits) / len(idx)
        lead = next((k for k, h in enumerate(hits) if h), len(hits))
        trail = next((k for k, h in enumerate(reversed(hits)) if h), len(hits))
        status = "missing" if frac < 0.3 else ("partial" if frac < 0.8 else "ok")
        lines.append({"line": li, "t_ms": t, "words": len(idx), "heard_frac": round(frac, 2),
                      "clipped_start_words": lead if status != "missing" else 0,
                      "cut_end_words": trail if status != "missing" else 0, "status": status,
                      "text": text[:160]})
    extra = []
    run: List[int] = []
    for i, h in enumerate(heard_hit + [True]):
        if not h:
            run.append(i)
            continue
        if len(run) >= 3:
            ws = [heard[j][1] for j in run]
            extra.append({"t_ms": heard_words[heard[run[0]][0]]["t_ms"], "text": " ".join(ws)[:160]})
        run = []
    return {
        "lines": lines,
        "extra": extra,
        "word_recall": round(sum(gen_hit) / len(gen), 3) if gen else None,
        "missing_lines": sum(1 for l in lines if l["status"] == "missing"),
        "partial_lines": sum(1 for l in lines if l["status"] == "partial"),
        "clipped_start_lines": sum(1 for l in lines if l["clipped_start_words"] > 0),
        "extra_runs": len(extra),
    }


def heard_text_between(heard_words: List[Dict], lo: int, hi: int) -> str:
    return " ".join(w["w"] for w in heard_words if lo <= w["t_ms"] < hi)
