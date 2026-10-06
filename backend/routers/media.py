import asyncio
import logging
import os
import re
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, HTTPException, Request, Response, UploadFile, status
from fastapi.responses import FileResponse, StreamingResponse

from backend.config import (
    EXPORTS_DIR,
    TEMP_DIR,
    UPLOADS_DIR,
    detect_speaker_face_box,
    extract_clip_frame,
    get_video_file_metadata,
    has_video_stream,
    is_valid_mp4,
    logger,
)
from backend.routers.system import _origin_is_allowed

router = APIRouter(tags=["Media"])


MAX_VIDEO_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024   # 4 GB
MAX_AUDIO_UPLOAD_BYTES = 100 * 1024 * 1024        # 100 MB
MAX_SFX_UPLOAD_BYTES = 50 * 1024 * 1024           # 50 MB
MAX_IMAGE_UPLOAD_BYTES = 25 * 1024 * 1024         # 25 MB


def _is_safe_path(target_path: Path) -> bool:
    """Ensures the resolved file path is strictly located within allowed media directories."""
    try:
        resolved = target_path.resolve()
        allowed_roots = [UPLOADS_DIR.resolve(), TEMP_DIR.resolve(), EXPORTS_DIR.resolve()]
        return any(resolved == root or resolved.is_relative_to(root) for root in allowed_roots)
    except Exception:
        return False


async def _save_uploaded_file_chunked(file: UploadFile, save_path: Path, max_bytes: int) -> int:
    """
    Streams upload content in 1MB chunks to disk while enforcing a strict maximum size limit
    to prevent memory exhaustion (OOM) and disk flood attacks.
    """
    total_written = 0
    chunk_size = 1024 * 1024  # 1 MB
    try:
        with open(save_path, "wb") as f:
            while chunk := await file.read(chunk_size):
                total_written += len(chunk)
                if total_written > max_bytes:
                    f.close()
                    if save_path.exists():
                        save_path.unlink()
                    limit_mb = round(max_bytes / (1024 * 1024))
                    raise HTTPException(
                        status_code=413,
                        detail=f"Uploaded file exceeds the maximum allowed size limit of {limit_mb} MB."
                    )
                f.write(chunk)
        return total_written
    except HTTPException:
        raise
    except Exception as e:
        if save_path.exists():
            try:
                save_path.unlink()
            except Exception:
                pass
        raise HTTPException(status_code=500, detail=f"Failed to save upload: {str(e)}")


