#!/usr/bin/env python3
"""Sustained sharded DACH crawl. Each shard runs its own $5 session budget → 4 shards
= ~$20 collective (leaves buffer under the ~$28 TikHub balance). crawl.run() shards the
seed list itself via CRAWL_SHARDS/CRAWL_SHARD env. Broad German-language seeds → depth-2
fanout into fresh DACH niches."""
import crawl

# Proven high-DACH hashtags (80–100% DACH yield) + broad German niche coverage.
SEEDS = [("hashtag", h) for h in [
    # proven (from source_overview, high dach share)
    "einkaufshaul", "foodspotsfrankfurt", "lifeingermany", "haarpflege", "rezepteliebe",
    "österreich", "mamaalltag", "lehramt", "medizinstudium", "münchen", "hautpflegeroutine",
    "selfcaredeutsch", "schwangerschaft", "schnellesmittagessen", "grwmdeutsch",
    "fashiondeutschland", "düsseldorffoodguide", "balicurls",
    # broad German niches for fanout
    "schminktipps", "pflegeroutine", "mealprepdeutsch", "fitnessdeutschland", "wocheneinkauf",
    "kochenmitliebe", "backenmachtglücklich", "hebamme", "berlinfood", "reisenmitkindern",
    "gartenliebe", "hundeliebe", "deutscherfoodblog", "wintergartenliebe",
]]

if __name__ == "__main__":
    crawl.run(budget=5.0, depth=2, pages=4, seeds=SEEDS,
              log=lambda m: print(m, flush=True))
