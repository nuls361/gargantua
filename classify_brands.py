#!/usr/bin/env python3
"""
Classify every brand by its TikTok account language -> market (dach / uk / other).

Brand profiles carry no country field but a reliable `language`:
  de -> DACH (strong), en -> UK (weak: en is ambiguous US/UK/global), else -> other.
Dead/unknown handles -> other. Manually-added brands are pinned to DACH (user's list).
Resumable: only brands with market IS NULL are checked, so a re-run continues.

    SUPABASE_URL=.. SUPABASE_SECRET_KEY=.. TIKHUB_API_KEY=.. python3 classify_brands.py
"""
from __future__ import annotations

import time
from collections import Counter

import parse
from provider import TikHubProvider, ProviderError
from store import Supa


def brand_language(raw: dict):
    u = (((raw.get("data") or {}).get("userInfo") or {}).get("user") or {})
    return u.get("language") or parse.find_first(raw, ["language"])


def market_of(lang) -> str:
    if lang == "de":
        return "dach"
    if lang == "en":
        return "uk"
    return "other"


def main():
    s = Supa()
    p = TikHubProvider()

    # user's hand-picked brands are kept as DACH regardless of account language
    s._patch("brands", {"discovered_via": "eq.manual"}, {"market": "dach"})

    rows = s._get("brands", {"select": "handle,market", "market": "is.null", "limit": "5000"})
    print(f"[classify-brands] zu prüfen: {len(rows)}", flush=True)
    c = Counter()
    t0 = time.time()
    for i, b in enumerate(rows):
        h = (b.get("handle") or "").lstrip("@")
        if not h:
            continue
        try:
            m = market_of(brand_language(p.fetch_profile(h)))
        except ProviderError:
            m = "other"          # dead / not found -> treat as out
        except Exception:
            continue
        try:
            s._patch("brands", {"handle": f"eq.@{h}"}, {"market": m})
        except Exception:
            pass
        c[m] += 1
        if (i + 1) % 50 == 0:
            print(f"  {i+1}/{len(rows)}  {dict(c)}  ({(time.time()-t0)/60:.0f}m)", flush=True)
    print(f"[classify-brands] FERTIG {dict(c)}  ({(time.time()-t0)/60:.1f}m)", flush=True)


if __name__ == "__main__":
    main()
