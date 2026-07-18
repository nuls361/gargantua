"""
Job dispatch: turn a scrape_jobs row into harvested + enriched creators, each tagged
with the job's source (source_type / source_value / requested_by).

Phase 2 ships the BRAND (repost) channel -- the most proven one. hashtag + creator
plug into DISPATCH next; sound is Phase 4. Harvest logic is reused verbatim from
repost_harvest.harvest_brand (pure API); only storage is now Supabase-direct.
"""
from __future__ import annotations

import parse
from provider import ProviderError
from repost_harvest import harvest_brand, region_from_email
from hashtag_harvest import harvest_hashtag
from creator_harvest import harvest_creator
from sound_harvest import resolve_music_id, harvest_sound, is_dach_author
from enrich import Enricher, BudgetExceeded

DEFAULT_PAGES = 8
JOB_BUDGET_USD = 2.00          # per-job enrich cap if the job doesn't set one
ENRICH_MIN, ENRICH_MAX = 1000, 250_000   # the selective-enrich follower tier


def _stub_row(c: dict, source_type: str, source_value: str, source_channel: str, region_default):
    email = c.get("email")
    region = region_from_email(email) or region_default
    row = {
        "sec_uid": c["sec_uid"], "handle": c["handle"], "display_name": c.get("nickname"),
        "bio": c.get("bio"), "follower_count": c.get("followers"),
        "verified": bool(c.get("verified")),
        "email": email, "email_source": "bio_regex" if email else None,
        "email_type": c.get("email_type"),
        "source_channel": source_channel,
        "source_brand": source_value if source_type == "brand" else None,
        "source_type": source_type, "source_value": source_value,
        "region_hint": region, "enrichment_status": "stub",
        "discovered_via": source_type, "discovered_from": source_value,
    }
    return row, region


def _store_and_enrich(prov, supa, job, creators, *, source_type, source_value,
                      source_channel, log) -> dict:
    """Shared path for channels whose authors carry follower stats inline (brand, hashtag,
    creator): stub -> tag source -> enrich the policy-matching stubs within the job budget.
    Already-enriched creators are skipped (no re-spend)."""
    opts = job.get("options") or {}
    do_enrich = opts.get("enrich", True)
    dach_only = opts.get("dach_only", True)
    region_default = opts.get("region")               # 'dach' | None
    budget = float(opts.get("budget_usd", JOB_BUDGET_USD))

    rows, region_by = [], {}
    for c in creators:
        row, region = _stub_row(c, source_type, source_value, source_channel, region_default)
        rows.append(row)
        region_by[c["sec_uid"]] = region
    new_secs = {r["sec_uid"] for r in supa.upsert_stubs(rows)}
    supa.add_creator_sources([{
        "sec_uid": c["sec_uid"], "source_type": source_type, "source_value": source_value,
        "job_id": job["id"], "requested_by": job.get("requested_by"),
    } for c in creators])

    candidates = [c for c in creators
                  if ENRICH_MIN <= (c.get("followers") or 0) <= ENRICH_MAX and c.get("email")
                  and (not dach_only or region_by.get(c["sec_uid"]) == "dach")]
    enriched = 0
    if do_enrich and candidates:
        status = supa.statuses([c["sec_uid"] for c in candidates])
        enr = Enricher(prov, supa, budget_usd=supa.total_spent() + budget,
                       max_harvest_followers=ENRICH_MAX)
        for c in candidates:
            sec = c["sec_uid"]
            if status.get(sec) != "stub":              # already enriched -> don't re-spend
                continue
            stub = {"sec_uid": sec, "handle": c["handle"],
                    "follower_count": c.get("followers") or 0,
                    "region_hint": region_by.get(sec), "email": c.get("email"),
                    "bio": c.get("bio"),
                    "source_brand": source_value if source_type == "brand" else None}
            try:
                _, outcome, _ = enr.enrich_from_stub(stub)
            except BudgetExceeded:
                log(f"  budget ${budget:.2f} reached — stop enriching")
                break
            except ProviderError as e:
                log(f"  @{c['handle']}: {str(e)[:50]}")
                continue
            if outcome in ("qualified", "out_of_market"):
                enriched += 1

    return {"found": len(creators), "stored": len(new_secs), "enriched": enriched,
            "spent_usd": round(supa.total_spent(), 4)}


def run_brand_job(prov, supa, job, *, log=print) -> dict:
    """A brand's repost feed -> creators it amplified."""
    handle = job["source_value"].lstrip("@")
    pages = int((job.get("options") or {}).get("pages", DEFAULT_PAGES))
    bfoll, creators = harvest_brand(
        prov, handle, pages, meter=lambda: supa.record_spend("repost", 0.001))
    stats = _store_and_enrich(prov, supa, job, creators, source_type="brand",
                              source_value=f"@{handle}", source_channel="repost", log=log)
    stats["brand_followers"] = bfoll
    return stats


