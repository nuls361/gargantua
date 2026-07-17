#!/usr/bin/env python3
"""
Market-Intelligence report over the WHOLE index (incl. no-email creators — the
whole point of keeping them). Read-only, no API calls. Produces:
  - market_intelligence.json   (machine-readable, feeds the Artifact / lead tool)
  - a printed summary

Sections, chosen for WePush's two revenue sides:
  A. Overview + reachability        (who we hold, who is contactable)
  B. Niche landscape + benchmarks   (median followers / ER / cadence / sponsored / reach per niche)
  C. Engagement matrix              (follower-tier x niche median ER -> the number you quote advertisers)
  D. Sound / music intelligence     (original vs commercial audio, most-used sounds -> WePush's core)
  E. Brand landscape                (top brands creators mention, paid share -> advertiser-sales leads)
"""
from __future__ import annotations

import json
import sqlite3
import statistics
from collections import Counter, defaultdict

DB = "creatordb.sqlite"

# generic hashtags that carry no niche signal (don't report them as "trends")
STOP = {
    "fyp", "foryou", "foryoupage", "fürdich", "fuerdich", "viral", "trending", "trend",
    "tiktok", "capcut", "fy", "xyzbca", "viralvideo", "edit", "edits", "deutschland",
    "deutsch", "germany", "österreich", "schweiz", "reels", "explore", "follow", "like",
    "fürdichpage", "foryoupageofficiall", "trending2026", "viraltiktok", "blowthisup",
}

TIERS = [("nano 1–10k", 1_000, 10_000), ("micro 10–50k", 10_000, 50_000),
         ("mid 50–250k", 50_000, 250_000), ("macro 250k+", 250_000, 10**12)]


def med(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), 2) if xs else None


def tier_of(f):
    for name, lo, hi in TIERS:
        if f is not None and lo <= f < hi:
            return name
    return None


