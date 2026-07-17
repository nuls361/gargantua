"""
Sound (music) discovery channel.

A sound's video list = creators riding that trend. Unlike the repost/hashtag feeds,
the TikTok app-v3 music endpoint returns each video's author WITHOUT follower stats,
but WITH region + language -> we get a strong, FREE DACH pre-filter (region DE/AT/CH
or language 'de'). Followers are backfilled with one profile call per DACH+email
candidate, so the expensive per-creator work only touches the pre-filtered subset.

    resolve_music_id(prov, "https://www.tiktok.com/music/original-sound-7403...")
    resolve_music_id(prov, "Taste")            # name -> top result by user_count
    harvest_sound(prov, music_id, max_pages)
"""
from __future__ import annotations

import re

import parse
import freemail

DACH_REGIONS = {"DE", "AT", "CH"}


def resolve_music_id(prov, value: str) -> tuple[str | None, str | None]:
    """Return (music_id, title). Accepts a raw music_id, a TikTok sound URL, or a name.
    A name is resolved to the most-used matching sound (by user_count)."""
    v = (value or "").strip()
    if v.isdigit():
        return v, None
    m = (re.search(r"/music/[^/?#]*?-(\d{6,})", v)   # .../music/original-sound-123456789
         or re.search(r"[?&]music_id=(\d+)", v)
         or (re.search(r"\b(\d{15,})\b", v) if not v.startswith("http") else None))
    if m:
        return m.group(1), None
    # treat as a sound name -> search
    sr = prov.fetch_music_search(v, count=15)
    music = (sr.get("data", sr) or {}).get("music") or []
    if not music:
        return None, None
    best = max(music, key=lambda mm: mm.get("user_count") or 0)
    return str(best.get("id_str") or best.get("id")), best.get("title")


def is_dach_author(a: dict) -> bool:
    return (a.get("region") in DACH_REGIONS) or (a.get("language") == "de")


def harvest_sound(prov, music_id: str, max_pages: int, meter=None) -> list:
    """Return de-duplicated authors (handle, sec_uid, bio, email, region, language) for
    the videos using this sound. meter() is called once per charged API call."""
    authors, seen, cursor = {}, set(), 0
    for _ in range(max_pages):
        raw = prov.fetch_music_video_list(music_id, cursor=cursor, count=30)
        if meter:
            meter()
        d = raw.get("data", raw) or {}
        items = d.get("aweme_list") or []
        for it in items:
            au = it.get("author") or {}
            sec = au.get("sec_uid")
            h = au.get("unique_id")
            if not sec or not h or sec in seen:
                continue
            seen.add(sec)
            bio = au.get("signature") or ""
            email = parse.email_from_bio(bio)
            authors[sec] = {
                "handle": h, "sec_uid": sec, "nickname": au.get("nickname"),
                "bio": bio.replace("\n", " ").strip(), "email": email,
                "email_type": freemail.classify_email(email) if email else None,
                "verified": bool(au.get("verification_type")),
                "region": au.get("region"), "language": au.get("language"),
            }
        has_more = d.get("has_more")
        cursor = d.get("cursor")
        if not items or not has_more or cursor in (None, 0):
            break
    return list(authors.values())
