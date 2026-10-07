import json
import logging
import os
from typing import Optional

from fastapi import APIRouter, HTTPException, Request

from backend.config import (
    COOKIES_PATH,
    ROOT_COOKIES_PATH,
    get_effective_cookies_path,
    get_browser_cookies_source,
    logger,
)
from backend.routers.system import _origin_is_allowed
from backend.schemas.downloads import CookiesSaveRequest

router = APIRouter(tags=["Cookies"])


def normalize_to_netscape(raw_content: str) -> str:
    """Cleans raw cookie input, strips UTF BOMs and null bytes, and auto-converts
    JSON cookies (from Cookie-Editor, EditThisCookie, etc.) to valid Netscape format for yt-dlp.
    """
    if not raw_content:
        return ""

    # 1. Clean encoding artifacts (BOMs, null bytes from UTF-16, mixed CRLF)
    text = (
        raw_content.replace("\ufeff", "")
        .replace("\ufffe", "")
        .replace("\x00", "")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .strip()
    )

    if not text:
        return ""

    # 2. Check if input is JSON (e.g. exported from Cookie-Editor / EditThisCookie)
    if text.startswith("[") or text.startswith("{"):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                parsed = [parsed]
            if isinstance(parsed, list) and len(parsed) > 0 and isinstance(parsed[0], dict):
                lines = [
                    "# Netscape HTTP Cookie File",
                    "# http://curl.haxx.se/rfc/cookie_spec.html",
                    "# Converted automatically from JSON format by CheatClip Pro",
                    "",
                ]
                count = 0
                for item in parsed:
                    domain = str(item.get("domain") or item.get("host") or "").strip()
                    if not domain:
                        continue
                    flag = "TRUE" if domain.startswith(".") else "FALSE"
                    path = str(item.get("path") or "/").strip()
                    secure = "TRUE" if item.get("secure") else "FALSE"
                    exp = item.get("expirationDate") or item.get("expires") or item.get("expiry") or 0
                    try:
                        exp_int = int(float(exp))
                    except Exception:
                        exp_int = 0
                    if exp_int <= 0:
                        exp_int = 2147483647  # year 2038 fallback for session cookies

                    name = str(item.get("name") or "").strip()
                    val = str(item.get("value") or "").strip()
                    if name:
                        lines.append(f"{domain}\t{flag}\t{path}\t{secure}\t{exp_int}\t{name}\t{val}")
                        count += 1

                if count > 0:
                    logger.info(f"Successfully converted {count} JSON cookies into Netscape format.")
                    return "\n".join(lines) + "\n"
                # JSON parsed but contained no usable cookies (unsupported export shape):
                # fail loudly instead of writing the raw JSON as a bogus Netscape file.
                return ""
        except Exception as json_err:
            logger.debug(f"JSON cookie parse check skipped: {json_err}")

    # 3. Handle standard Netscape text: ensure standard Netscape header is present
    lines = text.split("\n")
    cleaned_lines = []
    has_header = False

    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if "# Netscape HTTP Cookie File" in stripped:
            has_header = True
        cleaned_lines.append(stripped)

    if not has_header:
        cleaned_lines.insert(0, "# Netscape HTTP Cookie File")
        cleaned_lines.insert(1, "# http://curl.haxx.se/rfc/cookie_spec.html")
        cleaned_lines.insert(2, "")

    return "\n".join(cleaned_lines) + "\n"


@router.post("/api/cookies")
async def save_youtube_cookies(request: Request):
    if not _origin_is_allowed(request.headers.get("origin", "")):
        raise HTTPException(status_code=403, detail="Cross-origin request rejected")

    content = ""
    # Try reading as JSON first
    try:
        data = await request.json()
        if isinstance(data, dict):
            content = str(data.get("cookies_content") or data.get("cookies") or "")
        elif isinstance(data, list):
            content = json.dumps(data)
    except Exception:
        # Fallback to reading raw body text
        try:
            body_bytes = await request.body()
            content = body_bytes.decode("utf-8", errors="ignore")
        except Exception:
            pass

    normalized = normalize_to_netscape(content)
    if not normalized or len(normalized.strip()) < 10:
        raise HTTPException(
            status_code=400,
            detail="Cookies content is empty or invalid. Please paste or upload valid cookies (Netscape .txt or JSON format).",
        )

    try:
        def _atomic_write(target) -> None:
            """Write via temp file + rename so a concurrent yt-dlp write-back can't truncate it."""
            target.parent.mkdir(parents=True, exist_ok=True)
            tmp = target.with_name(target.name + ".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(normalized)
            os.replace(tmp, target)

        _atomic_write(COOKIES_PATH)
        try:
            _atomic_write(ROOT_COOKIES_PATH)
        except Exception:
            pass

        return {
            "success": True,
            "status": "saved",
            "exists": True,
            "has_cookies": True,
            "size": len(normalized),
        }
    except Exception as e:
        logger.error(f"Failed to save cookies: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to write cookies file: {str(e)}")


@router.get("/api/cookies")
def get_youtube_cookies_status():
    # Cookies can also come straight from a browser profile (YTDLP_COOKIES_FROM_BROWSER).
    # Reporting "no cookies" in that setup would mislead the badge and the pre-render warning
    # in the UI, so the source is reported explicitly.
    browser_source = get_browser_cookies_source()
    eff = get_effective_cookies_path()
    if eff and eff.exists():
        sample_lines = []
        try:
            with open(eff, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#"):
                        parts = line.split("\t")
                        if parts and len(parts) > 0:
                            domain = parts[0]
                            if domain not in sample_lines:
                                sample_lines.append(domain)
                            if len(sample_lines) >= 6:
                                break
        except Exception:
            pass
        return {
            "exists": True,
            "has_cookies": True,
            "size": eff.stat().st_size,
            "sample_lines": sample_lines,
            "source": "file",
            "cookies_content": ""  # Redacted to prevent credential exposure
        }
    if browser_source:
        return {
            "exists": True,
            "has_cookies": True,
            "size": 0,
            "sample_lines": [f"{browser_source} (browser profile)"],
            "source": "browser",
            "cookies_content": ""
        }
    return {"exists": False, "has_cookies": False, "size": 0, "sample_lines": [], "source": "none", "cookies_content": ""}


@router.delete("/api/cookies")
def delete_youtube_cookies(request: Request):
    if not _origin_is_allowed(request.headers.get("origin", "")):
        raise HTTPException(status_code=403, detail="Cross-origin request rejected")
    for p in [COOKIES_PATH, ROOT_COOKIES_PATH]:
        if p.exists():
            try:
                p.unlink()
            except Exception:
                pass
    return {"success": True, "status": "deleted", "exists": False, "has_cookies": False}
