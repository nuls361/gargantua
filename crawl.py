#!/usr/bin/env python3
"""
3-layer recursive discovery crawl.

Seeds (L1): the sounds + hashtag given. Each layer:
  harvest a source -> creators -> qualify + enrich the keepers (into tt_creators,
  topic-tagged, source-tagged) -> collect each keeper's hashtags / sounds / brands ->
  those become the NEXT layer's sources (deduped globally).
Runs until --depth layers deep OR TikHub funds run out. Metered; budget is a hard ceiling.

    SUPABASE_URL=.. SUPABASE_SECRET_KEY=.. TIKHUB_API_KEY=.. \
        python3 crawl.py --budget 38 --depth 3
"""
from __future__ import annotations

import argparse
import os
import time
from collections import deque

import parse
import freemail
from provider import TikHubProvider, ProviderError
from store import Supa
from enrich import Enricher, BudgetExceeded
from sound_harvest import harvest_sound, is_dach_author
from hashtag_harvest import harvest_hashtag
from creator_harvest import harvest_creator
from repost_harvest import harvest_brand, region_from_email

MIN_FOLLOWERS = 1000
MAX_CANDIDATES_PER_SOURCE = 80       # keepers enriched per source (breadth guard)
NEXT_CAP = {"hashtag": 20, "sound": 12, "brand": 12}   # entities pushed to next layer / source
FUNDS_MARKERS = ("insufficient", "balance", "quota", "402", "payment", "not enough", "credit")

SEEDS = [
    ("sound", "7608801818244270862"),
    ("sound", "7283953439722801952"),
    ("sound", "7640189670659312417"),
    ("hashtag", "coolgirlvibe"),
]


def is_funds_error(e) -> bool:
    s = str(e).lower()
    return any(m in s for m in FUNDS_MARKERS)


def norm(stype: str, value: str) -> str:
    if stype == "hashtag":
        return "#" + value.lstrip("#").lower()
    if stype in ("brand", "creator"):
        return "@" + value.lstrip("@").lower()
    return "sound:" + str(value)


def source_tag(stype: str, value: str) -> str:
    if stype == "hashtag":
        return "#" + value.lstrip("#")
    if stype in ("brand", "creator"):
        return "@" + value.lstrip("@")
    return "sound:" + str(value)


def harvest_for(prov, stype, value, pages, meter):
    if stype == "sound":
        return harvest_sound(prov, value, pages, meter=meter)
    if stype == "hashtag":
        return harvest_hashtag(prov, value.lstrip("#"), pages, meter=meter)
    if stype == "brand":
        return harvest_brand(prov, value.lstrip("@"), pages, meter=meter)[1]
    if stype == "creator":
        return harvest_creator(prov, value.lstrip("@"), pages, meter=meter)
    return []


def _retry(fn, tries=5, base=2.0):
    """Transient network/DB blips are normal on a long run -- retry with backoff."""
    last = None
    for i in range(tries):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001 - deliberately broad (network layer)
            last = e
            time.sleep(base * (i + 1))
    raise last


def load_existing_handles(supa: Supa) -> set:
    out, offset = set(), 0
    while True:
        rows = _retry(lambda o=offset: supa._get(
            "tt_creators", {"select": "handle", "limit": "1000", "offset": str(o)}))
        for r in rows:
            if r.get("handle"):
                out.add(r["handle"].lower())
        if len(rows) < 1000:
            break
        offset += 1000
    return out


