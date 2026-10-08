import asyncio
import logging
import os
import re
import zipfile
from typing import Any, Dict, List, Optional

from backend.utils.text import build_clip_metadata_text

from backend.config import (
    EXPORTS_DIR,
    TEMP_DIR,
    build_rank_overlay_ass,
    download_clip_segment,
    generate_ass_file,
    get_video_file_metadata,
    has_emoji,
    is_valid_mp4,
    is_within_media_dirs,
    logger,
    merge_rank_highlight,
    render_clip_to_mp4,
    render_title_overlay_png,
    transcribe_clip_words,
)
from backend.schemas.render import RenderBatchRequest, RenderSettingsModel

RENDER_BATCHES: Dict[str, Dict[str, Any]] = {}
BATCH_REQUESTS: Dict[str, RenderBatchRequest] = {}

# Two ranked moments that cover the same stretch of video would play it twice; anything overlapping
# an accepted rank by more than this is dropped, the usual threshold for temporal NMS.
RANK_NMS_IOU = 0.3

# AUTO duration for a ranked clip: end on the first sentence boundary at least this far past the hook,
# never longer than the max, and fall back to the nominal length when the transcript cannot say.
# Ranked clips run 10-15 seconds; a little longer is fine, shorter is not.
RANK_AUTO_MIN_SECONDS = 10.0
RANK_AUTO_MAX_SECONDS = 15.0
RANK_AUTO_FALLBACK_SECONDS = 10.0
RANK_MIN_SECONDS = 10.0


def _temporal_iou(a: tuple, b: tuple) -> float:
    """Intersection over union of two (start, end) spans."""
    inter = max(0.0, min(a[1], b[1]) - max(a[0], b[0]))
    union = max(a[1], b[1]) - min(a[0], b[0])
    return inter / union if union > 0 else 0.0