def main():
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    creators = [dict(r) for r in c.execute("SELECT * FROM creators")]
    n = len(creators)

    # per-creator hashtags + sounds from posts
    tags_by_cat = defaultdict(Counter)
    cat_of = {cr["sec_uid"]: cr["category"] for cr in creators}
    sound_creators = defaultdict(set)      # sound_title -> {sec_uid}
    audio = Counter()                       # original / commercial / other
    total_posts = 0
    for p in c.execute("SELECT creator_sec_uid, hashtags, sound_title, "
                       "sound_is_original, sound_is_commerce FROM posts"):
        total_posts += 1
        cat = cat_of.get(p["creator_sec_uid"])
        for t in json.loads(p["hashtags"] or "[]"):
            tl = t.lower().strip()
            if tl and tl not in STOP and not tl.isdigit() and len(tl) >= 3:
                tags_by_cat[cat][tl] += 1
        if p["sound_is_original"]:
            audio["original audio"] += 1
        elif p["sound_is_commerce"]:
            audio["commercial track"] += 1
        else:
            audio["other / unknown"] += 1
        if p["sound_title"]:
            sound_creators[p["sound_title"]].add(p["creator_sec_uid"])

    # ---- A. overview ----------------------------------------------------
    tiers = Counter(tier_of(cr["follower_count"]) for cr in creators)
    email_split = Counter(cr["email_type"] or "none" for cr in creators)
    reachable = sum(1 for cr in creators if cr["email_type"] in ("freemail", "management"))
    with_link = sum(1 for cr in creators if cr.get("bio_link"))
    overview = {
        "creators": n, "posts": total_posts,
        "follower_tiers": dict(tiers),
        "reachable_email": reachable, "reachable_pct": round(100 * reachable / n),
        "email_split": dict(email_split),
        "with_bio_link": with_link,
        "verified": sum(1 for cr in creators if cr["verified"]),
        "median_followers": med([cr["follower_count"] for cr in creators]),
        "median_engagement_pct": med([cr["engagement_median"] for cr in creators]),
    }

    # ---- B. niche landscape --------------------------------------------
    by_cat = defaultdict(list)
    for cr in creators:
        by_cat[cr["category"]].append(cr)
    niches = []
    for cat, crs in sorted(by_cat.items(), key=lambda kv: -len(kv[1])):
        sponsored = sum(1 for cr in crs if (cr["sponsored_count"] or 0) > 0)
        reach = sum(1 for cr in crs if cr["email_type"] in ("freemail", "management"))
        niches.append({
            "niche": cat, "creators": len(crs),
            "median_followers": med([cr["follower_count"] for cr in crs]),
            "median_engagement_pct": med([cr["engagement_median"] for cr in crs]),
            "median_posts_per_week": med([cr["posting_per_week"] for cr in crs]),
            "sponsored_creator_pct": round(100 * sponsored / len(crs)),
            "reachable_pct": round(100 * reach / len(crs)),
            "top_hashtags": [t for t, _ in tags_by_cat[cat].most_common(6)],
        })

    # ---- C. engagement matrix (tier x niche median ER) -----------------
    top_niches = [x["niche"] for x in niches[:8]]
    matrix = {}
    for name, lo, hi in TIERS:
        row = {}
        for cat in top_niches:
            ers = [cr["engagement_median"] for cr in by_cat[cat]
                   if cr["follower_count"] is not None and lo <= cr["follower_count"] < hi]
            row[cat] = med(ers)
        matrix[name] = row

    # ---- D. sound / music intelligence ---------------------------------
    audio_total = sum(audio.values()) or 1
    sounds = {
        "audio_mix_pct": {k: round(100 * v / audio_total) for k, v in audio.most_common()},
        "top_sounds_by_reach": [
            {"sound": s, "creators": len(u)}
            for s, u in sorted(sound_creators.items(), key=lambda kv: -len(kv[1]))[:20]
        ],
    }

    # ---- E. brand landscape (from post @-mentions) ---------------------
    brand_ct, brand_creators = Counter(), defaultdict(set)
    for p in c.execute("SELECT creator_sec_uid, mentions FROM posts"):
        for m in json.loads(p["mentions"] or "[]"):
            ml = m.lower().strip()
            if ml:
                brand_ct[ml] += 1
                brand_creators[ml].add(p["creator_sec_uid"])
    brands = [{"handle": b, "mentions": brand_ct[b], "distinct_creators": len(brand_creators[b])}
              for b, _ in brand_ct.most_common(30)]

    report = {"overview": overview, "niches": niches, "engagement_matrix": matrix,
              "sounds": sounds, "brands": brands}
    with open("market_intelligence.json", "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    # ---- printed summary ------------------------------------------------
    o = overview
    print(f"=== MARKET INTELLIGENCE — WePush DACH index ===")
    print(f"{o['creators']} creators · {o['posts']} posts · "
          f"median {o['median_followers']:,.0f} followers · median ER {o['median_engagement_pct']}%")
    print(f"reachable by email: {o['reachable_pct']}%  ({o['email_split']})  "
          f"· bio-link: {o['with_bio_link']} · verified: {o['verified']}")
    print(f"follower tiers: " + " · ".join(f"{k}={v}" for k, v in o['follower_tiers'].items() if k))
    print("\nNICHE BENCHMARKS (median):")
    print(f"  {'niche':16s} {'#':>4} {'followers':>10} {'ER%':>6} {'posts/wk':>9} {'spons%':>7} {'reach%':>7}")
    for x in niches:
        print(f"  {x['niche']:16s} {x['creators']:>4} "
              f"{(x['median_followers'] or 0):>10,.0f} {x['median_engagement_pct'] or 0:>6} "
              f"{x['median_posts_per_week'] or 0:>9} {x['sponsored_creator_pct']:>6}% {x['reachable_pct']:>6}%")
    print("\nAUDIO MIX:", " · ".join(f"{k}={v}%" for k, v in sounds["audio_mix_pct"].items()))
    print("TOP SOUNDS (by creator reach):")
    for s in sounds["top_sounds_by_reach"][:8]:
        print(f"  {s['creators']:>3} creators  {s['sound'][:60]}")
    print("\nwrote market_intelligence.json")


if __name__ == "__main__":
    main()
