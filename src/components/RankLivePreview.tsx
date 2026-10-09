import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLanguage } from '../locales';
import type { TranscriptLine, ViralClip } from '../types';
import { buildTimedWords, buildWordChunks, getCaptionAt, CAPTION_HIGHLIGHT_CLASS } from '../utils/wordTiming';

export interface RankPreviewEntry {
  clip: ViralClip;
  label: string;
  rank: number;   // number shown on screen (1 = the winner)
  start: number;  // window start (the hook)
  end: number;    // window end
  score?: number; // virality score, shown next to the label when enabled
}

interface RankLivePreviewProps {
  /** Playback order: the highest rank number first, the winner last (countdown). */
  entries: RankPreviewEntry[];
  title: string;
  position: 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right';
  aspectRatio: string;
  videoUrl: string;
  videoId: string;
  showScores?: boolean;
  loop?: boolean;
  /** Live captions mirroring the export's subtitle burn. */
  captionStyle?: string;
  captionPosition?: string;
  captionFont?: string;
  captionFontSize?: string;
  textCase?: string;
  transcript?: TranscriptLine[];
  /** The finished ranking file, once the batch is done — the preview can play it directly. */
  renderedUrl?: string;
  /** Layout controls for the rank list (1080x1920 space, like the renderer). */
  offsetX?: number;
  offsetY?: number;
  spacingY?: number;
  scale?: number;
  labelWeight?: string;
  /** How a revealed label appears: none | fade | slide (mirrors the burnt-in overlay). */
  labelTransition?: string;
  /** Dragging the list in the preview reports the new offset, Figma-style. */
  onOffsetChange?: (x: number, y: number) => void;
  /** A fixed crop percent (0-100) when the framing is not automatic; null asks face detection. */
  staticCropPercent?: number | null;
  /** Streamer/gaming layout preset in use; anything but "none" changes the render beyond framing. */
  layoutPreset?: string;
}

/**
 * The rank page's own live preview, kept apart from the clip page's preview so neither can steal the
 * other's player. It plays the whole ranking as one continuous sequence: each rank's window plays
 * from its hook, then the next rank takes over, with the leaderboard growing from the bottom up and
 * every label staying on screen exactly like the export.
 */
