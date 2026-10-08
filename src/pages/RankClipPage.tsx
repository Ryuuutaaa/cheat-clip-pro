import React, { useRef, useState } from 'react';
import { useLanguage } from '../locales';
import { ClipStudioSection } from '../components/ClipStudioSection';
import { runAnalysis } from '../utils/analyzeStream';
import type { AnalyzeResponse, BatchRenderProgress, RenderSettings, ViralClip } from '../types';

interface RankClipPageProps {
  apiKey: string;
  model: string;
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
      const top = [...(data.clips || [])]
        .sort((a, b) => (b.virality_score || 0) - (a.virality_score || 0))
        .slice(0, 6);
      const marks: Record<string, boolean> = {};
      top.forEach(c => {
        marks[`${c.start_time}_${c.end_time}`] = true;
      });
      setMarkedClips(marks);
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
