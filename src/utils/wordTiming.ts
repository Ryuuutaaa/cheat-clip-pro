import type { TranscriptLine } from '../types';

export interface TimedWord {
  word: string;
  start: number;
  end: number;
}

export interface CaptionState {
  words: string[];
  activeIndex: number;
}

/**
 * Derives per-word timings from a line-level transcript using the SAME
 * character-proportional distribution as the backend `transcribe_clip_words`.
 * Keeping both in sync means the live studio preview matches the final
 * burned-in (.ass) subtitles as closely as possible.
 */
export function buildTimedWords(lines?: TranscriptLine[]): TimedWord[] {
  if (!lines || lines.length === 0) return [];
  const out: TimedWord[] = [];
  for (const line of lines) {
    const text = (line.text || '').trim();
    if (!text) continue;
    const start = typeof line.start === 'number' ? line.start : 0;
    const end =
      typeof line.end === 'number' && line.end > start
        ? line.end
        : start + Math.max(1.8, text.split(/\s+/).length * 0.38);
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const dur = Math.max(0.2, end - start);
    const totalChars = Math.max(1, words.reduce((a, w) => a + Math.max(1, w.length), 0));
    let cur = start;
    for (const w of words) {
      const wd = Math.max(0.15, (Math.max(1, w.length) / totalChars) * dur);
      out.push({ word: w, start: cur, end: cur + wd });
      cur += wd;
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** Packs words into 1-3 word / <=16 char chunks, mirroring `generate_ass_file`. */
export function buildWordChunks(words: TimedWord[]): TimedWord[][] {
  const chunks: TimedWord[][] = [];
  let cur: TimedWord[] = [];
  let curChars = 0;
  for (const w of words) {
    const len = w.word.length;
    if (cur.length >= 3 || (cur.length > 0 && curChars + len > 16)) {
      chunks.push(cur);
      cur = [w];
      curChars = len;
    } else {
      cur.push(w);
      curChars += len + 1;
    }
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

/** Returns the caption chunk visible at `time` plus the active (spoken) word index. */
export function getCaptionAt(chunks: TimedWord[][], time: number): CaptionState | null {
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const w = chunk[i];
      if (time >= w.start - 0.02 && time <= w.end) {
        return { words: chunk.map((c) => c.word), activeIndex: i };
      }
    }
  }
  return null;
}

/** Maps a caption style id to the CSS highlight class used for the active word. */
export const CAPTION_HIGHLIGHT_CLASS: Record<string, string> = {
  viral_pop: 'pop-yellow',
  beast_punch: 'pop-green',
  cyber_violet: 'pop-violet',
  fire_red: 'pop-red',
  electric_cyan: 'pop-cyan',
  golden_aura: 'pop-gold',
};
