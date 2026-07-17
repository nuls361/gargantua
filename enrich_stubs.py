#!/usr/bin/env python3
"""Enrich the stubs that currently match the policy (stubs_to_enrich) -- promotes
cheap lead-stubs to full records (posts -> ER/category/market, comment-verified DACH).
Separate from repost_harvest so we can re-enrich the pool without re-harvesting brands.

    export TIKHUB_API_KEY=...
    python3 enrich_stubs.py [budget_usd]      # default 1.0
"""
import sys
from provider import TikHubProvider, ProviderError
from db import DB
from enrich import Enricher, BudgetExceeded

prov = TikHubProvider()
db = DB("creatordb.sqlite")
budget = float(sys.argv[1]) if len(sys.argv) > 1 else 1.0
enr = Enricher(prov, db, budget_usd=db.total_spent() + budget)

stubs = db.stubs_to_enrich()
print(f"{len(stubs)} Stubs matchen Policy, Budget +${budget:.2f}\n")
dach = verified = 0
for s in stubs:
    try:
        new, outcome, summ = enr.enrich_from_stub(s)
    except BudgetExceeded:
        print("Budget erreicht -- stop."); break
    except ProviderError as e:
        print(f"  @{s['handle']}: FEHLER {str(e)[:40]}"); continue
    row = db.conn.execute("SELECT comment_de_ratio FROM creators WHERE sec_uid=?",
                          (s["sec_uid"],)).fetchone()
    cdr = row["comment_de_ratio"] if row else None
    note = ""
    if cdr is not None:
        verified += 1
        note = f"  [comments de={cdr} -> {'RESCUED' if outcome=='qualified' else 'other'}]"
    if outcome == "qualified":
        dach += 1
    flag = "✓DACH " if outcome == "qualified" else "·other"
    er = summ["engagement_median"] if summ else "?"
    print(f"  {flag} @{s['handle']:<20} {s['follower_count']:>8,}  ER={er}{note}")

print(f"\nfertig: {dach} DACH-qualifiziert, {verified} per Kommentar geprüft, "
      f"spent=${db.total_spent():.3f}")
print("status:", db.status_counts())
