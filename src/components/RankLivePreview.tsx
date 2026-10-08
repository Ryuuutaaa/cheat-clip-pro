import React, { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../locales';
import type { ViralClip } from '../types';

export interface RankPreviewEntry {
  clip: ViralClip;
  label: string;
  rank: number;   // number shown on screen (1 = the winner)
  start: number;  // window start (the hook)
  end: number;    // window end
}

interface RankLivePreviewProps {
  /** Playback order: the highest rank number first, the winner last (countdown). */
  entries: RankPreviewEntry[];
  title: string;
  position: 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right';
  aspectRatio: string;
  videoUrl: string;
  videoId: string;
  loop?: boolean;
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
  loop = true,
}) => {
  const { t } = useLanguage();
  const directRef = useRef<HTMLVideoElement | null>(null);
  const ytRef = useRef<{
    getCurrentTime?: () => number;
    seekTo?: (s: number, allowSeekAhead?: boolean) => void;
    playVideo?: () => void;
    pauseVideo?: () => void;
    destroy?: () => void;
  } | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [playing, setPlaying] = useState(true);

  const isDirect = Boolean(
    videoUrl && (
      videoUrl.endsWith('.mp4') || videoUrl.endsWith('.webm') || videoUrl.endsWith('.mov') ||
      videoUrl.endsWith('.mkv') || videoUrl.includes('/api/video') || videoUrl.startsWith('blob:') ||
      videoId?.startsWith('upload_') || videoId?.startsWith('gdrive_')
    )
  );
  const active = entries.length > 0 ? entries[Math.min(activeIdx, entries.length - 1)] : null;
  // The newest rank sits at the bottom of the list, so the accumulated entries render top-first.
  const shown = [...entries.slice(0, activeIdx + 1)].reverse();

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

  // Direct <video>: seek to the active rank's window whenever it changes.
  useEffect(() => {
    const v = directRef.current;
    if (!isDirect || !v || !active) return;
    try {
      v.currentTime = active.start;
    } catch {
      // not seekable yet; the browser plays from wherever it can
    }
    if (playing) {
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  }, [isDirect, activeIdx, active?.start, playing]);

  const handleTimeUpdate = () => {
    const v = directRef.current;
    if (!v || !active || !playing) return;
    if (v.currentTime >= active.end - 0.05) advance();
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
        destroy?: () => void;
      };
      ytRef.current = new Player('rank-live-yt-slot', {
        videoId,
        playerVars: { autoplay: 0, controls: 1, playsinline: 1, rel: 0 },
        events: {
          onReady: (e: { target: { seekTo: (s: number, a: boolean) => void; playVideo: () => void } }) => {
            if (!active) return;
            try {
              e.target.seekTo(active.start, true);
              e.target.playVideo();
            } catch {
              // autoplay policy can block; the user can press play
            }
          },
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirect, videoId]);

  // Poll the YouTube player for the window boundary.
  useEffect(() => {
    if (isDirect || !active) return;
    const iv = window.setInterval(() => {
      try {
        const t = ytRef.current?.getCurrentTime?.();
        if (typeof t === 'number' && t >= active.end - 0.05) advance();
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

  const ratioClass = `ratio-${(aspectRatio || '9:16').replace(':', '-')}`;
  const isLetterbox = aspectRatio === '16:9_letterbox';
  // The export crops the 16:9 source into the frame (except letterbox). The direct video does that
  // with object-fit, but a YouTube iframe always renders 16:9, so it must be over-scaled to the
  // point where the frame is filled and the sides fall outside — the centre crop the export starts
  // from (face tracking refines it at render time).
  const ytCropWidthPct: Record<string, number> = {
    '9:16': 316,
    '1:1': 178,
    '4:3': 133,
    '16:9_landscape': 100,
    '16:9_letterbox': 100,
  };
  const ytSlotStyle = isLetterbox
    ? { position: 'absolute' as const, inset: 0 }
    : {
        position: 'absolute' as const,
        top: 0,
        bottom: 0,
        left: '50%',
        transform: 'translateX(-50%)',
        width: `${ytCropWidthPct[aspectRatio] || 316}%`,
      };

  return (
    <div className="rank-live-preview">
      <div className={`rank-live-frame ${ratioClass}`}>
        {isDirect ? (
          <video
            ref={directRef}
            src={videoUrl || (videoId ? `/api/video/${videoId}` : '')}
            muted
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
          <div id="rank-live-yt-slot" style={ytSlotStyle} />
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: '0.8rem', padding: '0 1rem', textAlign: 'center' }}>
            {t.studio.rankNoPreview}
          </div>
        )}

        <div className="rank-live-overlay">
          <div className="rank-preview-title">{title.trim() || t.studio.rankingDefault}</div>
          <div className={`rank-preview-list rank-live-list pos-${position}`}>
            {shown.map(e => (
              <div key={`${e.rank}-${e.start}`} className="rank-preview-item">
                <span className={`rank-preview-num ${e.rank <= 3 ? `medal-${e.rank}` : ''}`}>{e.rank}.</span>
                <span className="rank-preview-label">{e.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="rank-live-controls">
        <button type="button" className="rank-live-btn" onClick={togglePlay} aria-label={t.studio.previewPlaying}>
          {playing ? '⏸' : '▶'}
        </button>
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
