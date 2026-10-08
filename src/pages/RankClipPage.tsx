import React, { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../locales';
import { ClipStudioSection } from '../components/ClipStudioSection';
import { runAnalysis } from '../utils/analyzeStream';
import type { AnalyzeResponse, BatchRenderProgress, RenderSettings, ViralClip } from '../types';

interface RankClipPageProps {
  apiKey: string;
  model: string;
}

interface SavedAnalysis {
  key: string;
  videoId: string;
  title: string;
  clips: number;
  analyzedAt: string;
  itemUrl: string;
  thumb: string;
  data: AnalyzeResponse;
}

/**
 * Reads every analysis the app has cached, whichever page produced it: the clip page and this one
 * write the same `cheat_clip_cache_*` / `cheat_clip_ts_*` keys, so a video analysed once shows up in
 * both places and the rank page never has to re-analyse something it already knows.
 */
function readSavedAnalyses(): SavedAnalysis[] {
  const entries: SavedAnalysis[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith('cheat_clip_cache_')) continue;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const data = JSON.parse(raw) as AnalyzeResponse;
      if (!data || !data.video_id) continue;

      const videoId = data.video_id;
      const rest = key.substring('cheat_clip_cache_'.length);
      const suffix = rest.substring(videoId.length + 1);
      const durationPref = suffix.split('_')[0];
      const rangeSuffix = suffix.substring(durationPref.length);

      const isGDrive = data.source_type === 'gdrive' || videoId.startsWith('gdrive_');
      const isUpload = data.source_type === 'upload' || videoId.startsWith('upload_');
      const itemUrl = isUpload
        ? (data.video_url || `/api/video/${videoId}`)
        : isGDrive
        ? (data.video_url || videoId)
        : `https://www.youtube.com/watch?v=${videoId}`;

      entries.push({
        key,
        videoId,
        title: data.title || videoId,
        clips: (data.clips || []).length,
        analyzedAt: localStorage.getItem(`cheat_clip_ts_${videoId}_${durationPref}${rangeSuffix}`) || '',
        itemUrl,
        thumb: (isGDrive || isUpload)
          ? `/api/clip-frame?video_id=${encodeURIComponent(videoId)}&timestamp=2`
          : `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
        data,
      });
    } catch {
      // a corrupt entry should never take the page down
    }
  }
  const seen = new Set<string>();
  return entries
    .filter(entry => {
      // one entry per video: keep the most recent analysis
      const keyId = entry.videoId;
      if (seen.has(keyId)) return false;
      seen.add(keyId);
      return true;
    })
    .sort((a, b) => (b.analyzedAt || '').localeCompare(a.analyzedAt || '')).slice(0, 24);
}

const RANK_CACHE_SUFFIX = '10s_rank';

/** Saves this page's analysis under the shared key so the clip page can reuse it too. */
function persistAnalysis(data: AnalyzeResponse, sourceUrl: string) {
  if (!data?.video_id) return;
  const key = `cheat_clip_cache_${data.video_id}_${RANK_CACHE_SUFFIX}`;
  try {
    localStorage.setItem(key, JSON.stringify({ ...data, video_url: data.video_url || sourceUrl }));
    localStorage.setItem(`cheat_clip_ts_${data.video_id}_${RANK_CACHE_SUFFIX}`, new Date().toISOString());
  } catch {
    // storage full or unavailable: analysis still works, it just will not be remembered
  }
}

/**
 * The rank page: its own source, its own analysis and its own clips, kept apart from the clip page
 * so the two never share marked clips, progress or results. Only the Gemini key is handed in.
 */
export const RankClipPage: React.FC<RankClipPageProps> = ({ apiKey, model }) => {
  const { t } = useLanguage();

  const [url, setUrl] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState('');
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [markedClips, setMarkedClips] = useState<Record<string, boolean>>({});
  const [batchProgress, setBatchProgress] = useState<BatchRenderProgress | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [saved, setSaved] = useState<SavedAnalysis[]>([]);
  const [savedOpen, setSavedOpen] = useState(false);

  useEffect(() => {
    setSaved(readSavedAnalyses());
  }, []);

  const markTopClips = (clips: ViralClip[]) => {
    const top = [...clips].sort((a, b) => (b.virality_score || 0) - (a.virality_score || 0)).slice(0, 6);
    const marks: Record<string, boolean> = {};
    top.forEach(c => {
      marks[`${c.start_time}_${c.end_time}`] = true;
    });
    setMarkedClips(marks);
  };

  const useSavedAnalysis = (entry: SavedAnalysis) => {
    setResult(entry.data);
    setUrl(entry.itemUrl);
    setSourceName(entry.title);
    setError(null);
    markTopClips(entry.data.clips || []);
    setSavedOpen(false);
    // Jump straight to the setup: the analysis is already done, nothing to re-run.
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  };

  const deleteSavedAnalysis = (entry: SavedAnalysis) => {
    try {
      localStorage.removeItem(entry.key);
      const rest = entry.key.substring('cheat_clip_cache_'.length);
      const suffix = rest.substring(entry.videoId.length + 1);
      localStorage.removeItem(`cheat_clip_ts_${entry.videoId}_${suffix}`);
    } catch {
      // storage unavailable; the entry just stays
    }
    setSaved(readSavedAnalyses());
  };

  const analysisAbort = useRef<AbortController | null>(null);
  const renderStream = useRef<EventSource | null>(null);
  const uploadInput = useRef<HTMLInputElement | null>(null);

  const markedClipsList: ViralClip[] = (result?.clips || []).filter(
    c => markedClips[`${c.start_time}_${c.end_time}`]
  );

  const handleAnalyze = async () => {
    if (!url.trim()) {
      setError(t.rankPage.urlRequired);
      return;
    }
    if (!apiKey.trim()) {
      setError(t.errors.apiKeyRequired);
      return;
    }

    analysisAbort.current?.abort();
    const controller = new AbortController();
    analysisAbort.current = controller;

    setLoading(true);
    setError(null);
    setResult(null);
    setMarkedClips({});
    setProgress('');
    setPercent(0);

    try {
      const data = await runAnalysis({
        url: url.trim(),
        apiKey: apiKey.trim(),
        model,
        duration: '15s',
        // Six is the rank ceiling, so ask for six candidates and preselect them.
        targetClipCount: 6,
        signal: controller.signal,
        onProgress: (message, pct) => {
          setProgress(message);
          if (typeof pct === 'number') setPercent(pct);
        },
      });
      setResult(data);
      markTopClips(data.clips || []);
      persistAnalysis(data, url.trim());
      setSaved(readSavedAnalyses());
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLoading(false);
    }
  };

  const handleUpload = async (file: File) => {
    setLoading(true);
    setError(null);
    setProgress(t.rankPage.uploading);
    setPercent(0);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/upload-video', { method: 'POST', body: form });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error((detail as { detail?: string }).detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setUrl(`/api/video/${data.saved_name}`);
      setSourceName(file.name);
      setProgress('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleStartRender = async (settings: RenderSettings) => {
    if (!result) return;
    setIsRendering(true);
    setError(null);
    try {
      const body = {
        video_url: result.video_url || url,
        video_id: result.video_id,
        clips: settings.selectedClips,
        transcript: result.transcript,
        settings: {
          aspect_ratio: settings.aspectRatio,
          background_style: settings.backgroundStyle,
          enable_face_tracking: settings.enableFaceTracking,
          streamer_preset: settings.streamerPreset,
          facecam_position: settings.facecamPosition || 'auto',
          title_position: 'none',
          caption_style: settings.captionStyle,
          caption_font: settings.captionFont,
          font_size: settings.fontSize,
          text_case: settings.textCase,
          subtitles_enabled: settings.captionStyle !== 'none',
          subtitle_position_mode: settings.subtitlePositionMode,
          subtitle_center_y_percent: settings.subtitleCenterYPercent,
          subtitle_offset_sec: settings.subtitleOffsetSec || 0,
          bgm_enabled: settings.bgmEnabled && !!settings.bgmFilePath,
          bgm_file_path: settings.bgmFilePath,
          bgm_volume: settings.bgmVolume,
          hook_sfx_enabled: settings.hookSfxEnabled && !!settings.hookSfxFilePath,
          hook_sfx_file_path: settings.hookSfxFilePath,
          hook_sfx_volume: settings.hookSfxVolume,
          original_audio_volume: settings.originalAudioVolume,
          watermark_enabled: settings.watermarkEnabled,
          watermark_type: settings.watermarkType,
          watermark_file_path: settings.watermarkFilePath,
          watermark_text: settings.watermarkText,
          watermark_size: settings.watermarkSize,
          watermark_opacity: settings.watermarkOpacity,
          watermark_x: settings.watermarkX,
          watermark_y: settings.watermarkY,
          hardware_accel: settings.hardwareAccel || 'auto',
          rank_highlight: settings.rankHighlight ? {
            enabled: true,
            ranking_title: settings.rankHighlight.rankingTitle || null,
            rank_count: settings.rankHighlight.rankCount,
            clip_seconds: settings.rankHighlight.clipSeconds,
            position_mode: settings.rankHighlight.positionMode,
            show_numbers: true,
            show_scores: settings.rankHighlight.showScores === true,
            ranks: settings.rankHighlight.ranks,
          } : undefined,
        },
      };

      const resp = await fetch('/api/render-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const detail = await resp.json().catch(() => ({}));
        throw new Error((detail as { detail?: string }).detail || `HTTP ${resp.status}`);
      }
      const { batch_id: batchId } = await resp.json();

      renderStream.current?.close();
      const stream = new EventSource(`/api/render-progress/${batchId}`);
      renderStream.current = stream;
      stream.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as BatchRenderProgress;
          setBatchProgress(data);
          if (data.overall_status === 'completed' || data.overall_status === 'error') {
            stream.close();
            renderStream.current = null;
            setIsRendering(false);
          }
        } catch {
          // ignore malformed frames
        }
      };
      stream.onerror = () => {
        stream.close();
        renderStream.current = null;
        setIsRendering(false);
      };
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setIsRendering(false);
    }
  };

  return (
    <div className="rank-page">
      <section className="glass-panel" style={{ marginBottom: '1.25rem' }}>
        <div className="section-title">🏆 {t.rankPage.title}</div>
        <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', margin: '0.35rem 0 0.9rem', lineHeight: 1.55 }}>
          {t.rankPage.subtitle}
        </p>

        <div className="form-main-input-row" style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
          <input
            className="form-input"
            style={{ flex: 1, minWidth: '240px' }}
            placeholder={t.rankPage.urlPlaceholder}
            value={url}
            onChange={e => {
              setUrl(e.target.value);
              setSourceName('');
            }}
            disabled={loading}
          />
          <button type="button" className="btn-quiet" onClick={() => uploadInput.current?.click()} disabled={loading}>
            {t.rankPage.uploadBtn}
          </button>
          <button type="button" className="glowing-btn" onClick={handleAnalyze} disabled={loading}>
            {loading ? t.rankPage.analyzing : t.rankPage.analyzeBtn}
          </button>
        </div>
        <input
          ref={uploadInput}
          type="file"
          accept="video/*"
          style={{ display: 'none' }}
          onChange={e => {
            const file = e.target.files?.[0];
            if (file) handleUpload(file);
            e.target.value = '';
          }}
        />

        {sourceName && (
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
            {t.rankPage.sourceLabel}: {sourceName}
          </div>
        )}

        {loading && (
          <div style={{ marginTop: '0.8rem' }}>
            <div className="progress-track" style={{ height: '6px', background: 'rgba(255,255,255,0.08)', borderRadius: '999px', overflow: 'hidden' }}>
              <div style={{ width: `${Math.max(4, percent)}%`, height: '100%', background: 'linear-gradient(90deg,#a855f7,#38bdf8)', transition: 'width 0.3s ease' }} />
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.35rem' }}>{progress}</div>
          </div>
        )}

        {saved.length > 0 && (
          <div style={{ marginTop: '0.9rem', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '0.75rem' }}>
            <button
              type="button"
              className="btn-quiet"
              onClick={() => setSavedOpen(v => !v)}
              style={{ fontSize: '0.8rem', padding: '0.35rem 0.7rem' }}
            >
              {savedOpen ? t.rankPage.savedHide : t.rankPage.savedShow(saved.length)}
            </button>

            {savedOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.6rem', maxHeight: '260px', overflowY: 'auto' }}>
                {saved.map(entry => (
                  <button
                    key={entry.key}
                    type="button"
                    onClick={() => useSavedAnalysis(entry)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.45rem 0.6rem',
                      borderRadius: '10px', border: '1px solid rgba(255,255,255,0.08)',
                      background: 'rgba(255,255,255,0.03)', cursor: 'pointer', textAlign: 'left'
                    }}
                  >
                    <img
                      src={entry.thumb}
                      alt=""
                      style={{ width: '56px', height: '32px', objectFit: 'cover', borderRadius: '6px', flexShrink: 0, background: '#000' }}
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {entry.title}
                      </span>
                      <span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                        {t.rankPage.savedClips(entry.clips)}
                        {entry.analyzedAt ? ` · ${new Date(entry.analyzedAt).toLocaleDateString()}` : ''}
                      </span>
                    </span>
                    <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#c084fc', flexShrink: 0 }}>{t.rankPage.savedUse}</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteSavedAnalysis(entry);
                      }}
                      title={t.rankPage.savedDelete}
                      aria-label={t.rankPage.savedDelete}
                      style={{
                        background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer',
                        fontSize: '0.85rem', padding: '0.1rem 0.3rem', flexShrink: 0,
                      }}
                    >
                      ✕
                    </button>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {error && (
          <div style={{ marginTop: '0.8rem', padding: '0.6rem 0.8rem', borderRadius: '8px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', color: '#f87171', fontSize: '0.8rem' }}>
            {error}
          </div>
        )}
      </section>

      {result && (
        <ClipStudioSection
          rankMode
          videoUrl={result.video_url || url}
          videoId={result.video_id}
          transcript={result.transcript}
          allClips={result.clips}
          markedClips={markedClipsList}
          activeClip={markedClipsList[0] || null}
          onStartRender={handleStartRender}
          isRendering={isRendering}
          onToggleMarkClip={clip =>
            setMarkedClips(prev => {
              const key = `${clip.start_time}_${clip.end_time}`;
              const next = { ...prev };
              if (next[key]) delete next[key];
              else next[key] = true;
              return next;
            })
          }
          onToggleAllClips={forceSelect =>
            setMarkedClips(() => {
              const select = forceSelect ?? markedClipsList.length !== (result.clips || []).length;
              if (!select) return {};
              const marks: Record<string, boolean> = {};
              (result.clips || []).forEach(c => {
                marks[`${c.start_time}_${c.end_time}`] = true;
              });
              return marks;
            })
          }
          batchProgress={batchProgress}
          onDismissProgress={() => {
            renderStream.current?.close();
            renderStream.current = null;
            setBatchProgress(null);
          }}
        />
      )}
    </div>
  );
};