async def render_single_batch_clip(
    batch_id: str,
    idx: int,
    clip: Dict[str, Any],
    settings: RenderSettingsModel,
    target_url: str,
    transcript: Optional[List[Dict[str, Any]]] = None,
    total_clips: int = 1
):
    batch = RENDER_BATCHES.get(batch_id)
    if not batch:
        return

    clip_status = batch["clips"][idx]
    clip_status["status"] = "downloading"
    clip_status["progress_percent"] = 15
    clip_status["error_message"] = None
    clip_status["error"] = None

    raw_path = None
    ass_path = None
    title_overlay_path = None

    try:
        # 1. Download
        start_t = float(clip.get("start_time", 0.0))
        end_t = float(clip.get("end_time", start_t + 30.0))
        seg_filename = f"{batch_id}_clip_{idx}_raw.mp4"

        raw_path = await asyncio.to_thread(
            download_clip_segment,
            target_url,
            start_t,
            end_t,
            seg_filename
        )

        if not raw_path or not os.path.exists(raw_path) or not is_valid_mp4(raw_path):
            raise RuntimeError(
                "Source video segment is incomplete or corrupted ('moov atom not found'). "
                "Network lag interrupted the download. Please retry rendering this clip."
            )

        # 2. Transcribe & Generate Subtitles / Title (.ass)
        clip_status["status"] = "transcribing"
        clip_status["progress_percent"] = 40

        display_title = None
        base_title = (
            clip.get("custom_title")
            or clip.get("title_suggestion")
            or clip.get("title")
            or f"Clip {idx+1}"
        ).strip()

        if settings.title_position != "none":
            pfx = settings.title_prefix or ""
            sfx = settings.title_suffix or ""
            if pfx or sfx:
                display_title = f"{pfx}{base_title}{sfx}".strip()
            elif total_clips == 1 and settings.title_text and settings.title_text.strip() and not (clip.get("custom_title") or clip.get("title_suggestion")):
                display_title = settings.title_text.strip()
            else:
                display_title = base_title

        clip_status["title"] = display_title or base_title
        clip_status["base_title"] = base_title

        skip_ass_title = False
        duration_sec = max(1.0, end_t - start_t)

        # Check if title has emoji -> render transparent color emoji PNG overlay
        if display_title and settings.title_position != "none" and has_emoji(display_title):
            title_png_filename = f"{batch_id}_clip_{idx}_title.png"
            title_png_path = str(TEMP_DIR / title_png_filename)
            try:
                canvas_w = 1920 if (settings.aspect_ratio == "16:9_landscape") else 1080
                canvas_h = 1080 if (settings.aspect_ratio == "16:9_landscape") else 1920
                rendered_overlay = await asyncio.to_thread(
                    render_title_overlay_png,
                    title_text=display_title,
                    output_png_path=title_png_path,
                    font_name=settings.caption_font or "Montserrat",
                    target_aspect_ratio=settings.aspect_ratio or "9:16",
                    font_size_preset=settings.font_size or "medium",
                    text_case=settings.text_case or "uppercase",
                    title_position=settings.title_position or "auto",
                    title_y_percent=settings.title_y_percent,
                    canvas_w=canvas_w,
                    canvas_h=canvas_h,
                    title_font_size_preset=settings.title_font_size or settings.font_size or "medium",
                    streamer_preset=settings.streamer_preset or "none"
                )
                if rendered_overlay and os.path.exists(rendered_overlay):
                    title_overlay_path = rendered_overlay
                    skip_ass_title = True
                    logger.info(f"Rendered full-color emoji title overlay: {title_overlay_path}")
            except Exception as ex:
                logger.warning(f"Could not render color emoji title overlay: {ex}")
                skip_ass_title = False

        if settings.caption_style != "none" or (display_title and settings.title_position != "none" and not skip_ass_title):
            words = []
            if settings.caption_style != "none":
                words = await asyncio.to_thread(
                    transcribe_clip_words,
                    raw_path,
                    transcript,
                    start_t,
                    end_t
                )
            ass_filename = f"{batch_id}_clip_{idx}.ass"
            ass_path = str(TEMP_DIR / ass_filename)
            await asyncio.to_thread(
                generate_ass_file,
                words=words,
                style_preset=settings.caption_style,
                font_name=settings.caption_font,
                output_ass_path=ass_path,
                target_aspect_ratio=settings.aspect_ratio,
                font_size_preset=settings.font_size,
                text_case=settings.text_case,
                title_text=display_title if not skip_ass_title else None,
                title_position=settings.title_position,
                title_duration=settings.title_duration if settings.title_duration else "entire",
                duration_seconds=duration_sec,
                title_y_percent=settings.title_y_percent,
                subtitle_y_percent=settings.subtitle_y_percent,
                subtitle_position_mode=settings.subtitle_position_mode if settings.subtitle_position_mode else "bottom",
                subtitle_center_y_percent=settings.subtitle_center_y_percent if settings.subtitle_center_y_percent is not None else 50.0,
                skip_title=skip_ass_title,
                title_font_size_preset=settings.title_font_size or settings.font_size or "medium",
                streamer_preset=settings.streamer_preset or "none",
                subtitle_offset=float(settings.subtitle_offset_sec or 0.0)
            )

        # 3. Render Final Vertical MP4
        clip_status["status"] = "rendering"
        clip_status["progress_percent"] = 70

        out_filename = f"clip_{idx+1}_{batch_id}.mp4"
        out_path = str(EXPORTS_DIR / out_filename)

        await asyncio.to_thread(
            render_clip_to_mp4,
            video_path=raw_path,
            output_mp4_path=out_path,
            aspect_ratio=settings.aspect_ratio,
            background_style=settings.background_style,
            enable_face_tracking=settings.enable_face_tracking,
            streamer_preset=settings.streamer_preset,
            facecam_position=getattr(settings, "facecam_position", "auto") or "auto",
            title_text=display_title if not skip_ass_title else None,
            title_position=settings.title_position,
            ass_subtitles_path=ass_path,
            clip_duration=duration_sec,
            title_overlay_path=title_overlay_path,
            title_duration=settings.title_duration if settings.title_duration else "entire",
            watermark_enabled=bool(settings.watermark_enabled),
            watermark_type=settings.watermark_type or "image",
            watermark_image_path=settings.watermark_file_path,
            watermark_text=settings.watermark_text,
            watermark_size=float(settings.watermark_size if settings.watermark_size is not None else 20.0),
            watermark_opacity=float((settings.watermark_opacity if settings.watermark_opacity is not None else 80.0) / 100.0),
            watermark_x_percent=float(settings.watermark_x if settings.watermark_x is not None else 90.0),
            watermark_y_percent=float(settings.watermark_y if settings.watermark_y is not None else 8.0),
            bgm_enabled=bool(settings.bgm_enabled),
            bgm_path=settings.bgm_file_path,
            bgm_volume=float((settings.bgm_volume if settings.bgm_volume is not None else 25.0) / 100.0),
            bgm_start_offset=float(settings.bgm_start_offset or 0.0),
            hook_sfx_enabled=bool(settings.hook_sfx_enabled),
            hook_sfx_path=settings.hook_sfx_file_path,
            hook_sfx_volume=float((settings.hook_sfx_volume if settings.hook_sfx_volume is not None else 100.0) / 100.0),
            original_audio_volume=float((settings.original_audio_volume if settings.original_audio_volume is not None else 100.0) / 100.0),
            hardware_accel=settings.hardware_accel or "auto",
            title_y_percent=settings.title_y_percent
        )

        if not os.path.exists(out_path) or not is_valid_mp4(out_path):
            raise RuntimeError("Rendered MP4 file is incomplete or missing. Please retry rendering.")

        clip_status["status"] = "completed"
        clip_status["progress_percent"] = 100
        clip_status["download_url"] = f"/api/download-rendered/{out_filename}"
        clip_status["output_path"] = out_path

        # Final MP4 is safe on disk; drop intermediate artifacts so disk usage
        # does not double per clip.
        for _tmp in (raw_path, ass_path, title_overlay_path):
            if _tmp and os.path.exists(_tmp):
                try:
                    os.remove(_tmp)
                except Exception:
                    pass

    except Exception as e:
        logger.error(f"Error rendering clip {idx} in batch {batch_id}: {e}")
        clip_status["status"] = "error"
        err_msg = str(e)
        if "moov atom not found" in err_msg.lower():
            err_msg = "Download interrupted by internet lag ('moov atom not found'). Click Retry to re-download."
        elif "timed out" in err_msg.lower() or "timeout" in err_msg.lower():
            err_msg = "Download timed out due to slow/laggy internet connection. Click Retry to try again."
        clip_status["error_message"] = err_msg
        clip_status["error"] = err_msg

        # Clean up any partial raw video
        if raw_path and os.path.exists(raw_path):
            try:
                os.unlink(raw_path)
            except Exception:
                pass


