"""Audio primitives: stereo WAV reading, per-channel energy VAD, Goertzel DTMF.

Input convention for every recording the analyzer reads: stereo PCM16,
left = remote party, right = bot (what the party heard), any sample rate
(8 kHz from the lab and from the plugin's own call recorder).
"""
from __future__ import annotations

import wave
from dataclasses import dataclass
from typing import List, Optional, Tuple

import numpy as np

FRAME_MS = 20
Segment = Tuple[int, int]  # (start_ms, end_ms)


@dataclass
class Stereo:
    rate: int
    party: np.ndarray  # int16, left
    bot: np.ndarray  # int16, right

    @property
    def duration_ms(self) -> int:
        return int(round(len(self.party) * 1000 / self.rate))


def read_stereo_wav(path) -> Stereo:
    with wave.open(str(path), "rb") as w:
        ch, width, rate, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    if width != 2:
        raise ValueError(f"{path}: expected 16-bit PCM, got {width * 8}-bit")
    data = np.frombuffer(raw, dtype="<i2")
    if ch == 1:
        raise ValueError(f"{path}: expected stereo (left = party, right = bot), got mono")
    data = data.reshape(-1, ch)
    return Stereo(rate=rate, party=data[:, 0].copy(), bot=data[:, 1].copy())


def write_mono_wav(path_or_file, pcm: np.ndarray, rate: int) -> None:
    target = path_or_file if hasattr(path_or_file, "write") else str(path_or_file)
    with wave.open(target, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(np.asarray(pcm, dtype="<i2").tobytes())


def frame_db(x: np.ndarray, rate: int, frame_ms: int = FRAME_MS) -> np.ndarray:
    n = rate * frame_ms // 1000
    frames = len(x) // n
    if frames == 0:
        return np.zeros(0)
    f = x[: frames * n].astype(np.float64).reshape(frames, n) / 32768.0
    rms = np.sqrt(np.mean(f * f, axis=1))
    return 20 * np.log10(np.maximum(rms, 1e-6))


def vad_segments(x: np.ndarray, rate: int, threshold_db: Optional[float] = None, abs_floor_db: float = -45.0,
                 floor_margin_db: float = 10.0, min_on_frames: int = 2, hangover_ms: int = 300,
                 min_segment_ms: int = 60) -> List[Segment]:
    """Energy VAD. The threshold adapts to the channel's noise floor (10th
    percentile frame level + margin) but never drops below abs_floor_db.
    A segment opens after min_on_frames active frames and closes after
    hangover_ms of quiet; its end is the end of the last active frame."""
    db = frame_db(x, rate)
    if len(db) == 0:
        return []
    if threshold_db is None:
        floor = float(np.percentile(db, 10))
        threshold_db = max(abs_floor_db, floor + floor_margin_db)
    active = db > threshold_db
    segs: List[Segment] = []
    run = 0
    start = None
    last_active = None
    hang = max(1, hangover_ms // FRAME_MS)
    for i, a in enumerate(active):
        if a:
            run += 1
            if start is None and run >= min_on_frames:
                start = i - run + 1
            if start is not None:
                last_active = i
        else:
            run = 0
            if start is not None and last_active is not None and i - last_active >= hang:
                segs.append((start * FRAME_MS, (last_active + 1) * FRAME_MS))
                start = None
                last_active = None
    if start is not None and last_active is not None:
        segs.append((start * FRAME_MS, (last_active + 1) * FRAME_MS))
    return [s for s in segs if s[1] - s[0] >= min_segment_ms]


def overlap_ms(a: List[Segment], b: List[Segment]) -> int:
    """Total overlap between two sorted segment lists."""
    i = j = 0
    tot = 0
    while i < len(a) and j < len(b):
        lo = max(a[i][0], b[j][0])
        hi = min(a[i][1], b[j][1])
        if hi > lo:
            tot += hi - lo
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return tot


def clip_segments(segs: List[Segment], lo: int, hi: int) -> List[Segment]:
    return [(max(s, lo), min(e, hi)) for s, e in segs if e > lo and s < hi]


def subtract_windows(segs: List[Segment], windows: List[Segment]) -> List[Segment]:
    out = list(segs)
    for wlo, whi in windows:
        nxt: List[Segment] = []
        for s, e in out:
            if e <= wlo or s >= whi:
                nxt.append((s, e))
                continue
            if s < wlo:
                nxt.append((s, wlo))
            if e > whi:
                nxt.append((whi, e))
        out = nxt
    return out


# --- DTMF (Goertzel) --------------------------------------------------------------

DTMF_LOW = (697, 770, 852, 941)
DTMF_HIGH = (1209, 1336, 1477, 1633)
KEYS = (("1", "2", "3", "A"), ("4", "5", "6", "B"), ("7", "8", "9", "C"), ("*", "0", "#", "D"))


def _tone_powers(frames: np.ndarray, rate: int) -> np.ndarray:
    """|DFT|^2 at the 8 DTMF frequencies for each frame (same value Goertzel gives).
    frames: (F, N) float in [-1, 1]. Returns (F, 8): 4 low then 4 high."""
    n = frames.shape[1]
    freqs = np.array(DTMF_LOW + DTMF_HIGH, dtype=np.float64)
    basis = np.exp(-2j * np.pi * np.outer(freqs, np.arange(n)) / rate)  # (8, N)
    return np.abs(frames @ basis.T) ** 2


def _classify(powers: np.ndarray, energy: float, n: int) -> Optional[str]:
    if energy < 1e-4:
        return None
    lows, highs = powers[:4], powers[4:]
    li, hi = int(np.argmax(lows)), int(np.argmax(highs))
    ls, hs = np.sort(lows)[::-1], np.sort(highs)[::-1]
    if ls[0] < 6 * ls[1] or hs[0] < 6 * hs[1]:
        return None
    if (lows[li] + highs[hi]) * 2 / (n * n) < 0.6 * energy:
        return None
    twist = lows[li] / max(highs[hi], 1e-12)
    if twist > 10 or twist < 0.1:
        return None
    return KEYS[li][hi]


def classify_dtmf_frame(frame: np.ndarray, rate: int) -> Optional[str]:
    f = frame.astype(np.float64)[None, :] / 32768.0
    return _classify(_tone_powers(f, rate)[0], float(np.mean(f * f)), f.shape[1])


def detect_dtmf(x: np.ndarray, rate: int, min_frames: int = 2) -> List[Tuple[int, str]]:
    """[(t_ms, key)] for each key press (key held >= min_frames 20 ms frames)."""
    n = rate * FRAME_MS // 1000
    nf = len(x) // n
    if nf == 0:
        return []
    frames = x[: nf * n].astype(np.float64).reshape(nf, n) / 32768.0
    energy = np.mean(frames * frames, axis=1)
    loud = np.nonzero(energy >= 1e-4)[0]
    keys: List[Optional[str]] = [None] * nf
    if len(loud):
        pw = _tone_powers(frames[loud], rate)
        for row, i in enumerate(loud):
            keys[i] = _classify(pw[row], float(energy[i]), n)
    out: List[Tuple[int, str]] = []
    cur, run, reported = None, 0, False
    for i, key in enumerate(keys):
        if key and key == cur:
            run += 1
        else:
            cur, run, reported = key, (1 if key else 0), False
        if key and not reported and run >= min_frames:
            reported = True
            out.append(((i - run + 1) * FRAME_MS, key))
    return out


def dtmf_windows(presses: List[Tuple[int, str]], tone_ms: int = 160) -> List[Segment]:
    return [(t, t + tone_ms) for t, _ in presses]
