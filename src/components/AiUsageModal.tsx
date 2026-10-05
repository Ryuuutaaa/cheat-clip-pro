import React, { useEffect, useState } from 'react';
import { useLanguage } from '../locales';
import { resilientFetch } from '../utils/api';

interface AiUsageModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface UsageRecord {
  timestamp: number;
  model: string;
  ok: boolean;
  total_tokens: number;
  clip_count?: number | null;
}

interface UsageSummary {
  total_analyses: number;
  total_calls: number;
  total_failed: number;
  prompt_tokens: number;
  candidates_tokens: number;
  total_tokens: number;
  last_model?: string | null;
  recent: UsageRecord[];
}

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div
    style={{
      background: 'rgba(255,255,255,0.04)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: '8px',
      padding: '0.6rem 0.75rem',
    }}
  >
    <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginBottom: '0.2rem' }}>{label}</div>
    <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#fff', wordBreak: 'break-word' }}>{value}</div>
  </div>
);

export const AiUsageModal: React.FC<AiUsageModalProps> = ({ isOpen, onClose }) => {
  const { t } = useLanguage();
  const [data, setData] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await resilientFetch('/api/ai-usage', { maxRetries: 3, retryDelay: 800, silent: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch {
      setError(t.aiUsage.loadError);
    } finally {
      setLoading(false);
    }
  };

  const reset = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/ai-usage/reset', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch {
      setError(t.aiUsage.loadError);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) load();
  }, [isOpen]);

  if (!isOpen) return null;

  const fmt = (n?: number) => (n ?? 0).toLocaleString();
  const fmtTime = (ts: number) => new Date(ts * 1000).toLocaleTimeString();

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="cookies-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="studio-modal-header">
          <div className="studio-header-title">
            <div className="studio-icon-badge">📊</div>
            <div>
              <div className="studio-title-row">
                <h2>{t.aiUsage.modalTitle}</h2>
              </div>
              <p className="studio-header-desc">{t.aiUsage.modalDesc}</p>
            </div>
          </div>
          <button className="studio-close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="cookies-modal-scrollable" style={{ padding: '1rem 1.25rem' }}>
          {loading && <p style={{ color: 'var(--text-muted)' }}>…</p>}
          {error && <div className="cookie-alert-box alert-error">{error}</div>}

          {data && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.6rem', marginBottom: '0.9rem' }}>
                <Stat label={t.aiUsage.analysesLabel} value={fmt(data.total_analyses)} />
                <Stat label={t.aiUsage.totalTokensLabel} value={fmt(data.total_tokens)} />
                <Stat label={t.aiUsage.promptTokensLabel} value={fmt(data.prompt_tokens)} />
                <Stat label={t.aiUsage.outputTokensLabel} value={fmt(data.candidates_tokens)} />
                <Stat label={t.aiUsage.failedLabel} value={fmt(data.total_failed)} />
                <Stat label={t.aiUsage.lastModelLabel} value={data.last_model || '—'} />
              </div>

              <h4 style={{ margin: '0.4rem 0' }}>{t.aiUsage.recentTitle}</h4>
              {data.recent.length === 0 ? (
                <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{t.aiUsage.empty}</p>
              ) : (
                <table style={{ width: '100%', fontSize: '0.74rem', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                      <th style={{ padding: '0.25rem 0.35rem' }}>{t.aiUsage.colTime}</th>
                      <th style={{ padding: '0.25rem 0.35rem' }}>{t.aiUsage.colModel}</th>
                      <th style={{ padding: '0.25rem 0.35rem' }}>{t.aiUsage.colTokens}</th>
                      <th style={{ padding: '0.25rem 0.35rem' }}>{t.aiUsage.colStatus}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent.map((r, i) => (
                      <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                        <td style={{ padding: '0.25rem 0.35rem', color: 'var(--text-muted)' }}>{fmtTime(r.timestamp)}</td>
                        <td style={{ padding: '0.25rem 0.35rem' }}>{r.model}</td>
                        <td style={{ padding: '0.25rem 0.35rem' }}>{fmt(r.total_tokens)}</td>
                        <td style={{ padding: '0.25rem 0.35rem', color: r.ok ? '#4ade80' : '#f87171', fontWeight: 700 }}>
                          {r.ok ? t.aiUsage.statusOk : t.aiUsage.statusFail}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>

        <div className="studio-modal-footer">
          <button
            type="button"
            className="studio-btn-cancel"
            onClick={reset}
            disabled={loading}
            style={{ marginRight: 'auto' }}
          >
            {t.aiUsage.resetBtn}
          </button>
          <button className="studio-btn-cancel" onClick={onClose}>
            {t.aiUsage.closeBtn}
          </button>
          <button className="studio-btn-render glowing-btn" onClick={load} disabled={loading}>
            {t.aiUsage.refreshBtn}
          </button>
        </div>
      </div>
    </div>
  );
};
