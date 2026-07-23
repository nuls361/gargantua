#!/usr/bin/env python3
"""Re-extract brands_worked_with with an LLM (gpt-4o-mini) for ad-experienced creators
that have a placement date but no brand yet (@-mention method missed them). Fetch posts,
collect sponsored captions, ask the LLM which brands are advertised. Shardable."""
import os, json, requests
from store import Supa
from provider import TikHubProvider, ProviderError
import parse

OA = os.environ["OPENAI_API_KEY"]
BUDGET = float(os.environ.get("REBF_BUDGET", "8"))
OPENAI_CHAT = "https://api.openai.com/v1/chat/completions"


def llm_brands(caps):
    body = {"model": "gpt-4o-mini", "temperature": 0.2, "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": 'Extract the brand names being advertised in these sponsored TikTok captions. Return ONLY JSON: {"brands":["real brand names, [] if none clear"]}. No people, no generic words.'},
                {"role": "user", "content": " || ".join(caps)[:4000]}]}
    r = requests.post(OPENAI_CHAT, headers={"Authorization": f"Bearer {OA}", "Content-Type": "application/json"}, json=body, timeout=60)
    d = r.json()
    try:
        return [b for b in json.loads(d["choices"][0]["message"]["content"]).get("brands", []) if b and len(b) >= 2][:10]
    except Exception:
        return []


def targets(supa):
    out, off = [], 0
    while True:
        rows = supa._get("tt_creators", {"select": "sec_uid,handle",
                                         "brands_worked_with": "is.null", "last_placement_at": "not.is.null",
                                         "platform": "eq.tiktok", "limit": "1000", "offset": str(off)})
        out.extend(rows)
        if len(rows) < 1000:
            break
        off += 1000
    return out


def main():
    supa, prov = Supa(), TikHubProvider()
    shards = int(os.environ.get("CRAWL_SHARDS", "1")); shard = int(os.environ.get("CRAWL_SHARD", "0"))
    rows = targets(supa)
    if shards > 1:
        rows = [r for i, r in enumerate(rows) if i % shards == shard]
    start = supa.total_spent()
    print(f"[rebf s{shard}] targets: {len(rows)} budget=+${BUDGET}", flush=True)
    ok = withbrand = fail = 0
    for r in rows:
        if supa.total_spent() - start >= BUDGET:
            print(f"[rebf s{shard}] budget reached", flush=True); break
        try:
            raw = prov.fetch_posts(r["sec_uid"], count=30); supa.record_spend("rebrand", 0.001)
            caps = [pf["caption"][:300] for p in (parse.posts_list(raw) or [])
                    if parse.is_sponsored((pf := parse.post_fields(p)).get("caption") or "")]
            if not caps:
                ok += 1; continue
            brands = llm_brands(caps); supa.record_spend("rebrand", 0.0005)
            if brands:
                supa._patch("tt_creators", {"sec_uid": f"eq.{r['sec_uid']}"}, {"brands_worked_with": brands}); withbrand += 1
            ok += 1
        except (ProviderError, Exception):
            fail += 1
        if (ok + fail) % 100 == 0:
            supa.flush_spend(channel="rebrand")
            print(f"[rebf s{shard}] {ok+fail}/{len(rows)} withBrand={withbrand} fail={fail} ${supa.total_spent()-start:.2f}", flush=True)
    supa.flush_spend(channel="rebrand")
    print(f"[rebf s{shard}] DONE ok={ok} withBrand={withbrand} fail={fail} spent=${supa.total_spent()-start:.2f}", flush=True)


if __name__ == "__main__":
    main()
