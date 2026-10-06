/**
 * Storage helpers that never throw.
 *
 * Browsers can block localStorage entirely (SecurityError, e.g. "Block all cookies"
 * or partitioned third-party contexts) or fail writes (QuotaExceededError). A raw
 * access inside a React render initializer would otherwise blank the whole app.
 */
export const safeStorage = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* storage unavailable or full — ignore */
    }
  },
  remove(key: string): void {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};
