#!/usr/bin/env python3
"""
Creator-DOCUMENT builder (Supabase). The fused TEXT + METADATA layer per creator — the
foundation that unlocks hashtag analysis, the quality factor and pgvector semantic search.
Supersedes categorize_llm_supa.py: ONE Haiku call emits category + profile_summary + tags,
while the free metadata signals (original_sound_ratio, avg_views[_pinned], comment signals)
are computed in code. VISION (vibe/setting) is a separate later pass.

Sampling: newest posts within the last 90 days, capped at 30 (selection reservoir).
De-noise: reach hashtags + emoji/CTA-only captions stripped before anything is embedded.

Run:  ANTHROPIC_API_KEY=.. SUPABASE_URL=.. SUPABASE_SECRET_KEY=.. TIKHUB_API_KEY=.. \
        python3 doc_builder.py [--limit N] [--dry]   (shardable via CRAWL_SHARDS/CRAWL_SHARD)
"""
from __future__ import annotations

import datetime
import json
import os
import re
import sys
import time
import urllib.request
from collections import Counter

import parse
from provider import TikHubProvider, ProviderError
from store import Supa
from enrich import _container, _find_comments

MODEL = "claude-haiku-4-5-20251001"
API = "https://api.anthropic.com/v1/messages"
SINCE_DAYS = 90
CAP = 30

REACH_TAGS = {
    "fyp", "fy", "fypѕ", "fypage", "fyppage", "foryou", "foryoupage", "foryourpage",
    "fuerdich", "fürdich", "fürdichseite", "fuerdichseite", "viral", "viralvideo",
    "viraltiktok", "trend", "trending", "trendingvideo", "capcut", "xyzbca", "xyz", "tiktok",
    "follow", "follower", "like", "likes", "blowthisup", "blowup", "explore", "reels", "reel",
}
TAXONOMY = list(parse.CATEGORY_SIGNALS.keys())
FORMATS = ["grwm", "tutorial", "vlog", "day-in-life", "storytime", "talking-head", "pov",
           "skit", "haul", "review", "recipe", "transformation", "dance", "lip-sync",
           "get-ready", "unboxing", "asmr"]
PERSONAS = ["solo", "couple", "family", "group"]

SYSTEM = (
    "You build a content profile for a TikTok creator for an internal creator database "
    "(not identifying individuals). Judge from bio, most-used hashtags, sample captions, "
    "sounds and brands. Return STRICT JSON only, no prose:\n"
    "{\"category\": <one of: " + ", ".join(TAXONOMY) + ">,\n"
    " \"category_secondary\": <one of the same list, or null>,\n"
    " \"profile_summary\": <2-3 sentence natural-language description of who this creator is, "
    "their content, audience and any brand work>,\n"
    " \"content_format\": <subset of: " + ", ".join(FORMATS) + ">,\n"
    " \"persona\": <one of: solo, couple, family, group, or null if no textual evidence>}\n"
    "'relationship' category = couple/Paar content. 'persona' = who appears in the content, "
    "ONLY from explicit textual evidence (bio 'wir'/'Paar'/'family', couple/family hashtags); "
    "null if unclear. If the niche is genuinely unclear use category 'lifestyle'."
)


def _client(key):
    def call(payload):
        req = urllib.request.Request(
            API, data=json.dumps(payload).encode(),
            headers={"content-type": "application/json", "x-api-key": key,
                     "anthropic-version": "2023-06-01"})
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=90) as r:
                    return json.loads(r.read())
            except urllib.error.HTTPError as e:
                if e.code in (429, 529, 500, 503) and attempt < 3:
                    time.sleep(2 * (attempt + 1)); continue
                raise
    return call


