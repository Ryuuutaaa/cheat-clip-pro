import asyncio
import json
import logging
import os
import re
import time
import uuid
import zipfile
from typing import Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, Body, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse

from backend.utils.text import build_clip_metadata_text
from backend.routers.system import _origin_is_allowed

from backend.config import (
    ACTIVE_ENCODER_NAME,
    EXPORTS_DIR,
    UPLOADS_DIR,
    detect_hardware_support,
    logger,
)
from backend.schemas.render import (
    RenderBatchRequest,
    RenderSettingsModel,
    RetryBatchRequest,
)
from backend.services.render_service import (
    BATCH_REQUESTS,
    RENDER_BATCHES,
    process_batch_rendering,
    process_batch_retry,
    prune_render_registry,
    request_batch_cancel,
)
from backend.utils.rank_signals import compute_multimodal_order

router = APIRouter(tags=["Render"])


@router.post("/api/rank-order")
async def compute_rank_order(payload: Dict = Body(...)):
    """Returns the multimodal ranking order for the given clips, best first with rank numbers.

    Same scoring the renderer applies when RANK_USE_MULTIMODAL=1, so the UI can show the exact
    order the video will play. Falls back to the LLM virality score when the flag is off.
    """
    clips = payload.get("clips") or []
    if not clips:
        raise HTTPException(status_code=400, detail="No clips provided for ranking")
    transcript = payload.get("transcript") or []
    heatmap = payload.get("heatmap_points") or []
    auto_seconds = float(payload.get("clip_seconds") or 0.0) <= 0.0
    seconds = float(payload.get("clip_seconds") or 10.0) or 10.0

    source_path = None
    target_url = (payload.get("video_url") or "").strip()
    if target_url.startswith("/api/video/"):
        candidate = UPLOADS_DIR / os.path.basename(target_url.split("?")[0])
        if candidate.exists():
            source_path = str(candidate)

    # Optional per-request weights make the smart order work without any environment flag.
    weights = None
    body_weights = payload.get("weights")
    if isinstance(body_weights, list) and len(body_weights) == 4:
        try:
            weights = tuple(float(x) for x in body_weights)
        except (TypeError, ValueError):
            weights = None

    if os.environ.get("RANK_USE_MULTIMODAL") == "1" or weights is not None:
        if weights is None:
            raw_w = [float(x) for x in (os.environ.get("RANK_SCORE_WEIGHTS") or "0.55,0.15,0.15,0.15").split(",")]
            weights = tuple(x / (sum(raw_w) or 1.0) for x in raw_w) if len(raw_w) == 4 else (0.55, 0.15, 0.15, 0.15)
        scored = await asyncio.to_thread(
            compute_multimodal_order, clips, transcript, heatmap, source_path,
            len(clips), weights, auto_seconds, seconds,
        )
    else:
        scored = sorted(
            ((float(c.get("virality_score") or 0.0) / 100.0, i) for i, c in enumerate(clips)),
            key=lambda t: -t[0],
        )

    order = [
        {"clip_index": idx, "rank": pos + 1, "score": round(float(score), 4)}
        for pos, (score, idx) in enumerate(scored)
    ]
    return {"order": order, "multimodal": os.environ.get("RANK_USE_MULTIMODAL") == "1" or weights is not None}


@router.post("/api/render-batch")
async def start_batch_render(request: RenderBatchRequest, background_tasks: BackgroundTasks):
    if not request.clips:
        raise HTTPException(status_code=400, detail="No clips provided for rendering")

    batch_id = f"batch_{int(time.time())}_{uuid.uuid4().hex[:6]}"

    pfx = (request.settings.title_prefix or "") if request.settings else ""
    sfx = (request.settings.title_suffix or "") if request.settings else ""

    clips_status = []
    for idx, c in enumerate(request.clips):
        base_t = (c.get("custom_title") or c.get("title_suggestion") or c.get("title") or f"Clip {idx+1}").strip()
        full_t = f"{pfx}{base_t}{sfx}".strip() if (pfx or sfx) else base_t
        clips_status.append({
            "clip_index": idx,
            "title": full_t,
            "base_title": base_t,
            # Carried through so the batch archive can ship upload-ready metadata per clip.
            "caption_suggestion": (c.get("caption_suggestion") or "").strip(),
            "hashtag_suggestion": (c.get("hashtag_suggestion") or "").strip(),
            "seo_keywords": c.get("seo_keywords") or [],
            "status": "pending",
            "progress_percent": 0
        })

    RENDER_BATCHES[batch_id] = {
        "batch_id": batch_id,
        "total_clips": len(request.clips),
        "current_clip_index": 0,
        "overall_status": "running",
        "clips": clips_status,
        "zip_url": None
    }
    BATCH_REQUESTS[batch_id] = request
    prune_render_registry()

    background_tasks.add_task(process_batch_rendering, batch_id, request)
    return {"batch_id": batch_id, "total_clips": len(request.clips)}