def run_hashtag_job(prov, supa, job, *, log=print) -> dict:
    """A hashtag's video feed -> creators posting under it."""
    tag = job["source_value"].lstrip("#")
    pages = int((job.get("options") or {}).get("pages", DEFAULT_PAGES))
    creators = harvest_hashtag(prov, tag, pages,
                               meter=lambda: supa.record_spend("hashtag", 0.001))
    return _store_and_enrich(prov, supa, job, creators, source_type="hashtag",
                             source_value=f"#{tag}", source_channel="hashtag", log=log)


def run_creator_job(prov, supa, job, *, log=print) -> dict:
    """A seed creator's orbit -> @-mentioned collab partners (+ following if public)."""
    seed = job["source_value"].lstrip("@")
    pages = int((job.get("options") or {}).get("pages", 3))   # posts pages scanned for mentions
    creators = harvest_creator(prov, seed, pages,
                               meter=lambda: supa.record_spend("creator", 0.001))
    return _store_and_enrich(prov, supa, job, creators, source_type="creator",
                             source_value=f"@{seed}", source_channel="creator", log=log)


def run_sound_job(prov, supa, job, *, log=print) -> dict:
    """Resolve a sound (id/URL/name) -> its video authors -> DACH pre-filter (region/
    language, free) -> stubs (tagged) -> for DACH+email candidates, backfill followers
    via one profile call and enrich. Non-DACH authors are still stored as reference stubs."""
    opts = job.get("options") or {}
    pages = int(opts.get("pages", 10))
    do_enrich = opts.get("enrich", True)
    budget = float(opts.get("budget_usd", JOB_BUDGET_USD))

    music_id, title = resolve_music_id(prov, job["source_value"])
    if not music_id:
        return {"found": 0, "stored": 0, "enriched": 0, "spent_usd": round(supa.total_spent(), 4),
                "error": "could not resolve sound"}
    source_value = f"sound:{music_id}"

    authors = harvest_sound(prov, music_id, pages,
                            meter=lambda: supa.record_spend("music", 0.001))

    rows = []
    for a in authors:
        dach = is_dach_author(a)
        rows.append({
            "sec_uid": a["sec_uid"], "handle": a["handle"], "display_name": a.get("nickname"),
            "bio": a.get("bio"), "verified": bool(a.get("verified")),
            "email": a.get("email"), "email_source": "bio_regex" if a.get("email") else None,
            "email_type": a.get("email_type"),
            "language": a.get("language"), "country": a.get("region"),
            "source_channel": "sound", "source_brand": None,
            "source_type": "sound", "source_value": source_value,
            "region_hint": "dach" if dach else None, "enrichment_status": "stub",
            "discovered_via": "sound", "discovered_from": source_value,
        })
    new_secs = {r["sec_uid"] for r in supa.upsert_stubs(rows)}
    supa.add_creator_sources([{
        "sec_uid": a["sec_uid"], "source_type": "sound", "source_value": source_value,
        "job_id": job["id"], "requested_by": job.get("requested_by"),
    } for a in authors])

    # enrich the DACH candidates with an email; followers aren't inline for the sound
    # channel, so backfill via one profile call, then apply the tier gate + enrich.
    candidates = [a for a in authors if is_dach_author(a) and a.get("email")]
    enriched = 0
    if do_enrich and candidates:
        status = supa.statuses([a["sec_uid"] for a in candidates])
        enr = Enricher(prov, supa, budget_usd=supa.total_spent() + budget,
                       max_harvest_followers=ENRICH_MAX)
        for a in candidates:
            sec = a["sec_uid"]
            if status.get(sec) != "stub":
                continue
            try:
                prof = enr._call(lambda: prov.fetch_profile(a["handle"]), "profile")
            except BudgetExceeded:
                log(f"  budget ${budget:.2f} reached — stop enriching")
                break
            except ProviderError:
                continue
            pf = parse.profile_fields(prof.get("data", prof) if isinstance(prof, dict) else {})
            fol = pf.get("followers")
            if fol:
                supa.update_creator(sec, {"follower_count": fol})
            if isinstance(fol, int) and not (ENRICH_MIN <= fol <= ENRICH_MAX):
                continue                                   # out of the bookable tier
            stub = {"sec_uid": sec, "handle": a["handle"], "follower_count": fol,
                    "region_hint": "dach", "email": a["email"], "bio": a.get("bio")}
            try:
                _, outcome, _ = enr.enrich_from_stub(stub)
            except BudgetExceeded:
                log(f"  budget ${budget:.2f} reached — stop enriching")
                break
            except ProviderError as e:
                log(f"  @{a['handle']}: {str(e)[:50]}")
                continue
            if outcome in ("qualified", "out_of_market"):
                enriched += 1

    return {
        "music_id": music_id, "sound_title": title,
        "found": len(authors), "dach_prefilter": len(candidates),
        "stored": len(new_secs), "enriched": enriched,
        "spent_usd": round(supa.total_spent(), 4),
    }


DISPATCH = {
    "brand": run_brand_job,
    "hashtag": run_hashtag_job,
    "creator": run_creator_job,
    "sound": run_sound_job,
}
