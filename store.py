"""
Supabase-direct storage for the always-on worker (replaces local SQLite on the server).

PostgREST over the service_role key -> bypasses RLS, full read/write. Only stdlib +
requests (already a dependency), so it deploys clean on Railway with no extra infra.

Method names/signatures mirror db.DB where the harvest/enrich pipeline touches them
(total_spent, record_spend(endpoint, cost), update_creator, upsert_post, hashtag_seen,
enqueue_hashtag ...) so Enricher runs unchanged against Supabase. Column names here are
the tt_creators (Supabase) names; the worker builds tt_creators-native stub dicts.

Spend is counted in-memory during a job (no network per API call) and flushed to
spend_ledger once per job -> cheap + gives per-job granularity for the dashboard.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone

import requests


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today_start() -> str:
    return datetime.now(timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0).isoformat()


class Supa:
    """Thin PostgREST client scoped to one Supabase project via the service_role key."""

    def __init__(self, url: str | None = None, key: str | None = None, timeout: int = 30):
        base = (url or os.environ.get("SUPABASE_URL") or "").rstrip("/")
        self.key = (key or os.environ.get("SUPABASE_SECRET_KEY")
                    or os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
        if not base:
            raise RuntimeError("SUPABASE_URL not set")
        if not self.key:
            raise RuntimeError("SUPABASE_SECRET_KEY (service_role) not set")
        self.url = base + "/rest/v1"
        self.timeout = timeout
        self.s = requests.Session()
        self.s.headers.update({
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
        })
        self._spend_base: float | None = None   # all-time ledger sum, fetched once
        self._session_spend = 0.0                # accrued this job, not yet flushed

    # ---- low-level PostgREST -------------------------------------------------
    def _get(self, table: str, params: dict) -> list:
        r = self.s.get(f"{self.url}/{table}", params=params, timeout=self.timeout)
        r.raise_for_status()
        return r.json()

    def _count(self, table: str, filt: dict | None = None) -> int:
        params = dict(filt or {})
        params["select"] = "sec_uid" if table.startswith("tt_") else "id"
        r = self.s.get(f"{self.url}/{table}", params=params,
                       headers={"Prefer": "count=exact", "Range": "0-0"},
                       timeout=self.timeout)
        r.raise_for_status()
        cr = r.headers.get("Content-Range", "*/0")   # e.g. "0-0/1234"
        return int(cr.split("/")[-1]) if "/" in cr else 0

    def _insert(self, table: str, rows, *, on_conflict: str | None = None,
                resolution: str | None = None, returning: str = "minimal") -> list:
        prefer = []
        if resolution:
            prefer.append(f"resolution={resolution}-duplicates")   # merge | ignore
        prefer.append(f"return={returning}")
        params = {"on_conflict": on_conflict} if on_conflict else {}
        r = self.s.post(f"{self.url}/{table}", params=params, json=rows,
                        headers={"Prefer": ",".join(prefer)}, timeout=self.timeout)
        r.raise_for_status()
        return r.json() if (returning == "representation" and r.text) else []

    def _patch(self, table: str, match: dict, fields: dict,
               returning: str = "minimal") -> list:
        r = self.s.patch(f"{self.url}/{table}", params=match, json=fields,
                         headers={"Prefer": f"return={returning}"}, timeout=self.timeout)
        r.raise_for_status()
        return r.json() if (returning == "representation" and r.text) else []

    # ---- job queue -----------------------------------------------------------
    def pending_jobs(self) -> int:
        return self._count("scrape_jobs", {"status": "eq.pending"})

    def claim_next_job(self) -> dict | None:
        """Pop the oldest pending job. The PATCH is filtered on status=pending so if a
        second worker grabbed it first we get [] back -- atomic claim."""
        rows = self._get("scrape_jobs", {
            "select": "*", "status": "eq.pending",
            "order": "priority.asc,created_at.asc", "limit": "1"})
        if not rows:
            return None
        claimed = self._patch("scrape_jobs",
                              {"id": f"eq.{rows[0]['id']}", "status": "eq.pending"},
                              {"status": "running", "started_at": _now()},
                              returning="representation")
        return claimed[0] if claimed else None

    def finish_job(self, job_id, stats: dict, status: str = "done", error: str | None = None):
        self._patch("scrape_jobs", {"id": f"eq.{job_id}"},
                    {"status": status, "stats": stats, "error": error, "finished_at": _now()})

    def create_job(self, source_type: str, source_value: str, *, requested_by=None,
                   options: dict | None = None, priority: int = 100) -> dict:
        rows = self._insert("scrape_jobs", {
            "source_type": source_type, "source_value": source_value,
            "requested_by": requested_by, "options": options or {}, "priority": priority,
        }, returning="representation")
        return rows[0] if rows else {}

    # ---- spend ledger (db.DB-compatible) -------------------------------------
    def _base(self) -> float:
        if self._spend_base is None:
            rows = self._get("spend_ledger", {"select": "usd"})
            self._spend_base = sum(float(r["usd"]) for r in rows)
        return self._spend_base

    def record_spend(self, endpoint: str, cost_usd: float) -> None:
        """Enricher calls this per charged API call. Accrue in memory only; the ledger
        row is written once per job by flush_spend -> no network per call."""
        self._session_spend += cost_usd

    def total_spent(self) -> float:
        return self._base() + self._session_spend

    def flush_spend(self, job_id=None, channel: str | None = None) -> None:
        if self._session_spend <= 0:
            return
        self._insert("spend_ledger", {"usd": round(self._session_spend, 4),
                                      "channel": channel, "job_id": job_id})
        self._spend_base = self._base() + self._session_spend
        self._session_spend = 0.0

    def spent_today(self) -> float:
        rows = self._get("spend_ledger", {"select": "usd", "ts": f"gte.{_today_start()}"})
        return sum(float(r["usd"]) for r in rows) + self._session_spend

    # ---- creators ------------------------------------------------------------
    def upsert_stubs(self, rows: list) -> list:
        """Batch-insert lead-stubs. On sec_uid conflict, DO NOTHING (never downgrade an
        already-enriched row back to a stub). Returns the rows that were NEWLY inserted."""
        rows = [dict(r) for r in rows if r.get("sec_uid")]
        for r in rows:
            r.setdefault("enrichment_status", "stub")
            r.setdefault("first_seen_at", _now())
        if not rows:
            return []
        return self._insert("tt_creators", rows, on_conflict="sec_uid",
                            resolution="ignore", returning="representation")

    def upsert_stub(self, c: dict) -> bool:
        return bool(self.upsert_stubs([c]))

    def update_creator(self, sec_uid: str, fields: dict) -> None:
        """Targeted UPDATE that preserves unnamed columns (so enriching a stub keeps its
        source tags). Mirrors db.DB.update_creator."""
        fields = dict(fields)
        fields["last_enriched_at"] = _now()
        self._patch("tt_creators", {"sec_uid": f"eq.{sec_uid}"}, fields)

    def upsert_creator(self, c: dict) -> None:
        c = dict(c)
        c.pop("raw", None)                       # tt_creators has no raw column
        c["last_enriched_at"] = _now()
        c.setdefault("first_seen_at", _now())
        self._insert("tt_creators", c, on_conflict="sec_uid", resolution="merge")

    def stubs_to_enrich(self, *, min_followers=1000, max_followers=250000,
                        require_email=True, dach_only=True, limit=0) -> list:
        conds = ["enrichment_status.eq.stub",
                 f"follower_count.gte.{min_followers}",
                 f"follower_count.lte.{max_followers}"]
        if require_email:
            conds.append("email.not.is.null")
        if dach_only:
            conds.append("region_hint.eq.dach")
        params = {"and": f"({','.join(conds)})", "order": "follower_count.desc"}
        if limit:
            params["limit"] = str(limit)
        return self._get("tt_creators", params)

    def statuses(self, sec_uids: list) -> dict:
        """Map sec_uid -> enrichment_status for a set of creators (one query).
        Lets a job enrich the stubs it just harvested that aren't enriched yet, while
        skipping ones already enriched (no re-spend)."""
        if not sec_uids:
            return {}
        out = {}
        for i in range(0, len(sec_uids), 200):        # keep the URL length sane
            chunk = sec_uids[i:i + 200]
            inlist = ",".join(f'"{s}"' for s in chunk)
            rows = self._get("tt_creators",
                             {"sec_uid": f"in.({inlist})", "select": "sec_uid,enrichment_status"})
            out.update({r["sec_uid"]: r["enrichment_status"] for r in rows})
        return out

    def upsert_post(self, p: dict) -> None:
        """No-op: raw posts live in the source project, not lbug. The lead tool only
        needs the derived aggregates, which land on the creator row. (Phase 4+ may add
        a tt_posts table here if the sound channel needs it.)"""
        return None

    # ---- source tagging ------------------------------------------------------
    def add_creator_sources(self, links: list) -> None:
        """Batch idempotent (creator <-> source) links. PK (sec_uid,type,value) dedupes."""
        links = [l for l in links if l.get("sec_uid")]
        if links:
            self._insert("tt_creator_sources", links,
                         on_conflict="sec_uid,source_type,source_value", resolution="ignore")

    def add_creator_source(self, sec_uid, source_type, source_value, *, job_id=None,
                           requested_by=None):
        self.add_creator_sources([{
            "sec_uid": sec_uid, "source_type": source_type, "source_value": source_value,
            "job_id": job_id, "requested_by": requested_by}])

    # ---- hashtag feedback loop (Phase 5) -- inert for now --------------------
    def hashtag_seen(self, name: str) -> bool:
        return True          # True => _harvest skips enqueue; no hashtag queue in lbug yet

    def enqueue_hashtag(self, name: str, source: str = "") -> bool:
        return False

    # ---- read model (heartbeat / dashboard) ----------------------------------
    def creator_count(self) -> int:
        return self._count("tt_creators")

    def status_counts(self) -> dict:
        return {st: self._count("tt_creators", {"enrichment_status": f"eq.{st}"})
                for st in ("stub", "enriched", "enrich_failed")}
