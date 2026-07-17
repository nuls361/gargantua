"""
Scraper worker — the always-on Railway process.

Loop: claim the oldest pending scrape_job -> dispatch to its channel -> write creators
(tagged with source) to Supabase -> mark the job done with stats. When the queue is
empty it heartbeats (and, once Phase 5 lands, runs an autonomous discovery round while
under the daily budget cap).
"""
from __future__ import annotations

import os
import signal
import sys
import time

from store import Supa
from channels import DISPATCH

POLL_SECONDS = int(os.environ.get("WORKER_POLL_SECONDS", "15"))
DAILY_CAP_USD = float(os.environ.get("AUTONOMOUS_DAILY_USD", "0"))   # 0 = autonomous off

_running = True


def _stop(*_):
    global _running
    _running = False


signal.signal(signal.SIGTERM, _stop)
signal.signal(signal.SIGINT, _stop)


def _sleep(seconds: int):
    for _ in range(seconds):
        if not _running:
            return
        time.sleep(1)


def _run_job(supa, prov, job):
    jid, st, sv = job["id"], job["source_type"], job["source_value"]
    print(f"[worker] job #{jid} start — {st}={sv} opts={job.get('options')}", flush=True)
    fn = DISPATCH.get(st)
    if not fn:
        supa.finish_job(jid, {}, status="error", error=f"no channel for source_type={st}")
        print(f"[worker] job #{jid} error — no channel for {st}", flush=True)
        return
    try:
        stats = fn(prov, supa, job, log=lambda m: print(m, flush=True))
        supa.flush_spend(jid, channel=st)
        supa.finish_job(jid, stats, status="done")
        print(f"[worker] job #{jid} done — {stats}", flush=True)
    except Exception as e:
        supa.flush_spend(jid, channel=st)
        supa.finish_job(jid, {}, status="error", error=str(e)[:500])
        print(f"[worker] job #{jid} FAILED — {type(e).__name__}: {e}", flush=True)


def main():
    try:
        supa = Supa()
    except Exception as e:
        print(f"[worker] FATAL: {e}", flush=True)
        sys.exit(1)

    # provider reads TIKHUB_API_KEY lazily; import here so a missing dep fails loud
    from provider import TikHubProvider
    prov = TikHubProvider()

    have = lambda k: "set" if os.environ.get(k) else "MISSING"
    print(f"[worker] up — supabase=ok  tikhub={have('TIKHUB_API_KEY')}  "
          f"anthropic={have('ANTHROPIC_API_KEY')}  poll={POLL_SECONDS}s  "
          f"autonomous_cap=${DAILY_CAP_USD:.2f}/day", flush=True)

    while _running:
        try:
            job = supa.claim_next_job()
        except Exception as e:
            if "401" in str(e):
                print("[worker] Supabase 401 — SUPABASE_SECRET_KEY rejected by lbug. "
                      "Use the project's service_role (secret) key, not anon/publishable.",
                      flush=True)
            else:
                print(f"[worker] claim error: {type(e).__name__}: {e}", flush=True)
            _sleep(POLL_SECONDS)
            continue

        if job:
            _run_job(supa, prov, job)
            continue                     # drain the queue before idling

        try:
            counts = supa.status_counts()
            print(f"[worker] idle — pending_jobs=0  spent_today=${supa.spent_today():.3f}  "
                  f"creators(stub/enriched)={counts.get('stub', 0)}/{counts.get('enriched', 0)}",
                  flush=True)
            # Phase 5: autonomous discovery round grafts here when under DAILY_CAP_USD
        except Exception as e:
            print(f"[worker] idle error: {type(e).__name__}: {e}", flush=True)
        _sleep(POLL_SECONDS)

    print("[worker] shutting down cleanly.", flush=True)


if __name__ == "__main__":
    main()
