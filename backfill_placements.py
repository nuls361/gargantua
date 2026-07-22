#!/usr/bin/env python3
"""Backfill tt_creators.brands_worked_with + last_placement_at for ad-experienced creators.
One posts page each; find sponsored posts (caption heuristic), collect @-mentioned brands and
the newest sponsored date. Resumable (last_placement_at is null). Shardable via CRAWL_SHARDS/SHARD."""
import os, time
from datetime import datetime, timezone
from store import Supa
from provider import TikHubProvider, ProviderError
import parse

BUDGET = float(os.environ.get("PLACE_BUDGET", "10"))


def clean_brand(m):
    """Drop caption-slice artifacts (e.g. 'TTO o', 'l&Bear ich'); keep clean handles and
    proper brand display names (every word capitalised)."""
    m = (m or "").strip()
    if len(m) < 2:
        return None
    words = [w for w in m.split() if w not in ("&", "x", "×")]
    if len(words) == 1:
        return m if len(m) >= 2 else None
    return m if all(w[0].isupper() for w in words if w) else None


def targets(supa):
    out, off = [], 0
    while True:
        rows = supa._get("tt_creators", {
            "select": "sec_uid,handle", "sponsored_count": "gte.1",
            "last_placement_at": "is.null", "platform": "eq.tiktok", "sec_uid": "not.is.null",
            "order": "follower_count.desc.nullslast", "limit": "1000", "offset": str(off)})
        out.extend(rows)
        if len(rows) < 1000:
            break
        off += 1000
    return out


def main():
    supa, prov = Supa(), TikHubProvider()
    shards = int(os.environ.get("CRAWL_SHARDS", "1")); shard = int(os.environ.get("CRAWL_SHARD", "0"))
    rows = targets(supa)
    if shards > 1:
        rows = [r for i, r in enumerate(rows) if i % shards == shard]
    start = supa.total_spent()
    print(f"[place s{shard}] targets: {len(rows)}  budget=+${BUDGET}", flush=True)
    ok = withbrand = fail = 0
    for i, r in enumerate(rows):
        if supa.total_spent() - start >= BUDGET:
            print(f"[place s{shard}] budget reached", flush=True); break
        sec, handle = r["sec_uid"], (r.get("handle") or "")
        try:
            raw = prov.fetch_posts(sec, count=30); supa.record_spend("placement", 0.001)
            posts = parse.posts_list(raw) or []
            brands, last_ts = [], 0
            for p in posts:
                pf = parse.post_fields(p)
                if parse.is_sponsored(pf.get("caption") or ""):
                    ct = pf.get("create_time")
                    if ct:
                        last_ts = max(last_ts, int(ct))
                    for m in pf.get("mentions") or []:
                        cb = clean_brand(m)
                        if cb and cb.lower() != handle.lower() and cb not in brands:
                            brands.append(cb)
            fields = {}
            if brands:
                fields["brands_worked_with"] = brands[:10]; withbrand += 1
            if last_ts:
                fields["last_placement_at"] = datetime.fromtimestamp(last_ts, tz=timezone.utc).date().isoformat()
            if not fields:
                # sponsored_count>=1 but nothing in the last 30 posts -> mark done cheaply (epoch handled via count only)
                fields["last_placement_at"] = None  # leave null; still counts as processed via ok
            if fields.get("last_placement_at") or fields.get("brands_worked_with"):
                supa._patch("tt_creators", {"sec_uid": f"eq.{sec}"}, {k: v for k, v in fields.items() if v is not None})
            ok += 1
        except (ProviderError, Exception):
            fail += 1
        if (ok + fail) % 100 == 0:
            supa.flush_spend(channel="placement")
            print(f"[place s{shard}] {ok+fail}/{len(rows)} ok={ok} withBrand={withbrand} fail={fail} ${supa.total_spent()-start:.2f}", flush=True)
    supa.flush_spend(channel="placement")
    print(f"[place s{shard}] DONE ok={ok} withBrand={withbrand} fail={fail} spent=${supa.total_spent()-start:.2f}", flush=True)


if __name__ == "__main__":
    main()
