#!/usr/bin/env python3
"""
Two-level categorization (full index, one LLM pass). Fixes what the single-level
pass couldn't: creators the 16-niche taxonomy had no home for (Ballermann/Malle,
career, deals, anime, city-guides) were force-fit to the nearest wrong label.

Now every creator gets:
  category   (PRIMARY)  -> one of 15 lead-tool niches (skincare folded into beauty),
                          tool-facing, 1:1 with the Search filter.
  sub_niche  (FREE)     -> a short DACH-native label (rave, kita, malle, anime,
                          medizin, career, deals, city-guide, ...) — internal granularity.

Run:  ANTHROPIC_API_KEY=sk-... python3 categorize_v2.py [--dry] [--limit N]
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import urllib.request
from collections import Counter, defaultdict

DB = "creatordb.sqlite"
MODEL = "claude-haiku-4-5-20251001"
BATCH = 15
API = "https://api.anthropic.com/v1/messages"

# PRIMARY taxonomy: lead-tool NICHES minus skincare (folded into beauty).
PRIMARY = [
    "beauty", "wellness", "fitness", "fashion", "food", "travel", "lifestyle",
    "gaming", "tech", "finance", "music", "comedy", "parenting",
    "home & interior", "sustainability",
]

# Preferred sub-niches (the model may add a short custom one if none fit). These
# encode the DACH-native clusters we actually saw in the data.
SUBS = (
    "makeup, skincare, fragrance, nails, haircare, drogerie-beauty, "
    "techno-rave, hardtekk, hiphop-rap, kpop, singer, dj, "
    "kita-erzieher, mamalife, pregnancy, dad, "
    "workandtravel, city-guide, backpacking, roadtrip, "
    "ootd, haul, thrift, plus-size, "
    "vlog, lifehacks, student, couple, party-malle, local-news, "
    "health-medizin, personal-finance, business-news, career-ausbildung, "
    "deals-couponing, anime, cosplay, gym, weightloss, "
    "food-recipes, restaurant-guide, home-decor, cleaning, sustainability"
)

SYSTEM = (
    "You classify German-speaking (DACH) TikTok creators on two levels.\n\n"
    "1) PRIMARY — choose exactly ONE of these tool-facing niches:\n"
    + ", ".join(PRIMARY) + ".\n"
    "   Rules: skincare content -> \"beauty\". Techno/rave/Hardtekk -> \"music\". "
    "Ballermann/Malle/Schlager party -> \"music\" if music-led else \"lifestyle\". "
    "City guides, career/Ausbildung, deals/couponing, news, anime -> \"lifestyle\" "
    "unless a stronger niche clearly dominates. Health/medical education -> \"wellness\".\n\n"
    "2) SUB_NICHE — one short lowercase label (1-2 words) naming the REAL content type. "
    "Prefer one of: " + SUBS + ". If none fit, invent a short one.\n\n"
    "Judge from top hashtags + sample captions + bio. Return STRICT JSON only: a list of "
    "{\"id\": <int>, \"primary\": <niche>, \"sub_niche\": <label>}. No prose."
)


def client(key):
    def call(payload):
        req = urllib.request.Request(
            API, data=json.dumps(payload).encode(),
            headers={"content-type": "application/json", "x-api-key": key,
                     "anthropic-version": "2023-06-01"})
        with urllib.request.urlopen(req, timeout=90) as r:
            return json.loads(r.read())
    return call


def briefs(conn, limit):
    rows = conn.execute("SELECT sec_uid, handle, nickname, bio, follower_count "
                        "FROM creators WHERE sub_niche IS NULL "
                        "ORDER BY follower_count DESC").fetchall()
    if limit:
        rows = rows[:limit]
    secs = {r["sec_uid"] for r in rows}
    tags, caps = defaultdict(Counter), defaultdict(list)
    for pr in conn.execute("SELECT creator_sec_uid, hashtags, caption FROM posts"):
        s = pr["creator_sec_uid"]
        if s not in secs:
            continue
        for t in json.loads(pr["hashtags"] or "[]"):
            tags[s][t.lower().strip()] += 1
        if pr["caption"] and len(caps[s]) < 3:
            caps[s].append(pr["caption"][:160])
    out = []
    for i, r in enumerate(rows):
        s = r["sec_uid"]
        out.append({"id": i, "sec_uid": s, "handle": r["handle"],
                    "bio": (r["bio"] or "")[:150],
                    "hashtags": [t for t, _ in tags[s].most_common(12)],
                    "captions": caps[s]})
    return out


def classify(call, batch):
    prompt = "Classify:\n" + json.dumps(
        [{"id": b["id"], "handle": b["handle"], "bio": b["bio"],
          "top_hashtags": b["hashtags"], "sample_captions": b["captions"]}
         for b in batch], ensure_ascii=False)
    resp = call({"model": MODEL, "max_tokens": 1500, "system": SYSTEM,
                 "messages": [{"role": "user", "content": prompt}]})
    text = "".join(c.get("text", "") for c in resp.get("content", []))
    text = text[text.find("["): text.rfind("]") + 1]
    return {o["id"]: o for o in json.loads(text)}


def main():
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        sys.exit("Set ANTHROPIC_API_KEY. Full index ~€0.40.")
    dry = "--dry" in sys.argv
    limit = 0
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])

    conn = sqlite3.connect(DB); conn.row_factory = sqlite3.Row
    call = client(key)
    items = briefs(conn, limit)
    print(f"two-level pass: {len(items)} creators (model={MODEL}, dry={dry})\n")

    valid = set(PRIMARY)
    prim_ct, sub_ct, moved = Counter(), Counter(), 0
    for i in range(0, len(items), BATCH):
        chunk = items[i:i + BATCH]
        try:
            out = classify(call, chunk)
        except Exception as e:
            print(f"  batch {i//BATCH} failed: {e}"); continue
        for b in chunk:
            o = out.get(b["id"])
            if not o or o.get("primary") not in valid:
                continue
            sub = (o.get("sub_niche") or "").strip().lower()[:24] or None
            prim_ct[o["primary"]] += 1
            if sub:
                sub_ct[sub] += 1
            if not dry:
                cur = conn.execute("SELECT category FROM creators WHERE sec_uid=?", (b["sec_uid"],)).fetchone()
                if cur and cur["category"] != o["primary"]:
                    moved += 1
                conn.execute(
                    "UPDATE creators SET category=?, sub_niche=?, category_confidence=1.0, "
                    "category_source='llm-v2' WHERE sec_uid=?",
                    (o["primary"], sub, b["sec_uid"]))
        if not dry:
            conn.commit()
        print(f"  batch {i//BATCH+1}/{-(-len(items)//BATCH)} done")

    print("\nPRIMARY:", ", ".join(f"{k}={v}" for k, v in prim_ct.most_common()))
    print(f"\nSUB_NICHE ({len(sub_ct)} distinct), top 25:")
    for k, v in sub_ct.most_common(25):
        print(f"  {k:20s} {v}")
    if not dry:
        print(f"\nprimary reassigned for {moved} creators")


if __name__ == "__main__":
    main()
