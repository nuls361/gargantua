"""
Job dispatch: turn a scrape_jobs row into harvested + enriched creators, each tagged
with the job's source (source_type / source_value / requested_by).

Phase 2 ships the BRAND (repost) channel -- the most proven one. hashtag + creator
plug into DISPATCH next; sound is Phase 4. Harvest logic is reused verbatim from
repost_harvest.harvest_brand (pure API); only storage is now Supabase-direct.
"""
from __future__ import annotations

from provider import ProviderError
from repost_harvest import harvest_brand, region_from_email
from enrich import Enricher, BudgetExceeded

DEFAULT_PAGES = 8
JOB_BUDGET_USD = 2.00          # per-job enrich cap if the job doesn't set one
ENRICH_MIN, ENRICH_MAX = 1000, 250_000   # the selective-enrich follower tier


def _stub_row(c: dict, source_type: str, source_value: str, region_default):
    email = c.get("email")
    region = region_from_email(email) or region_default
    row = {
        "sec_uid": c["sec_uid"], "handle": c["handle"], "display_name": c.get("nickname"),
        "bio": c.get("bio"), "follower_count": c.get("followers"),
        "verified": bool(c.get("verified")),
        "email": email, "email_source": "bio_regex" if email else None,
        "email_type": c.get("email_type"),
        "source_channel": "repost", "source_brand": source_value,
        "source_type": source_type, "source_value": source_value,
        "region_hint": region, "enrichment_status": "stub",
        "discovered_via": source_type, "discovered_from": source_value,
    }
    return row, region


def run_brand_job(prov, supa, job, *, log=print) -> dict:
    """Harvest a brand's repost feed -> stubs (tagged) -> selectively enrich the
    policy-matching NEW creators within the job's budget. Returns stats for the job row."""
    opts = job.get("options") or {}
    handle = job["source_value"].lstrip("@")
    source_value = f"@{handle}"
    pages = int(opts.get("pages", DEFAULT_PAGES))
    do_enrich = opts.get("enrich", True)
    dach_only = opts.get("dach_only", True)
    region_default = opts.get("region")               # 'dach' | None
    budget = float(opts.get("budget_usd", JOB_BUDGET_USD))

    bfoll, creators = harvest_brand(
        prov, handle, pages, meter=lambda: supa.record_spend("repost", 0.001))

    rows, region_by = [], {}
    for c in creators:
        row, region = _stub_row(c, "brand", source_value, region_default)
        rows.append(row)
        region_by[c["sec_uid"]] = region
    new_secs = {r["sec_uid"] for r in supa.upsert_stubs(rows)}
    supa.add_creator_sources([{
        "sec_uid": c["sec_uid"], "source_type": "brand", "source_value": source_value,
        "job_id": job["id"], "requested_by": job.get("requested_by"),
    } for c in creators])

    # enrich the policy-matching creators from THIS harvest that are still stubs
    # (skip ones already enriched via another source -> no re-spend)
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
            fol = c.get("followers") or 0
            stub = {"sec_uid": sec, "handle": c["handle"], "follower_count": fol,
                    "region_hint": region_by.get(sec), "email": c.get("email")}
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

    return {
        "brand_followers": bfoll,
        "found": len(creators),
        "stored": len(new_secs),
        "enriched": enriched,
        "spent_usd": round(supa.total_spent(), 4),
    }


DISPATCH = {
    "brand": run_brand_job,
    # "hashtag": run_hashtag_job,   # next
    # "creator": run_creator_job,   # next
    # "sound":   run_sound_job,     # Phase 4
}
