# Creator-DB — Stage 1: Provider Reality-Check

The €0 gate before building anything. Confirms a pay-as-you-go provider (TikHub)
returns **real, complete** TikTok data for DACH creators — and, critically, that a
**User-Search** endpoint actually works (the whole discovery architecture depends on
it). No database, no scraping loop, no embeddings yet. If this passes, Stage 2 grows
from `provider.py` — and the code starts migrating into the `email lead management` app.

## Files
- `provider.py` — `Provider` interface + `TikHubProvider`. The rented layer lives behind
  one class; swapping providers later = one new subclass. **Endpoint paths live only here.**
- `parse.py` — tolerant extractors proving the valuable fields are *derivable* from raw
  responses (email from bio, median engagement, DACH language signal).
- `validate.py` — the harness. Runs profile → posts → following → user-search for a few
  known creators, dumps raw JSON to `raw/`, prints a GO/NO-GO checklist.

## Run
```bash
cd "~/Desktop/Creator DB"
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 1) Get a free trial key at https://tikhub.io  (Dashboard → API Keys)
export TIKHUB_API_KEY=your_key

# 2) Run against the defaults, or pass creators whose numbers YOU already know:
python3 validate.py
python3 validate.py pamela_rf herrnewstime
```

## What "GO" means
Every line in the printed DECISION GATE reads `PASS`, **and** when you open a dumped
`raw/<handle>_profile.json` the follower count matches what tiktok.com shows. Then the
provider is trustworthy and Stage 2 (DB + dedupe, target-fit ingestion) begins.

Any `FAIL` — especially User-Search returning nothing — is a NO-GO for this provider.
It cost cents to learn that. Try another provider by writing a second `Provider` subclass;
nothing else changes.

## The secUid chain (why each creator costs ≥2 requests)
`fetch_posts` / `fetch_following` need `secUid`, which only `fetch_profile` returns.
Profile first, everything else second. This is baked into the cost model.
