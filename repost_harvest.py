#!/usr/bin/env python3
"""
Brand-repost discovery channel.

A brand's TikTok repost feed = videos it re-shared. Each reposted video's ORIGINAL
author is a creator the brand itself amplified -> a pre-vetted, on-brand UGC partner.
Stronger signal than proxy-hashtags for premium/clean-girl targeting because the
brand did the curation. Each reposted item carries the author WITH follower stats +
bio inline, so building the creator list costs one call per repost page and ZERO
per creator (no secUid chain, no profile calls).

Geography follows the brand's home market (CAIA->SE, Rhode->US; dm/Rossmann/Douglas
->DACH). So this is a QUALITY channel; DACH-ness is a separate filter you apply
depending on whether you want direct-outreach (DACH brands) or aesthetic/lookalike
seeds (any premium brand).

    export TIKHUB_API_KEY=...
    python3 repost_harvest.py caiacosmetics rhode
    python3 repost_harvest.py --pages 8 --out reposts.csv dm_deutschland rossmann
"""
from __future__ import annotations

import argparse
import csv
import sys

import parse
import freemail
from provider import TikHubProvider, ProviderError
from db import DB
from enrich import Enricher, BudgetExceeded


def region_from_email(email: str | None) -> str | None:
    """Cheap region guess from the email's TLD. Management agencies often use .com
    even for DACH creators, so this only fires on unambiguous country TLDs; the run's
    --region (brand home market) is the fallback."""
    if not email or "@" not in email:
        return None
    dom = email.rsplit("@", 1)[1].lower()
    if dom.endswith((".de", ".at", ".ch")):
        return "dach"
    if dom.endswith(".nl"):
        return "nl"
    if dom.endswith((".uk", ".co.uk")):
        return "uk"
    if dom.endswith((".no", ".se", ".dk", ".fi")):
        return "nordic"
    return None


def _dig(d, keys):
    if isinstance(d, dict):
        for k in keys:
            if d.get(k) not in (None, ""):
                return d[k]
        for v in d.values():
            r = _dig(v, keys)
            if r not in (None, ""):
                return r
    return None


def _find_list(raw):
    """Locate the list of reposted videos wherever TikHub nests it."""
    if isinstance(raw, dict):
        for k in ("aweme_list", "itemList"):
            if isinstance(raw.get(k), list) and raw[k]:
                return raw[k]
        for v in raw.values():
            r = _find_list(v)
            if r:
                return r
    if isinstance(raw, list) and raw and isinstance(raw[0], dict):
        return raw
    return None


def _cursor_and_more(raw):
    cont = raw
    if isinstance(raw, dict):
        # the container with hasMore/cursor usually sits next to the list
        for v in raw.values():
            if isinstance(v, dict) and ("hasMore" in v or "has_more" in v):
                cont = v
                break
    has_more = _dig(cont, ["hasMore", "has_more"])
    cursor = _dig(cont, ["cursor", "max_cursor"])
    return has_more, cursor


def harvest_brand(prov, handle, max_pages):
    """Return (brand_followers, [creator dicts]) for one brand's repost feed."""
    prof = prov.fetch_profile(handle)
    sec = _dig(prof, ["secUid", "sec_uid"])
    bfoll = _dig(prof, ["followerCount", "follower_count"])
    if not sec:
        raise ProviderError(f"no secUid for @{handle}")

    creators, seen, cursor = {}, set(), 0
    for _ in range(max_pages):
        raw = prov.fetch_user_repost(sec, cursor=cursor, count=30)
        items = _find_list(raw) or []
        for it in items:
            au = it.get("author") or {}
            ast = it.get("authorStats") or it.get("authorStatsV2") or {}
            ah = au.get("uniqueId") or au.get("unique_id")
            asec = au.get("secUid") or au.get("sec_uid")
            if not ah or not asec or asec in seen:
                continue
            seen.add(asec)
            bio = au.get("signature") or ""
            email = parse.email_from_bio(bio)
            creators[asec] = {
                "brand": handle,
                "handle": ah,
                "sec_uid": asec,
                "nickname": au.get("nickname"),
                "followers": ast.get("followerCount") or ast.get("follower_count")
                or au.get("follower_count"),
                "verified": bool(au.get("verified")),
                "bio": bio.replace("\n", " ").strip(),
                "email": email,
                "email_type": freemail.classify_email(email) if email else None,
            }
        has_more, cursor = _cursor_and_more(raw)
        if not items or not has_more or cursor in (None, 0):
            break
    return bfoll, list(creators.values())


