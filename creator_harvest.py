"""
Seed-creator discovery channel.

Given one creator the team likes, harvest their orbit: the @-mentions in their recent
posts (collab partners) plus their following list when it's public (often hidden). Each
candidate is a bare handle, so it's resolved with one profile call -> sec_uid + follower
stats + bio, the same author shape the brand/hashtag channels produce.

    harvest_creator(prov, "kessberlin", max_pages)
"""
from __future__ import annotations

import parse
import freemail
from provider import ProviderError

MAX_CANDIDATES = 40          # cap the profile resolves per seed (cost guard)


def _following_handles(prov, sec_uid, meter) -> set:
    try:
        fl = prov.fetch_following(sec_uid, count=50)
        if meter:
            meter()
    except ProviderError:
        return set()
    cont = fl.get("data", fl) or {}
    users = cont.get("userList") or cont.get("followings") or cont.get("user_list") or []
    out = set()
    for u in users:
        uu = u.get("user") or u
        h = uu.get("uniqueId") or uu.get("unique_id")
        if h:
            out.add(h)
    return out


def harvest_creator(prov, seed_handle: str, max_pages: int, meter=None) -> list:
    """Return resolved author dicts for the seed creator's orbit (mentions + following)."""
    seed = seed_handle.lstrip("@")
    prof = prov.fetch_profile(seed)
    if meter:
        meter()
    pf = parse.profile_fields(prof.get("data", prof) if isinstance(prof, dict) else {})
    sec = pf.get("sec_uid")
    if not sec:
        raise ProviderError(f"no secUid for @{seed}")

    candidates = set()
    candidates |= _following_handles(prov, sec, meter)

    # @-mentions from the seed's recent posts (collab partners)
    cursor = 0
    for _ in range(max_pages):
        raw = prov.fetch_posts(sec, count=30, max_cursor=cursor)
        if meter:
            meter()
        cont = raw.get("data", raw) or {}
        items = cont.get("aweme_list") or cont.get("itemList") or []
        for a in items:
            for m in (parse.post_fields(a).get("mentions") or []):
                candidates.add(str(m).lstrip("@"))
        cursor = cont.get("max_cursor")
        if not items or not cont.get("has_more") or not cursor:
            break

    candidates.discard(seed)
    candidates = list(candidates)[:MAX_CANDIDATES]

    authors = []
    for h in candidates:
        try:
            pr = prov.fetch_profile(h)
            if meter:
                meter()
        except ProviderError:
            continue
        cpf = parse.profile_fields(pr.get("data", pr) if isinstance(pr, dict) else {})
        csec = cpf.get("sec_uid")
        if not csec:
            continue
        bio = cpf.get("bio") or ""
        email = parse.email_from_bio(bio)
        authors.append({
            "handle": cpf.get("handle") or h, "sec_uid": csec,
            "nickname": cpf.get("nickname"),
            "followers": cpf.get("followers"),
            "verified": bool(cpf.get("verified")),
            "bio": bio.replace("\n", " ").strip(), "email": email,
            "email_type": freemail.classify_email(email) if email else None,
        })
    return authors
