"""Multimodal scoring signals for the ranking pipeline.

Reference design: FinalScore = W_t * S_text + W_a * S_audio + W_v * S_visual + W_e * S_engage, with
the weights summing to 1. The terms that can be computed from data the app already has are
implemented here:

* S_text  — hook-word presence in the first seconds plus a compact arousal lexicon (EN + ID),
* S_audio — RMS energy of the window normalised into a z-score and squeezed through a logistic,
* S_engage— the acoustic-engagement heatmap the analysis already builds (peak + mean in the window).

Visual arousal (Action Units / optical flow), laughter classification and live-chat velocity need
models this app does not ship, so those weights can simply stay at zero.
"""

import math
import subprocess
from typing import Dict, List, Optional

import numpy as np

HOOK_WORDS_EN = {
    "wait", "but", "never", "imagine", "secret", "the truth", "nobody", "stop",
    "why", "how", "if you", "this is", "crazy", "insane", "unbelievable", "exposed",
    "mistake", "shocking", "warning", "listen", "watch this", "did you know",
}
HOOK_WORDS_ID = {
    "tunggu", "tapi", "jangan", "bayangkan", "rahasia", "ternyata", "faktanya",
    "gila", "parah", "bongkar", "kesalahan", "nggak percaya", "wajib tahu",
    "dengerin", "liat ini", "tahukah kamu", "awas", "stop", "viral", "penasaran",
}
_ALL_HOOKS = HOOK_WORDS_EN | HOOK_WORDS_ID

# Arousal-style lexicon, intensity in [-3, 3]. Compact on purpose: no model download, works offline.
EMOTION_WORDS: Dict[str, int] = {
    "amazing": 3, "insane": 3, "crazy": 2, "unbelievable": 3, "shocking": 3,
    "terrible": -3, "horrible": -3, "love": 2, "hate": -2, "incredible": 3,
    "secret": 2, "exposed": 2, "never": 2, "best": 2, "worst": -2,
    "gila": 2, "parah": 2, "luar biasa": 3, "nggak percaya": 3, "kecewa": -2,
    "bahaya": -2, "viral": 2, "mengejutkan": 3, "sedih": -2, "marah": -2,
    "senang": 2, "takut": -2, "wow": 2, "astaga": 2, "menyeramkan": -2,
}


def _overlap(line: Dict, start: float, end: float) -> bool:
    try:
        ls = float(line.get("start") or 0.0)
        le = float(line.get("end") or 0.0)
    except (TypeError, ValueError):
        return False
    return le > start and ls < end


def hook_word_score(lines: List[Dict], window_start: float, window_end: float) -> float:
    """H(T): 1.0 for a hook word inside the first 3s of the window, 0.5 within 6s, else 0."""
    best = 0.0
    for line in lines:
        if not _overlap(line, window_start, min(window_end, window_start + 6.0)):
            continue
        try:
            ls = float(line.get("start") or 0.0)
        except (TypeError, ValueError):
            ls = window_start + 3.0
        low = (str(line.get("text") or "")).lower()
        if any(h in low for h in _ALL_HOOKS):
            best = max(best, 1.0 if ls <= window_start + 3.0 else 0.5)
    return best


def emotion_score(lines: List[Dict], window_start: float, window_end: float) -> float:
    """E(T): mean absolute arousal of emotion words inside the window, normalised to 0..1."""
    total, hits = 0.0, 0
    for line in lines:
        if not _overlap(line, window_start, window_end):
            continue
        low = (str(line.get("text") or "")).lower()
        for word, intensity in EMOTION_WORDS.items():
            if word in low:
                total += abs(intensity)
                hits += 1
    if not hits:
        return 0.0
    return min(1.0, total / hits / 3.0)


def text_score(lines: List[Dict], window_start: float, window_end: float) -> float:
    """S_text = 0.6 * hook presence + 0.4 * emotion intensity."""
    return 0.6 * hook_word_score(lines, window_start, window_end) + \
           0.4 * emotion_score(lines, window_start, window_end)


