#!/usr/bin/env python3
"""One-off: backfill tt_creators.video_count (total lifetime posts) for creators scraped
before the free-capture fix. One profile call each (~$0.001). TikTok only (IG uses ig_ ids).
Does NOT touch last_enriched_at (keeps recycle-age segments intact). Shardable.

    CRAWL_SHARDS=8 CRAWL_SHARD=0 python3 backfill_video_count.py
"""
from __future__ import annotations

import os
import time

import parse
from provider import TikHubProvider, ProviderError
from store import Supa


def targets(supa: Supa) -> list:
    out, offset = [], 0
    while True:
        rows = supa._get("tt_creators", {
            "select": "sec_uid,handle", "video_count": "is.null",
            "platform": "eq.tiktok", "handle": "not.is.null",
            "order": "sec_uid.asc", "limit": "1000", "offset": str(offset)})
        out.extend(rows)
        if len(rows) < 1000:
            break
        offset += 1000
    return out


def main():
    supa = Supa()
    prov = TikHubProvider()
    shards = int(os.environ.get("CRAWL_SHARDS", "1"))
    shard = int(os.environ.get("CRAWL_SHARD", "0"))
    rows = targets(supa)
    if shards > 1:
        rows = [r for i, r in enumerate(rows) if i % shards == shard]
    print(f"[backfill] shard {shard}/{shards}: {len(rows)} creators", flush=True)
    done = fail = 0
    t0 = time.time()
    for r in rows:
        sec, h = r["sec_uid"], r["handle"]
        try:
            pf = parse.profile_fields(prov.fetch_profile(h))
            supa.record_spend("backfill", 0.001)
            vc = pf.get("videos")
            if isinstance(vc, int):
                supa._patch("tt_creators", {"sec_uid": f"eq.{sec}"}, {"video_count": vc})
                done += 1
            else:
                fail += 1
        except ProviderError:
            fail += 1
        except Exception:
            fail += 1
        if (done + fail) % 100 == 0:
            supa.flush_spend(channel="backfill")
            print(f"[backfill s{shard}] {done+fail}/{len(rows)} | ok {done} | fail {fail} "
                  f"| ${supa.total_spent():.2f} | {(time.time()-t0)/60:.1f}m", flush=True)
    supa.flush_spend(channel="backfill")
    print(f"[backfill s{shard}] DONE ok={done} fail={fail} time={(time.time()-t0)/60:.1f}m", flush=True)


if __name__ == "__main__":
    main()