def update_batch_summary_and_zip(batch_id: str, settings: RenderSettingsModel):
    """
    Updates the batch ZIP archive and computes overall status and friendly messages.
    """
    batch = RENDER_BATCHES.get(batch_id)
    if not batch:
        return

    # Generate/update ZIP bundle for the batch with title-based filenames and duplicate handling
    try:
        completed_clips = [c for c in batch["clips"]
                           if c.get("status") == "completed" and c.get("download_url") and not c.get("consumed")]
        if completed_clips:
            zip_filename = f"cheat_clip_pro_{batch_id}.zip"
            zip_path = EXPORTS_DIR / zip_filename
            title_counts: Dict[str, int] = {}
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zipf:
                for c in completed_clips:
                    fname = c["download_url"].split("?")[0].split("/")[-1]
                    fpath = EXPORTS_DIR / fname
                    if fpath.exists():
                        raw_title = (c.get("base_title") or c.get("title") or "").strip()
                        clean_title = re.sub(r'[\\/*?:"<>|]', "", raw_title) or f"clip_{c.get('clip_index', 1)}"
                        fn_pfx = re.sub(r'[\\/*?:"<>|]', "", settings.file_name_prefix or "")
                        fn_sfx = re.sub(r'[\\/*?:"<>|]', "", settings.file_name_suffix or "")
                        formatted_name = f"{fn_pfx}{clean_title}{fn_sfx}".strip() or clean_title
                        count = title_counts.get(formatted_name, 0)
                        title_counts[formatted_name] = count + 1
                        arc_name = f"{formatted_name}.mp4" if count == 0 else f"{formatted_name} ({count}).mp4"
                        zipf.write(fpath, arcname=arc_name)
                        # Ship the upload metadata beside the video so the clipper never has to
                        # copy the title and hashtags out of the UI one field at a time.
                        meta_name = arc_name[:-4] + ".txt"
                        zipf.writestr(meta_name, build_clip_metadata_text(
                            c.get("title") or formatted_name,
                            c.get("caption_suggestion", ""),
                            c.get("hashtag_suggestion", ""),
                            c.get("seo_keywords") or [],
                        ))
            batch["zip_url"] = f"/api/download-batch-zip/{batch_id}"
        else:
            batch["zip_url"] = None
    except Exception as e:
        logger.warning(f"Failed to create batch zip: {e}")

    # Determine overall status and error messaging
    failed_clips = [c for c in batch["clips"] if c.get("status") == "error"]
    running_clips = [c for c in batch["clips"] if c.get("status") in ["downloading", "transcribing", "rendering", "pending"]]

    if running_clips:
        batch["overall_status"] = "running"
    elif len(failed_clips) == len(batch["clips"]):
        batch["overall_status"] = "error"
        batch["error_message"] = f"All {len(batch['clips'])} clip(s) failed. You can click 'Retry' to try again."
    elif len(failed_clips) > 0:
        batch["overall_status"] = "completed"
        batch["warning_message"] = f"{len(failed_clips)} of {len(batch['clips'])} clips encountered errors. You can retry failed clips anytime."
    else:
        batch["overall_status"] = "completed"
        batch["warning_message"] = None


