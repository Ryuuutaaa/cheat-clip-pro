/**
 * Clipboard helper that never throws.
 *
 * `navigator.clipboard` is unavailable over plain http:// (common when this app is
 * opened from a LAN IP / phone), and a denied write rejects. Both cases used to
 * surface as a silent failure (or an unhandled rejection) in the copy buttons.
 *
 * Returns true when the text really made it to the clipboard.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }

  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.top = '-1000px';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    el.remove();
    return ok;
  } catch {
    return false;
  }
}
