import type { AnalyzeResponse } from '../types';

export interface AnalyzeOptions {
  url: string;
  apiKey: string;
  model: string;
  duration?: string;
  targetClipCount?: number | 'auto';
  signal?: AbortSignal;
  onProgress?: (message: string, percent?: number) => void;
}

/**
 * Runs an analysis and resolves with the finished result.
 *
 * The endpoint streams over SSE: an `error` field ends it badly, `done` carries the payload, and
 * anything else is a progress tick. Both the clip page and the rank page need exactly this, so it
 * lives here rather than being written twice.
 */
export async function runAnalysis(opts: AnalyzeOptions): Promise<AnalyzeResponse> {
  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: opts.signal,
    body: JSON.stringify({
      url: opts.url,
      api_key: opts.apiKey,
      model: opts.model,
      duration: opts.duration || '15s',
      target_clip_count: opts.targetClipCount ?? 'auto',
    }),
  });

  if (!res.ok || !res.body) {
    let detail = `HTTP ${res.status}`;
    try {
      detail = (await res.json()).detail || detail;
    } catch {
      // keep the status text
    }
    throw new Error(detail);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: AnalyzeResponse | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() || '';

    for (const chunk of chunks) {
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (event.error) throw new Error(String(event.error));
        if (event.done) {
          result = event.result as AnalyzeResponse;
          continue;
        }
        opts.onProgress?.(
          String(event.message || event.stage || '…'),
          typeof event.overall_progress === 'number' ? event.overall_progress : undefined
        );
      }
    }
  }

  if (!result) throw new Error('The analysis finished without a result');
  return result;
}
