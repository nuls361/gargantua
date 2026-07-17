#!/usr/bin/env python3
"""
Pull the FULL post history for one creator and show everything we can extract +
derive from it (the enrich stage). Paginates fetch_user_post until exhausted,
dumps raw pages to raw/<handle>_posts_full.json, and prints per-post detail plus
the aggregate signals the Creator-DB actually runs on (median engagement, posting
cadence, top hashtags, brand @-mentions, sound patterns).

    export TIKHUB_API_KEY=...
    python3 pull_posts.py pamela_rf
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import parse
from provider import TikHubProvider, ProviderError

RAW = Path(__file__).parent / "raw"
PAGE = 30
MAX_PAGES = 25  # app v3 returns ~10/page; 25 pages covers a full catalog


def when(ts):
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%d")
    except Exception:
        return "?"


def main():
    handle = (sys.argv[1] if len(sys.argv) > 1 else "pamela_rf").lstrip("@")
    prov = TikHubProvider()

    acct = prov.account()
    print(f"balance=${acct.get('balance')}  free_credit=${acct.get('free_credit')}\n")

    prof = parse.profile_fields(prov.fetch_profile(handle))
    sec = prof["sec_uid"]
    print(f"@{handle}  followers={prof['followers']:,}  videos(profile)={prof['videos']}  secUid ok\n")

    # ---- paginate (app v3: data.max_cursor + data.has_more) ----------------
    # Read cursor from the SAME container that holds aweme_list, and dedupe by
    # post id so a stuck/repeated cursor can never silently loop the same page.
    def container(o):
        if isinstance(o, dict):
            if "aweme_list" in o or "itemList" in o:
                return o
            for v in o.values():
                r = container(v)
                if r:
                    return r
        if isinstance(o, list):
            for v in o:
                r = container(v)
                if r:
                    return r
        return {}

    def pid(a):
        return a.get("aweme_id") or a.get("id")

    raw_pages, posts, seen, cursor = [], [], set(), 0
    for page in range(MAX_PAGES):
        raw = prov.fetch_posts(sec, count=PAGE, max_cursor=cursor)
        raw_pages.append(raw)
        cont = container(raw)
        items = cont.get("aweme_list") or cont.get("itemList") or []
        fresh = [a for a in items if pid(a) not in seen]
        for a in fresh:
            seen.add(pid(a))
        posts.extend(fresh)
        has_more = cont.get("has_more")
        cursor = cont.get("max_cursor")
        print(f"  page {page+1}: +{len(fresh)} new (total {len(posts)})  has_more={has_more}")
        if not has_more or not fresh or not cursor:
            break

    RAW.mkdir(exist_ok=True)
    (RAW / f"{handle}_posts_full.json").write_text(
        json.dumps(raw_pages, ensure_ascii=False, indent=2))

    pf = [parse.post_fields(p) for p in posts]

    # ---- per-post detail ---------------------------------------------------
    print(f"\n===== {len(pf)} POSTS for @{handle} =====")
    for i, p in enumerate(pf, 1):
        cap = (p["caption"] or "").replace("\n", " ")[:60]
        print(f"{i:>3}. {when(p['create_time'])}  play={p['play']:>9,} digg={p['digg']:>7,} "
              f"cmt={p['comment']:>5,} shr={p['share']:>5,}  ♪{(p['sound'] or '')[:22]:<22}")
        print(f"      {cap!r}")
        if p["hashtags"]:
            print(f"      #: {p['hashtags'][:8]}")
        if p["mentions"]:
            print(f"      @: {p['mentions']}")

    # ---- derived aggregates (the 'berechnet' fields) -----------------------
    er = parse.engagement_rate(pf)
    times = sorted(int(p["create_time"]) for p in pf if p["create_time"])
    span_days = (times[-1] - times[0]) / 86400 if len(times) > 1 else 0
    freq = round(len(times) / (span_days / 7), 1) if span_days else None
    tags = Counter(t.lower() for p in pf for t in p["hashtags"])
    mentions = Counter(m for p in pf for m in p["mentions"])
    sounds = Counter(p["sound"] for p in pf if p["sound"])
    locs = Counter(p["location"] for p in pf if p["location"])

    print("\n===== DERIVED (no extra API calls) =====")
    print(f"  median engagement rate : {er}%")
    print(f"  post date range        : {when(times[0])} -> {when(times[-1])}  ({span_days:.0f} days)")
    print(f"  posting frequency      : {freq} posts/week")
    print(f"  top hashtags           : {tags.most_common(12)}")
    print(f"  brand/@-mentions       : {mentions.most_common(12) or 'none found'}")
    print(f"  recurring sounds       : {sounds.most_common(5)}")
    print(f"  post locations         : {dict(locs) or 'none'}")
    print(f"\n  email (from bio)       : {parse.email_from_bio(prof['bio'])}")
    print(f"\nraw saved -> raw/{handle}_posts_full.json")


if __name__ == "__main__":
    try:
        main()
    except ProviderError as e:
        sys.exit(f"ERROR: {e}")
