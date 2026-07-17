#!/usr/bin/env python3
"""
Discovery runner — HASHTAG engine.

The channel that actually works for DACH: German hashtags -> fetch_tag_post ->
~29 creators/call with follower counts inline (free pre-filter). Qualified
creators feed their own German hashtags back into the queue (self-feeding loop).
Following/@-mentions ride along as a minor supplement. Hard €5 ceiling.

    export TIKHUB_API_KEY=...
    python3 discover.py --budget 0.20     # tiny check
    python3 discover.py                   # full run (~€5)
"""
from __future__ import annotations

import argparse
import time

from provider import TikHubProvider, ProviderError
from db import DB
from enrich import Enricher, BudgetExceeded

# The 20 sample creators — enriched directly (they ARE targets).
SAMPLE_SEEDS = [
    "yulesy", "aylinend", "antoniaviehbeck", "edda.elisa", "emifrais",
    "22annii", "juliahsen", "chantall.smd", "jasmindres", "hellaseng",
    "kimm.glossy", "orne.may", "claraajulie", "xilezhou", "amiraa.ldr",
    "chantal.sizi", "tyraberlin", "blondminh", "alisacayenne", "mo.kanoute",
]

# Curated German long-tail hashtags (validated pattern: DE word -> DE creators).
# The self-feeding loop grows this from qualified creators; the DACH gate filters
# any that leak global.
SEED_HASHTAGS = [
    "hautpflege", "pflegeroutine", "drogerie", "dmhaul",
    "schranz", "tekk", "technodeutschland",
    "kita", "erzieherin", "mamaalltag", "familienalltag",
    "whatieat", "reisetipps", "urlaubmit",
    "münchen", "stuttgart", "berlinlebt", "berlinfashionweek",
    "outfitinspo", "midsizefashion", "modetrends",
    "rezepte", "günstigkochen", "kbeauty", "makeuptutorial", "haushalt",
]

REFILL_BELOW = 40   # harvest another hashtag when the creator queue drops under this


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--budget", type=float, default=5.40, help="USD hard cap (~€5)")
    ap.add_argument("--db", default="creatordb.sqlite")
    ap.add_argument("--max-followers", type=int, default=0, help="tier cap (0=none)")
    ap.add_argument("--min-active", type=int, default=5, help="min posts in 90d")
    args = ap.parse_args()

    prov = TikHubProvider()
    db = DB(args.db)
    budget = args.budget
    print(f"budget=${budget:.2f}  bereits ausgegeben=${db.total_spent():.3f}")

    if db.pending_hashtag_count() == 0 and db.creator_count() == 0:
        for t in SEED_HASHTAGS:
            db.enqueue_hashtag(t, source="seed")
        for h in SAMPLE_SEEDS:
            db.enqueue("@" + h.lower(), handle=h, source="sample")
        print(f"geseedet: {db.pending_hashtag_count()} Hashtags + {len(SAMPLE_SEEDS)} Sample-Creator\n")

    enr = Enricher(prov, db, budget_usd=budget,
                   max_followers=(args.max_followers or None),
                   min_active_90d=args.min_active)
    kept = seen = 0
    t0 = time.time()

    while db.total_spent() + 0.004 < budget:
        # keep the creator queue fed from hashtags
        if db.pending_count() < REFILL_BELOW and db.pending_hashtag_count() > 0:
            h = db.next_pending_hashtag()
            try:
                cid, n = enr.harvest_hashtag(h["name"])
            except BudgetExceeded:
                break
            except ProviderError as e:
                db.mark_hashtag(h["name"], "failed")
                print(f"  #{h['name']}: FEHLER {str(e)[:40]}")
                continue
            db.mark_hashtag(h["name"], "done" if cid else "failed", cid, n)
            print(f"  #{h['name']:<22} → +{n} Kandidaten  "
                  f"[queue {db.pending_count()} | tags {db.pending_hashtag_count()} | ${db.total_spent():.3f}]")
            continue

        seed = db.next_pending()
        if not seed:
            if db.pending_hashtag_count() == 0:
                print("\nQueue + Hashtags leer -- fertig.")
                break
            continue

        try:
            new, outcome, summ = enr.enrich(seed)
        except BudgetExceeded:
            break
        except ProviderError as e:
            db.mark(seed["identity"], "failed")
            continue
        seen += 1
        db.mark(seed["identity"], "done" if outcome == "qualified" else "rejected")
        if outcome == "qualified":
            kept += 1
            print(f"  ✓ @{summ['handle']:<22} {summ['followers']:>8,}  {summ['country']}  "
                  f"ER={summ['engagement_median']}%  {'📧' if summ['email'] else '  '}  "
                  f"[{kept} kept | ${db.total_spent():.3f} | queue {db.pending_count()}]")

    print(f"\n{'='*60}\nFERTIG  creators={db.creator_count()}  posts={db.post_count()}  "
          f"spent=${db.total_spent():.3f} (~€{db.total_spent()/1.08:.2f})  "
          f"gesehen={seen}  kept={kept}  zeit={time.time()-t0:.0f}s")
    print("Report:  python3 report.py    CSV:  python3 export.py")


if __name__ == "__main__":
    main()
