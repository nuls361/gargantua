#!/usr/bin/env python3
"""
Layer 2 categorization: an LLM cleanup pass over the rows the hashtag rules
missed or were unsure about. Cheap and one-shot.

  targets  : category IS NULL  OR  category_confidence < MIN_CONF
  taxonomy : the lead tool's NICHES, verbatim -- the model may ONLY choose from it
  model    : Haiku (small, ~€0.10 for the whole index), batched to cut overhead
  writes   : category / category_secondary, category_source='llm', confidence=1.0
             (only when the model returns a valid in-taxonomy label; else left as-is)

Run:  ANTHROPIC_API_KEY=sk-... python3 categorize_llm.py [--all] [--dry]
      --all  also re-check rows the rules already labeled with high confidence
      --dry  print proposed labels, write nothing
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
MIN_CONF = 0.4          # rules rows below this get a second opinion
BATCH = 15              # creators per API call
API = "https://api.anthropic.com/v1/messages"

# EXACT lead-tool taxonomy (src/lib/search.ts NICHES). The model picks from this.
NICHES = [
    "beauty", "skincare", "wellness", "fitness", "fashion", "food", "travel",
    "lifestyle", "gaming", "tech", "finance", "music", "comedy", "parenting",
    "home & interior", "sustainability",
]

SYSTEM = (
    "You classify German-speaking (DACH) TikTok creators into ONE primary content "
    "niche and an optional secondary niche. You may ONLY use these exact labels:\n"
    + ", ".join(NICHES) + ".\n"
    "Judge from the creator's most-used hashtags and sample captions. If truly "
    "unclear, use \"lifestyle\". Return STRICT JSON only: a list of objects "
    "{\"id\": <int>, \"primary\": <label>, \"secondary\": <label|null>}. No prose."
)


def _client(key):
    def call(payload):
        req = urllib.request.Request(
            API, data=json.dumps(payload).encode(),
            headers={"content-type": "application/json", "x-api-key": key,
                     "anthropic-version": "2023-06-01"})
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    return call


def creator_briefs(conn, where):
    briefs = []
    rows = conn.execute(f"SELECT sec_uid, handle, nickname, bio FROM creators WHERE {where}").fetchall()
    tags = defaultdict(Counter); caps = defaultdict(list)
    secs = {r["sec_uid"] for r in rows}
    for pr in conn.execute("SELECT creator_sec_uid, hashtags, caption FROM posts"):
        s = pr["creator_sec_uid"]
        if s not in secs:
            continue
        for t in json.loads(pr["hashtags"] or "[]"):
            tags[s][t.lower()] += 1
        if pr["caption"] and len(caps[s]) < 3:
            caps[s].append(pr["caption"][:160])
    for i, r in enumerate(rows):
        s = r["sec_uid"]
        briefs.append({
            "id": i, "sec_uid": s, "handle": r["handle"],
            "bio": (r["bio"] or "")[:160],
            "hashtags": [t for t, _ in tags[s].most_common(12)],
            "captions": caps[s],
        })
    return briefs


def classify(call, batch):
    prompt = "Classify these creators:\n" + json.dumps(
        [{"id": b["id"], "handle": b["handle"], "bio": b["bio"],
          "top_hashtags": b["hashtags"], "sample_captions": b["captions"]}
         for b in batch], ensure_ascii=False)
    resp = call({"model": MODEL, "max_tokens": 1024, "system": SYSTEM,
                 "messages": [{"role": "user", "content": prompt}]})
    text = "".join(c.get("text", "") for c in resp.get("content", []))
    text = text[text.find("["): text.rfind("]") + 1]
    return {o["id"]: o for o in json.loads(text)}


def main():
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        sys.exit("Set ANTHROPIC_API_KEY (Haiku). ~€0.10 for the whole tail.")
    dry = "--dry" in sys.argv
    where = "1=1" if "--all" in sys.argv else \
        f"(category IS NULL OR category_confidence < {MIN_CONF})"

    conn = sqlite3.connect(DB); conn.row_factory = sqlite3.Row
    call = _client(key)
    briefs = creator_briefs(conn, where)
    print(f"targets: {len(briefs)} creators  (model={MODEL}, dry={dry})")

    valid = set(NICHES); changed = Counter()
    for i in range(0, len(briefs), BATCH):
        chunk = briefs[i:i + BATCH]
        try:
            out = classify(call, chunk)
        except Exception as e:
            print(f"  batch {i//BATCH} failed: {e}"); continue
        for b in chunk:
            o = out.get(b["id"])
            if not o or o.get("primary") not in valid:
                continue
            sec = o.get("secondary") if o.get("secondary") in valid else None
            changed[o["primary"]] += 1
            print(f"  @{b['handle']:24s} -> {o['primary']}"
                  + (f" / {sec}" if sec else ""))
            if not dry:
                conn.execute(
                    "UPDATE creators SET category=?, category_secondary=?, "
                    "category_confidence=1.0, category_source='llm' WHERE sec_uid=?",
                    (o["primary"], sec, b["sec_uid"]))
        if not dry:
            conn.commit()
    print("\nassigned:", ", ".join(f"{k}={v}" for k, v in changed.most_common()))


if __name__ == "__main__":
    main()
