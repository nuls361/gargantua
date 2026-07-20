#!/usr/bin/env python3
"""
Instagram brand channel. A brand's TAGGED posts -> creators who tagged it (IG's much
richer equivalent of the TikTok repost feed). Same hard filters as crawl.py (imported,
one definition): E-MAIL · 1k–250k · DACH/UK/US · ER 2–14%. Creators land in the same
pool with platform='instagram'; E-mail dedups them against TikTok in the leads table.

Market on IG (no country field): TikTok-handle-in-bio → that creator's TikTok market,
else caption language, else the seed brand's market.

    SUPABASE_URL=.. SUPABASE_SECRET_KEY=.. TIKHUB_API_KEY=.. python3 ig_crawl.py @paulaschoice
"""
from __future__ import annotations

import os
import sys
import time

import freemail
from store import Supa
from ig_provider import IGProvider
from provider import ProviderError
import ig_parse as igp
import ig_enrich as ige
from crawl import (MIN_FOLLOWERS_BRAND, MAX_FOLLOWERS_BRAND, MARKETS, ER_MIN, ER_MAX,
                   MAX_CANDIDATES_PER_SOURCE)


def _tiktok_market(supa, tt_handle):
    if not tt_handle:
        return None
    try:
        rows = supa._get("tt_creators", {"handle": f"eq.{tt_handle}", "select": "market", "limit": "1"})
        return rows[0].get("market") if rows else None
    except Exception:
        return None


def ig_harvest_brand(supa, prov, brand_handle, *, brand_market="dach", log=print) -> dict:
    """One IG brand -> tagged creators -> hard gate -> store (platform='instagram')."""
    bh = brand_handle.lstrip("@")
    bf = igp.profile_fields(prov.fetch_user_info(bh))
    if not bf.get("user_id"):
        return {"kept": 0, "error": "brand not found"}
    tagged = prov.fetch_tagged_posts(bf["user_id"], count=50)
    authors = igp.tagged_authors(tagged)
    kept = 0
    for a in authors:
        if kept >= MAX_CANDIDATES_PER_SOURCE:
            break
        try:
            pf = igp.profile_fields(prov.fetch_user_info(a["handle"]))
        except ProviderError:
            continue
        fol = pf.get("followers") or 0
        email = pf.get("email")
        # HARD: e-mail + 0–500k (brand-tagged = pre-validated by the brand)
        if not email or not (MIN_FOLLOWERS_BRAND <= fol <= MAX_FOLLOWERS_BRAND):
            continue
        tt_mkt = _tiktok_market(supa, pf.get("tiktok_in_bio"))
        try:
            e = ige.enrich(prov, pf, tiktok_market=tt_mkt, brand_market=brand_market)
        except ProviderError:
            continue
        er = e.get("engagement_median")
        # HARD: market DACH/UK/US + ER 2–14%
        if e["market"] not in MARKETS or not isinstance(er, (int, float)) or not (ER_MIN <= er <= ER_MAX):
            continue
        try:
            supa.upsert_stubs([{
                "sec_uid": "ig_" + pf["user_id"], "handle": pf["handle"], "platform": "instagram",
                "display_name": pf.get("nickname"), "bio": pf.get("bio"),
                "follower_count": fol, "verified": pf.get("verified"),
                "email": email, "email_source": "bio_regex", "email_type": freemail.classify_email(email),
                "market": e["market"], "engagement_median": er, "category": e.get("category"),
                "source_channel": "ig_brand", "source_type": "brand", "source_value": "@" + bh,
                "enrichment_status": "enriched", "discovered_via": "ig_brand", "discovered_from": "@" + bh,
            }])
            supa.add_creator_sources([{"sec_uid": "ig_" + pf["user_id"], "source_type": "brand",
                                       "source_value": "@" + bh}])
            # brands discovered in IG captions -> Brands view (instagram_handle side)
            for b in e.get("brands", []):
                try:
                    supa._insert("brands", {"handle": "@ig_" + b, "instagram_handle": "@" + b,
                                            "status": "candidate", "discovered_via": "ig_crawl"},
                                 on_conflict="handle", resolution="ignore")
                except Exception:
                    pass
            kept += 1
            log(f"  ✓ @{pf['handle']} {fol} foll · {e['market']} · ER {er}% · {e.get('category')}"
                + (f" · TT:@{pf['tiktok_in_bio']}" if pf.get("tiktok_in_bio") else ""))
        except Exception:
            continue
    return {"kept": kept, "brand_followers": bf.get("followers"), "tagged": len(authors)}


def run_ig(budget: float = 15.0, log=print) -> dict:
    """Batch: harvest all DACH IG-brands (brands.instagram_handle) with sharding +
    budget governor. CRAWL_SHARDS/CRAWL_SHARD split the seeds across parallel processes."""
    supa = Supa()
    start = supa.total_spent()
    prov = IGProvider(meter=lambda: supa.record_spend("ig", 0.001))
    brows = supa._get("brands", {"select": "instagram_handle", "instagram_handle": "not.is.null",
                                 "market": "eq.dach", "limit": "3000"})
    seeds = [(r.get("instagram_handle") or "").lstrip("@") for r in brows if r.get("instagram_handle")]
    shards = int(os.environ.get("CRAWL_SHARDS", "1"))
    shard = int(os.environ.get("CRAWL_SHARD", "0"))
    if shards > 1:
        seeds = [x for i, x in enumerate(seeds) if i % shards == shard]
    log(f"[ig] seeds: {len(seeds)}" + (f" (shard {shard}/{shards})" if shards > 1 else ""))
    kept, t0 = 0, time.time()
    for ig in seeds:
        if supa.total_spent() - start >= budget:
            log("[ig] budget reached"); break
        try:
            k = ig_harvest_brand(supa, prov, ig, brand_market="dach", log=log).get("kept", 0)
        except Exception as e:
            k = 0; log(f"  @{ig}: {str(e)[:50]}")
        kept += k
        supa.flush_spend(channel="ig")
        log(f"[ig] @{ig} -> +{k} | total {kept} | ${supa.total_spent() - start:.2f}")
    supa.flush_spend(channel="ig")
    log(f"[ig] DONE kept={kept} spent=${supa.total_spent() - start:.2f} time={(time.time() - t0) / 60:.1f}m")
    return {"kept": kept}


def main():
    # single brand: `ig_crawl.py @handle` ; batch over DACH IG-brands: `ig_crawl.py --all [budget]`
    if len(sys.argv) > 1 and sys.argv[1] != "--all":
        supa, prov = Supa(), IGProvider()
        print(f"[ig] harvesting brand {sys.argv[1]} …", flush=True)
        print(f"[ig] DONE {ig_harvest_brand(supa, prov, sys.argv[1], brand_market='dach')}", flush=True)
    else:
        run_ig(budget=float(sys.argv[2]) if len(sys.argv) > 2 else 15.0)


if __name__ == "__main__":
    main()