def sanitize_settings_media_paths(settings: RenderSettingsModel) -> None:
    """Drops client-supplied media paths that are not inside the app's media dirs."""
    for attr in ("bgm_file_path", "hook_sfx_file_path", "watermark_file_path"):
        val = getattr(settings, attr, None)
        if val and not is_within_media_dirs(val):
            logger.warning(f"Ignoring unsafe media path for {attr}: {val}")
            try:
                setattr(settings, attr, None)
            except Exception:
                pass


def prune_render_registry(max_entries: int = 50) -> None:
    """Bounds the in-memory batch registries without ever evicting a running batch."""
    terminal_ids = [
        bid for bid, batch in RENDER_BATCHES.items()
        if batch.get("overall_status") in ("completed", "error")
    ]
    overflow = len(RENDER_BATCHES) - max_entries
    while overflow > 0 and terminal_ids:
        oldest = terminal_ids.pop(0)  # insertion order == oldest first
        RENDER_BATCHES.pop(oldest, None)
        BATCH_REQUESTS.pop(oldest, None)
        overflow -= 1


async def _render_rank_highlight(batch_id: str, clips, settings, rank_settings, target_url: str, transcript=None):
    """
    Builds the ranking compilation: each rank is trimmed around its hook, rendered with the normal
    per-clip pipeline, then all of them are concatenated and given the rank overlay in a single pass.
    """
    batch = RENDER_BATCHES.get(batch_id)
    if not batch:
        return

    count = max(2, min(10, int(rank_settings.rank_count or 6)))
    # clip_seconds <= 0 means AUTO: follow the speaker to the end of the sentence instead of a fixed
    # number of seconds, so a ranked moment is never cut mid-word. Ranked clips never run under 10 s.
    auto_seconds = float(rank_settings.clip_seconds or 0.0) <= 0.0
    seconds = max(RANK_MIN_SECONDS, min(30.0, float(rank_settings.clip_seconds or RANK_AUTO_FALLBACK_SECONDS))) if not auto_seconds else 0.0
    transcript_lines = transcript or []

    def auto_window(start: float, clip_end: float) -> float:
        """End of the first spoken line that finishes at least AUTO_MIN after the hook."""
        for line in transcript_lines:
            try:
                line_end = float(line.get("end") or 0.0)
            except (TypeError, ValueError):
                continue
            if line_end <= start:
                continue
            length = line_end - start
            if length >= RANK_AUTO_MIN_SECONDS:
                return min(clip_end, start + min(length, RANK_AUTO_MAX_SECONDS))
        return min(clip_end, start + RANK_AUTO_FALLBACK_SECONDS)

    # Rank order: explicit overrides from the UI win, otherwise the best virality score ranks first.
    # Each entry carries the number shown on screen, so the video can play in countdown order while
    # the numbering stays 1..N.
    ordered = []
    for pos, item in enumerate((rank_settings.ranks or [])[:count]):
        idx = item.get("clip_index")
        if isinstance(idx, int) and 0 <= idx < len(clips):
            try:
                shown_rank = int(item.get("rank", pos + 1))
            except (TypeError, ValueError):
                shown_rank = pos + 1
            ordered.append((idx, clips[idx], (item.get("label") or "").strip(), shown_rank))
    if not ordered:
        ranked = sorted(range(len(clips)), key=lambda i: float(clips[i].get("virality_score") or 0), reverse=True)
        ordered = [(i, clips[i], "", pos + 1) for pos, i in enumerate(ranked[:count])]
    ordered = ordered[:count]

    # Temporal NMS: the analysis is asked not to overlap clips, but nothing enforced it, and two ranks
    # covering the same seconds would simply play that moment twice in the final video.
    kept, kept_spans = [], []
    for candidate in ordered:
        _, candidate_clip, _, _ = candidate
        span = (float(candidate_clip.get("start_time") or 0.0), float(candidate_clip.get("end_time") or 0.0))
        if any(_temporal_iou(span, seen) > RANK_NMS_IOU for seen in kept_spans):
            logger.info(f"Rank NMS: dropped '{candidate_clip.get('title')}' — it overlaps a higher-ranked moment")
            continue
        kept.append(candidate)
        kept_spans.append(span)
    if len(kept) >= 2:
        ordered = kept
    elif kept:
        logger.warning("Rank NMS would leave fewer than two clips; keeping the requested order instead")

    # With the individual pass skipped in rank mode, clips that did not make the ranking have no job
    # left; mark them so the batch summary counts them as done instead of waiting on them forever.
    ranked_indices = {src_idx for src_idx, _, _, _ in ordered}
    for entry_idx, entry in enumerate(batch.get("clips") or []):
        if entry.get("is_ranking") or entry_idx in ranked_indices:
            continue
        entry["status"] = "skipped"
        entry["consumed"] = True
        entry["is_rank_part"] = True
        entry["output_path"] = None
        entry["download_url"] = None

    ranking_title = (rank_settings.ranking_title or "").strip() or "Ranking"
    clip_settings = settings.model_copy(deep=True)
    # The ranking overlay owns the titles: the per-clip banner stays off so the only title on screen
    # is the custom ranking headline. Clip titles still exist in the UI and feed the labels.
    clip_settings.title_position = "none"
    clip_settings.title_text = None

    rendered: List[str] = []
    segments: List[Dict[str, Any]] = []
    elapsed = 0.0
    for rank_pos, (src_idx, clip, label, shown_rank) in enumerate(ordered):
        c_start = float(clip.get("start_time") or 0.0)
        c_end = float(clip.get("end_time") or (c_start + (seconds or 5.0)))
        hook = clip.get("hook_time")
        begin = float(hook) if isinstance(hook, (int, float)) and c_start <= float(hook) <= max(c_start, c_end - 1.0) else c_start
        if auto_seconds:
            finish = auto_window(begin, c_end)
        else:
            begin = min(begin, max(c_start, c_end - seconds))
            finish = max(min(c_end, begin + seconds), begin + 1.0)

        trimmed = dict(clip)
        trimmed["start_time"] = begin
        trimmed["end_time"] = finish

        await render_single_batch_clip(
            batch_id=batch_id, idx=src_idx, clip=trimmed, settings=clip_settings,
            target_url=target_url, transcript=transcript, total_clips=len(ordered),
        )

        entries = batch.get("clips") or []
        entry = entries[src_idx] if src_idx < len(entries) else None
        if entry:
            entry["consumed"] = True          # a part of the ranking, not an output of its own
            entry["is_rank_part"] = True
            entry["rank_position"] = shown_rank
        out_path = (entry or {}).get("output_path")
        if out_path and os.path.exists(out_path):
            rendered.append(out_path)
            # Use the duration the renderer actually produced: planned lengths drift by a few frames
            # and the overlay would slowly fall out of step with the clips.
            actual = None
            try:
                actual = get_video_file_metadata(out_path).get("duration")
            except Exception:
                actual = None
            segment_length = float(actual) if actual and actual > 0.5 else (finish - begin)
            label_text = label or (clip.get("title_suggestion") or clip.get("title") or f"Rank {rank_pos + 1}")
            if getattr(rank_settings, "show_scores", False):
                score = clip.get("virality_score")
                if isinstance(score, (int, float)):
                    label_text = f"{label_text} · {int(score)}"
            segments.append({
                "label": label_text,
                "rank": shown_rank,
                "start": elapsed,
                "end": elapsed + segment_length,
            })
            elapsed += segment_length

    if len(rendered) < 2:
        raise RuntimeError("Only one clip rendered, so there is nothing to rank")

    ass_path = str(TEMP_DIR / f"{batch_id}_rank_overlay.ass")
    build_rank_overlay_ass(
        ranking_title, segments, ass_path,
        position_mode=rank_settings.position_mode or "top_left",
        show_numbers=bool(rank_settings.show_numbers),
        total_seconds=elapsed,
    )
    out_name = f"ranking_{batch_id}.mp4"
    out_path = str(EXPORTS_DIR / out_name)
    merge_rank_highlight(rendered, ass_path, out_path)

    # The ranked clips existed only to be joined; keeping them would leave six extra files next to a
    # single deliverable, so they go and nothing can offer them for download afterwards.
    for part in rendered:
        try:
            os.remove(part)
        except Exception:
            pass
    for entry in batch.get("clips") or []:
        if entry.get("is_rank_part"):
            entry["output_path"] = None
            entry["download_url"] = None

    tags: List[str] = []
    for _, clip, _, _ in ordered:
        for tag in re.split(r"\s+", (clip.get("hashtag_suggestion") or "")):
            if tag.startswith("#") and tag.lower() not in [t.lower() for t in tags]:
                tags.append(tag.lower())
    for filler in ("#fyp", "#viral", "#shorts", "#trending"):
        if len(tags) >= 4:
            break
        if filler not in tags:
            tags.append(filler)

    batch.setdefault("clips", []).append({
        "clip_index": len(batch.get("clips") or []),
        "title": ranking_title,
        "base_title": ranking_title,
        "status": "completed",
        "progress_percent": 100,
        "download_url": f"/api/download-rendered/{out_name}",
        "output_path": out_path,
        "is_ranking": True,
        "caption_suggestion": " | ".join(s["label"] for s in segments),
        "hashtag_suggestion": " ".join(tags[:10]),
        "seo_keywords": [],
    })
    batch["rank_mode"] = True
    logger.info(f"Ranking video built: {out_name} ({len(rendered)} ranks, {elapsed:.1f}s)")