def store_stubs(db, brand, rows, run_region):
    """Write cheap lead-stubs (Ebene 1). Returns #newly inserted."""
    new = 0
    for r in rows:
        region = region_from_email(r["email"]) or run_region
        got = db.upsert_stub({
            "sec_uid": r["sec_uid"], "handle": r["handle"], "nickname": r["nickname"],
            "bio": r["bio"], "follower_count": r["followers"],
            "verified": int(bool(r["verified"])),
            "email": r["email"],
            "email_source": "bio_regex" if r["email"] else None,
            "email_type": r["email_type"],
            "source_channel": "repost", "source_brand": f"@{brand}",
            "region_hint": region, "enrichment_status": "stub",
            "discovered_via": "repost", "discovered_from": f"@{brand}",
        })
        new += 1 if got else 0
    return new


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("brands", nargs="+", help="brand TikTok handles (no @)")
    ap.add_argument("--pages", type=int, default=8, help="max repost pages/brand")
    ap.add_argument("--out", default="reposts.csv")
    ap.add_argument("--store", action="store_true", help="write lead-stubs into the DB")
    ap.add_argument("--db", default="creatordb.sqlite")
    ap.add_argument("--region", default=None,
                    help="brand home market as region fallback (dach|us|nordic|...)")
    ap.add_argument("--enrich", action="store_true",
                    help="after storing, enrich the policy-matching stubs (posts->ER/cat/market)")
    ap.add_argument("--enrich-budget", type=float, default=1.00, help="USD cap for --enrich")
    args = ap.parse_args()

    prov = TikHubProvider()
    db = DB(args.db) if (args.store or args.enrich) else None
    all_rows, stub_new = [], 0
    for h in args.brands:
        h = h.strip().lstrip("@")
        try:
            bfoll, rows = harvest_brand(prov, h, args.pages)
        except ProviderError as e:
            print(f"@{h}: FEHLER {e}")
            continue
        with_mail = sum(1 for r in rows if r["email"])
        print(f"\n@{h}  (brand {bfoll:,} foll)  ->  {len(rows)} unique reposted creators, "
              f"{with_mail} mit Email ({100*with_mail//max(len(rows),1)}%)")
        for r in sorted(rows, key=lambda r: -(r["followers"] or 0)):
            mail = f"  📧 {r['email']} [{r['email_type']}]" if r["email"] else ""
            print(f"   @{r['handle']:<24} {(r['followers'] or 0):>9,}{mail}")
        if args.store:
            stub_new += store_stubs(db, h, rows, args.region)
        all_rows.extend(rows)

    if all_rows:
        cols = ["brand", "handle", "sec_uid", "nickname", "followers", "verified",
                "email", "email_type", "bio"]
        with open(args.out, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            w.writerows(all_rows)
        tot_mail = sum(1 for r in all_rows if r["email"])
        print(f"\n{'='*60}\n{len(all_rows)} creators gesamt, {tot_mail} mit Email "
              f"({100*tot_mail//len(all_rows)}%)  ->  {args.out}")
    if args.store:
        print(f"stubs neu in DB: {stub_new}  |  status: {db.status_counts()}")

    if args.enrich:
        stubs = db.stubs_to_enrich()
        print(f"\n--- ENRICH: {len(stubs)} Stubs matchen Policy (1k-50k + Email + DACH-hint) ---")
        enr = Enricher(prov, db, budget_usd=db.total_spent() + args.enrich_budget)
        kept = 0
        for s in stubs:
            try:
                new, outcome, summ = enr.enrich_from_stub(s)
            except BudgetExceeded:
                print("  Budget erreicht -- stop."); break
            except ProviderError as e:
                print(f"  @{s['handle']}: FEHLER {str(e)[:40]}"); continue
            if outcome == "qualified":
                kept += 1
                print(f"  ✓ @{summ['handle']:<22} {(summ['followers'] or 0):>8,}  "
                      f"ER={summ['engagement_median']}%  {summ['category']}  "
                      f"[{kept} DACH | ${db.total_spent():.3f}]")
            else:
                print(f"  · @{s['handle']:<22} {outcome}")
        print(f"\nenriched: {kept} DACH-qualifiziert  |  status: {db.status_counts()}  "
              f"|  spent=${db.total_spent():.3f}")


if __name__ == "__main__":
    main()
