#!/usr/bin/env python3
"""Harvest the hashtags our sample creators actually use -> the discovery fuel.
Aggregates across all seeds, strips generic stopwords, ranks. Writes the list to
seed_hashtags.txt so the hashtag engine can read it."""
from __future__ import annotations

from collections import Counter

import parse
from provider import TikHubProvider, ProviderError

SEEDS = [
    "yulesy", "aylinend", "antoniaviehbeck", "edda.elisa", "emifrais",
    "22annii", "juliahsen", "chantall.smd", "jasmindres", "hellaseng",
    "kimm.glossy", "orne.may", "claraajulie", "xilezhou", "amiraa.ldr",
    "chantal.sizi", "tyraberlin", "blondminh", "alisacayenne", "mo.kanoute",
]

STOP = {"fyp", "foryou", "foryoupage", "fürdich", "fuerdich", "viral", "trending",
        "trend", "tiktok", "capcut", "fy", "xyzbca", "viralvideo", "edit", "edits",
        "foru", "para", "parati", "reels", "explore", "german", "deutschland",
        "deutsch", "germany", "berlin"}


def cont(o):
    if isinstance(o, dict):
        if "aweme_list" in o:
            return o
        for v in o.values():
            r = cont(v)
            if r:
                return r
    if isinstance(o, list):
        for v in o:
            r = cont(v)
            if r:
                return r
    return {}


def main():
    prov = TikHubProvider()
    tags = Counter()
    per_seed = {}
    for h in SEEDS:
        try:
            sec = parse.profile_fields(prov.fetch_profile(h))["sec_uid"]
        except ProviderError as e:
            print(f"{h}: ERROR {str(e)[:40]}")
            continue
        posts, cursor = [], 0
        for _ in range(3):  # ~90 recent posts
            c = cont(prov.fetch_posts(sec, count=30, max_cursor=cursor))
            items = c.get("aweme_list", [])
            posts += items
            if not c.get("has_more") or not items:
                break
            cursor = c.get("max_cursor")
        local = Counter()
        for a in posts:
            for t in parse.post_fields(a)["hashtags"]:
                tl = t.lower().strip()
                if tl and tl not in STOP and not tl.isdigit():
                    tags[tl] += 1
                    local[tl] += 1
        per_seed[h] = [t for t, _ in local.most_common(5)]
        print(f"  {h:<20} {len(posts):>3} posts  top: {per_seed[h]}")

    print("\n" + "=" * 60)
    print("TOP HASHTAGS über alle 20 Sample-Creator (= Discovery-Fuel):")
    top = tags.most_common(45)
    for t, n in top:
        print(f"   #{t:<26} {n}x")

    with open("seed_hashtags.txt", "w", encoding="utf-8") as f:
        for t, n in top:
            f.write(f"{t}\t{n}\n")
    print(f"\ngespeichert -> seed_hashtags.txt ({len(top)} Hashtags)")


if __name__ == "__main__":
    main()
