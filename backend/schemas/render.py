from typing import List, Optional, Dict, Any
from pydantic import BaseModel

class RankHighlightModel(BaseModel):
    """
    Settings for a "ranking" compilation: several clips played in rank order inside one video with a
    stacked list of rank labels and a headline over the whole thing.
    """
    enabled: bool = False
    ranking_title: Optional[str] = None          # headline; falls back to the clip titles
    rank_count: int = 6                          # how many ranks to include (2-10)
    clip_seconds: float = 10.0                    # length of each ranked clip, taken from its hook
    position_mode: str = "top_left"              # top_left | top_right | bottom_left | bottom_right
    show_numbers: bool = True
    # Append the clip's virality score to its rank label ("3. Bald arch · 87")
    show_scores: bool = False
    # Draw a duration line under every rank label that fills while that rank plays (off by default:
    # a clean overlay is what most people want)
    show_progress_bars: bool = False
    # Layout controls for the whole rank list
    max_label_chars: int = 0                 # 0 = never cut (the font auto-fits instead)
    spacing_y: int = 0                       # row gap in px (0 = the anchor default)
    offset_x: int = 0                        # horizontal shift of the whole list
    offset_y: int = 0                        # vertical shift of the whole list
    scale: float = 1.0                       # overall size multiplier (0.5-2.0)
    label_weight: str = "bold"               # regular | semibold | bold | heavy
    # Transition between ranked clips: hard | fade_black | fade_white, and how long it lasts
    transition: str = "hard"
    transition_seconds: float = 0.3
    # How each rank's label appears: none | fade | slide
    label_transition: str = "fade"
    # Optional per-rank overrides from the UI: [{"clip_index": int, "label": str}], in rank order.
    ranks: Optional[List[Dict[str, Any]]] = None


class RenderSettingsModel(BaseModel):
    aspect_ratio: str = "9:16"
    background_style: str = "black"
    enable_face_tracking: bool = True
    streamer_preset: str = "none"
    facecam_position: Optional[str] = "auto"
    title_text: Optional[str] = None
    title_prefix: Optional[str] = ""
    title_suffix: Optional[str] = ""
    file_name_prefix: Optional[str] = ""
    file_name_suffix: Optional[str] = ""
    title_position: str = "auto"
    title_duration: Optional[str] = "entire"
    subtitles_enabled: Optional[bool] = True
    caption_style: str = "viral_pop"
    caption_font: str = "Outfit"
    font_size: str = "medium"
    title_font_size: Optional[str] = "medium"
    text_case: str = "uppercase"
    title_y_percent: Optional[float] = None
    subtitle_y_percent: Optional[float] = None
    subtitle_position_mode: Optional[str] = "bottom"
    subtitle_center_y_percent: Optional[float] = 50.0
    # Manual subtitle nudge in seconds (+ later / - earlier), e.g. 0.25
    subtitle_offset_sec: Optional[float] = 0.0
    # Background Music
    bgm_enabled: Optional[bool] = False
    bgm_file_path: Optional[str] = None
    bgm_volume: Optional[float] = 25.0
    bgm_start_offset: Optional[float] = 0.0
    # Hook SFX
    hook_sfx_enabled: Optional[bool] = False
    hook_sfx_file_path: Optional[str] = None
    hook_sfx_volume: Optional[float] = 100.0
    # Raw Audio / Voice Boost
    original_audio_volume: Optional[float] = 100.0
    # Watermark
    watermark_enabled: Optional[bool] = False
    watermark_type: Optional[str] = "image"
    watermark_file_path: Optional[str] = None
    watermark_text: Optional[str] = None
    watermark_size: Optional[float] = 20.0
    watermark_opacity: Optional[float] = 80.0
    watermark_x: Optional[float] = 90.0
    watermark_y: Optional[float] = 8.0
    hardware_accel: Optional[str] = "auto"
    # Transition applied to a clip's own edges, e.g. "black:0.3" (both), "in:black:0.3" (fade in
    # only) or "out:white:0.3" (fade out only)
    fade_in_out: Optional[str] = None
    # Spoiler hook: each clip opens with a short teaser cut from its own hook moment, so the final
    # length becomes spoiler_seconds + the clip's own duration.
    spoiler_enabled: bool = False
    spoiler_seconds: float = 3.0
    spoiler_label: bool = False
    spoiler_transition: str = "hard"        # hard | fade_black | fade_white
    rank_highlight: Optional[RankHighlightModel] = None

class RenderBatchRequest(BaseModel):
    video_url: str
    video_id: str
    clips: List[Dict[str, Any]]
    settings: RenderSettingsModel
    transcript: Optional[List[Dict[str, Any]]] = None
    # Acoustic-engagement heatmap from the analysis, used by the multimodal ranking signal.
    heatmap_points: Optional[List[Dict[str, Any]]] = None

class RetryBatchRequest(BaseModel):
    clip_indices: Optional[List[int]] = None