def fetch_sample(prov, sec) -> list:
    """Newest posts, last 90 days, capped at CAP (floor 8 if the window is sparse)."""
    cutoff = time.time() - SINCE_DAYS * 86400
    raw = prov.fetch_posts(sec, count=35)
    items = (_container(raw).get("aweme_list") or _container(raw).get("itemList") or [])
    posts = [parse.post_fields(a) for a in items]
    posts = [p for p in posts if p.get("create_time")]
    posts.sort(key=lambda p: int(p["create_time"]), reverse=True)
    recent = [p for p in posts if int(p["create_time"]) >= cutoff]
    return recent[:CAP] if len(recent) >= 8 else posts[:CAP]


def denoise_hashtags(posts, n=15) -> list:
    c = Counter()
    for p in posts:
        for t in p.get("hashtags") or []:
            t = t.lower().strip()
            if t and t not in REACH_TAGS and not t.isdigit():
                c[t] += 1
    return [t for t, _ in c.most_common(n)]


def best_captions(posts, n=6) -> list:
    scored = []
    for p in posts:
        cap = (p.get("caption") or "").strip()
        words = re.findall(r"[A-Za-zÀ-ſ]{3,}", cap)
        if len(words) >= 4:                       # skip emoji/CTA/near-empty
            scored.append((len(words), cap[:200]))
    scored.sort(reverse=True)
    return [c for _, c in scored[:n]]


def sound_ratio(posts, handle, nick) -> float | None:
    hl, nk = handle.lower(), (nick or "").lower()
    own = 0
    for p in posts:
        if p.get("sound_is_original"):
            o = (p.get("sound_owner") or p.get("sound_author") or "").lower()
            if o and (o in hl or hl in o or (nk and (o in nk or nk in o))):
                own += 1
    return round(own / len(posts), 3) if posts else None


def view_signals(posts):
    reg = [p["play"] for p in posts if not p.get("is_top") and isinstance(p.get("play"), int)]
    pin = [p["play"] for p in posts if p.get("is_top") and isinstance(p.get("play"), int)]
    avg = int(sum(reg) / len(reg)) if reg else None
    avgp = int(sum(pin) / len(pin)) if pin else None
    return avg, avgp


def comment_signals(prov, posts, market):
    want = "de" if market == "dach" else "en"
    top = sorted((p for p in posts if (p.get("comment") or 0) >= 5),
                 key=lambda p: p.get("comment") or 0, reverse=True)[:4]
    langs, total, substantive, eng, eng_tot = Counter(), 0, 0, 0, 0
    for p in top:
        if not p.get("aweme_id"):
            continue
        try:
            raw = prov.fetch_video_comments(p["aweme_id"], count=20)
        except ProviderError:
            continue
        for c in (_find_comments(raw) or []):
            txt = c.get("text") or c.get("comment") or ""
            total += 1
            eng_tot += 1
            if len([w for w in re.findall(r"\w+", txt) if len(w) >= 2]) >= 3:
                substantive += 1
            cl = (c.get("comment_language") or "").lower()[:2]
            if cl:
                langs[cl] += 1
            if c.get("is_author_digged") or c.get("author_pin"):
                eng += 1
    substance = round(substantive / total, 3) if total else None
    lang_match = round(langs.get(want, 0) / sum(langs.values()), 3) if langs else None
    reply_rate = round(eng / eng_tot, 3) if eng_tot else None
    aud = None
    if langs:
        top_lang, cnt = langs.most_common(1)[0]
        aud = "mixed" if cnt / sum(langs.values()) < 0.6 else top_lang
    return substance, lang_match, reply_rate, aud