@router.post("/api/upload-video")
async def upload_video(request: Request, file: UploadFile = File(...)):
    """
    Handles local video file uploads (.mp4, .mov, .mkv, .webm, .avi, etc.).
    Extracts video metadata (duration, resolution, fps) and saves to uploads folder.
    """
    if not _origin_is_allowed(request.headers.get("origin", "")):
        raise HTTPException(status_code=403, detail="Cross-origin request rejected")
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")
    
    ext = os.path.splitext(file.filename)[1].lower()
    allowed = [".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".flv", ".wmv"]
    if ext not in allowed:
        raise HTTPException(status_code=400, detail=f"Unsupported video format. Allowed: {', '.join(allowed)}")
    
    clean_name = re.sub(r'[^a-zA-Z0-9_.-]', '_', file.filename)
    unique_id = f"upload_{uuid.uuid4().hex[:10]}"
    unique_name = f"{unique_id}_{clean_name}"
    save_path = UPLOADS_DIR / unique_name
    
    try:
        bytes_written = await _save_uploaded_file_chunked(file, save_path, MAX_VIDEO_UPLOAD_BYTES)

        # Reject files whose container/streams are unreadable — otherwise the failure
        # only surfaces much later inside Whisper/ffmpeg with a cryptic message.
        readable = await asyncio.to_thread(is_valid_mp4, save_path)
        has_video = readable and await asyncio.to_thread(has_video_stream, save_path)
        if not has_video:
            try:
                save_path.unlink()
            except Exception:
                pass
            raise HTTPException(
                status_code=400,
                detail="The uploaded file is not a readable video (invalid container or no video stream).",
            )

        meta = await asyncio.to_thread(get_video_file_metadata, save_path)
        logger.info(f"Uploaded video '{file.filename}' -> saved as '{unique_name}' ({meta.get('duration')}s, {meta.get('width')}x{meta.get('height')})")
        
        return {
            "success": True,
            "video_id": unique_id,
            "filename": file.filename,
            "saved_name": unique_name,
            "file_path": str(save_path),
            "video_url": f"/api/video/{unique_name}",
            "duration": meta.get("duration", 0.0),
            "width": meta.get("width", 1920),
            "height": meta.get("height", 1080),
            "fps": meta.get("fps", 30.0),
            "has_audio": meta.get("has_audio", True),
            "size_bytes": bytes_written
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to upload video: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to process video upload: {str(e)}")


def _find_video_file_on_disk(file_name: str) -> Optional[Path]:
    import urllib.parse
    clean_name = urllib.parse.unquote(os.path.basename(file_name.split("?")[0])).strip()
    
    # Check direct paths
    for base in [UPLOADS_DIR, TEMP_DIR, EXPORTS_DIR]:
        candidate = base / clean_name
        if candidate.exists() and candidate.is_file() and _is_safe_path(candidate):
            return candidate

    # Search directory listings without regex/glob pitfalls
    all_files: list[Path] = []
    for d in [UPLOADS_DIR, TEMP_DIR, EXPORTS_DIR]:
        if d.exists():
            all_files.extend([f for f in d.iterdir() if f.is_file() and _is_safe_path(f)])

    clean_lower = clean_name.lower()
    
    # 1. Exact case-insensitive match
    for f in all_files:
        if f.name.lower() == clean_lower:
            return f

    # 2. Match without extension
    stem_lower = os.path.splitext(clean_lower)[0]
    for f in all_files:
        if f.stem.lower() == stem_lower or f.stem.lower() == clean_lower:
            return f

    # 3. Match Google Drive or Upload ID substring
    drive_match = re.search(r'([a-zA-Z0-9_-]{20,})', clean_name)
    if drive_match:
        fid = drive_match.group(1)
        for f in all_files:
            if fid in f.name:
                return f

    upload_match = re.search(r'(upload_[a-zA-Z0-9]{6,})', clean_name)
    if upload_match:
        uid = upload_match.group(1)
        for f in all_files:
            if uid in f.name:
                return f

    # 4. Containment matching
    for f in all_files:
        if clean_lower in f.name.lower() or f.stem.lower() in clean_lower:
            return f

    return None


@router.get("/api/video/{file_name:path}")
def get_video_file(file_name: str, request: Request):
    """
    Streams local video files with HTTP byte ranges support (HTTP 206 Partial Content)
    for smooth seeking, immediate playback start, and previewing without loading the whole file.
    """
    file_path = _find_video_file_on_disk(file_name)
    if not file_path or not file_path.exists() or not _is_safe_path(file_path):
        raise HTTPException(status_code=404, detail="Video file not found")

    ext = os.path.splitext(file_path.name)[1].lower()
    media_type = "video/webm" if ext == ".webm" else "video/quicktime" if ext == ".mov" else "video/x-matroska" if ext == ".mkv" else "video/mp4"

    # Open once and read the size from the handle so the declared Content-Length
    # always matches what this descriptor can actually deliver (the file may be
    # replaced/cleaned while a client streams it).
    fh = open(file_path, "rb")
    file_size = os.fstat(fh.fileno()).st_size
    range_header = request.headers.get("range")

    if not range_header:
        def iter_full():
            try:
                while chunk := fh.read(1024 * 512):
                    yield chunk
            finally:
                fh.close()

        return StreamingResponse(
            iter_full(),
            status_code=200,
            media_type=media_type,
            headers={
                "Content-Length": str(file_size),
                "Accept-Ranges": "bytes",
                "Content-Disposition": f'inline; filename="{file_path.name}"'
            }
        )

    # Parse a single Range: bytes=start-end | bytes=start- | bytes=-suffixLen
    spec = range_header.split("=", 1)[1].split(",")[0].strip() if "=" in range_header else ""
    match = re.match(r"^(\d*)-(\d*)$", spec)
    if not match or (not match.group(1) and not match.group(2)):
        fh.close()
        return Response(
            status_code=status.HTTP_416_REQUESTED_RANGE_NOT_SATISFIABLE,
            headers={"Content-Range": f"bytes */{file_size}"}
        )

    if match.group(1) == "":
        # Suffix range (e.g. "bytes=-65536") — the final N bytes
        suffix_len = int(match.group(2) or 0)
        if suffix_len <= 0:
            fh.close()
            return Response(
                status_code=status.HTTP_416_REQUESTED_RANGE_NOT_SATISFIABLE,
                headers={"Content-Range": f"bytes */{file_size}"}
            )
        start = max(0, file_size - suffix_len)
        end = file_size - 1
    else:
        start = int(match.group(1))
        end = int(match.group(2)) if match.group(2) else file_size - 1
        end = min(end, file_size - 1)  # RFC 9110: clamp over-long ranges

    if file_size == 0 or start >= file_size or start > end:
        fh.close()
        return Response(
            status_code=status.HTTP_416_REQUESTED_RANGE_NOT_SATISFIABLE,
            headers={"Content-Range": f"bytes */{file_size}"}
        )

    content_length = end - start + 1
    fh.seek(start)

    def iter_range():
        remaining = content_length
        try:
            while remaining > 0:
                data = fh.read(min(1024 * 512, remaining))
                if not data:
                    break
                remaining -= len(data)
                yield data
        finally:
            fh.close()

    return StreamingResponse(
        iter_range(),
        status_code=206,
        media_type=media_type,
        headers={
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(content_length),
            "Content-Disposition": f'inline; filename="{file_path.name}"'
        }
    )


@router.post("/api/upload-bgm")
async def upload_bgm(request: Request, file: UploadFile = File(...)):
    if not _origin_is_allowed(request.headers.get("origin", "")):
        raise HTTPException(status_code=403, detail="Cross-origin request rejected")
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")
    ext = os.path.splitext(file.filename)[1].lower()
    allowed = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]
    if ext not in allowed:
        raise HTTPException(status_code=400, detail=f"Unsupported audio format. Allowed: {', '.join(allowed)}")
    
    clean_name = re.sub(r'[^a-zA-Z0-9_.-]', '_', file.filename)
    unique_name = f"bgm_{uuid.uuid4().hex[:8]}_{clean_name}"
    save_path = UPLOADS_DIR / unique_name
    
    try:
        bytes_written = await _save_uploaded_file_chunked(file, save_path, MAX_AUDIO_UPLOAD_BYTES)
        return {
            "success": True,
            "filename": file.filename,
            "saved_name": unique_name,
            "file_path": str(save_path),
            "url": f"/api/audio/{unique_name}",
            "size_bytes": bytes_written
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to upload BGM: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/audio/{file_name}")
def get_audio_file(file_name: str):
    clean_name = os.path.basename(file_name)
    file_path = UPLOADS_DIR / clean_name
    if not file_path.exists() or not _is_safe_path(file_path):
        raise HTTPException(status_code=404, detail="Audio file not found")
    media_type = "audio/mpeg" if clean_name.endswith(".mp3") else "audio/wav" if clean_name.endswith(".wav") else "application/octet-stream"
    return FileResponse(file_path, media_type=media_type, filename=clean_name)


@router.post("/api/upload-sfx")
async def upload_hook_sfx(request: Request, file: UploadFile = File(...)):
    if not _origin_is_allowed(request.headers.get("origin", "")):
        raise HTTPException(status_code=403, detail="Cross-origin request rejected")
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")
    ext = os.path.splitext(file.filename)[1].lower()
    allowed = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]
    if ext not in allowed:
        raise HTTPException(status_code=400, detail=f"Unsupported audio format. Allowed: {', '.join(allowed)}")

    clean_name = re.sub(r'[^a-zA-Z0-9_.-]', '_', file.filename)
    unique_name = f"sfx_{uuid.uuid4().hex[:8]}_{clean_name}"
    save_path = UPLOADS_DIR / unique_name

    try:
        bytes_written = await _save_uploaded_file_chunked(file, save_path, MAX_SFX_UPLOAD_BYTES)
        return {
            "success": True,
            "filename": file.filename,
            "saved_name": unique_name,
            "file_path": str(save_path),
            "url": f"/api/audio/{unique_name}",
            "size_bytes": bytes_written
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to upload Hook SFX: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/upload-watermark")
async def upload_watermark(request: Request, file: UploadFile = File(...)):
    if not _origin_is_allowed(request.headers.get("origin", "")):
        raise HTTPException(status_code=403, detail="Cross-origin request rejected")
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")
    ext = os.path.splitext(file.filename)[1].lower()
    allowed = [".png", ".jpg", ".jpeg", ".webp", ".svg"]
    if ext not in allowed:
        raise HTTPException(status_code=400, detail=f"Unsupported image format. Allowed: {', '.join(allowed)}")
    
    clean_name = re.sub(r'[^a-zA-Z0-9_.-]', '_', file.filename)
    unique_name = f"wm_{uuid.uuid4().hex[:8]}_{clean_name}"
    save_path = UPLOADS_DIR / unique_name
    
    try:
        bytes_written = await _save_uploaded_file_chunked(file, save_path, MAX_IMAGE_UPLOAD_BYTES)
        return {
            "success": True,
            "filename": file.filename,
            "saved_name": unique_name,
            "file_path": str(save_path),
            "url": f"/api/watermark/{unique_name}",
            "size_bytes": bytes_written
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to upload watermark: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/watermark/{file_name}")
def get_watermark_file(file_name: str):
    clean_name = os.path.basename(file_name)
    file_path = UPLOADS_DIR / clean_name
    if not file_path.exists() or not _is_safe_path(file_path):
        raise HTTPException(status_code=404, detail="Watermark file not found")
    media_type = "image/png" if clean_name.endswith(".png") else "image/jpeg" if (clean_name.endswith(".jpg") or clean_name.endswith(".jpeg")) else "image/webp"
    return FileResponse(file_path, media_type=media_type, filename=clean_name)


@router.get("/api/clip-frame")
async def get_clip_frame(video_id: str, timestamp: float = 0.0, video_url: Optional[str] = None):
    """
    Returns an extracted real video frame at timestamp for the real video preview.
    Guarantees returning a real video frame, never a promotional thumbnail.
    """
    try:
        frame_path = await asyncio.to_thread(extract_clip_frame, video_url or "", video_id, timestamp)
        if frame_path and os.path.exists(frame_path):
            return FileResponse(frame_path, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})
    except Exception as e:
        logger.warning(f"Failed to serve extracted frame for {video_id}: {e}")

    raise HTTPException(status_code=404, detail="Real video frame could not be extracted yet")


@router.get("/api/detect-face")
async def detect_face(
    video_id: str,
    timestamp: float = 0.0,
    video_url: Optional[str] = None,
    facecam_position: Optional[str] = "auto",
    streamer_preset: Optional[str] = "none"
):
    """
    Detects speaker face coordinates (cx, cy, w, h) on the video at timestamp.
    Returns normalized coordinates and the frame URL.
    """
    is_streamer = (streamer_preset or "none") in ["split_top_cam", "pip_corner"]
    default_cx = 0.85 if is_streamer else 0.5
    default_cy = 0.78 if is_streamer else 0.35
    default_res = {
        "found": False,
        "cx": default_cx,
        "cy": default_cy,
        "w": 0.22,
        "h": 0.25,
        "frame_url": f"/api/clip-frame?video_id={video_id}&timestamp={timestamp}"
    }
    try:
        # First try to extract or get the cached frame
        frame_path = await asyncio.to_thread(extract_clip_frame, video_url or "", video_id, timestamp)
        if frame_path and os.path.exists(frame_path):
            box = await asyncio.to_thread(
                detect_speaker_face_box,
                frame_path,
                facecam_position or "auto",
                streamer_preset or "none"
            )
            box["frame_url"] = f"/api/clip-frame?video_id={video_id}&timestamp={timestamp}"
            return box

        # If frame extract didn't complete, check local candidates
        safe_id = re.sub(r'[^a-zA-Z0-9_-]', '_', video_id)
        local_candidates = list(TEMP_DIR.glob(f"*{safe_id}*.mp4")) + list(EXPORTS_DIR.glob(f"*{safe_id}*.mp4"))
        for candidate in local_candidates:
            if candidate.exists() and candidate.stat().st_size > 10000 and "slice_" not in candidate.name and is_valid_mp4(candidate):
                box = await asyncio.to_thread(
                    detect_speaker_face_box,
                    str(candidate),
                    facecam_position or "auto",
                    streamer_preset or "none"
                )
                box["frame_url"] = f"/api/clip-frame?video_id={video_id}&timestamp={timestamp}"
                return box
    except Exception as e:
        logger.warning(f"Face detection API error: {e}")

    return default_res
