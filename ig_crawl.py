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

import sys
import time

import freemail
from store import Supa
from ig_provider import IGProvider
from provider import ProviderError
import ig_parse as igp
import ig_enrich as ige
from crawl import MIN_FOLLOWERS, MAX_FOLLOWERS, MARKETS, ER_MIN, ER_MAX, MAX_CANDIDATES_PER_SOURCE


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
        # HARD: e-mail + 1k–250k (pre-enrich)
        if not email or not (MIN_FOLLOWERS <= fol <= MAX_FOLLOWERS):
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


def main():
    brand = sys.argv[1] if len(sys.argv) > 1 else "@paulaschoice"
    supa, prov = Supa(), IGProvider()
    t0 = time.time()
    print(f"[ig] harvesting brand {brand} …", flush=True)
    stats = ig_harvest_brand(supa, prov, brand, brand_market="uk")
    print(f"[ig] DONE {stats} time={(time.time()-t0)/60:.1f}m", flush=True)


if __name__ == "__main__":
    main()
