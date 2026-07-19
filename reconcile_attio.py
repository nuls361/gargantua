#!/usr/bin/env python3
"""
Reconcile the creator index against Attio (WePush's CRM / Songpush users).

For each not-yet-checked tt_creators handle, look it up in Attio's `users` object by
`user_name_tiktok`. A match = the creator is already a Songpush user, so we flag it and
store the SongPush admin URL + record id + user type + status. This is what stops us from
re-sourcing / cold-mailing people who are already in Songpush.

The unique key in Attio is the TikTok URL with the numeric ID (`url_tiktok_using_id`);
we match on the handle here (fast, batched) and keep that URL for exact dedupe.

    export ATTIO_API_KEY=...  SUPABASE_URL=...  SUPABASE_SECRET_KEY=...
    python3 reconcile_attio.py [--limit N] [--batch 25]

Runs standalone or as a cron/worker step (the Railway worker can call main() on new
creators). The interactive Attio MCP is NOT available there, hence the REST API + key.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from datetime import datetime, timezone

import requests

from store import Supa

ATTIO = "https://api.attio.com/v2"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _val(rec: dict, slug: str):
    """Pull a scalar out of Attio's {values: {slug: [{...}]}} record shape."""
    vals = (rec.get("values") or {}).get(slug) or []
    if not vals:
        return None
    v = vals[0]
    # text/number -> value; select -> option.title; status -> status.title
    if "value" in v:
        return v["value"]
    if isinstance(v.get("option"), dict):
        return v["option"].get("title")
    if isinstance(v.get("status"), dict):
        return v["status"].get("title")
    return None


def query_attio(handles: list, key: str) -> dict:
    """Batch-match handles -> {handle: attio_record}. Prefers 'Active' on duplicates."""
    r = requests.post(
        f"{ATTIO}/objects/users/records/query",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={"filter": {"$or": [{"user_name_tiktok": h} for h in handles]}, "limit": 500},
        timeout=30,
    )
    r.raise_for_status()
    out: dict = {}
    for rec in r.json().get("data", []):
        h = _val(rec, "user_name_tiktok")
        if not h:
            continue
        if h not in out or _val(rec, "status") == "Active":
            out[h] = rec
    return out


def reconcile_batch(supa, sec_by_handle: dict, key: str | None = None, batch: int = 25) -> int:
    """Flag a set of {handle: sec_uid} against Attio. Reusable by the worker (per-harvest)
    and by main() (whole-index sweep). Returns how many were matched as Songpush users."""
    key = key or os.environ.get("ATTIO_API_KEY")
    if not key or not sec_by_handle:
        return 0
    handles = list(sec_by_handle.keys())
    matched = 0
    for i in range(0, len(handles), batch):
        chunk = handles[i:i + batch]
        try:
            found = query_attio(chunk, key)
        except requests.HTTPError:
            continue
        for h in chunk:
            sec = sec_by_handle[h]
            rec = found.get(h)
            if rec:
                supa._patch("tt_creators", {"sec_uid": f"eq.{sec}"}, {
                    "is_songpush_user": True,
                    "attio_record_id": rec.get("id", {}).get("record_id"),
                    "songpush_admin_url": _val(rec, "admin_url"),
                    "attio_user_type": _val(rec, "user_type"),
                    "attio_status": _val(rec, "status"),
                    "attio_checked_at": _now(),
                })
                matched += 1
            else:
                supa._patch("tt_creators", {"sec_uid": f"eq.{sec}"},
                            {"is_songpush_user": False, "attio_checked_at": _now()})
        time.sleep(0.2)
    return matched


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=5000)
    ap.add_argument("--batch", type=int, default=25)
    args = ap.parse_args()

    if not os.environ.get("ATTIO_API_KEY"):
        sys.exit("Set ATTIO_API_KEY (Attio REST API token).")
    supa = Supa()

    rows = supa._get("tt_creators", {
        "select": "sec_uid,handle", "attio_checked_at": "is.null",
        "handle": "not.is.null", "limit": str(args.limit)})
    sec_by_handle = {r["handle"]: r["sec_uid"] for r in rows if r.get("handle")}
    print(f"checking {len(sec_by_handle)} unreconciled creators against Attio…", flush=True)
    matched = reconcile_batch(supa, sec_by_handle, batch=args.batch)
    print(f"done — {matched}/{len(sec_by_handle)} are already Songpush users.", flush=True)


if __name__ == "__main__":
    main()