async def process_batch_rendering(batch_id: str, request: RenderBatchRequest):
    batch = RENDER_BATCHES.get(batch_id)
    if not batch:
        return

    clips = request.clips
    settings = request.settings
    sanitize_settings_media_paths(settings)

    # Normalize video URL for history or direct URL
    target_url = (request.video_url or "").strip()
    if not target_url:
        if request.video_id and (request.video_id.startswith("gdrive_") or request.video_id.startswith("upload_")):
            target_url = f"/api/video/{request.video_id}"
        elif request.video_id:
            target_url = f"https://www.youtube.com/watch?v={request.video_id}"
    elif not target_url.startswith("http") and not target_url.startswith("/api/video/"):
        if request.video_id and (request.video_id.startswith("gdrive_") or request.video_id.startswith("upload_")):
            target_url = f"/api/video/{request.video_id}"
        elif request.video_id:
            target_url = f"https://www.youtube.com/watch?v={request.video_id}"
        else:
            target_url = f"https://www.youtube.com/watch?v={target_url}"

    rank_settings = getattr(settings, "rank_highlight", None)
    rank_mode = rank_settings is not None and rank_settings.enabled and len(clips) >= 2

    # Rank mode has one deliverable: the ranking pass renders each ranked clip itself, trimmed around
    # its hook, so rendering the clips here as individual outputs would double the work and leave
    # files the ranking never ships.
    if not rank_mode:
        for idx, clip in enumerate(clips):
            batch["current_clip_index"] = idx
            await render_single_batch_clip(
                batch_id=batch_id,
                idx=idx,
                clip=clip,
                settings=settings,
                target_url=target_url,
                transcript=request.transcript,
                total_clips=len(clips)
            )
            # Fallback continuation: regardless of whether clip succeeded or failed, proceed to next clip!
            batch["current_clip_index"] = idx + 1

    if rank_mode:
        try:
            await _render_rank_highlight(
                batch_id, clips, settings, rank_settings, target_url, request.transcript
            )
        except Exception as e:
            logger.error(f"Ranking compilation failed for batch {batch_id}: {e}")
            batch.setdefault("clips", []).append({
                "clip_index": len(batch.get("clips") or []),
                "title": (rank_settings.ranking_title or "Ranking"),
                "base_title": (rank_settings.ranking_title or "Ranking"),
                "status": "error",
                "progress_percent": 0,
                "error": str(e)[:300],
                "is_ranking": True,
            })

    update_batch_summary_and_zip(batch_id, settings)


