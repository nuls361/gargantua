"""
Scraper worker — the always-on Railway process.

Phase 1 (this slice): connect to Supabase-direct and heartbeat (pending jobs, spend
today, index size). This verifies the deploy + all secrets end-to-end in production.

Later phases graft onto the loop below:
  Phase 2  if pending: job = supa.claim_next_job() -> dispatch by source_type -> tag source
  Phase 5  elif autonomous enabled and spent_today < daily cap: run a discovery round
"""
from __future__ import annotations

import os
import signal
import sys
import time

from store import Supa

POLL_SECONDS = int(os.environ.get("WORKER_POLL_SECONDS", "15"))
DAILY_CAP_USD = float(os.environ.get("AUTONOMOUS_DAILY_USD", "0"))  # 0 = autonomous off

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


def main():
    try:
        supa = Supa()
    except Exception as e:
        print(f"[worker] FATAL: {e}", flush=True)
        sys.exit(1)

    have = lambda k: "set" if os.environ.get(k) else "MISSING"
    print(f"[worker] up — supabase=ok  tikhub={have('TIKHUB_API_KEY')}  "
          f"anthropic={have('ANTHROPIC_API_KEY')}  poll={POLL_SECONDS}s  "
          f"autonomous_cap=${DAILY_CAP_USD:.2f}/day", flush=True)

    while _running:
        try:
            pending = supa.pending_jobs()
            spent = supa.spent_today()
            counts = supa.status_counts()
            print(f"[worker] heartbeat — pending_jobs={pending}  spent_today=${spent:.3f}  "
                  f"creators(stub/enriched)={counts.get('stub', 0)}/{counts.get('enriched', 0)}",
                  flush=True)
            # --- Phase 2/5 dispatch grafts here ---
        except Exception as e:
            print(f"[worker] loop error: {type(e).__name__}: {e}", flush=True)
        _sleep(POLL_SECONDS)

    print("[worker] shutting down cleanly.", flush=True)


if __name__ == "__main__":
    main()
