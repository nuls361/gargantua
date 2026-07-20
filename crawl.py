#!/usr/bin/env python3
"""
The scraper. ONE source of truth for harvest + qualify + enrich.

`process_source()` takes a single source (brand / hashtag / sound / creator), harvests
its creators and applies ALL hard filters in one place:
    E-MAIL required · followers 1k–250k · market DACH/UK/US · engagement 2–14%
Anything failing is never stored (or deleted if it only reveals itself post-enrich), so
the pool ONLY ever holds bookable creators. Keepers get Attio-reconciled (WePush flag).

Two entry points, same core (no duplicated logic):
  - run()        : batch / recursive crawl (BFS over sources, optional sharding). CLI + CRAWL=1.
  - harvest_one(): one source for the reactive Railway worker (a scrape_jobs row).

    SUPABASE_URL=.. SUPABASE_SECRET_KEY=.. TIKHUB_API_KEY=.. \
        python3 crawl.py --budget 38 --depth 2
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
from sound_harvest import harvest_sound, resolve_music_id, is_dach_author
from hashtag_harvest import harvest_hashtag
from creator_harvest import harvest_creator
from repost_harvest import harvest_brand, region_from_email

# ---- hard filters (the single definition, used everywhere) ------------------
MIN_FOLLOWERS = 1_000
MAX_FOLLOWERS = 250_000
# Brand sources: taggers/reposters are pre-validated BY the brand, so the follower band
# is wider (0–500k) — a brand collab is itself the quality signal.
MIN_FOLLOWERS_BRAND = 0
MAX_FOLLOWERS_BRAND = 500_000
MARKETS = ("dach", "uk", "us")          # target countries
ER_MIN, ER_MAX = 2, 14                   # engagement-rate band (%)


def follower_band(source_type: str) -> tuple[int, int]:
    if source_type == "brand":
        return MIN_FOLLOWERS_BRAND, MAX_FOLLOWERS_BRAND
    return MIN_FOLLOWERS, MAX_FOLLOWERS
MAX_CANDIDATES_PER_SOURCE = 80           # keepers enriched per source (breadth guard)
NEXT_CAP = {"hashtag": 20, "sound": 12, "brand": 12}
FUNDS_MARKERS = ("insufficient", "balance", "quota", "402", "payment", "not enough", "credit")

SEEDS = [("hashtag", "coolgirlvibe")]    # default only; real runs pass CRAWL_SEEDS / seeds=


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
    last = None
    for i in range(tries):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001 - network layer
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


def _attio_reconcile(supa, keepers, log):
    """Flag kept creators that are already WePush users (needs ATTIO_API_KEY). Best-effort."""
    if not os.environ.get("ATTIO_API_KEY") or not keepers:
        return
    try:
        from reconcile_attio import reconcile_batch
        n = reconcile_batch(supa, {c["handle"]: c["sec_uid"] for c in keepers if c.get("handle")})
        if n:
            log(f"  attio: {n} already WePush users")
    except Exception as e:
        log(f"  attio reconcile skipped: {str(e)[:60]}")


class _Stop(Exception):
    """Raised to abort the whole run (budget/funds exhausted)."""


def process_source(supa, prov, enr, stype, sval, *, depth, max_depth, pages,
                   processed, meter, over_budget, log):
    """Harvest ONE source, apply all hard filters, store keepers, return
    (src_kept, next_entities, brands_found). Raises _Stop when budget/funds run out."""
    cands = harvest_for(prov, stype, sval, pages, meter)

    next_ent = {"hashtag": set(), "sound": set(), "brand": set()}
    brands_found = set()
    keepers = []
    for c in cands:
        if len(keepers) >= MAX_CANDIDATES_PER_SOURCE:
            break
        if over_budget():
            raise _Stop()
        sec, h = c.get("sec_uid"), c.get("handle")
        if not sec or not h or h.lower() in processed:
            continue
        processed.add(h.lower())

        # sounds carry a free region signal -> pre-filter to DACH before a profile call
        if stype == "sound" and not is_dach_author(c):
            continue

        fol = c.get("followers")
        if fol is None:                     # sound authors have no inline follower count
            try:
                prof = enr._call(lambda hh=h: prov.fetch_profile(hh), "profile")
            except BudgetExceeded:
                raise _Stop()
            except ProviderError as e:
                if is_funds_error(e):
                    raise _Stop()
                continue
            except Exception:
                continue
            pf = parse.profile_fields(prof)
            fol = pf.get("followers")
            c["bio"] = c.get("bio") or pf.get("bio")
            if not c.get("email"):
                c["email"] = parse.email_from_bio(pf.get("bio", ""))

        # HARD FILTER 1: followers (brand sources 0–500k pre-validated, else 1k–250k)
        lo, hi = follower_band(stype)
        if not isinstance(fol, int) or not (lo <= fol <= hi):
            continue
        # HARD FILTER 2: E-MAIL required (pre-enrich -> never pay to enrich a dead-end)
        email = c.get("email")
        if not email:
            continue

        bio = c.get("bio") or ""
        region = region_from_email(email) or ("dach" if (stype == "sound" and is_dach_author(c)) else None)
        stag = source_tag(stype, sval)
        try:
            _retry(lambda: supa.upsert_stubs([{
                "sec_uid": sec, "handle": h, "display_name": c.get("nickname"),
                "bio": bio, "follower_count": fol, "verified": bool(c.get("verified")),
                "email": email, "email_source": "bio_regex",
                "email_type": freemail.classify_email(email),
                "source_channel": stype, "source_brand": sval.lstrip("@") if stype == "brand" else None,
                "source_type": stype, "source_value": stag,
                "region_hint": region, "enrichment_status": "stub",
                "discovered_via": stype, "discovered_from": stag,
            }]))
            _retry(lambda: supa.add_creator_sources([{
                "sec_uid": sec, "source_type": stype, "source_value": stag}]))
        except Exception:
            continue

        try:
            _, _outcome, summ = enr.enrich_from_stub({
                "sec_uid": sec, "handle": h, "follower_count": fol, "region_hint": region,
                "email": email, "bio": bio,
                "source_brand": sval.lstrip("@") if stype == "brand" else None})
        except BudgetExceeded:
            raise _Stop()
        except ProviderError as e:
            if is_funds_error(e):
                raise _Stop()
            continue
        except Exception:
            continue

        # HARD FILTER 3+4: market DACH/UK/US AND ER 2–14% (only known post-enrich) -> else delete
        mkt = summ.get("market") if summ else None
        er = summ.get("engagement_median") if summ else None
        if mkt not in MARKETS or not isinstance(er, (int, float)) or not (ER_MIN <= er <= ER_MAX):
            try:
                supa.delete_creator(sec)
            except Exception:
                pass
            continue

        keepers.append({"sec_uid": sec, "handle": h})
        for b in summ.get("brands", []):
            bh = (b or "").lstrip("@")
            if 2 <= len(bh) <= 30:
                brands_found.add(bh)
        if depth + 1 < max_depth:
            next_ent["hashtag"].update(summ.get("hashtags", []))
            next_ent["sound"].update(summ.get("sounds", []))
            next_ent["brand"].update(brands_found)

    # Attio: flag keepers already in WePush
    _attio_reconcile(supa, keepers, log)
    # register brands seen in captions (idempotent)
    if brands_found:
        try:
            _retry(lambda: supa._insert(
                "brands", [{"handle": "@" + b, "status": "candidate", "discovered_via": "crawl"}
                           for b in brands_found],
                on_conflict="handle", resolution="ignore"))
        except Exception:
            pass
    return len(keepers), next_ent, brands_found


def run(budget=36.0, depth=2, pages=6, seeds=None, log=print) -> dict:
    """Batch / recursive crawl. `seeds` = list of (type, value); if None, read CRAWL_SEEDS
    env (supports `brands:dach|dachuk`) or the default. Optional sharding via CRAWL_SHARDS."""
    supa = Supa()
    prov = TikHubProvider()
    start = supa.total_spent()
    enr = Enricher(prov, supa, budget_usd=start + budget, max_harvest_followers=MAX_FOLLOWERS,
                   max_pages=4, min_posts=12)
    meter = lambda: supa.record_spend("crawl", 0.001)

    if seeds is None:
        seed_env = os.environ.get("CRAWL_SEEDS", "").strip()
        if seed_env.startswith("brands:"):
            markets = "dach,uk" if "uk" in seed_env.split(":", 1)[1] else "dach"
            brows = supa._get("brands", {"select": "handle", "market": f"in.({markets})", "limit": "5000"})
            seeds = [("brand", (r.get("handle") or "").lstrip("@")) for r in brows if r.get("handle")]
        elif seed_env:
            seeds = []
            for tok in seed_env.split(","):
                if ":" in tok:
                    t, v = tok.strip().split(":", 1)
                    if t in ("brand", "hashtag", "sound", "creator") and v.strip():
                        seeds.append((t, v.strip()))
        else:
            seeds = SEEDS
    shards = int(os.environ.get("CRAWL_SHARDS", "1"))
    shard = int(os.environ.get("CRAWL_SHARD", "0"))
    if shards > 1:
        seeds = [s for i, s in enumerate(seeds) if i % shards == shard]
    log(f"[crawl] seeds: {len(seeds)}" + (f" (shard {shard}/{shards})" if shards > 1 else "")
        + " -> " + ", ".join(f"{t}:{v}" for t, v in seeds[:8]) + ("…" if len(seeds) > 8 else ""))

    q = deque((st, sv, 0) for st, sv in seeds)
    seen_sources = {norm(st, sv) for st, sv, _ in q}
    processed = load_existing_handles(supa)
    log(f"[crawl] start_spend=${start:.3f} budget=+${budget:.2f} depth={depth} "
        f"seeds={len(q)} pool_known={len(processed)}")

    def over_budget():
        return supa.total_spent() - start >= budget

    kept = 0
    t0 = time.time()
    while q:
        stype, sd, d = q.popleft()
        if over_budget():
            log("[crawl] budget reached"); break
        try:
            src_kept, next_ent, _ = process_source(
                supa, prov, enr, stype, sd, depth=d, max_depth=depth, pages=pages,
                processed=processed, meter=meter, over_budget=over_budget, log=log)
        except _Stop:
            log("[crawl] budget/funds exhausted"); break
        except BudgetExceeded:
            break
        except ProviderError as e:
            if is_funds_error(e):
                log(f"[crawl] funds out: {str(e)[:80]}"); break
            log(f"  L{d} {source_tag(stype, sd)}: harvest err {str(e)[:50]}"); continue
        kept += src_kept
        if d + 1 < depth:
            for etype, vals in next_ent.items():
                for v in list(vals)[:NEXT_CAP[etype]]:
                    key = norm(etype, v)
                    if key not in seen_sources:
                        seen_sources.add(key)
                        q.append((etype, v, d + 1))
        supa.flush_spend(channel="crawl")
        log(f"[L{d}] {source_tag(stype, sd)} -> +{src_kept} kept | total {kept} | "
            f"queue {len(q)} | ${supa.total_spent() - start:.2f}")

    supa.flush_spend(channel="crawl")
    stats = {"kept": kept, "sources_seen": len(seen_sources),
             "spent_usd": round(supa.total_spent() - start, 4)}
    log(f"[crawl] DONE {stats} time={(time.time() - t0) / 60:.1f}m")
    return stats


def harvest_one(source_type, source_value, options=None, *, log=print) -> dict:
    """Reactive entry for the Railway worker: harvest ONE scrape_jobs source with the same
    hard filters. Product harvests default to 2 levels deep (options.max_depth)."""
    opts = options or {}
    sv = source_value
    if source_type == "sound":                 # resolve id/url/name up front
        prov = TikHubProvider()
        mid, _ = resolve_music_id(prov, source_value)
        if not mid:
            return {"kept": 0, "error": "could not resolve sound"}
        sv = mid
    return run(budget=float(opts.get("budget_usd", 2.0)),
               depth=int(opts.get("max_depth", 2)),
               pages=int(opts.get("pages", 6)),
               seeds=[(source_type, sv)], log=log)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--budget", type=float, default=36.0)
    ap.add_argument("--depth", type=int, default=2)
    ap.add_argument("--pages", type=int, default=6)
    a = ap.parse_args()
    run(budget=a.budget, depth=a.depth, pages=a.pages)


if __name__ == "__main__":
    main()
