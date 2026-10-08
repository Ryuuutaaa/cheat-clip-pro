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

  const ratioClass = `ratio-${(aspectRatio || '9:16').replace(':', '-')}`;
  const isLetterbox = aspectRatio === '16:9';

  return (
    <div className="rank-live-preview">
      <div className={`rank-live-frame ${ratioClass}`}>
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

        <div className="rank-live-overlay">
          <div className="rank-preview-title">{title.trim() || t.studio.rankingDefault}</div>
          <div className={`rank-preview-list rank-live-list pos-${position}`}>
            {skeleton.map(e => {
              const revealed = playedRanks.has(e.rank);
              return (
                <button
                  type="button"
                  key={`${e.rank}-${e.start}`}
                  className="rank-preview-item rank-live-jump"
                  onClick={() => jumpToRank(e.rank)}
                  title={`${t.studio.rankWord} ${e.rank}`}
                >
                  <span className={`rank-preview-num ${e.rank <= 3 ? `medal-${e.rank}` : ''} ${revealed ? '' : 'dimmed'}`}>{e.rank}.</span>
                  {revealed && (
                    <span className="rank-preview-label">
                      {e.label}
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
