#!/usr/bin/env python3
"""
Brand extractor — the second product from the same data.

Every enriched creator's posts already store their @-mentions. Aggregated across
the index, these reveal which BRANDS run creator marketing in DACH -- WePush's
advertiser-sales target list. The 'sponsored' count (caption says anzeige/werbung)
is the key signal: it separates 'a brand a creator tagged' from 'a brand that PAYS
creators'. Read-only: safe to run while discovery is still writing.

    python3 brands.py            # top brands to stdout + brands.csv
"""
from __future__ import annotations

import csv
import json
import re
import sqlite3
from collections import Counter, defaultdict

DB = "creatordb.sqlite"
AD_WORDS = ("anzeige", "werbung", "sponsored", "/ad", "#ad", "paid partnership", "gifted")

# Mentions that are almost certainly other CREATORS, not brands, get down-weighted
# (handle-style: all lowercase, no spaces, dots/underscores). Brands tend to be
# Title Case with spaces or carry ®/™.
HANDLE_RE = re.compile(r"^[a-z0-9._]+$")
BRANDISH_RE = re.compile(r"[®™]| [A-Z]|^[A-Z][a-z]+ ")


def looks_like_brand(name: str, distinct_creators: int, sponsored: int) -> bool:
    if sponsored > 0:                      # tagged in a paid post -> brand
        return True
    if distinct_creators >= 3:             # many creators tag it -> brand
        return True
    if BRANDISH_RE.search(name) and not HANDLE_RE.match(name):
        return True
    return False


def clean(name: str) -> str | None:
    n = " ".join((name or "").split())     # collapse whitespace/newlines
    n = n.rstrip(" @#")                     # drop offset-slice artifacts
    if len(n) < 2 or n.startswith("#"):
        return None
    return n


def main():
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    handle_of = {sec: h for sec, h in c.execute("SELECT sec_uid, handle FROM creators")}

    count = Counter()
    creators = defaultdict(set)
    sponsored = Counter()
    for sec, mj, cap in c.execute("SELECT creator_sec_uid, mentions, caption FROM posts"):
        is_ad = any(w in (cap or "").lower() for w in AD_WORDS)
        for m in json.loads(mj or "[]"):
            m = clean(m)
            if not m:
                continue
            count[m] += 1
            creators[m].add(sec)
            if is_ad:
                sponsored[m] += 1

    rows = []
    for m in count:
        dc = len(creators[m])
        if not looks_like_brand(m, dc, sponsored[m]):
            continue
        score = dc * 2 + sponsored[m] * 3          # activity = reach × paid intensity
        examples = [handle_of.get(s, "?") for s in list(creators[m])[:5]]
        rows.append((m, count[m], dc, sponsored[m], score, examples))
    rows.sort(key=lambda r: (-r[4], -r[3]))

    with open("brands.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["brand", "mentions", "distinct_creators", "sponsored_posts",
                    "activity_score", "example_creators"])
        for m, cnt, dc, sp, sc, ex in rows:
            w.writerow([m, cnt, dc, sp, sc, ", ".join(ex)])

    active = [r for r in rows if r[3] > 0]
    print(f"Brands extrahiert: {len(rows)}  (davon {len(active)} mit bezahlten Posts)\n")
    print(f"{'BRAND':<30}{'creators':>9}{'werbung':>8}{'score':>6}   beispiel")
    print("-" * 78)
    for m, cnt, dc, sp, sc, ex in rows[:35]:
        print(f"{m[:29]:<30}{dc:>9}{sp:>8}{sc:>6}   {', '.join(ex[:2])}")
    print(f"\n-> brands.csv ({len(rows)} Zeilen)")


if __name__ == "__main__":
    main()
