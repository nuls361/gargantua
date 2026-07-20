"""
Parse Instagram web-profile + post payloads into the same shape the pipeline uses for
TikTok, so the shared gate (email · followers · market · ER) applies unchanged.

Instagram gives no per-post country, so `market` can't be derived like on TikTok. For
brand-driven discovery it's inferred from the seed brand (a DACH brand's taggers are
DACH-leaning) + bio language; confirmed later via the creator's own IG signals.
"""
from __future__ import annotations

import re

import parse   # reuse email_from_bio + language helpers

_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")


def _count(node) -> int | None:
    if isinstance(node, dict):
        return node.get("count")
    return node if isinstance(node, int) else None


def profile_fields(data: dict) -> dict:
    """IG web-profile -> normalized creator fields (mirrors parse.profile_fields)."""
    bio = data.get("biography") or ""
    m = _EMAIL.search(bio)
    email = (m.group(0) if m else None) or data.get("business_email") or data.get("public_email")
    ext = data.get("external_url") or ""
    return {
        "handle": data.get("username"),
        "user_id": str(data.get("id")) if data.get("id") is not None else None,
        "nickname": data.get("full_name"),
        "followers": _count(data.get("edge_followed_by")) or data.get("follower_count"),
        "following": _count(data.get("edge_follow")) or data.get("following_count"),
        "media_count": _count(data.get("edge_owner_to_timeline_media")) or data.get("media_count"),
        "bio": bio.replace("\n", " ").strip(),
        "email": email,
        "external_url": ext,
        "is_business": bool(data.get("is_business_account")),
        "verified": bool(data.get("is_verified")),
        "private": bool(data.get("is_private")),
        # cross-platform anchor: a tiktok link in the IG bio/link -> same person
        "tiktok_in_bio": _tiktok_handle(bio + " " + ext),
    }


def _tiktok_handle(text: str) -> str | None:
    m = re.search(r"tiktok\.com/@([\w.]+)", text or "", re.I)
    return m.group(1) if m else None


def tagged_authors(tagged_data: dict) -> list[dict]:
    """Posts tagging a brand -> the creators who posted them (username + id), deduped."""
    out, seen = [], set()

    def walk(o):
        if isinstance(o, dict):
            # a post node exposes its poster under owner/user
            for key in ("owner", "user"):
                u = o.get(key)
                if isinstance(u, dict) and u.get("username") and u.get("username") not in seen:
                    seen.add(u["username"])
                    out.append({"handle": u["username"], "user_id": str(u.get("id") or u.get("pk") or "")})
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(tagged_data)
    return out


def reel_engagement(reels_data: dict, followers: int | None) -> float | None:
    """Median (like+comment)/followers over a creator's recent reels -> ER %."""
    if not followers:
        return None
    rates = []

    def walk(o):
        if isinstance(o, dict):
            likes = o.get("like_count")
            comments = o.get("comment_count")
            if isinstance(likes, int) and isinstance(comments, int):
                rates.append(100.0 * (likes + comments) / followers)
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(reels_data)
    if not rates:
        return None
    rates.sort()
    return round(rates[len(rates) // 2], 2)