@router.post("/api/render-batch/{batch_id}/retry")
async def retry_batch_rendering(
    batch_id: str,
    background_tasks: BackgroundTasks,
    body: Optional[RetryBatchRequest] = None
):
    if batch_id not in RENDER_BATCHES:
        raise HTTPException(status_code=404, detail="Batch not found")
    batch = RENDER_BATCHES[batch_id]
    if batch_id not in BATCH_REQUESTS:
        raise HTTPException(status_code=400, detail="Batch configuration expired. Please start a new render.")

    if batch.get("overall_status") == "running":
        # Check if any clip is actively running
        running = any(c.get("status") in ["downloading", "transcribing", "rendering"] for c in batch.get("clips", []))
        if running:
            raise HTTPException(status_code=400, detail="Batch is currently rendering. Please wait for the current clip to finish.")

    req = BATCH_REQUESTS[batch_id]
    indices_to_retry: List[int] = []
    if body and body.clip_indices:
        indices_to_retry = [i for i in body.clip_indices if 0 <= i < len(batch["clips"])]
    else:
        indices_to_retry = [i for i, c in enumerate(batch["clips"]) if c.get("status") == "error"]

    if not indices_to_retry:
        raise HTTPException(status_code=400, detail="No failed clips to retry in this batch.")

    for idx in indices_to_retry:
        batch["clips"][idx]["status"] = "pending"
        batch["clips"][idx]["progress_percent"] = 0
        batch["clips"][idx]["error_message"] = None
        batch["clips"][idx]["error"] = None

    batch["overall_status"] = "running"
    batch["error_message"] = None
    batch["warning_message"] = None

    background_tasks.add_task(process_batch_retry, batch_id, indices_to_retry)
    return {
        "status": "started",
        "batch_id": batch_id,
        "retrying_clips": indices_to_retry
    }


@router.get("/api/render-progress/{batch_id}")
async def get_render_progress(batch_id: str):
    if batch_id not in RENDER_BATCHES:
        raise HTTPException(status_code=404, detail="Batch not found")

    async def stream():
        last_sent_json = None
        idle_count = 0
        while True:
            batch = RENDER_BATCHES.get(batch_id)
            if not batch:
                break
            batch_json = json.dumps(batch)
            if batch_json != last_sent_json:
                yield f"data: {batch_json}\n\n"
                last_sent_json = batch_json
                idle_count = 0
            else:
                idle_count += 1
                # Send SSE keep-alive comment every 5 iterations (~2.5s) to prevent client/proxy timeout during lag
                if idle_count % 5 == 0:
                    yield ": keep-alive\n\n"
            if batch.get("overall_status") in ["completed", "error"]:
                # Yield final state once and break
                yield f"data: {batch_json}\n\n"
                break
            await asyncio.sleep(0.5)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )


@router.post("/api/cancel-render/{batch_id}")
def cancel_render(batch_id: str, request: Request):
    """Stops a running batch after the clip it is working on finishes."""
    if not _origin_is_allowed(request.headers.get("origin", "")):
        raise HTTPException(status_code=403, detail="Cross-origin request rejected")
    clean_id = os.path.basename(batch_id)
    if clean_id not in RENDER_BATCHES:
        raise HTTPException(status_code=404, detail="Batch not found")
    request_batch_cancel(clean_id)
    logger.info(f"Cancel requested for batch {clean_id}")
    return {"cancelling": clean_id}


@router.get("/api/rendered-files")
def list_rendered_files(kind: Optional[str] = None, limit: int = 12):
    """Lists finished renders so they stay downloadable after a page reload.

    kind=ranking returns only the ranking compilations, anything else returns the individual clips.
    """
    files = []
    try:
        for entry in EXPORTS_DIR.iterdir():
            if not entry.is_file() or entry.suffix.lower() != ".mp4":
                continue
            is_ranking = entry.name.startswith("ranking_")
            if kind == "ranking" and not is_ranking:
                continue
            if kind == "clips" and is_ranking:
                continue
            stat = entry.stat()
            files.append({
                "name": entry.name,
                "size": stat.st_size,
                "modified": int(stat.st_mtime),
                "is_ranking": is_ranking,
                "download_url": f"/api/download-rendered/{entry.name}",
            })
    except FileNotFoundError:
        return {"files": []}

    files.sort(key=lambda f: f["modified"], reverse=True)
    return {"files": files[: max(1, min(50, limit))]}


@router.delete("/api/rendered-files")
def delete_all_rendered_files(request: Request, kind: Optional[str] = "ranking"):
    """Removes every finished render of one kind. Same-origin only, like the single delete.

    Only the videos go; the ZIP archives stay, so a mistake here is still recoverable.
    """
    if not _origin_is_allowed(request.headers.get("origin", "")):
        raise HTTPException(status_code=403, detail="Cross-origin request rejected")

    deleted, failed = [], []
    try:
        candidates = list(EXPORTS_DIR.iterdir())
    except FileNotFoundError:
        return {"deleted": [], "failed": []}

    for entry in candidates:
        if not entry.is_file() or entry.suffix.lower() != ".mp4":
            continue
        is_ranking = entry.name.startswith("ranking_")
        if kind == "ranking" and not is_ranking:
            continue
        if kind == "clips" and is_ranking:
            continue
        try:
            entry.unlink()
            deleted.append(entry.name)
        except OSError:
            failed.append(entry.name)

    logger.info(f"Deleted {len(deleted)} rendered files (kind={kind}), {len(failed)} failed")
    return {"deleted": deleted, "failed": failed}


