"""
Hashtag discovery channel.

A hashtag's video feed = creators posting under that tag. Each tag_post item carries
its author WITH follower stats inline (authorStats.followerCount) + bio -> same cheap
shape as the brand-repost feed: one call per page, zero per creator.

    harvest_hashtag(prov, "kochenmitliebe", max_pages)
"""
from __future__ import annotations

import parse
import freemail
from provider import ProviderError


def _challenge_id(detail: dict):
    return (((detail.get("data") or {}).get("challengeInfo") or {})
            .get("challenge") or {}).get("id")


def harvest_hashtag(prov, tag_name: str, max_pages: int, meter=None) -> list:
    """Return de-duplicated authors (handle, sec_uid, followers, bio, email) posting
    under a hashtag. meter() is called once per charged API call."""
    tag = tag_name.lstrip("#")
    detail = prov.fetch_tag_detail(tag)
    if meter:
        meter()
    cid = _challenge_id(detail)
    if not cid:
        raise ProviderError(f"no challenge id for #{tag}")

    creators, seen, cursor = {}, set(), 0
    for _ in range(max_pages):
        raw = prov.fetch_tag_post(cid, cursor=cursor, count=30)
        if meter:
            meter()
        cont = raw.get("data", raw) or {}
        items = cont.get("itemList") or cont.get("aweme_list") or []
        for it in items:
            au = it.get("author") or {}
            ast = it.get("authorStats") or it.get("authorStatsV2") or {}
            h = au.get("uniqueId") or au.get("unique_id")
            sec = au.get("secUid") or au.get("sec_uid")
            if not h or not sec or sec in seen:
                continue
            seen.add(sec)
            bio = au.get("signature") or ""
            email = parse.email_from_bio(bio)
            creators[sec] = {
                "handle": h, "sec_uid": sec, "nickname": au.get("nickname"),
                "followers": ast.get("followerCount") or ast.get("follower_count"),
                "verified": bool(au.get("verified")),
                "bio": bio.replace("\n", " ").strip(), "email": email,
                "email_type": freemail.classify_email(email) if email else None,
            }
        has_more = cont.get("hasMore")
        if has_more is None:
            has_more = cont.get("has_more")
        cursor = cont.get("cursor")
        if cursor is None:
            cursor = cont.get("max_cursor")
        if not items or not has_more or cursor in (None, 0):
            break
    return list(creators.values())
