#!/usr/bin/env python3
"""
Brand-discovery loop: find NEW brands to harvest from the MENTIONS + HASHTAGS of our
already-sourced creators (the repost-channel analogue of the hashtag self-feeding loop).

Two AI (Haiku) calls keep it precise -- the AI identifies, TikHub verifies (no
hallucinated handles ever reach the DB):
  AI#1  classify candidate strings -> which are BRANDS (vs creators/generic), canonical
        name, a TikTok search query, and whether it's DACH-market relevant.
  AI#2  disambiguate the real TikHub search results -> pick the official account,
        preferring the DACH subsidiary (nyxcosmetics_de over global nyxcosmetics);
        return null if none of the real accounts is the brand.

    export TIKHUB_API_KEY=... ANTHROPIC_API_KEY=...
    python3 brand_discover.py [--limit 60] [--dach-only] [--out new_brand_seeds.txt]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import urllib.request
from collections import Counter, defaultdict

import brands
from resolve_brands import find_users, is_verified, ALREADY_DONE
from provider import TikHubProvider, ProviderError

DB = "creatordb.sqlite"
MODEL = "claude-haiku-4-5-20251001"
API = "https://api.anthropic.com/v1/messages"

CLASSIFY_SYS = (
    "You are given strings that German-speaking (DACH) TikTok creators either @-mentioned "
    "or used as #hashtags in their posts. For EACH string decide whether it names a consumer "
    "BRAND that pays creators for partnerships (a product/label/DTC company in beauty, fashion, "
    "jewelry, fitness, nutrition, home, etc.).\n"
    "Set is_brand=false for: other creators/people, generic words, places, and — importantly — "
    "APPS/PLATFORMS/TOOLS (CapCut, TikTok, Instagram, Shopify, Amazon), media outlets, and "
    "marketplaces. We only want consumer product brands that run influencer campaigns.\n"
    "Return STRICT JSON: a list of {\"id\": <int>, \"is_brand\": <bool>, \"name\": <canonical "
    "brand name>, \"query\": <best TikTok search term, include 'de' if a German account likely "
    "exists>, \"dach\": <bool: has a German-market presence/audience>, \"category\": "
    "<beauty|fashion|jewelry|fitness|nutrition|home|tech|other>}. "
    "For non-brands set is_brand=false and omit the rest. No prose."
)

PICK_SYS = (
    "You pick the correct official TikTok account for a brand from REAL search results. "
    "Rules: prefer the DACH/German subsidiary account (e.g. 'nyxcosmetics_de' over the global "
    "'nyxcosmetics') when the brand sells in DACH; the account must be the BRAND itself, not a "
    "fan/parody/reseller/creator page; prefer verified + higher followers. If NONE of the given "
    "accounts is the real brand, return handle=null.\n"
    "Return STRICT JSON only: {\"handle\": <chosen unique_id or null>, \"reason\": <short>}."
)


def haiku(key):
    def call(system, prompt, max_tokens=1500):
        req = urllib.request.Request(
            API, data=json.dumps({"model": MODEL, "max_tokens": max_tokens, "system": system,
                                  "messages": [{"role": "user", "content": prompt}]}).encode(),
            headers={"content-type": "application/json", "x-api-key": key,
                     "anthropic-version": "2023-06-01"})
        with urllib.request.urlopen(req, timeout=90) as r:
            body = json.loads(r.read())
        text = "".join(c.get("text", "") for c in body.get("content", []))
        return text
    return call


def _norm(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _harvested_stems(c):
    """Base name of every brand we've already harvested, so the loop surfaces only NEW
    brands (else the cohort's top mentions are just its own seed brands tagged back)."""
    stems = set()
    for (sb,) in c.execute("SELECT DISTINCT source_brand FROM creators "
                           "WHERE source_brand IS NOT NULL"):
        h = _norm(sb)
        for suf in ("germany", "deutschland", "official", "cosmetics", "fashion",
                    "jewelry", "lab", "de"):
            if h.endswith(suf) and len(h) > len(suf) + 2:
                h = h[: -len(suf)]
        if len(h) >= 4:
            stems.add(h)
    return stems


def candidates(limit):
    """The BRANDS our sourced DACH creators tag in @-mentions, ranked by brand-signal
    (paid mentions first), not raw frequency -- else generic hashtags and creator
    cross-mentions bury the real brands. Name variants (ICRUSH/icrush/#icrush) collapse.
    Excludes brands we already harvested, so only NEW brands surface."""
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    cohort = {r[0] for r in c.execute(
        "SELECT sec_uid FROM creators WHERE source_channel='repost' AND market='dach' "
        "AND enrichment_status='enriched'")}
    done = _harvested_stems(c)
    cnt, cre, spon, display = Counter(), defaultdict(set), Counter(), {}
    AD = ("anzeige", "werbung", "sponsored", "#ad", "/ad", "gifted", "paid partnership")
    for sec, mj, cap in c.execute("SELECT creator_sec_uid, mentions, caption FROM posts"):
        if sec not in cohort:
            continue
        isad = any(w in (cap or "").lower() for w in AD)
        for m in json.loads(mj or "[]"):
            m = brands.clean(m)
            if not m:
                continue
            key = _norm(m)                       # collapse ICRUSH / icrush / variants
            if len(key) < 3:
                continue
            cnt[key] += 1
            cre[key].add(sec)
            display.setdefault(key, m)
            if isad:
                spon[key] += 1

    def already(k):
        return any(k == d or k.startswith(d) or d.startswith(k) for d in done if len(k) >= 4)

    # rank: paid mentions first (definitely a brand), then reach
    ranked = sorted(cnt, key=lambda k: (spon[k], len(cre[k])), reverse=True)
    out = []
    for k in ranked:
        dc, sp, name = len(cre[k]), spon[k], display[k]
        if dc < 2 or already(k):
            continue
        if not brands.looks_like_brand(name, dc, sp):   # heuristic pre-filter
            continue
        out.append({"str": name, "creators": dc, "sponsored": sp})
        if len(out) >= limit:
            break
    return out


def classify(call, cands):
    prompt = "Classify:\n" + json.dumps(
        [{"id": i, "string": c["str"]} for i, c in enumerate(cands)], ensure_ascii=False)
    txt = call(CLASSIFY_SYS, prompt, max_tokens=3000)
    txt = txt[txt.find("["): txt.rfind("]") + 1]
    return {o["id"]: o for o in json.loads(txt)}


def pick(call, name, results):
    slim = [{"handle": (r.get("user_info") or r).get("unique_id"),
             "name": (r.get("user_info") or r).get("nickname"),
             "followers": (r.get("user_info") or r).get("follower_count"),
             "verified": is_verified(r.get("user_info") or r),
             "bio": ((r.get("user_info") or r).get("signature") or "")[:80]}
            for r in results[:10] if (r.get("user_info") or r).get("unique_id")]
    if not slim:
        return None
    prompt = f"Brand: {name}\nAccounts:\n" + json.dumps(slim, ensure_ascii=False)
    txt = call(PICK_SYS, prompt, max_tokens=300)
    txt = txt[txt.find("{"): txt.rfind("}") + 1]
    try:
        return json.loads(txt)
    except json.JSONDecodeError:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=80, help="max candidate strings to classify")
    ap.add_argument("--dach-only", action="store_true", help="keep only DACH-market brands")
    ap.add_argument("--out", default="new_brand_seeds.txt")
    args = ap.parse_args()

    tik_key = os.environ.get("TIKHUB_API_KEY")
    an_key = os.environ.get("ANTHROPIC_API_KEY")
    if not (tik_key and an_key):
        sys.exit("Set TIKHUB_API_KEY and ANTHROPIC_API_KEY.")
    prov = TikHubProvider()
    call = haiku(an_key)

    # every handle we've already harvested -> never re-suggest it
    _c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    harvested_handles = {(_norm(sb)) for (sb,) in _c.execute(
        "SELECT DISTINCT source_brand FROM creators WHERE source_brand IS NOT NULL")}

    cands = candidates(args.limit)
    print(f"{len(cands)} Kandidaten (Mentions+Hashtags) -> AI#1 Klassifikation...")
    cls = classify(call, cands)
    brand_cands = []
    for i, c in enumerate(cands):
        o = cls.get(i) or {}
        if o.get("is_brand") and o.get("name"):
            brand_cands.append({**c, **o})
    if args.dach_only:
        brand_cands = [b for b in brand_cands if b.get("dach")]
    print(f"  -> {len(brand_cands)} als Brand erkannt "
          f"({sum(1 for b in brand_cands if b.get('dach'))} DACH)\n")

    resolved, seen = [], set()
    for b in brand_cands:
        try:
            results = find_users(prov.search_users(b.get("query") or b["name"])) or []
        except ProviderError:
            results = []
        if not results:
            print(f"  ? {b['name'][:24]:<24} keine Suchergebnisse"); continue
        choice = pick(call, b["name"], results)
        handle = (choice or {}).get("handle")
        if not handle or handle in seen or _norm(handle) in harvested_handles:
            if not handle:
                print(f"  – {b['name'][:24]:<24} AI: kein echter Brand-Account")
            continue
        # verify the chosen handle exists in the (real) search results + grab stats
        match = next((r for r in results if (r.get("user_info") or r).get("unique_id") == handle), None)
        if not match:
            continue
        ui = match.get("user_info") or match
        seen.add(handle)
        resolved.append({"handle": handle, "name": b["name"], "dach": b.get("dach"),
                         "category": b.get("category"), "followers": ui.get("follower_count") or 0,
                         "creators": b["creators"]})
        tag = "🇩🇪" if b.get("dach") else "🌍"
        print(f"  {tag} {b['name'][:22]:<22} -> @{handle:<22} {ui.get('follower_count') or 0:>9,} "
              f"({b['category']}, {b['creators']}c)")

    with open(args.out, "w") as f:
        f.write("\n".join(r["handle"] for r in resolved))
    dach = sum(1 for r in resolved if r["dach"])
    print(f"\n{len(resolved)} neue Brand-Seeds verifiziert ({dach} DACH) -> {args.out}")


if __name__ == "__main__":
    main()