def build_one(supa, prov, call, row, dry=False):
    sec, handle = row["sec_uid"], row["handle"]
    posts = fetch_sample(prov, sec)
    if not posts:
        return None
    supa.record_spend("docbuild", 0.002)
    tags = denoise_hashtags(posts)
    caps = best_captions(posts)
    brands = sorted({m for p in posts if parse.is_sponsored(p.get("caption"))
                     for m in (p.get("mentions") or [])})
    sounds = [p.get("sound") for p in posts if p.get("sound")][:6]
    osr = sound_ratio(posts, handle, row.get("display_name"))
    avg, avgp = view_signals(posts)
    subst, lmatch, reply, aud = comment_signals(prov, posts, row.get("market"))

    brief = {"handle": handle, "bio": (row.get("bio") or "")[:200],
             "top_hashtags": tags, "sample_captions": caps,
             "brands": brands[:10], "sounds": sounds}
    resp = call({"model": MODEL, "max_tokens": 500, "system": SYSTEM,
                 "messages": [{"role": "user", "content": json.dumps(brief, ensure_ascii=False)}]})
    text = "".join(c.get("text", "") for c in resp.get("content", []))
    text = text[text.find("{"): text.rfind("}") + 1]
    o = json.loads(text)

    cat = o.get("category") if o.get("category") in TAXONOMY else None
    fields = {
        "category": cat,
        "category_secondary": o.get("category_secondary") if o.get("category_secondary") in TAXONOMY else None,
        "category_confidence": 1.0, "category_source": "doc",
        "profile_summary": (o.get("profile_summary") or "")[:1000] or None,
        "content_format": [f for f in (o.get("content_format") or []) if f in FORMATS] or None,
        "persona": o.get("persona") if o.get("persona") in PERSONAS else None,
        "audience_lang": aud,
        "top_hashtags": tags or None,
        "original_sound_ratio": osr,
        "avg_views": avg, "avg_views_pinned": avgp,
        "comment_substance_ratio": subst, "comment_lang_match": lmatch, "creator_reply_rate": reply,
        "raw_doc": {"captions": caps, "hashtags": tags, "sounds": sounds, "brands": brands[:15]},
        "doc_built_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    if dry:
        return {"handle": handle, **{k: fields[k] for k in
                ("category", "content_format", "persona", "audience_lang",
                 "original_sound_ratio", "avg_views", "avg_views_pinned",
                 "comment_substance_ratio", "creator_reply_rate")},
                "summary": fields["profile_summary"]}
    supa._patch("tt_creators", {"sec_uid": f"eq.{sec}"}, fields)
    return {"handle": handle, "category": cat, "persona": fields["persona"]}


def targets(supa, limit):
    # doc_built_at is null -> resumable: a re-launch skips creators already done.
    # Paginate: PostgREST caps a single response at 1000 rows.
    out, offset = [], 0
    while True:
        rows = supa._get("tt_creators", {
            "select": "sec_uid,handle,bio,market,display_name",
            "enrichment_status": "eq.enriched", "platform": "eq.tiktok",
            "doc_built_at": "is.null",
            "order": "follower_count.desc.nullslast",
            "limit": "1000", "offset": str(offset)})
        out.extend(rows)
        if len(rows) < 1000 or (limit and len(out) >= limit):
            break
        offset += 1000
    return out[:limit] if limit else out


def main():
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        sys.exit("Set ANTHROPIC_API_KEY.")
    dry = "--dry" in sys.argv
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else 0
    supa, prov, call = Supa(), TikHubProvider(), _client(key)
    rows = targets(supa, limit)
    shards = int(os.environ.get("CRAWL_SHARDS", "1"))
    shard = int(os.environ.get("CRAWL_SHARD", "0"))
    if shards > 1:
        rows = [r for i, r in enumerate(rows) if i % shards == shard]
    print(f"[doc] targets: {len(rows)} (dry={dry}, shard {shard}/{shards})", flush=True)
    done, t0 = 0, time.time()
    for r in rows:
        try:
            out = build_one(supa, prov, call, r, dry=dry)
        except Exception as e:
            print(f"  @{r['handle']}: {str(e)[:70]}", flush=True); continue
        if out is None:
            continue
        done += 1
        if dry:
            print(json.dumps(out, ensure_ascii=False, indent=1))
        if done % 25 == 0:
            supa.flush_spend(channel="docbuild")
            print(f"  {done}/{len(rows)} | {(time.time()-t0)/60:.1f}m", flush=True)
    supa.flush_spend(channel="docbuild")
    print(f"[doc] DONE {done} built, time={(time.time()-t0)/60:.1f}m", flush=True)


if __name__ == "__main__":
    main()
