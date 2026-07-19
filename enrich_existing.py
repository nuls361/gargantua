#!/usr/bin/env python3
"""
Enrich the imported CRM leads (lbug `creators`) INTO the discovery pool (`tt_creators`)
so they gain follower / engagement / TOPIC and become searchable in the product.

Handle-driven, quality-gated (>=1000 followers, not private), metered against a USD
budget, and resumable: creators whose handle is already in tt_creators are skipped, so
re-running never re-spends. Topic categorisation is the same pipeline the scraper uses
(enrich_from_stub -> categorize_rich).

    SUPABASE_URL=.. SUPABASE_SECRET_KEY=.. TIKHUB_API_KEY=.. \
        python3 enrich_existing.py --budget 28 [--limit N]
"""
from __future__ import annotations

import argparse
import time

import parse
import freemail
from provider import TikHubProvider, ProviderError
from store import Supa
from enrich import Enricher, BudgetExceeded

MIN_FOLLOWERS = 1000
PAGE = 500


def load_existing_handles(supa: Supa) -> set:
    out, offset = set(), 0
    while True:
        rows = supa._get("tt_creators", {"select": "handle", "limit": "1000", "offset": str(offset)})
        for r in rows:
            if r.get("handle"):
                out.add(r["handle"].lower())
        if len(rows) < 1000:
            break
        offset += 1000
    return out


def iter_creators(supa: Supa):
    offset = 0
    while True:
        rows = supa._get("creators", {
            "select": "id,handle,tiktok_username,email,region_label",
            "handle": "not.is.null", "order": "id.asc",
            "limit": str(PAGE), "offset": str(offset)})
        if not rows:
            break
        for r in rows:
            yield r
        if len(rows) < PAGE:
            break
        offset += PAGE


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--budget", type=float, default=28.0, help="USD to spend this run")
    ap.add_argument("--limit", type=int, default=0, help="cap creators processed (0=all)")
    args = ap.parse_args()

    supa = Supa()
    prov = TikHubProvider()
    start = supa.total_spent()
    # Enricher's budget is an absolute ceiling on total_spent -> start + our budget.
    # Fewer post pages than discovery (these are known leads, not a precision cut) keeps
    # each creator cheap + fast while still giving enough posts for ER + topic.
    enr = Enricher(prov, supa, budget_usd=start + args.budget, max_harvest_followers=250_000,
                   max_pages=4, min_posts=12)

    have = load_existing_handles(supa)
    print(f"[enrich-existing] start_spend=${start:.3f} budget=+${args.budget:.2f} "
          f"already_in_pool={len(have)}", flush=True)

    seen = kept = skipped = failed = 0
    t0 = time.time()
    try:
        for c in iter_creators(supa):
            if args.limit and seen >= args.limit:
                break
            h = (c.get("handle") or c.get("tiktok_username") or "").lstrip("@").strip()
            if not h or h.lower() in have:
                continue
            seen += 1
            have.add(h.lower())            # mark attempted (resumable, no re-spend)
            try:
                raw = enr._call(lambda hh=h: prov.fetch_profile(hh), "profile")
            except BudgetExceeded:
                print("[enrich-existing] budget reached — stopping", flush=True)
                break
            except ProviderError:
                failed += 1
                continue

            pf = parse.profile_fields(raw)
            sec = pf.get("sec_uid")
            fol = pf.get("followers")
            if not sec or pf.get("private") or not isinstance(fol, int) or fol < MIN_FOLLOWERS:
                skipped += 1
                continue

            bio = pf.get("bio") or ""
            bio_email = parse.email_from_bio(bio)
            email = bio_email or c.get("email")
            supa.upsert_stubs([{
                "sec_uid": sec, "handle": pf.get("handle") or h, "display_name": pf.get("nickname"),
                "bio": bio, "follower_count": fol, "verified": bool(pf.get("verified")),
                "tiktok_id": pf.get("user_id"),
                "email": email, "email_source": "bio_regex" if bio_email else ("crm" if email else None),
                "email_type": freemail.classify_email(email) if email else None,
                "source_channel": "crm_import", "source_type": "crm_import", "source_value": "import",
                "region_hint": c.get("region_label"),
                "enrichment_status": "stub", "discovered_via": "crm_import", "discovered_from": "import",
            }])
            supa.add_creator_sources([{
                "sec_uid": sec, "source_type": "crm_import", "source_value": "import"}])

            try:
                _, outcome, _ = enr.enrich_from_stub({
                    "sec_uid": sec, "handle": pf.get("handle") or h, "follower_count": fol,
                    "region_hint": c.get("region_label"), "email": email, "bio": bio,
                    "source_brand": None})
            except BudgetExceeded:
                print("[enrich-existing] budget reached — stopping", flush=True)
                break
            except ProviderError:
                failed += 1
                continue
            kept += 1

            if kept % 25 == 0:
                supa.flush_spend(channel="crm_import")
                print(f"  kept={kept} skip={skipped} fail={failed} seen={seen} "
                      f"spent=${supa.total_spent() - start:.2f}/{args.budget:.0f} "
                      f"({(time.time() - t0) / 60:.0f}m)", flush=True)
    finally:
        supa.flush_spend(channel="crm_import")

    print(f"[enrich-existing] DONE kept={kept} skipped={skipped} failed={failed} seen={seen} "
          f"spent=${supa.total_spent() - start:.2f} time={(time.time() - t0) / 60:.1f}m", flush=True)


if __name__ == "__main__":
    main()
