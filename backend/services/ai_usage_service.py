import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger("cheat-clip-pro.ai-usage")

_LOCK = threading.Lock()
_MAX_RECENT = 50
_USAGE_FILE = Path(__file__).resolve().parent.parent / "ai_usage.json"

# Aggregated, process-lifetime counters (bounded memory).
_state: Dict[str, Any] = {
    "total_calls": 0,        # successful generate_content calls
    "total_failed": 0,       # failed attempts (quota / errors)
    "prompt_tokens": 0,
    "candidates_tokens": 0,
    "total_tokens": 0,
    "last_model": None,
    "last_at": None,
    "recent": [],            # newest-first bounded list
}


def _persist_locked() -> None:
    """Writes the current state to disk atomically. Call while holding _LOCK."""
    try:
        tmp = _USAGE_FILE.with_name(_USAGE_FILE.name + ".tmp")
        tmp.write_text(json.dumps(_state, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, _USAGE_FILE)
    except Exception as e:
        logger.warning(f"Could not persist AI usage: {e}")


def _load() -> None:
    """Restores persisted usage on startup (best-effort)."""
    try:
        if not _USAGE_FILE.exists():
            return
        data = json.loads(_USAGE_FILE.read_text(encoding="utf-8"))
        for key in ("total_calls", "total_failed", "prompt_tokens",
                    "candidates_tokens", "total_tokens", "last_model", "last_at"):
            if key in data:
                _state[key] = data[key]
        if isinstance(data.get("recent"), list):
            _state["recent"] = data["recent"][:_MAX_RECENT]
    except Exception as e:
        logger.warning(f"Could not load AI usage history: {e}")


_load()


def _int(value: Any) -> int:
    try:
        return int(value or 0)
    except Exception:
        return 0


def record_ai_usage(
    model: str,
    usage_metadata: Any = None,
    ok: bool = True,
    error: Optional[str] = None,
    source: Optional[str] = None,
    clip_count: Optional[int] = None,
) -> None:
    """Records a single Gemini call (success or failure) with token usage if available."""
    prompt = _int(getattr(usage_metadata, "prompt_token_count", None)) if ok else 0
    candidates = _int(getattr(usage_metadata, "candidates_token_count", None)) if ok else 0
    total = _int(getattr(usage_metadata, "total_token_count", None)) if ok else 0
    if ok and not total:
        total = prompt + candidates

    with _LOCK:
        if ok:
            _state["total_calls"] += 1
            _state["prompt_tokens"] += prompt
            _state["candidates_tokens"] += candidates
            _state["total_tokens"] += total
            _state["last_model"] = model
            _state["last_at"] = time.time()
        else:
            _state["total_failed"] += 1

        _state["recent"].insert(0, {
            "timestamp": time.time(),
            "model": model,
            "ok": ok,
            "prompt_tokens": prompt,
            "candidates_tokens": candidates,
            "total_tokens": total,
            "source": source,
            "clip_count": clip_count,
            "error": (error[:200] if error else None),
        })
        if len(_state["recent"]) > _MAX_RECENT:
            del _state["recent"][_MAX_RECENT:]
        _persist_locked()


def get_ai_usage_summary() -> Dict[str, Any]:
    with _LOCK:
        summary = dict(_state)
        summary["recent"] = list(_state["recent"])
        summary["total_analyses"] = _state["total_calls"]
        return summary


def reset_ai_usage() -> None:
    with _LOCK:
        _state.update({
            "total_calls": 0,
            "total_failed": 0,
            "prompt_tokens": 0,
            "candidates_tokens": 0,
            "total_tokens": 0,
            "last_model": None,
            "last_at": None,
            "recent": [],
        })
        _persist_locked()
