#!/usr/bin/env python3
"""Measure seed-graph yield for a set of seeds WITHOUT storing anything.
For each seed: is following public? how many followed accounts are >=1k?
how many real @-mentions in posts? Then the aggregate: total NEW candidate
seeds the graph would hand us. Read-only diagnostic before we scale."""
from __future__ import annotations

import sys
from collections import Counter

import parse
from provider import TikHubProvider, ProviderError

SEEDS = [
    "yulesy", "aylinend", "antoniaviehbeck", "edda.elisa", "emifrais",
    "22annii", "juliahsen", "chantall.smd", "jasmindres", "hellaseng",
    "kimm.glossy", "orne.may", "claraajulie", "xilezhou", "amiraa.ldr",
    "chantal.sizi", "tyraberlin", "blondminh", "alisacayenne", "mo.kanoute",
]


def cl(o, keys):
    if isinstance(o, dict):
        for k, v in o.items():
            if k in keys and isinstance(v, list) and v:
                return v
            r = cl(v, keys)
            if r:
                return r
    if isinstance(o, list):
        for v in o:
            r = cl(v, keys)
            if r:
                return r
    return []


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
    cand_following = {}   # handle -> followers (>=1k accounts the seeds follow)
    cand_mentions = Counter()
    pub = 0
    print(f"{'seed':<20}{'foll':>8}  lg  {'follows→pub':>11}  {'≥1k':>4}  {'mentions':>8}")
    print("-" * 66)
    for h in SEEDS:
        try:
            pf = parse.profile_fields(prov.fetch_profile(h))
        except ProviderError as e:
            print(f"{h:<20}  ERROR {str(e)[:30]}")
            continue
        sec = pf["sec_uid"]
        lang = pf.get("language") if isinstance(pf.get("language"), str) else "?"
        # following
        fol_users = cl(prov.fetch_following(sec, count=30), {"followings", "user_list", "userList"})
        if fol_users:
            pub += 1
        n_big = 0
        for e in fol_users:
            u = e.get("user", e)
            uh = parse.find_first(u, ["uniqueId", "unique_id"])
            fc = (e.get("stats") or {}).get("followerCount") or parse.find_first(u, ["follower_count"]) or 0
            if uh and isinstance(fc, int) and fc >= 1000:
                cand_following[uh] = fc
                n_big += 1
        # mentions from ~2 pages of posts
        posts, cursor, ment = [], 0, 0
        for _ in range(2):
            c = cont(prov.fetch_posts(sec, count=30, max_cursor=cursor))
            items = c.get("aweme_list", [])
            posts += items
            if not c.get("has_more") or not items:
                break
            cursor = c.get("max_cursor")
        for a in posts:
            for m in parse.post_fields(a)["mentions"]:
                cand_mentions[m] += 1
                ment += 1
        print(f"{h:<20}{(pf.get('followers') or 0):>8,}  {lang:<2}  {len(fol_users):>11}  {n_big:>4}  {ment:>8}")

    uniq_follow = set(cand_following)
    uniq_ment = set(cand_mentions)
    print("\n" + "=" * 66)
    print(f"seeds mit öffentlicher Following-Liste : {pub}/{len(SEEDS)}")
    print(f"neue ≥1k-Kandidaten aus FOLLOWING      : {len(uniq_follow)} unique")
    print(f"neue Kandidaten aus MENTIONS           : {len(uniq_ment)} unique")
    print(f"GESAMT neue Seeds aus 20 Seeds         : {len(uniq_follow | uniq_ment)} unique")
    print("\nTop Following-Kandidaten (≥1k, wie oft von den Seeds gefolgt):")
    top = sorted(cand_following.items(), key=lambda x: -x[1])[:15]
    for hh, fc in top:
        print(f"   @{hh:<24} {fc:>10,}")
    print("\nTop Mentions (wie oft getaggt):")
    for m, n in cand_mentions.most_common(15):
        print(f"   @{m:<24} {n}x")


if __name__ == "__main__":
    main()
