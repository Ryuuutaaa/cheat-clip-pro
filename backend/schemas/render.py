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
    # Draw a duration line under every rank label that fills while that rank plays
    show_progress_bars: bool = True
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
