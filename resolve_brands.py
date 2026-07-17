#!/usr/bin/env python3
"""
Brand-seed resolver + extrapolator for scaling the repost channel.

Two seed sources:
  1) --extra "handle1,handle2"  -> hand-given brand handles (used as-is).
  2) cohort self-feed: the brands our already-sourced creators TAG in paid posts
     become new seeds (the repost-channel analogue of the hashtag self-feeding loop).

Each candidate is resolved to a real TikTok account via search_users, biased toward
the DACH subsidiary account (nyxcosmetics_de, not the 1.4M global nyxcosmetics) --
because a brand reposts its HOME market, so the .de account is what yields DACH creators.

Prints the resolved list and writes the handles to --out (one per line) for
repost_harvest.py to consume.

    export TIKHUB_API_KEY=...
    python3 resolve_brands.py --extra "esteelauder,lamer,elfyeah,cotyinc,yepoda" --out brand_seeds.txt
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
from collections import Counter, defaultdict

import brands
from provider import TikHubProvider, ProviderError

DB = "creatordb.sqlite"
DACH_HINT = ("_de", ".de", "deutschland", "dach", "_at", "_ch", "germany", "österreich")
ALREADY_DONE = {"kessberlin", "purelei", "purishcom"}   # harvested already


def find_users(r):
    if isinstance(r, dict):
        for k in ("user_list", "userList", "users"):
            if isinstance(r.get(k), list) and r[k]:
                return r[k]
        for v in r.values():
            x = find_users(v)
            if x:
                return x
    if isinstance(r, list) and r and isinstance(r[0], dict):
        return r
    return None


def is_verified(ui):
    v = (ui.get("custom_verify") or ui.get("enterprise_verify_reason") or "").lower()
    return "verif" in v or "official" in v or "business" in v


def resolve(prov, query):
    """query (brand name/handle) -> best matching official account dict or None."""
    try:
        results = find_users(prov.search_users(query)) or []
    except ProviderError:
        return None
    cands = []
    stem = re.sub(r"[^a-z0-9]", "", query.lower())[:5]  # brand stem for name-match
    for r in results:
        ui = r.get("user_info") or r
        h, nick = (ui.get("unique_id") or ""), (ui.get("nickname") or "")
        if not ui.get("sec_uid") or not h:
            continue
        hc = re.sub(r"[^a-z0-9]", "", h.lower())
        # the account HANDLE must start with the brand stem -- a real brand account is
        # named after the brand (nyxcosmetics_de, teveo); this rejects same-name creators
        # (Mango->imchrismangos) and junk (Sol de Janeiro->hate.sol.de.janeiro).
        if stem and not hc.startswith(stem):
            continue
        blob = (h + nick).lower()
        cands.append({
            "handle": h, "nickname": nick, "sec_uid": ui["sec_uid"],
            "followers": ui.get("follower_count") or 0,
            "verified": is_verified(ui),
            "dach": any(x in blob for x in DACH_HINT),
        })
    if not cands:
        return None
    # rank: verified first (real brand), then DACH subsidiary, then followers
    cands.sort(key=lambda c: (c["verified"], c["dach"], c["followers"]), reverse=True)
    top = cands[0]
    # junk guard: an unverified sub-10k account named like the brand is usually a
    # fan/meme page, not the brand -> treat as unresolved.
    if not top["verified"] and top["followers"] < 10000:
        return None
    return top


def cohort_brand_candidates(limit=25):
    """Paid brands tagged by our sourced (repost) creators -> new seed names."""
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    cohort = {r[0] for r in c.execute(
        "SELECT sec_uid FROM creators WHERE source_channel='repost' "
        "AND market='dach' AND enrichment_status='enriched'")}
    cnt, cre, spon = Counter(), defaultdict(set), Counter()
    AD = ("anzeige", "werbung", "sponsored", "#ad", "/ad", "gifted", "paid partnership")
    for sec, mj, cap in c.execute("SELECT creator_sec_uid, mentions, caption FROM posts"):
        if sec not in cohort:
            continue
        isad = any(w in (cap or "").lower() for w in AD)
        for m in json.loads(mj or "[]"):
            m = brands.clean(m)
            if not m:
                continue
            cnt[m] += 1
            cre[m].add(sec)
            if isad:
                spon[m] += 1
    out = []
    for m in cnt:
        dc, sp = len(cre[m]), spon[m]
        if sp > 0 and dc >= 2 and brands.looks_like_brand(m, dc, sp):
            out.append((m, dc, sp))
    out.sort(key=lambda x: (-x[1], -x[2]))
    return out[:limit]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--extra", default="", help="comma-separated brand handles (used as-is)")
    ap.add_argument("--limit", type=int, default=25, help="max cohort-extrapolated brands")
    ap.add_argument("--out", default="brand_seeds.txt")
    args = ap.parse_args()

    prov = TikHubProvider()
    resolved, seen = [], set()

    # 1) user-given handles: verify via profile (exact, no search guessing)
    for h in [x.strip().lstrip("@") for x in args.extra.split(",") if x.strip()]:
        try:
            pf = prov.fetch_profile(h)
        except ProviderError:
            print(f"  ! @{h}: Profil nicht gefunden"); continue
        def dig(d, ks):
            if isinstance(d, dict):
                for k in ks:
                    if d.get(k) not in (None, ""):
                        return d[k]
                for v in d.values():
                    r = dig(v, ks)
                    if r not in (None, ""):
                        return r
            return None
        sec = dig(pf, ["secUid", "sec_uid"])
        foll = dig(pf, ["followerCount", "follower_count"]) or 0
        if sec and h not in seen:
            resolved.append({"handle": h, "followers": foll, "src": "given", "dach": False})
            seen.add(h)
            print(f"  ✓ given  @{h:<24} {foll:>9,}")

    # 2) cohort self-feed: extrapolated brands
    cands = cohort_brand_candidates(args.limit)
    print(f"\n{len(cands)} Brand-Kandidaten aus Cohorte-Mentions (paid, >=2 creators):")
    for name, dc, sp in cands:
        r = resolve(prov, name)
        if not r:
            print(f"  ? '{name[:26]}' -> nicht aufgelöst"); continue
        if r["handle"] in seen or r["handle"] in ALREADY_DONE:
            continue
        seen.add(r["handle"])
        resolved.append({**r, "src": f"cohort({dc}c/{sp}ad)"})
        tag = "🇩🇪" if r["dach"] else "🌍"
        print(f"  {tag} '{name[:22]:<22}' -> @{r['handle']:<22} {r['followers']:>9,}  ({dc}c/{sp}ad)")

    with open(args.out, "w") as f:
        f.write("\n".join(r["handle"] for r in resolved))
    dach = sum(1 for r in resolved if r.get("dach"))
    print(f"\n{len(resolved)} Brand-Seeds aufgelöst ({dach} klar DACH) -> {args.out}")


if __name__ == "__main__":
    main()