def rms_of_window(source_path: str, start: float, end: float) -> Optional[float]:
    """RMS of the window's audio, decoded mono at 16 kHz straight out of ffmpeg — no temp files."""
    duration = max(0.5, end - start)
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-ss", str(start), "-t", str(duration), "-i", str(source_path),
        "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1",
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=90)
    except Exception:
        return None
    if not out.stdout:
        return None
    x = np.frombuffer(out.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    if x.size < 1600:
        return None
    return float(np.sqrt(np.mean(x ** 2)))


def audio_score(rms_values: List[Optional[float]]) -> List[float]:
    """S_audio per window: logistic of the RMS z-score so the term lands in 0..1 like the others."""
    present = [r for r in rms_values if r is not None]
    if len(present) < 2:
        return [0.5 for _ in rms_values]
    mu = float(np.mean(present))
    sigma = float(np.std(present)) or 1e-6
    out: List[float] = []
    for r in rms_values:
        if r is None:
            out.append(0.5)
            continue
        z = (r - mu) / sigma
        out.append(1.0 / (1.0 + math.exp(-z)))
    return out


def heatmap_score(points: List[Dict], window_start: float, window_end: float) -> float:
    """S_engage from the acoustic-engagement heatmap: mean + peak inside the window, 0..1."""
    vals: List[float] = []
    for p in points or []:
        try:
            s = float(p.get("start_time") or 0.0)
            e = float(p.get("end_time") or s)
            v = float(p.get("value") or 0.0)
        except (TypeError, ValueError, AttributeError):
            continue
        if e <= window_start or s >= window_end:
            continue
        vals.append(max(0.0, min(1.0, v)))
    if not vals:
        return 0.0
    return 0.7 * (sum(vals) / len(vals)) + 0.3 * max(vals)


# Ranked clips run 10-15 seconds; a little longer is fine, shorter is not.
RANK_AUTO_MIN_SECONDS = 10.0
RANK_AUTO_MAX_SECONDS = 15.0
RANK_AUTO_FALLBACK_SECONDS = 10.0
RANK_MIN_SECONDS = 10.0


def auto_window_end(transcript_lines: List[Dict], start: float, clip_end: float) -> float:
    """End of the first spoken line that finishes at least AUTO_MIN after the hook."""
    first_past = None
    for line in transcript_lines or []:
        try:
            line_end = float(line.get("end") or 0.0)
        except (TypeError, ValueError):
            continue
        if line_end <= start:
            continue
        length = line_end - start
        if length < RANK_AUTO_MIN_SECONDS:
            continue
        if line_end <= start + RANK_AUTO_MAX_SECONDS:
            return min(clip_end, line_end)
        if first_past is None:
            first_past = line_end
    if first_past is not None:
        # No clean boundary inside the window: take the first one past it with a small grace so
        # the cut lands between words rather than mid-word, else cap at the maximum length.
        if first_past <= start + RANK_AUTO_MAX_SECONDS + 3.0:
            return min(clip_end, first_past)
        return min(clip_end, start + RANK_AUTO_MAX_SECONDS)
    return min(clip_end, start + RANK_AUTO_FALLBACK_SECONDS)


def rank_window(
    clip: Dict,
    transcript_lines: Optional[List[Dict]] = None,
    auto_seconds: bool = False,
    seconds: float = RANK_AUTO_FALLBACK_SECONDS,
) -> tuple:
    """The (start, end) a ranked clip is actually cut to: the hook plus the configured length,
    or the first sentence boundary when AUTO is on. Single source of truth for the renderer and
    the order preview."""
    c_start = float(clip.get("start_time") or 0.0)
    c_end = float(clip.get("end_time") or (c_start + (seconds or RANK_AUTO_FALLBACK_SECONDS)))
    hook = clip.get("hook_time")
    begin = float(hook) if isinstance(hook, (int, float)) and c_start <= float(hook) <= max(c_start, c_end - 1.0) else c_start
    if auto_seconds:
        finish = auto_window_end(transcript_lines, begin, c_end)
    else:
        begin = min(begin, max(c_start, c_end - seconds))
        finish = max(min(c_end, begin + seconds), begin + 1.0)
    return begin, finish


def compute_multimodal_order(
    clips: List[Dict],
    transcript_lines: Optional[List[Dict]],
    heatmap_points: Optional[List[Dict]],
    source_path: Optional[str],
    count: int,
    weights: tuple = (0.55, 0.15, 0.15, 0.15),
    auto_seconds: bool = False,
    seconds: float = RANK_AUTO_FALLBACK_SECONDS,
) -> List[tuple]:
    """Scores every clip with the multimodal signals and returns (score, index) DESC — best first."""
    w_llm, w_text, w_audio, w_engage = weights
    windows = [rank_window(c, transcript_lines, auto_seconds, seconds) for c in clips]
    rms = [rms_of_window(source_path, s, e) for s, e in windows] if source_path else [None] * len(clips)
    audio = audio_score(rms)
    scored: List[tuple] = []
    for i, clip in enumerate(clips):
        s, e = windows[i]
        llm = float(clip.get("virality_score") or 0.0) / 100.0
        final = (
            w_llm * llm
            + w_text * text_score(transcript_lines or [], s, e)
            + w_audio * audio[i]
            + w_engage * heatmap_score(heatmap_points or [], s, e)
        )
        scored.append((final, i))
    scored.sort(key=lambda t: -t[0])
    return scored[:count]
