#!/usr/bin/env python3
"""
Layer-2 categorization for the SUPABASE pool (tt_creators). An LLM cleanup pass over the
rows the rule-based `parse.categorize_rich` missed or was unsure about — the safety net the
old SQLite `categorize_llm.py` promised but never ran against lbug.

  targets  : category IS NULL  OR  category_source='rich_uncertain'  OR  confidence < MIN_CONF
  taxonomy : parse.CATEGORY_SIGNALS keys, VERBATIM (rich + LLM always in sync)
  evidence : Supabase stores no posts -> re-fetch each creator's posts once for the brief
  model    : Haiku, batched to cut overhead
  writes   : category / category_secondary, category_source='llm', confidence=1.0
             (only on a valid in-taxonomy label; else the row is left untouched)

Run:  ANTHROPIC_API_KEY=sk-.. SUPABASE_URL=.. SUPABASE_SECRET_KEY=.. TIKHUB_API_KEY=.. \
        python3 categorize_llm_supa.py [--all] [--dry] [--limit N]
      shardable via CRAWL_SHARDS / CRAWL_SHARD
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
from collections import Counter

import parse
from provider import TikHubProvider, ProviderError
from store import Supa
from enrich import _container

MODEL = "claude-haiku-4-5-20251001"
MIN_CONF = 0.4
BATCH = 15
API = "https://api.anthropic.com/v1/messages"

NICHES = list(parse.CATEGORY_SIGNALS.keys())   # authoritative taxonomy (incl. relationship)

SYSTEM = (
    "You classify German-speaking (DACH/UK/US) TikTok creators into ONE primary content "
    "niche and an optional secondary niche. You may ONLY use these exact labels:\n"
    + ", ".join(NICHES) + ".\n"
    "Judge from bio, most-used hashtags and sample captions. 'relationship' = couple / "
    "partner / Paar-Content. Trust an explicit self-description in the bio over incidental "
    "hashtags. If genuinely unclear, use \"lifestyle\". Return STRICT JSON only: a list of "
    "{\"id\": <int>, \"primary\": <label>, \"secondary\": <label|null>}. No prose."
)


def _client(key):
    def call(payload):
        req = urllib.request.Request(
            API, data=json.dumps(payload).encode(),
            headers={"content-type": "application/json", "x-api-key": key,
                     "anthropic-version": "2023-06-01"})
        with urllib.request.urlopen(req, timeout=90) as r:
            return json.loads(r.read())
    return call


def targets(supa: Supa, all_rows: bool, limit: int) -> list:
    out, offset = [], 0
    while True:
        params = {"select": "sec_uid,handle,bio,category,category_confidence",
                  "enrichment_status": "eq.enriched", "platform": "eq.tiktok",
                  "order": "sec_uid.asc", "limit": "1000", "offset": str(offset)}
        if not all_rows:
            # category null OR source uncertain OR confidence < MIN_CONF
            params["or"] = f"(category.is.null,category_source.eq.rich_uncertain,category_confidence.lt.{MIN_CONF})"
        rows = supa._get("tt_creators", params)
        out.extend(rows)
        if len(rows) < 1000 or (limit and len(out) >= limit):
            break
        offset += 1000
    return out[:limit] if limit else out


def brief(prov, r) -> dict:
    """Re-fetch a creator's posts once -> bio + top hashtags + sample captions."""
    tags, caps = Counter(), []
    try:
        raw = prov.fetch_posts(r["sec_uid"], count=15)
        for a in _container(raw).get("aweme_list") or _container(raw).get("itemList") or []:
            p = parse.post_fields(a)
            for t in p.get("hashtags") or []:
                tags[t.lower()] += 1
            if p.get("caption") and len(caps) < 3:
                caps.append(p["caption"][:160])
    except ProviderError:
        pass
    return {"handle": r["handle"], "bio": (r.get("bio") or "")[:160],
            "top_hashtags": [t for t, _ in tags.most_common(12)], "sample_captions": caps}


def classify(call, batch) -> dict:
    prompt = "Classify these creators:\n" + json.dumps(
        [{"id": i, **b} for i, b in enumerate(batch)], ensure_ascii=False)
    resp = call({"model": MODEL, "max_tokens": 1024, "system": SYSTEM,
                 "messages": [{"role": "user", "content": prompt}]})
    text = "".join(c.get("text", "") for c in resp.get("content", []))
    text = text[text.find("["): text.rfind("]") + 1]
    return {o["id"]: o for o in json.loads(text)}


def main():
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        sys.exit("Set ANTHROPIC_API_KEY (Haiku).")
    dry = "--dry" in sys.argv
    all_rows = "--all" in sys.argv
    limit = 0
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])

    supa = Supa()
    prov = TikHubProvider()
    call = _client(key)
    rows = targets(supa, all_rows, limit)
    shards = int(os.environ.get("CRAWL_SHARDS", "1"))
    shard = int(os.environ.get("CRAWL_SHARD", "0"))
    if shards > 1:
        rows = [r for i, r in enumerate(rows) if i % shards == shard]
    print(f"[llm-cat] targets: {len(rows)} (dry={dry}, shard {shard}/{shards})", flush=True)

    valid = set(NICHES)
    changed = Counter()
    t0 = time.time()
    for i in range(0, len(rows), BATCH):
        chunk = rows[i:i + BATCH]
        briefs = [brief(prov, r) for r in chunk]        # re-fetch posts (metered by provider)
        supa.record_spend("llmcat", 0.001 * len(chunk))
        try:
            out = classify(call, briefs)
        except Exception as e:
            print(f"  batch {i//BATCH} failed: {str(e)[:80]}", flush=True); continue
        for j, r in enumerate(chunk):
            o = out.get(j)
            if not o or o.get("primary") not in valid:
                continue
            sec = o.get("secondary") if o.get("secondary") in valid else None
            changed[o["primary"]] += 1
            if not dry:
                try:
                    supa._patch("tt_creators", {"sec_uid": f"eq.{r['sec_uid']}"},
                                {"category": o["primary"], "category_secondary": sec,
                                 "category_confidence": 1.0, "category_source": "llm"})
                except Exception:
                    pass
        supa.flush_spend(channel="llmcat")
        print(f"  {min(i+BATCH,len(rows))}/{len(rows)} | {(time.time()-t0)/60:.1f}m", flush=True)
    print(f"[llm-cat] DONE assigned: " + ", ".join(f"{k}={v}" for k, v in changed.most_common()), flush=True)


if __name__ == "__main__":
    main()