def run(budget: float = 36.0, depth: int = 3, pages: int = 6):
    """3-layer recursive crawl. Callable from the Railway worker (CRAWL=1) or the CLI."""
    class _A:
        pass
    args = _A()
    args.budget, args.depth, args.pages = budget, depth, pages

    supa = Supa()
    prov = TikHubProvider()
    start = supa.total_spent()
    enr = Enricher(prov, supa, budget_usd=start + args.budget, max_harvest_followers=250_000,
                   max_pages=4, min_posts=12)
    meter = lambda: supa.record_spend("crawl", 0.001)

    # Seeds: CRAWL_SEEDS env ("brand:larocheposay,hashtag:hautpflege,sound:123…") overrides
    # the default sound seeds, so a DACH run can start from the German brands instead.
    seed_env = os.environ.get("CRAWL_SEEDS", "").strip()
    if seed_env:
        seeds = []
        for tok in seed_env.split(","):
            tok = tok.strip()
            if ":" in tok:
                t, v = tok.split(":", 1)
                if t in ("brand", "hashtag", "sound", "creator") and v.strip():
                    seeds.append((t, v.strip()))
    else:
        seeds = SEEDS
    print(f"[crawl] seeds: " + ", ".join(f"{t}:{v}" for t, v in seeds), flush=True)

    q = deque((st, sv, 0) for st, sv in seeds)
    seen_sources = {norm(st, sv) for st, sv, _ in q}
    processed = load_existing_handles(supa)
    print(f"[crawl] start_spend=${start:.3f} budget=+${args.budget:.2f} depth={args.depth} "
          f"seeds={len(q)} pool_known={len(processed)}", flush=True)

    kept = 0
    stop = False
    t0 = time.time()

    def over_budget() -> bool:
        return supa.total_spent() - start >= args.budget

    while q and not stop:
        stype, sval, depth = q.popleft()
        if over_budget():
            print("[crawl] budget reached", flush=True)
            break
        try:
            cands = harvest_for(prov, stype, sval, args.pages, meter)
        except BudgetExceeded:
            break
        except ProviderError as e:
            if is_funds_error(e):
                print(f"[crawl] funds out at harvest: {str(e)[:80]}", flush=True)
                break
            print(f"  L{depth} {source_tag(stype, sval)}: harvest err {str(e)[:50]}", flush=True)
            continue

        next_ent = {"hashtag": set(), "sound": set(), "brand": set()}
        brands_found = set()          # every brand seen in a caption -> the Brands view
        src_kept = 0
        for c in cands:
            if src_kept >= MAX_CANDIDATES_PER_SOURCE or over_budget():
                if over_budget():
                    stop = True
                break
            sec, h = c.get("sec_uid"), c.get("handle")
            if not sec or not h or h.lower() in processed:
                continue
            processed.add(h.lower())

            # Sound authors carry a free region/language signal -> pre-filter to DACH
            # BEFORE spending a profile call (same gate as channels.run_sound_job).
            if stype == "sound" and not is_dach_author(c):
                continue

            fol = c.get("followers")
            if fol is None:                      # sound authors carry no follower stat
                try:
                    prof = enr._call(lambda hh=h: prov.fetch_profile(hh), "profile")
                except BudgetExceeded:
                    stop = True; break
                except ProviderError as e:
                    if is_funds_error(e):
                        stop = True; break
                    continue
                except Exception:
                    continue
                pf = parse.profile_fields(prof)
                fol = pf.get("followers")
                c["bio"] = c.get("bio") or pf.get("bio")
                if not c.get("email"):
                    c["email"] = parse.email_from_bio(pf.get("bio", ""))
            if not isinstance(fol, int) or fol < MIN_FOLLOWERS:
                continue

            email = c.get("email")
            bio = c.get("bio") or ""
            region = region_from_email(email) or ("dach" if (stype == "sound" and is_dach_author(c)) else None)
            try:
                _retry(lambda: supa.upsert_stubs([{
                    "sec_uid": sec, "handle": h, "display_name": c.get("nickname"),
                    "bio": bio, "follower_count": fol, "verified": bool(c.get("verified")),
                    "email": email, "email_source": "bio_regex" if parse.email_from_bio(bio) else ("crm" if email else None),
                    "email_type": freemail.classify_email(email) if email else None,
                    "source_channel": stype, "source_brand": sval.lstrip("@") if stype == "brand" else None,
                    "source_type": stype, "source_value": source_tag(stype, sval),
                    "region_hint": region, "enrichment_status": "stub",
                    "discovered_via": stype, "discovered_from": source_tag(stype, sval),
                }]))
                _retry(lambda: supa.add_creator_sources([{
                    "sec_uid": sec, "source_type": stype, "source_value": source_tag(stype, sval)}]))
            except Exception:
                continue

            try:
                _, _outcome, summ = enr.enrich_from_stub({
                    "sec_uid": sec, "handle": h, "follower_count": fol, "region_hint": region,
                    "email": email, "bio": bio,
                    "source_brand": sval.lstrip("@") if stype == "brand" else None})
            except BudgetExceeded:
                stop = True; break
            except ProviderError as e:
                if is_funds_error(e):
                    stop = True; break
                continue
            except Exception:
                continue

            kept += 1
            src_kept += 1
            # Only DACH/UK keepers seed the next layer + the Brands view -> the snowball
            # stays in-market instead of drifting global (this was the €-eating bug).
            if summ and summ.get("market") in ("dach", "uk"):
                for b in summ.get("brands", []):
                    bh = (b or "").lstrip("@")
                    if 2 <= len(bh) <= 30:
                        brands_found.add(bh)
                if depth + 1 < args.depth:
                    for t in summ.get("hashtags", []):
                        next_ent["hashtag"].add(t)
                    for s in summ.get("sounds", []):
                        next_ent["sound"].add(s)
                    next_ent["brand"] |= brands_found
            if kept % 20 == 0:
                supa.flush_spend(channel="crawl")
                print(f"  kept={kept} queue={len(q)} spent=${supa.total_spent() - start:.2f}/"
                      f"{args.budget:.0f} ({(time.time() - t0) / 60:.0f}m)", flush=True)

        # register every brand seen in a caption into the Brands view (idempotent)
        if brands_found:
            try:
                _retry(lambda: supa._insert(
                    "brands",
                    [{"handle": "@" + b, "status": "candidate", "discovered_via": "crawl"}
                     for b in brands_found],
                    on_conflict="handle", resolution="ignore"))
            except Exception:
                pass

        # enqueue the next layer (deduped, capped per type)
        if depth + 1 < args.depth:
            for etype, vals in next_ent.items():
                for v in list(vals)[:NEXT_CAP[etype]]:
                    key = norm(etype, v)
                    if key in seen_sources:
                        continue
                    seen_sources.add(key)
                    q.append((etype, v, depth + 1))
        supa.flush_spend(channel="crawl")
        print(f"[L{depth}] {source_tag(stype, sval)} -> +{src_kept} kept | total {kept} | "
              f"queue {len(q)} | ${supa.total_spent() - start:.2f}", flush=True)

    supa.flush_spend(channel="crawl")
    print(f"[crawl] DONE kept={kept} sources_seen={len(seen_sources)} "
          f"spent=${supa.total_spent() - start:.2f} time={(time.time() - t0) / 60:.1f}m", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--budget", type=float, default=36.0, help="USD to spend this crawl")
    ap.add_argument("--depth", type=int, default=3, help="layers of qualification")
    ap.add_argument("--pages", type=int, default=6, help="harvest pages per source")
    a = ap.parse_args()
    run(budget=a.budget, depth=a.depth, pages=a.pages)


if __name__ == "__main__":
    main()