export const RankLivePreview: React.FC<RankLivePreviewProps> = ({
  entries,
  title,
  position,
  aspectRatio,
  videoUrl,
  videoId,
  showScores = false,
  loop = true,
  captionStyle = 'none',
  captionPosition = 'center',
  captionFont = 'Montserrat, sans-serif',
  captionFontSize = 'medium',
  textCase = 'capitalize',
  transcript = [],
  renderedUrl,
  offsetX = 0,
  offsetY = 0,
  spacingY = 0,
  scale = 1,
  labelWeight = 'bold',
  labelTransition = 'none',
  onOffsetChange,
  staticCropPercent = 50,
  layoutPreset = 'none',
}) => {
  const { t } = useLanguage();
  const directRef = useRef<HTMLVideoElement | null>(null);
  const ytRef = useRef<{
    getCurrentTime?: () => number;
    seekTo?: (s: number, allowSeekAhead?: boolean) => void;
    playVideo?: () => void;
    pauseVideo?: () => void;
    mute?: () => void;
    unMute?: () => void;
    destroy?: () => void;
  } | null>(null);

  const isDirect = Boolean(
    videoUrl && (
      videoUrl.endsWith('.mp4') || videoUrl.endsWith('.webm') || videoUrl.endsWith('.mov') ||
      videoUrl.endsWith('.mkv') || videoUrl.includes('/api/video') || videoUrl.startsWith('blob:') ||
      videoId?.startsWith('upload_') || videoId?.startsWith('gdrive_')
    )
  );
  // Direct videos autoplay muted; YouTube waits for a click, so the button never lies about the
  // state and the first press always means "play".
  const [activeIdx, setActiveIdx] = useState(0);
  const [playing, setPlaying] = useState(isDirect);
  const [muted, setMuted] = useState(true);
  const [playerError, setPlayerError] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [viewMode, setViewMode] = useState<'sequence' | 'rendered'>('sequence');

  const timedWords = useMemo(() => buildTimedWords(transcript), [transcript]);
  const wordChunks = useMemo(() => buildWordChunks(timedWords), [timedWords]);
  const liveCaption = useMemo(
    () => (captionStyle === 'none' ? null : getCaptionAt(wordChunks, currentTime)),
    [wordChunks, currentTime, captionStyle]
  );
  const captionPx = (captionFontSize === 'small' ? 15 : captionFontSize === 'big' ? 23 : 18.5);
  const applyCase = (text: string): string => {
    if (textCase === 'uppercase') return text.toUpperCase();
    if (textCase === 'lowercase') return text.toLowerCase();
    return text.toLowerCase().replace(/(?:^|\s|\b)\w/g, c => c.toUpperCase());
  };
  const active = entries.length > 0 ? entries[Math.min(activeIdx, entries.length - 1)] : null;
  // The fixed skeleton: every number shows from the start, dimmed; a rank's label fills in once its
  // clip has played. Reversed so the winner sits on top of the list.
  const playedRanks = new Set(entries.slice(0, activeIdx + 1).map(e => e.rank));
  const skeleton = [...entries].reverse();

  // Layout controls in the preview's pixel space (the renderer works in 1080x1920).
  const frameRef = useRef<HTMLDivElement | null>(null);
  const frameW = frameRef.current?.clientWidth || 338;
  const toPx = (v: number) => v * (frameW / 1080);
  const weightFont: Record<string, number> = { regular: 500, semibold: 600, bold: 700, heavy: 900 };
  const trunc = (s: string) => s;
  const clampScale = Math.max(0.5, Math.min(2.0, Number(scale) || 1));

  // Figma-style dragging: press anywhere on the list and move it; a small threshold keeps label
  // clicks working as jumps.
  const dragState = useRef<{ startX: number; startY: number; baseX: number; baseY: number; moved: boolean } | null>(null);
  const dragMovedRef = useRef(false);

  // Crop the preview the way the render will: automatic framing asks the face detector for the
  // active rank's window and slides the video toward the speaker, mirroring the clip preview's math.
  const [cropPercent, setCropPercent] = useState<number>(staticCropPercent ?? 50);
  const cropCacheRef = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    if (staticCropPercent != null) {
      setCropPercent(staticCropPercent);
      return;
    }
    if (!active) return;
    const cached = cropCacheRef.current.get(active.rank);
    if (cached !== undefined) {
      setCropPercent(cached);
      return;
    }
    let cancelled = false;
    // A slow or unreachable detector must never leave the preview waiting forever.
    const controller = new AbortController();
    const abortTimer = window.setTimeout(() => controller.abort(), 6000);
    const params = new URLSearchParams({
      video_id: videoId || '',
      timestamp: String(Math.max(0, Math.round(active.start))),
      video_url: videoUrl || '',
      facecam_position: 'center',
      streamer_preset: 'none',
    });
    fetch(`/api/detect-face?${params.toString()}`, { signal: controller.signal })
      .then(r => r.json())
      .then(d => {
        if (cancelled || !d || typeof d.cx !== 'number') return;
        let safeCx = d.cx;
        if (safeCx >= 0.46 && safeCx <= 0.54) safeCx = 0.5;
        safeCx = Math.max(0.15, Math.min(0.85, safeCx));
        const outputRatio = aspectRatio === '16:9' || aspectRatio === '16:9_landscape' ? 16 / 9
          : aspectRatio === '4:3' ? 4 / 3
          : aspectRatio === '1:1' ? 1
          : 9 / 16;
        const sourceAspect = typeof d.aspect === 'number' && d.aspect > 0 ? d.aspect : 16 / 9;
        const cropFraction = Math.min(1, outputRatio / sourceAspect);
        const slack = 1 - cropFraction;
        const percent = slack > 0.001
          ? Math.max(0, Math.min(1, (safeCx - cropFraction / 2) / slack)) * 100
          : 50;
        cropCacheRef.current.set(active.rank, percent);
        setCropPercent(percent);
      })
      .catch(() => {
        // no detection available: stay centred
      })
      .finally(() => window.clearTimeout(abortTimer));
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(abortTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staticCropPercent, active?.rank, active?.start, aspectRatio, videoId, videoUrl]);

  const handleListKeyDown = (e: React.KeyboardEvent) => {
    if (!onOffsetChange) return;
    const step = e.shiftKey ? 50 : 10;
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
    };
    const d = deltas[e.key];
    if (!d) return;
    e.preventDefault();
    onOffsetChange(offsetX + d[0], offsetY + d[1]);
  };
  const handleListPointerDown = (e: React.PointerEvent) => {
    if (!onOffsetChange) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragMovedRef.current = false;
    dragState.current = { startX: e.clientX, startY: e.clientY, baseX: offsetX, baseY: offsetY, moved: false };
  };
  const handleListPointerMove = (e: React.PointerEvent) => {
    const d = dragState.current;
    if (!d || !onOffsetChange) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    d.moved = true;
    dragMovedRef.current = true;
    const factor = 1080 / frameW;
    onOffsetChange(d.baseX + dx * factor, d.baseY + dy * factor);
  };
  const handleListPointerUp = () => {
    dragState.current = null;
  };

  const advance = (next?: number) => {
    if (!entries.length) return;
    const target = typeof next === 'number' ? next : activeIdx + 1;
    if (target < entries.length) {
      setActiveIdx(target);
    } else if (loop) {
      setActiveIdx(0);
    } else {
      setPlaying(false);
    }
  };

  // Direct <video>: seek whenever the active rank changes (but never when merely pausing, or a
  // pause would throw the window back to its start).
  useEffect(() => {
    const v = directRef.current;
    if (!isDirect || !v || !active) return;
    try {
      v.currentTime = active.start;
    } catch {
      // not seekable yet; the browser plays from wherever it can
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirect, activeIdx, active?.start]);

  // Play/pause follows the toggle alone.
  useEffect(() => {
    const v = directRef.current;
    if (!isDirect || !v) return;
    if (playing) v.play().catch(() => {});
    else v.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirect, playing]);

  // Mute follows the toggle.
  useEffect(() => {
    const v = directRef.current;
    if (!isDirect || !v) return;
    v.muted = muted;
    if (isDirect && ytRef.current) {
      try {
        if (muted) ytRef.current.mute?.();
        else ytRef.current.unMute?.();
      } catch {
        // ignore
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [muted, isDirect]);

  const handleTimeUpdate = () => {
    const v = directRef.current;
    if (!v || !active) return;
    setCurrentTime(v.currentTime);
    if (playing && v.currentTime >= active.end - 0.05) advance();
  };

  // YouTube: build an isolated player so the clip page's player is never disturbed.
  useEffect(() => {
    if (isDirect || !videoId) return;
    let disposed = false;
    const w = window as unknown as { YT?: { Player?: unknown } };
    const boot = () => {
      if (disposed || !w.YT?.Player) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Player = (w.YT as any).Player as new (id: string, opts: unknown) => {
        getCurrentTime?: () => number;
        seekTo?: (s: number, allowSeekAhead?: boolean) => void;
        playVideo?: () => void;
        pauseVideo?: () => void;
        mute?: () => void;
        unMute?: () => void;
        destroy?: () => void;
      };
      // A fresh target node every boot: the API replaces it with the iframe, so reusing the same
      // node across StrictMode's double mount would leave the second boot without an element.
      const wrapEl = document.querySelector('.rank-live-yt-wrap');
      const slot = document.createElement('div');
      slot.id = 'rank-live-yt-slot';
      wrapEl?.replaceChildren(slot);
      ytRef.current = new Player(slot.id, {
        videoId,
        playerVars: { autoplay: 0, controls: 0, playsinline: 1, rel: 0 },
        events: {
          onReady: (e: { target: { seekTo: (s: number, a: boolean) => void; playVideo: () => void; mute: () => void } }) => {
            if (!active) return;
            try {
              // Muted autoplay is allowed without a gesture, so the preview starts by itself.
              e.target.mute();
              e.target.seekTo(active.start, true);
              e.target.playVideo();
            } catch {
              // autoplay policy can block; the user can press play
            }
          },
          onStateChange: (e: { data: number }) => {
            if (e.data === 1) setPlaying(true);
            else if (e.data === 2) setPlaying(false);
          },
          onError: () => setPlayerError(true),
        },
      });
    };
    if (w.YT?.Player) {
      boot();
    } else {
      const prev = (window as unknown as { onYouTubeIframeAPIReady?: () => void }).onYouTubeIframeAPIReady;
      (window as unknown as { onYouTubeIframeAPIReady?: () => void }).onYouTubeIframeAPIReady = () => {
        prev?.();
        boot();
      };
      if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
        const s = document.createElement('script');
        s.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(s);
      }
    }
    return () => {
      disposed = true;
      try {
        ytRef.current?.destroy?.();
      } catch {
        // already gone
      }
      ytRef.current = null;
      document.querySelector('.rank-live-yt-wrap')?.replaceChildren();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirect, videoId]);

  // When the sequence advances, the YouTube player must jump to the new rank's window.
  useEffect(() => {
    if (isDirect || !active) return;
    try {
      ytRef.current?.seekTo?.(active.start, true);
    } catch {
      // player not ready yet
    }
    if (playing) {
      try {
        ytRef.current?.playVideo?.();
      } catch {
        // ignore
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirect, activeIdx, active?.start]);

  // Poll the YouTube player for the window boundary.
  useEffect(() => {
    if (isDirect || !active) return;
    const iv = window.setInterval(() => {
      try {
        const t = ytRef.current?.getCurrentTime?.();
        if (typeof t === 'number') {
          setCurrentTime(t);
          if (t >= active.end - 0.05) advance();
        }
      } catch {
        // player not ready yet
      }
    }, 400);
    return () => window.clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirect, active, activeIdx, loop]);

  const togglePlay = () => {
    if (isDirect && directRef.current) {
      if (playing) directRef.current.pause();
      else directRef.current.play().catch(() => {});
    } else {
      try {
        if (playing) ytRef.current?.pauseVideo?.();
        else ytRef.current?.playVideo?.();
      } catch {
        // ignore
      }
    }
    setPlaying(v => !v);
  };

  const toggleMute = () => {
    if (isDirect && directRef.current) {
      directRef.current.muted = !muted;
    } else {
      try {
        if (muted) ytRef.current?.unMute?.();
        else ytRef.current?.mute?.();
      } catch {
        // ignore
      }
    }
    setMuted(v => !v);
  };

  const jumpToRank = (rank: number) => {
    const idx = entries.findIndex(e => e.rank === rank);
    if (idx >= 0) {
      setActiveIdx(idx);
      setPlaying(true);
    }
  };

  // The canvas is what the export produces: always the portrait frame, except true landscape.
  // Inside it the video occupies its own ratio area, centred, with the rest left black — that is
  // exactly how the renderer lays a 1:1 or 4:3 cut out on the 1080x1920 canvas.
  const frameRatioClass = aspectRatio === '16:9_landscape' ? 'ratio-16-9_landscape' : 'ratio-9-16';
  const contentRatioClass = `box-${(aspectRatio || '9:16').replace(':', '-')}`;
  const isLetterbox = aspectRatio === '16:9';

  return (
    <div className="rank-live-preview">
      <div
        className={`rank-live-frame ${frameRatioClass}`}
        ref={frameRef}
        style={{ ['--crop-pct' as string]: cropPercent } as React.CSSProperties}
      >
        <div className={`rank-live-content ${contentRatioClass}`}>
        {renderedUrl && viewMode === 'rendered' ? (
          <>
            <video
              src={renderedUrl}
              controls
              playsInline
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
            />
            <div className="rank-live-rendered-badge">{t.studio.rankRenderedBadge}</div>
          </>
        ) : isDirect ? (
          <video
            ref={directRef}
            src={videoUrl || (videoId ? `/api/video/${videoId}` : '')}
            muted={muted}
            playsInline
            onTimeUpdate={handleTimeUpdate}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: isLetterbox ? 'contain' : 'cover',
              objectPosition: `${cropPercent}% 50%`,
              transition: 'object-position 0.3s ease-out',
              background: '#000',
            }}
          />
        ) : videoId ? (
          // The YouTube API replaces the target element with its iframe, so any sizing on the
          // target dies with it. The crop lives in CSS on the iframe inside this wrapper instead,
          // which survives the replacement.
          <div className="rank-live-yt-wrap">
            <div id="rank-live-yt-slot" style={{ position: 'absolute', inset: 0 }} />
          </div>
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: '0.8rem', padding: '0 1rem', textAlign: 'center' }}>
            {t.studio.rankNoPreview}
          </div>
        )}

        {entries.length === 0 && (
          <div className="rank-live-empty">{t.studio.rankNeedsTwo}</div>
        )}

        {playerError && !isDirect && (
          <div className="rank-live-empty">{t.studio.rankNoPreview}</div>
        )}
        </div>

        <div className="rank-live-overlay">
          {layoutPreset !== 'none' && (
            <div className="rank-live-preset-note">{t.studio.rankPresetNote}</div>
          )}
          <div className="rank-preview-title">{title.trim() || t.studio.rankingDefault}</div>
          <div
            className={`rank-preview-list rank-live-list pos-${position}`}
            style={{
              gap: spacingY ? `${toPx(spacingY)}px` : undefined,
              transform: `translate(${toPx(offsetX)}px, ${toPx(offsetY)}px) scale(${clampScale})`,
              transformOrigin: position.startsWith('bottom') ? 'left bottom' : 'left top',
              touchAction: 'none',
              cursor: onOffsetChange ? 'grab' : undefined,
            }}
            onPointerDown={handleListPointerDown}
            onPointerMove={handleListPointerMove}
            onPointerUp={handleListPointerUp}
            onPointerCancel={handleListPointerUp}
            tabIndex={0}
            onKeyDown={handleListKeyDown}
          >
            {skeleton.map(e => {
              const revealed = playedRanks.has(e.rank);
              return (
                <button
                  type="button"
                  key={`${e.rank}-${e.start}`}
                  className="rank-preview-item rank-live-jump"
                  onClick={() => {
                    if (dragMovedRef.current) {
                      dragMovedRef.current = false;
                      return;
                    }
                    jumpToRank(e.rank);
                  }}
                  title={`${t.studio.rankWord} ${e.rank}`}
                  style={{ fontWeight: weightFont[labelWeight] || 700 }}
                >
                  <span className={`rank-preview-num ${e.rank <= 3 ? `medal-${e.rank}` : ''} ${revealed ? '' : 'dimmed'}`}>{e.rank}.</span>
                  {revealed && (
                    <span
                      className={`rank-preview-label${labelTransition === 'fade' ? ' rank-label-anim' : ''}${labelTransition === 'slide' ? ' rank-label-anim rank-label-slide' : ''}`}
                    >
                      {trunc(e.label)}
                      {showScores && typeof e.score === 'number' ? ` · ${Math.round(e.score)}` : ''}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {liveCaption && (
            <div className={`studio-live-caption rank-live-caption mode-${captionPosition}`}>
              <span
                className="studio-live-caption-text"
                style={{
                  fontFamily: captionFont,
                  fontSize: `${captionPx}px`,
                  fontWeight: 800,
                  textShadow: '0 0 2px #000, 0 1px 3px rgba(0,0,0,0.95)',
                }}
              >
                {liveCaption.words.map((w, i) => (
                  <React.Fragment key={i}>
                    {i > 0 ? ' ' : ''}
                    <span className={i === liveCaption.activeIndex ? (CAPTION_HIGHLIGHT_CLASS[captionStyle] || 'pop-yellow') : undefined}>
                      {applyCase(w)}
                    </span>
                  </React.Fragment>
                ))}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="rank-live-controls">
        <button type="button" className="rank-live-btn" onClick={togglePlay} aria-label={t.studio.previewPlaying}>
          {playing ? '⏸' : '▶'}
        </button>
        <button type="button" className="rank-live-btn" onClick={toggleMute} aria-label={t.studio.rankMute}>
          {muted ? '🔇' : '🔊'}
        </button>
        {renderedUrl && (
          <button
            type="button"
            className="rank-live-btn"
            onClick={() => setViewMode(v => (v === 'sequence' ? 'rendered' : 'sequence'))}
            title={viewMode === 'sequence' ? t.studio.rankViewRendered : t.studio.rankViewSequence}
            aria-label={viewMode === 'sequence' ? t.studio.rankViewRendered : t.studio.rankViewSequence}
          >
            🎞
          </button>
        )}
        <span className="rank-live-progress">
          {active ? `${t.studio.rankWord} ${active.rank}/${entries.length} · ${active.label}` : ''}
        </span>
        <button
          type="button"
          className="rank-live-btn"
          onClick={() => {
            setActiveIdx(0);
            setPlaying(true);
          }}
          aria-label={t.studio.rankRestart}
        >
          ↺
        </button>
      </div>
      <div className="rank-live-bar">
        <div style={{ width: `${entries.length ? ((activeIdx + 1) / entries.length) * 100 : 0}%` }} />
      </div>
    </div>
  );
};