@router.delete("/api/rendered-files/{file_name}")
def delete_rendered_file(file_name: str, request: Request):
    """Removes one finished render from disk. Same-origin only, like the other mutating routes."""
    if not _origin_is_allowed(request.headers.get("origin", "")):
        raise HTTPException(status_code=403, detail="Cross-origin request rejected")

    safe_name = os.path.basename(file_name)
    if not safe_name.lower().endswith(".mp4"):
        raise HTTPException(status_code=400, detail="Only rendered mp4 files can be deleted")
    file_path = EXPORTS_DIR / safe_name
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Rendered file not found")
    try:
        file_path.unlink()
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Could not delete the file: {str(e)[:150]}")
    logger.info(f"Deleted rendered file {safe_name}")
    return {"deleted": safe_name}


@router.get("/api/download-rendered/{file_name}")
def download_rendered_file(file_name: str, title: Optional[str] = None):
    safe_name = os.path.basename(file_name)
    file_path = EXPORTS_DIR / safe_name
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Rendered clip not found")

    # If title provided, sanitize and use as download filename
    dl_filename = safe_name
    if title and title.strip():
        clean_title = re.sub(r'[\\/*?:"<>|]', "", title.strip())
        if clean_title:
            dl_filename = f"{clean_title}.mp4" if not clean_title.lower().endswith(".mp4") else clean_title

    return FileResponse(file_path, media_type="video/mp4", filename=dl_filename)


@router.get("/api/download-batch-zip/{batch_id}")
def download_batch_zip(batch_id: str):
    clean_id = os.path.basename(batch_id)
    safe_name = f"cheat_clip_pro_{clean_id}.zip"
    file_path = EXPORTS_DIR / safe_name
    if not file_path.exists():
        # Attempt to package any completed clips for this batch on the fly
        job = RENDER_BATCHES.get(batch_id)
        if job and job.get("clips"):
            try:
                title_counts: Dict[str, int] = {}
                with zipfile.ZipFile(file_path, "w", zipfile.ZIP_DEFLATED) as zipf:
                    for c in job["clips"]:
                        c_out = c.get("output_path")
                        if not c_out and c.get("download_url"):
                            fname = c["download_url"].split("/")[-1]
                            c_out = str(EXPORTS_DIR / fname)
                        if c_out and os.path.exists(c_out):
                            raw_title = (c.get("title") or "").strip()
                            clean_title = re.sub(r'[\\/*?:"<>|]', "", raw_title) or os.path.splitext(os.path.basename(c_out))[0]
                            count = title_counts.get(clean_title, 0)
                            title_counts[clean_title] = count + 1
                            arc_name = f"{clean_title}.mp4" if count == 0 else f"{clean_title} ({count}).mp4"
                            zipf.write(c_out, arcname=arc_name)
                            meta_name = arc_name[:-4] + ".txt"
                            zipf.writestr(meta_name, build_clip_metadata_text(
                                c.get("title") or clean_title,
                                c.get("caption_suggestion", ""),
                                c.get("hashtag_suggestion", ""),
                                c.get("seo_keywords") or [],
                            ))
            except Exception as e:
                logger.error(f"Error packaging batch zip on the fly: {e}")
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Batch zip file not found")
    return FileResponse(file_path, media_type="application/zip", filename=safe_name)


@router.get("/api/hardware-accel")
def get_hardware_acceleration_status():
    """Returns detected GPU/CPU hardware acceleration options and recommendations."""
    support = detect_hardware_support()
    rec = support.get("recommended", "cpu")
    return {
        "status": "success",
        "active_default": ACTIVE_ENCODER_NAME,
        "recommended": rec,
        "support": support,
        "options": [
            {
                "id": "auto",
                "label": "Auto Detect",
                "sub": f"Recommended ({rec.upper()})",
                "available": True,
            },
            {
                "id": "nvenc",
                "label": "NVIDIA NVENC",
                "sub": "GeForce & RTX Hardware Acceleration",
                "available": support.get("nvenc", False),
            },
            {
                "id": "amf",
                "label": "AMD AMF",
                "sub": "Radeon RX & APU Hardware Acceleration",
                "available": support.get("amf", False),
            },
            {
                "id": "qsv",
                "label": "Intel QuickSync",
                "sub": "Intel Arc & UHD Hardware Acceleration",
                "available": support.get("qsv", False),
            },
            {
                "id": "cpu",
                "label": "CPU Software (libx264)",
                "sub": "Multi-threaded CPU (100% Universal)",
                "available": True,
            },
        ],
    }