async def process_batch_retry(batch_id: str, clip_indices: List[int]):
    batch = RENDER_BATCHES.get(batch_id)
    request = BATCH_REQUESTS.get(batch_id)
    if not batch or not request:
        logger.error(f"Cannot retry batch {batch_id}: batch or request data not found")
        return

    batch["overall_status"] = "running"
    clips = request.clips
    settings = request.settings
    sanitize_settings_media_paths(settings)
    target_url = (request.video_url or "").strip()
    if not target_url:
        if request.video_id and (request.video_id.startswith("gdrive_") or request.video_id.startswith("upload_")):
            target_url = f"/api/video/{request.video_id}"
        elif request.video_id:
            target_url = f"https://www.youtube.com/watch?v={request.video_id}"
    elif not target_url.startswith("http") and not target_url.startswith("/api/video/"):
        if request.video_id and (request.video_id.startswith("gdrive_") or request.video_id.startswith("upload_")):
            target_url = f"/api/video/{request.video_id}"
        elif request.video_id:
            target_url = f"https://www.youtube.com/watch?v={request.video_id}"
        else:
            target_url = f"https://www.youtube.com/watch?v={target_url}"

    for idx in clip_indices:
        if 0 <= idx < len(clips):
            batch["current_clip_index"] = idx
            await render_single_batch_clip(
                batch_id=batch_id,
                idx=idx,
                clip=clips[idx],
                settings=settings,
                target_url=target_url,
                transcript=request.transcript,
                total_clips=len(clips)
            )

    update_batch_summary_and_zip(batch_id, settings)
