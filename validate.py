#!/usr/bin/env python3
"""
Stage 1 reality-check for the Creator-DB.

Runs the full secUid chain against a real provider for a few KNOWN DACH creators
and prints a GO/NO-GO summary. The entire point: spend cents to confirm the data
is real BEFORE building any database, discovery loop, or embeddings on top of it.

    export TIKHUB_API_KEY=...            # free trial key from https://tikhub.io
    python3 validate.py                  # default known handles
    python3 validate.py pamela_rf herrnewstime   # your own (numbers you KNOW)

Every raw response is dumped to raw/<handle>_<call>.json so you can eyeball the
truth yourself. Nothing here writes to any database.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import parse
from provider import TikHubProvider, ProviderError

RAW = Path(__file__).parent / "raw"
# Big, well-known DACH creators make good defaults ONLY because you already know
# roughly what their numbers should be -- that's what makes it a reality-check.
DEFAULT_HANDLES = ["pamela_rf", "younes_zarou"]
# A long-tail German keyword is the right discovery probe (doc: long-tail beats broad).
SEARCH_PROBE = "hautpflege routine"


def dump(handle: str, call: str, payload) -> None:
    RAW.mkdir(exist_ok=True)
    safe = handle.lstrip("@").replace("/", "_")
    (RAW / f"{safe}_{call}.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2)
    )


def check(label: str, ok: bool) -> bool:
    print(f"    [{'PASS' if ok else 'FAIL'}] {label}")
    return ok


def run_creator(prov: TikHubProvider, handle: str) -> dict:
    print(f"\n=== @{handle.lstrip('@')} " + "=" * (40 - len(handle)))
    result = {"handle": handle}

    # 1) profile ------------------------------------------------------------
    prof_raw = prov.fetch_profile(handle)
    dump(handle, "profile", prof_raw)
    pf = parse.profile_fields(prof_raw)
    sec_uid = pf["sec_uid"]
    email = parse.email_from_bio(pf["bio"])
    print(f"  profile: followers={pf['followers']!s:>10}  following={pf['following']}  "
          f"likes={pf['likes']}  videos={pf['videos']}  verified={pf['verified']}")
    print(f"           nickname={pf['nickname']!r}  secUid={'yes' if sec_uid else 'MISSING'}")
    print(f"           bio={pf['bio'][:80]!r}")
    print(f"           email-from-bio={email!r}")
    result["has_secuid"] = bool(sec_uid)
    result["followers_present"] = isinstance(pf["followers"], int) and pf["followers"] > 0
    result["email"] = email

    if not sec_uid:
        print("  !! no secUid -> cannot fetch posts/following. Chain broken.")
        result["posts_ok"] = result["following_ok"] = False
        result["er"] = None
    else:
        # 2) posts ----------------------------------------------------------
        posts_raw = prov.fetch_posts(sec_uid, count=30)
        dump(handle, "posts", posts_raw)
        posts = [parse.post_fields(p) for p in parse.posts_list(posts_raw)]
        er = parse.engagement_rate(posts)
        result["er"] = er
        n_hash = sum(1 for p in posts if p["hashtags"])
        n_ment = sum(1 for p in posts if p["mentions"])
        result["posts_ok"] = len(posts) > 0 and n_hash > 0
        print(f"  posts: {len(posts)} pulled  |  median engagement={er}%  |  "
              f"{n_hash} w/ hashtags  {n_ment} w/ @-mentions")
        for p in posts[:3]:
            print(f"     - {(p['caption'] or '')[:52]!r:<54} "
                  f"play={p['play']} digg={p['digg']} tags={p['hashtags'][:3]} "
                  f"@={p['mentions'][:2]} loc={p['location']}")

        # 3) following (nano channel) --------------------------------------
        try:
            follow_raw = prov.fetch_following(sec_uid, count=30)
            dump(handle, "following", follow_raw)
            follows = parse.find_first_list(follow_raw, ["userList", "user_list", "followings"])
            handles = [parse.find_first(u, ["uniqueId", "unique_id"]) for u in follows][:8]
            result["following_ok"] = len(follows) > 0
            print(f"  following: {len(follows)} returned  e.g. {[h for h in handles if h]}")
        except ProviderError as e:
            result["following_ok"] = False
            print(f"  following: ERROR {e}")

    return result


def run_search(prov: TikHubProvider) -> bool:
    print(f"\n=== USER-SEARCH probe: {SEARCH_PROBE!r} " + "=" * 12)
    try:
        raw = prov.search_users(SEARCH_PROBE)
    except ProviderError as e:
        print(f"  SEARCH ERROR: {e}")
        return False
    dump("_search", SEARCH_PROBE.replace(" ", "_"), raw)
    users = parse.find_first_list(raw, ["user_list", "userList", "users", "data"])
    handles = [parse.find_first(u, ["uniqueId", "unique_id", "nickname"]) for u in users][:10]
    handles = [h for h in handles if h]
    print(f"  returned {len(users)} users  e.g. {handles}")
    return len(handles) > 0


def main() -> None:
    handles = sys.argv[1:] or DEFAULT_HANDLES
    try:
        prov = TikHubProvider()
    except ProviderError as e:
        sys.exit(str(e))

    # Balance first: near-zero credit is the #1 cause of otherwise-cryptic
    # 400/402 failures on the paid endpoints (posts especially).
    try:
        acct = prov.account()
        funds = (acct.get("balance") or 0) + (acct.get("free_credit") or 0)
        print(f"TikHub balance=${acct.get('balance')}  free_credit=${acct.get('free_credit')}  "
              f"(total ${funds:.3f})")
        if funds < 1.0:
            print("  !! WARNING: under $1 credit -> paid calls (posts) will 400/402, and "
                  "you can't crawl at any scale. Top up at https://tikhub.io before "
                  "trusting any posts failures below.")
    except ProviderError as e:
        print(f"(could not read balance: {e})")

    print(f"Provider: TikHub  |  creators: {handles}")
    results = []
    for h in handles:
        try:
            results.append(run_creator(prov, h))
        except ProviderError as e:
            print(f"  ERROR on @{h}: {e}")
            results.append({"handle": h, "error": str(e)})

    search_ok = run_search(prov)

    # ---- decision gate ----------------------------------------------------
    print("\n" + "=" * 56)
    print("DECISION GATE (all should PASS to proceed to Stage 2):")
    good = [r for r in results if "error" not in r]
    check("auth + requests succeed", bool(good))
    check("User-Search returns real creators  << make-or-break", search_ok)
    check("secUid chain works (profile -> posts)",
          any(r.get("has_secuid") and r.get("posts_ok") for r in good))
    check("follower numbers present & non-zero",
          all(r.get("followers_present") for r in good) if good else False)
    check("posts carry hashtags/@-mentions (lookalike inputs)",
          any(r.get("posts_ok") for r in good))
    check("email-from-bio found on >=1 creator",
          any(r.get("email") for r in good))
    print("\nNow open raw/*.json and sanity-check one creator's follower count against "
          "tiktok.com. If the numbers are real, it's GO.")


if __name__ == "__main__":
    main()
