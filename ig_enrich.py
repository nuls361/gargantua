"""
Instagram enrichment: turn a creator's posts into the same derived signals the shared
hard gate needs — market, engagement rate, topic, brands — using CAPTIONS (IG has no
per-post country). Market is decided by, in order of confidence:
    1. the creator's TikTok market, if we already know them cross-platform (bio link)
    2. caption language  (German -> DACH, English -> UK/US)
    3. the seed brand's market (a DACH brand's taggers lean DACH)
"""
from __future__ import annotations

import re
from statistics import median

import parse   # comment_german_ratio, categorize_rich, is_sponsored


_MENTION = re.compile(r"@([\w.]{2,30})")


def _captions(posts_data) -> list[str]:
    """Pull caption text out of the IG posts payload (varies by node shape)."""
    caps = []

    def walk(o):
        if isinstance(o, dict):
            # web nodes: edge_media_to_caption.edges[].node.text ; app nodes: caption.text
            cap = o.get("caption")
            if isinstance(cap, dict) and cap.get("text"):
                caps.append(cap["text"])
            elif isinstance(cap, str) and cap:
                caps.append(cap)
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(posts_data)
    return caps


def _engagement(posts_data, followers) -> float | None:
    if not followers:
        return None
    rates = []

    def walk(o):
        if isinstance(o, dict):
            lk, cm = o.get("like_count"), o.get("comment_count")
            if isinstance(lk, int) and isinstance(cm, int):
                rates.append(100.0 * (lk + cm) / followers)
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(posts_data)
    return round(median(rates), 2) if rates else None


def market_from(captions: list[str], *, tiktok_market=None, brand_market=None) -> str:
    # 1. cross-platform: trust the TikTok market we already verified
    if tiktok_market in ("dach", "uk", "us"):
        return tiktok_market
    # 2. caption language — German is a strong DACH signal
    de = parse.comment_german_ratio(captions) if captions else 0
    if de is not None and de >= 0.3:
        return "dach"
    # 3. English captions -> UK/US; disambiguate via the seed brand, else default UK
    joined = " ".join(captions).lower()
    if captions:
        if brand_market in ("uk", "us"):
            return brand_market
        # crude US vs UK lean from spelling/currency
        if re.search(r"\$|\bcolor\b|\bfavorite\b|\by'all\b", joined):
            return "us"
        return "uk"
    return brand_market or "other"


def enrich(prov, creator: dict, *, tiktok_market=None, brand_market=None) -> dict:
    """creator = {handle, user_id, followers, bio, email}. Returns derived signals
    (market, engagement_median, category, brands) or {} on failure."""
    posts = prov.fetch_user_posts(creator["user_id"]) if hasattr(prov, "fetch_user_posts") \
        else prov.fetch_reels(creator["user_id"])
    caps = _captions(posts)
    er = _engagement(posts, creator.get("followers"))
    market = market_from(caps, tiktok_market=tiktok_market, brand_market=brand_market)
    # brands = @-mentions in sponsored captions (the loop, same as TikTok)
    brands = []
    for cap in caps:
        if parse.is_sponsored(cap):
            brands += _MENTION.findall(cap)
    # topic from captions (+ bio) — reuse the rich categorizer with caption-only "posts"
    try:
        cat, cat2, conf, src = parse.categorize_rich(
            [{"caption": c, "hashtags": [], "mentions": []} for c in caps],
            bio=creator.get("bio"), brands=brands)
    except Exception:
        cat = None
    return {
        "market": market,
        "engagement_median": er,
        "category": cat,
        "brands": list(dict.fromkeys(b.lstrip("@") for b in brands))[:5],
        "posts": len(caps),
    }
