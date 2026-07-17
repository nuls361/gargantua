#!/usr/bin/env python3
"""
Load the local index (creatordb.sqlite) into Supabase tt_creators / tt_posts,
the backend the reworked Search reads. Idempotent upsert on the primary keys, so
re-running after a bigger discovery run just merges the new creators.

Precomputes per-creator search fields (avg_views, posts_90d, last_post_at) so the
Search query hits ONE table with no join.

Env:  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (service role bypasses RLS)
Run:  python3 load_supabase.py [--dry] [--posts]
        --dry    compute + print, no network (verify locally)
        --posts  also load tt_posts (bulkier; needed for Stage-5 embeddings)
"""
from __future__ import annotations

import json
import os
import sqlite3
import statistics
import sys
import time
import urllib.request

DB = "creatordb.sqlite"
BATCH = 500
CUTOFF_90D = time.time() - 90 * 86400


def iso(ts):
    if ts in (None, ""):
        return None
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(ts)))
    except (TypeError, ValueError):
        return ts  # already an ISO string (first_seen_at / last_enriched_at)


def build_rows(conn):
    # per-creator post aggregates in one pass
    agg = {}
    for p in conn.execute("SELECT creator_sec_uid, play, created_at FROM tt_src_posts"):
        a = agg.setdefault(p["creator_sec_uid"], {"plays": [], "n": 0, "n90": 0, "last": 0})
        if p["play"] is not None:
            a["plays"].append(p["play"])
        a["n"] += 1
        ct = p["created_at"]
        if ct:
            if int(ct) >= CUTOFF_90D:
                a["n90"] += 1
            a["last"] = max(a["last"], int(ct))

    rows = []
    # Skip pure lead-stubs (repost-harvested, not yet enriched): they carry no
    # ER/category/posts, so they'd land in the tool's Search as empty rows. They
    # stay local until promoted. Legacy rows (enrichment_status NULL) still load.
    for c in conn.execute("SELECT * FROM creators WHERE enrichment_status IS NULL "
                          "OR enrichment_status='enriched'"):
        c = dict(c)
        a = agg.get(c["sec_uid"], {"plays": [], "n": 0, "n90": 0, "last": 0})
        rows.append({
            "sec_uid": c["sec_uid"], "handle": c["handle"], "tiktok_id": c["tiktok_id"],
            "display_name": c["nickname"], "bio": c["bio"],  # local col is API-named "nickname"
            "follower_count": c["follower_count"], "following_count": c["following_count"],
            "heart_count": c["heart_count"], "video_count": c["video_count"],
            "verified": bool(c["verified"]), "is_private": bool(c["is_private"]),
            "language": c["language"], "bio_link": c["bio_link"],
            "email": c["email"], "email_source": c["email_source"], "email_type": c["email_type"],
            "country": c["country"], "country_confidence": c["country_confidence"],
            "dach_lang_ratio": c["dach_lang_ratio"], "engagement_median": c["engagement_median"],
            "posting_per_week": c["posting_per_week"], "sponsored_count": c["sponsored_count"],
            "category": c["category"], "category_secondary": c["category_secondary"],
            "sub_niche": c["sub_niche"], "category_confidence": c["category_confidence"],
            "category_source": c["category_source"],
            "avg_views": int(statistics.median(a["plays"])) if a["plays"] else None,
            "posts_stored": a["n"], "posts_90d": a["n90"],
            "last_post_at": iso(a["last"]) if a["last"] else None,
            "qualify_status": c["qualify_status"], "discovered_via": c["discovered_via"],
            "discovered_from": c["discovered_from"], "completeness": c["completeness"],
            # two-tier / repost-channel provenance (so the tool can surface the
            # brand-vetted cohort and filter market)
            "source_channel": c["source_channel"], "source_brand": c["source_brand"],
            "market": c["market"], "region_hint": c["region_hint"],
            "enrichment_status": c["enrichment_status"],
            "first_seen_at": iso(c["first_seen_at"]), "last_enriched_at": iso(c["last_enriched_at"]),
        })
    return rows


def post_rows(conn):
    out = []
    for p in conn.execute("SELECT * FROM tt_src_posts"):
        p = dict(p)
        out.append({
            "aweme_id": p["aweme_id"], "creator_sec_uid": p["creator_sec_uid"],
            "caption": p["caption"],
            "hashtags": json.loads(p["hashtags"] or "[]"),
            "mentions": json.loads(p["mentions"] or "[]"),
            "sound_id": p["sound_id"], "sound_title": p["sound_title"],
            "play": p["play"], "digg": p["digg"], "comment": p["comment"],
            "share": p["share"], "collect": p["collect"], "duration_s": p["duration_s"],
            "region": p["region"], "desc_language": p["desc_language"],
            "share_url": p["share_url"], "created_at": p["created_at"],
        })
    return out


def upsert(table, rows, url, key):
    endpoint = f"{url}/rest/v1/{table}"
    for i in range(0, len(rows), BATCH):
        chunk = rows[i:i + BATCH]
        req = urllib.request.Request(
            endpoint, data=json.dumps(chunk).encode(),
            headers={"apikey": key, "Authorization": f"Bearer {key}",
                     "Content-Type": "application/json",
                     "Prefer": "resolution=merge-duplicates,return=minimal"},
            method="POST")
        with urllib.request.urlopen(req, timeout=120) as r:
            if r.status not in (200, 201, 204):
                raise RuntimeError(f"{table} batch {i}: HTTP {r.status}")
        print(f"  {table}: upserted {min(i+BATCH, len(rows))}/{len(rows)}")


def main():
    dry = "--dry" in sys.argv
    do_posts = "--posts" in sys.argv
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    # posts table is named `posts` locally; alias so this script is explicit
    conn.execute("CREATE TEMP VIEW tt_src_posts AS SELECT * FROM posts")

    rows = build_rows(conn)
    print(f"tt_creators rows: {len(rows)}")
    with_views = sum(1 for r in rows if r["avg_views"] is not None)
    active90 = sum(1 for r in rows if (r["posts_90d"] or 0) >= 5)
    print(f"  avg_views computed: {with_views} · active(≥5/90d): {active90} · "
          f"categorized: {sum(1 for r in rows if r['category'])}")

    if dry:
        print("\nsample row:")
        print(json.dumps({k: rows[0][k] for k in
              ("sec_uid","handle","category","sub_niche","follower_count",
               "engagement_median","avg_views","posts_90d","email_type","last_post_at")},
              indent=2, ensure_ascii=False))
        if do_posts:
            print(f"\ntt_posts rows: {conn.execute('SELECT COUNT(*) c FROM posts').fetchone()['c']}")
        print("\n--dry: nothing written.")
        return

    url = os.environ.get("SUPABASE_URL")
    # accept the new key naming (sb_secret_...) or the legacy service_role key
    key = os.environ.get("SUPABASE_SECRET_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key):
        sys.exit("Set SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY).")
    url = url.rstrip("/")
    print("loading tt_creators…")
    upsert("tt_creators", rows, url, key)
    if do_posts:
        pr = post_rows(conn)
        print(f"loading tt_posts ({len(pr)})…")
        upsert("tt_posts", pr, url, key)
    print("done.")


if __name__ == "__main__":
    main()
