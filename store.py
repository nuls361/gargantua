"""
Supabase-direct storage for the always-on worker (replaces local SQLite on the server).

PostgREST over the service_role key -> bypasses RLS, full read/write. Only stdlib +
requests (already a dependency), so it deploys clean on Railway with no extra infra.

Method names mirror db.DB where they overlap (record_spend, status_counts, upsert_stub,
stubs_to_enrich ...) so the harvest/enrich pipeline can swap SQLite -> Supabase with
minimal churn. Column names here are the tt_creators (Supabase) names, not the old
SQLite ones -- upsert_stub maps the harvest dict (nickname -> display_name) on the way in.
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

    def _insert(self, table: str, rows, *, upsert: bool = False,
                on_conflict: str | None = None, returning: str = "minimal") -> list:
        prefer = []
        if upsert:
            prefer.append("resolution=merge-duplicates")
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
        second worker grabbed it first, we get [] back and try again -- atomic claim."""
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

    # ---- spend ledger --------------------------------------------------------
    def record_spend(self, usd: float, *, channel: str | None = None,
                     job_id=None, calls: int = 1):
        self._insert("spend_ledger",
                     {"usd": usd, "channel": channel, "job_id": job_id, "calls": calls})

    def spent_today(self) -> float:
        rows = self._get("spend_ledger", {"select": "usd", "ts": f"gte.{_today_start()}"})
        return sum(float(r["usd"]) for r in rows)

    def total_spent(self) -> float:
        rows = self._get("spend_ledger", {"select": "usd"})
        return sum(float(r["usd"]) for r in rows)

    # ---- source tagging ------------------------------------------------------
    def add_creator_source(self, sec_uid: str, source_type: str, source_value: str,
                           *, job_id=None, requested_by=None):
        """Idempotent link (creator <-> source). PK (sec_uid, type, value) dedupes."""
        self._insert("tt_creator_sources", {
            "sec_uid": sec_uid, "source_type": source_type, "source_value": source_value,
            "job_id": job_id, "requested_by": requested_by,
        }, upsert=True, on_conflict="sec_uid,source_type,source_value")

    # ---- read model (heartbeat / dashboard) ----------------------------------
    def creator_count(self) -> int:
        return self._count("tt_creators")

    def status_counts(self) -> dict:
        return {st: self._count("tt_creators", {"enrichment_status": f"eq.{st}"})
                for st in ("stub", "enriched", "enrich_failed")}
