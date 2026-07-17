#!/usr/bin/env python3
"""Index summary. Read-only; makes no API calls."""
from __future__ import annotations

import json
import sqlite3
from collections import Counter

DB = "creatordb.sqlite"


def main():
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    n = c.execute("SELECT COUNT(*) x FROM creators").fetchone()["x"]
    posts = c.execute("SELECT COUNT(*) x FROM posts").fetchone()["x"]
    spent = c.execute("SELECT COALESCE(SUM(cost_usd),0) x FROM spend").fetchone()["x"]
    print(f"CREATOR INDEX — {n} creators, {posts} posts, ${spent:.3f} spent "
          f"(~€{spent/1.08:.2f})\n")
    if n == 0:
        return

    rows = c.execute("SELECT * FROM creators").fetchall()
    with_email = sum(1 for r in rows if r["email"])
    print(f"  with email     : {with_email}/{n} ({100*with_email//n}%)")
    print(f"  avg engagement : {_avg(r['engagement_median'] for r in rows)}%")
    print(f"  avg followers  : {int(_avg(r['follower_count'] for r in rows)):,}")

    tiers = Counter()
    for r in rows:
        f = r["follower_count"] or 0
        tiers["<10k" if f < 10_000 else "10-100k" if f < 100_000 else "100k-1M" if f < 1_000_000 else "1M+"] += 1
    print("  follower tiers :", dict(tiers))
    print("  countries      :", dict(Counter(r["country"] for r in rows)))
    print("  discovered via :", dict(Counter(r["discovered_via"] for r in rows)))

    tags = Counter()
    for (h,) in c.execute("SELECT hashtags FROM posts"):
        tags.update(json.loads(h or "[]"))
    for junk in ("fyp", "foryou", "foryoupage", "viral", "fürdich", "trending", "capcut", "tiktok"):
        tags.pop(junk, None)
    print("  top hashtags   :", [t for t, _ in tags.most_common(15)])

    print("\n  sample creators:")
    for r in rows[:12]:
        print(f"    @{r['handle']:<22} {r['follower_count']:>8,}  {r['country']}  "
              f"ER={r['engagement_median']}%  {r['email'] or ''}")


def _avg(it):
    xs = [x for x in it if x is not None]
    return round(sum(xs) / len(xs), 1) if xs else 0


if __name__ == "__main__":
    main()
