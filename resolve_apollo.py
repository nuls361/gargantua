#!/usr/bin/env python3
"""
Resolve TikTok handles for the Apollo company list -> repost-channel seeds.

For each company: strip the legal form (GmbH/AG/...), search TikHub, and let the AI
pick the company's official TikTok account from the REAL results (or null if the
company simply isn't on TikTok -- most B2B producers won't be). Verified handle +
follower stats come from the search result, so no hallucinated handles.

    export TIKHUB_API_KEY=... ANTHROPIC_API_KEY=...
    python3 resolve_apollo.py [--limit N] [--min-followers 500] --out apollo_tiktok.csv
"""
from __future__ import annotations

import argparse
import csv
import re
import os
import sys

from brand_discover import haiku, pick
from resolve_brands import find_users
from provider import TikHubProvider, ProviderError

SRC = "/Users/nuls101/Downloads/apollo-accounts-export (5).csv"

LEGAL = re.compile(
    r"\b(gmbh|mbh|ag|kgaa|kg|ohg|ug|se|holding|group|vertriebs?|"
    r"ges\.?\s?m\.?\s?b\.?\s?h\.?|e\.?\s?k\.?|e\.?\s?v\.?|co|inc|ltd|llc)\b", re.I)


def clean_company(n: str) -> str:
    n = LEGAL.sub(" ", n or "")
    n = n.replace("&", " ").replace(".", " ")
    return re.sub(r"\s+", " ", n).strip(" -")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="only first N companies (0=all)")
    ap.add_argument("--min-followers", type=int, default=500)
    ap.add_argument("--out", default="apollo_tiktok.csv")
    args = ap.parse_args()

    if not (os.environ.get("TIKHUB_API_KEY") and os.environ.get("ANTHROPIC_API_KEY")):
        sys.exit("Set TIKHUB_API_KEY and ANTHROPIC_API_KEY.")
    prov = TikHubProvider()
    call = haiku(os.environ["ANTHROPIC_API_KEY"])

    rows = list(csv.DictReader(open(SRC)))
    if args.limit:
        rows = rows[: args.limit]

    # resume: skip companies already resolved in a prior (crashed) run
    done = set()
    if os.path.exists(args.out):
        done = {r["company"] for r in csv.DictReader(open(args.out))}

    cols = ["company", "handle", "followers", "industry", "city", "website"]
    f = open(args.out, "a", newline="")
    w = csv.DictWriter(f, fieldnames=cols)
    if not done:
        w.writeheader(); f.flush()

    found, searched, no_tiktok = len(done), 0, 0
    for r in rows:
        if r["Company Name"] in done:
            continue
        name = clean_company(r["Company Name"])
        if len(name) < 3:
            continue
        searched += 1
        # one company must never kill the whole run -> catch EVERYTHING (timeouts too)
        try:
            results = find_users(prov.search_users(name)) or []
            if not results:
                no_tiktok += 1
                continue
            choice = pick(call, r["Company Name"], results)
        except Exception as e:
            print(f"  ! {r['Company Name'][:30]:<30} skip ({type(e).__name__})")
            continue
        handle = (choice or {}).get("handle")
        if not handle:
            no_tiktok += 1
            continue
        match = next((x for x in results
                      if (x.get("user_info") or x).get("unique_id") == handle), None)
        if not match:
            continue
        ui = match.get("user_info") or match
        foll = ui.get("follower_count") or 0
        if foll < args.min_followers:
            continue
        w.writerow({
            "company": r["Company Name"], "handle": handle, "followers": foll,
            "industry": r.get("Industry", ""), "city": r.get("Company City", ""),
            "website": r.get("Website", ""),
        })
        f.flush()                                # persist immediately
        found += 1
        print(f"  ✓ {r['Company Name'][:34]:<34} -> @{handle:<22} {foll:>8,} ({r.get('Industry','')[:18]})")

    f.close()
    print(f"\n{searched} durchsucht -> {found} mit TikTok-Account total. -> {args.out}")


if __name__ == "__main__":
    main()
