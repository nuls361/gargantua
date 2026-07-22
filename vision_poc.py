#!/usr/bin/env python3
"""POC: can we read vibe/persona from TikTok COVER THUMBNAILS (free from the post feed)
with a cheap vision model? Prints the label + real token usage so we can price it."""
import base64
import json
import os
import sys
import urllib.request

import requests

import parse
from provider import TikHubProvider
from enrich import _container

MODEL = "claude-haiku-4-5-20251001"
PROMPT = ("You tag the CONTENT STYLE of a TikTok account for a content taxonomy (not identifying "
          "anyone). From these cover thumbnails, classify the account's typical content. Answer "
          "ONLY JSON: {\"content_persona\":\"solo-creator|couple|family|group\","
          "\"vibe\":[aesthetic tags e.g. clean-girl,cozy,luxury,edgy,natural],"
          "\"setting\":\"typical setting\",\"content_note\":\"one line on the content style\"}")


def cover_urls(prov, handle, n=3):
    sec = parse.profile_fields(prov.fetch_profile(handle))["sec_uid"]
    raw = prov.fetch_posts(sec, count=10)
    urls = []
    for a in (_container(raw).get("aweme_list") or [])[:n]:
        v = a.get("video") or {}
        oc = v.get("origin_cover") or v.get("cover") or {}
        ul = oc.get("url_list") or []
        if ul:
            urls.append(ul[0])
    return urls


def _media_type(b: bytes) -> str:
    if b[:2] == b"\xff\xd8":
        return "image/jpeg"
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "image/webp"
    if b[:4] == b"GIF8":
        return "image/gif"
    if b[4:8] == b"ftyp":                 # HEIC/HEIF (Apple) — NOT accepted by the API
        return "image/heic"
    return "application/octet-stream"     # unknown -> force a conversion, never mislabel


SCRATCH = "/private/tmp/claude-501/-Users-nuls101-Desktop-Company-Merge/5d3e391b-0ff4-4193-9999-aa606643981f/scratchpad"


def _to_jpeg(raw: bytes) -> bytes:
    """Normalise any cover (HEIC/webp/…) to JPEG via macOS `sips` (POC). Prod: pillow-heif."""
    import subprocess
    import uuid
    src = f"{SCRATCH}/img_{uuid.uuid4().hex}.heic"   # sips needs a real image extension
    dst = src + ".jpg"
    with open(src, "wb") as f:
        f.write(raw)
    subprocess.run(["sips", "-s", "format", "jpeg", src, "--out", dst],
                   capture_output=True, check=True)
    with open(dst, "rb") as f:
        out = f.read()
    if out[:2] != b"\xff\xd8":
        raise RuntimeError("sips did not produce JPEG")
    return out


def b64(url):
    r = requests.get(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://www.tiktok.com/"}, timeout=20)
    r.raise_for_status()
    data = r.content
    if _media_type(data) not in ("image/jpeg", "image/png", "image/gif", "image/webp"):
        data = _to_jpeg(data)          # HEIC etc. -> JPEG
    return _media_type(data), base64.b64encode(data).decode()


def vision(key, handle, prov):
    imgs = []
    for u in cover_urls(prov, handle):
        try:
            imgs.append(b64(u))
        except Exception as e:
            print("  img fail:", str(e)[:60])
    if not imgs:
        return None, "keine Bilder ladbar"
    content = [{"type": "image", "source": {"type": "base64", "media_type": mt, "data": b}}
               for mt, b in imgs]
    content.append({"type": "text", "text": PROMPT})
    payload = {"model": MODEL, "max_tokens": 400, "messages": [{"role": "user", "content": content}]}
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages", data=json.dumps(payload).encode(),
        headers={"content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01"})
    import time
    d = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=90) as rr:
                d = json.loads(rr.read())
            break
        except urllib.error.HTTPError as e:
            if e.code in (429, 529, 500, 503) and attempt < 3:
                time.sleep(2 * (attempt + 1)); continue
            return None, f"HTTP {e.code}: {e.read().decode()[:200]}"
    if d is None:
        return None, "overloaded after retries"
    txt = "".join(c.get("text", "") for c in d.get("content", []))
    return d.get("usage", {}), txt


def main():
    key = os.environ["ANTHROPIC_API_KEY"]
    prov = TikHubProvider()
    for h in sys.argv[1:] or ["vivien.sherwan", "sudenazdoguu"]:
        usage, txt = vision(key, h, prov)
        print(f"=== @{h} ===")
        print(txt)
        if usage:
            it, ot = usage.get("input_tokens", 0), usage.get("output_tokens", 0)
            # Haiku 4.5: ~$1/Mtok in, ~$5/Mtok out
            cost = it / 1e6 * 1.0 + ot / 1e6 * 5.0
            print(f"tokens: in={it} out={ot}  ->  ${cost:.5f}/Creator (3 Cover)")
        print()


if __name__ == "__main__":
    main()
