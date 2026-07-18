"""
Enrich one creator and harvest new seeds. Reuses provider.py (fetch) + parse.py
(extract/derive) + db.py (store/dedupe/meter).

Cost discipline (the doc's three tiers, never in one rush):
  - HARVEST  : seeds arrive from search/following already carrying secUid+stats+bio
               -> qualify with NO api call.
  - QUALIFY  : cheap gate (followers, DACH, not private). Rejects are NOT stored
               ("verwerfen, nicht speichern") to keep the index precise.
  - ENRICH   : posts, newest-first, stop past 90d once >=MIN_POSTS. Only survivors.

Every API call goes through self._call, which refuses to spend past the budget --
so €5 is a hard ceiling at call granularity, not a per-creator estimate.
"""

from __future__ import annotations

import time
from collections import Counter

import parse
import freemail
from provider import ProviderError

COST_PER_CALL = 0.001

# Global / generic hashtags that return worldwide creators, not DACH. Never fed
# back into the hashtag loop (the DACH gate would reject their creators anyway,
# but chasing them wastes budget).
HASHTAG_STOP = {
    "fyp", "foryou", "foryoupage", "fürdich", "fuerdich", "viral", "trending", "trend",
    "tiktok", "capcut", "fy", "xyzbca", "viralvideo", "edit", "edits", "grwm", "haul",
    "vlog", "makeup", "beauty", "outfit", "food", "fashion", "style", "hair", "girl",
    "girls", "kpop", "bts", "reels", "explore", "comedy", "funny", "love", "follow",
    "like", "duet", "deutschland", "deutsch", "germany", "berlin", "trending",
}


class BudgetExceeded(Exception):
    pass


def _container(raw):
    """The dict holding aweme_list + its sibling cursor fields."""
    if isinstance(raw, dict):
        if "aweme_list" in raw or "itemList" in raw:
            return raw
        for v in raw.values():
            r = _container(v)
            if r:
                return r
    if isinstance(raw, list):
        for v in raw:
            r = _container(v)
            if r:
                return r
    return {}


def _find_comments(raw):
    """Locate the comment list wherever TikHub nests it."""
    if isinstance(raw, dict):
        for k in ("comments", "comment_list", "comment"):
            if isinstance(raw.get(k), list) and raw[k]:
                return raw[k]
        for v in raw.values():
            r = _find_comments(v)
            if r:
                return r
    if isinstance(raw, list) and raw and isinstance(raw[0], dict) and (
            "text" in raw[0] or "comment" in raw[0]):
        return raw
    return None


def cheap_qualify(pf: dict, min_followers: int) -> tuple[bool, str]:
    """Cheap gate on already-held profile fields -- no API call. DACH is NOT
    decided here (search seeds often have empty bios); it's enforced after posts
    using the per-post language/region signals, which are far stronger."""
    if not pf.get("sec_uid"):
        return False, "no_secuid"
    if pf.get("private"):
        return False, "private"
    fol = pf.get("followers")
    if not isinstance(fol, int) or fol < min_followers:
        return False, f"followers<{min_followers}"
    return True, "ok"


def is_dach(pf: dict, posts: list, country: str, conf: float, dach_ratio: float) -> bool:
    """Post-enrich DACH decision from the strongest available signals."""
    if pf.get("language") == "de":
        return True
    if dach_ratio >= 0.3:
        return True
    if country in parse.DACH and conf >= 0.4:
        return True
    return False  # no weak caption-hint fallback -- it let global accounts through


class Enricher:
    def __init__(self, prov, db, *, budget_usd, min_followers=1000, max_followers=None,
                 since_days=90, min_posts=15, min_active_90d=5, max_pages=8,
                 harvest_following=True, max_harvest_followers=250_000, max_tag_pages=4):
        self.prov, self.db = prov, db
        self.budget = budget_usd
        self.min_followers = min_followers
        self.max_followers = max_followers   # targeted runs cap the tier (e.g. 1k–50k)
        self.since_days = since_days
        self.min_posts = min_posts
        self.min_active_90d = min_active_90d
        self.max_pages = max_pages
        self.max_tag_pages = max_tag_pages
        self.harvest_following = harvest_following
        # only harvest the following-graph from smaller creators -- a mega account's
        # follow list is full of other global mega accounts, not target nano/micro.
        self.max_harvest_followers = max_harvest_followers

    def _call(self, fn, endpoint: str):
        if self.db.total_spent() + COST_PER_CALL > self.budget:
            raise BudgetExceeded()
        result = fn()
        self.db.record_spend(endpoint, COST_PER_CALL)  # only charged calls reach here
        return result

    # -- HASHTAG channel: tag -> videos -> pre-qualified creator seeds ------
    def harvest_hashtag(self, tag_name: str) -> tuple[str | None, int]:
        detail = self._call(lambda: self.prov.fetch_tag_detail(tag_name), "tag_detail")
        # the challenge id lives at data.challengeInfo.challenge.id (there is no
        # "challengeID" key at all).
        cid = (((detail.get("data") or {}).get("challengeInfo") or {})
               .get("challenge") or {}).get("id")
        if not cid:
            return None, 0
        n, cursor = 0, 0
        for _ in range(self.max_tag_pages):
            raw = self._call(lambda c=cursor: self.prov.fetch_tag_post(cid, cursor=c), "tag_post")
            cont = _container(raw)
            items = cont.get("itemList") or cont.get("aweme_list") or []
            for it in items:
                au = it.get("author") or {}
                ast = it.get("authorStats") or it.get("authorStatsV2") or {}
                if not au.get("secUid"):
                    continue
                u = dict(au)
                u.update(ast)                      # merge stats so followers resolve
                pf = parse.profile_fields(u)
                fol = pf.get("followers")
                if pf.get("private") or not isinstance(fol, int) or fol < self.min_followers:
                    continue                        # free pre-filter, no extra call
                ident = pf["sec_uid"]
                if self.db.seen(ident):
                    continue
                if self.db.enqueue(ident, handle=pf.get("handle"), sec_uid=ident,
                                   source="hashtag", profile=u, discovered_from=f"#{tag_name}"):
                    n += 1
            has_more = cont.get("hasMore")
            if has_more is None:
                has_more = cont.get("has_more")
            cursor = cont.get("cursor")
            if cursor is None:
                cursor = cont.get("max_cursor")
            if not has_more or not items or cursor is None:
                break
        return cid, n

    # -- language of the seed profile: harvested (no call) or fetched ------
    def _profile(self, seed) -> tuple[dict, str]:
        if seed.get("profile_json"):
            import json
            return parse.profile_fields(json.loads(seed["profile_json"])), "harvested"
        raw = self._call(lambda: self.prov.fetch_profile(seed["handle"]), "profile")
        return parse.profile_fields(raw), "fetched"

    def _fetch_posts(self, sec_uid) -> list:
        cutoff = time.time() - self.since_days * 86400
        posts, seen, cursor = [], set(), 0
        for _ in range(self.max_pages):
            raw = self._call(lambda c=cursor: self.prov.fetch_posts(sec_uid, count=30, max_cursor=c), "posts")
            cont = _container(raw)
            items = cont.get("aweme_list") or cont.get("itemList") or []
            fresh = [a for a in items if (a.get("aweme_id") or a.get("id")) not in seen]
            for a in fresh:
                seen.add(a.get("aweme_id") or a.get("id"))
            posts.extend(parse.post_fields(a) for a in fresh)
            has_more, cursor = cont.get("has_more"), cont.get("max_cursor")
            oldest = min((int(p["create_time"]) for p in posts if p.get("create_time")), default=cutoff)
            if not has_more or not fresh or not cursor:
                break
            if len(posts) >= self.min_posts and oldest < cutoff:
                break
        return posts

    def enrich(self, seed) -> tuple[int, str, dict | None]:
        """Returns (#new_seeds_enqueued, outcome, summary|None)."""
        pf, _src = self._profile(seed)
        keep, reason = cheap_qualify(pf, self.min_followers)
        if not keep:
            return 0, f"reject:{reason}", None
        # targeted tier cap (e.g. 1k–50k) -- reject BEFORE the expensive posts pull
        if self.max_followers and isinstance(pf.get("followers"), int) \
                and pf["followers"] > self.max_followers:
            return 0, "reject:too_big", None

        sec = pf["sec_uid"]
        posts = self._fetch_posts(sec)
        cutoff = time.time() - self.since_days * 86400
        recent = [p for p in posts if p.get("create_time") and int(p["create_time"]) >= cutoff]
        if len(recent) < self.min_active_90d:
            return 0, f"reject:inactive({len(recent)}/90d)", None

        country, conf = parse.country_from_regions(posts)
        dach_ratio = parse.dach_language_ratio(posts)
        if not is_dach(pf, posts, country, conf, dach_ratio):
            return 0, "reject:not_dach", None

        brands = []
        for p in posts:
            if parse.is_sponsored(p.get("caption")):
                brands += p.get("mentions") or []
        cat, cat2, cat_conf, cat_src = parse.categorize_rich(posts, bio=pf.get("bio"), brands=brands)

        creator = {
            "sec_uid": sec,
            "handle": pf["handle"],
            "tiktok_id": pf.get("user_id"),
            "nickname": pf.get("nickname"),
            "bio": pf.get("bio"),
            "follower_count": pf.get("followers"),
            "following_count": pf.get("following"),
            "heart_count": pf.get("likes"),
            "video_count": pf.get("videos"),
            "verified": int(bool(pf.get("verified"))),
            "is_private": int(bool(pf.get("private"))),
            "language": parse.dominant_language(posts),
            "bio_link": pf.get("bio_link"),
            "email": parse.email_from_bio(pf.get("bio", "")),
            "email_source": "bio_regex" if parse.email_from_bio(pf.get("bio", "")) else None,
            "email_type": freemail.classify_email(parse.email_from_bio(pf.get("bio", ""))),
            "country": country,
            "country_confidence": conf,
            "dach_lang_ratio": parse.dach_language_ratio(posts),
            "engagement_median": parse.engagement_rate(posts),
            "posting_per_week": parse.posting_per_week(posts),
            "category": cat,
            "category_secondary": cat2,
            "category_confidence": cat_conf,
            "category_source": cat_src if cat else None,
            "sponsored_count": sum(1 for p in posts if parse.is_sponsored(p.get("caption"))),
            "qualify_status": "qualified",
            "source_channel": seed.get("source"),
            "enrichment_status": "enriched",
            "market": "dach",   # passed the DACH gate to get here
            "region_hint": country if country in parse.DACH else "dach",
            "discovered_via": seed.get("source"),
            "discovered_from": seed.get("discovered_from"),
            "completeness": self._completeness(pf, posts),
            "raw": None,
        }
        self.db.upsert_creator(creator)
        for p in posts:
            self.db.upsert_post({
                "aweme_id": p["aweme_id"], "creator_sec_uid": sec,
                "caption": p["caption"], "hashtags": p["hashtags"], "mentions": p["mentions"],
                "sound_id": p["sound_id"], "sound_title": p["sound"], "sound_author": p["sound_author"],
                "sound_is_original": _b(p["sound_is_original"]), "sound_is_commerce": _b(p["sound_is_commerce"]),
                "play": p["play"], "digg": p["digg"], "comment": p["comment"],
                "share": p["share"], "collect": p["collect"], "duration_s": p["duration_s"],
                "region": p["region"], "desc_language": p["desc_language"],
                "share_url": p["share_url"], "created_at": p["create_time"],
            })

        new = self._harvest(pf, posts, sec)
        summary = {
            "sec_uid": sec, "handle": pf["handle"], "followers": pf.get("followers"),
            "country": country, "email": creator["email"],
            "engagement_median": creator["engagement_median"], "posts": len(posts),
        }
        return new, "qualified", summary

    def _comment_german_ratio(self, posts) -> float | None:
        """Measure how German a creator's AUDIENCE is by sampling comments across a few
        posts. Deliberately skips the single most-commented (usually a viral post with
        international comments) and reads the next mid-tier posts -> representative of the
        core audience. Aggregates ~3 posts' comments. Returns [0,1] or None (no signal)."""
        commented = sorted((p for p in posts if (p.get("comment") or 0) >= 10),
                           key=lambda p: p.get("comment") or 0, reverse=True)
        # skip the viral #1 when we have enough posts; else take what's there
        sample = commented[1:4] if len(commented) >= 4 else commented[:3]
        texts = []
        for p in sample:
            if not p.get("aweme_id"):
                continue
            try:
                raw = self._call(
                    lambda a=p["aweme_id"]: self.prov.fetch_video_comments(a, count=30),
                    "comments")
            except ProviderError:
                continue
            texts += [(it.get("text") or it.get("comment") or "") for it in (_find_comments(raw) or [])]
        r = parse.comment_german_ratio(texts)
        return None if r < 0 else r

    def enrich_from_stub(self, stub: dict) -> tuple[int, str, dict | None]:
        """Promote a cheap repost-stub to a full record: pull posts, compute ER +
        category + confirmed market, harvest its hashtags. Unlike enrich(), this NEVER
        drops the creator -- non-DACH/inactive get a flag, not a delete. Returns
        (#new_hashtags, outcome, summary)."""
        sec = stub["sec_uid"]
        posts = self._fetch_posts(sec)
        if not posts:
            self.db.update_creator(sec, {"enrichment_status": "enrich_failed"})
            return 0, "enrich_failed:no_posts", None

        country, conf = parse.country_from_regions(posts)
        dach_ratio = parse.dach_language_ratio(posts)
        # market is a real dimension: dach | uk | other. UK = GB upload region (English
        # alone is not a country signal), so it leans on the per-post region, not language.
        if is_dach({}, posts, country, conf, dach_ratio):
            market = "dach"
        elif country in ("GB", "UK"):
            market = "uk"
        else:
            market = "other"

        # Borderline rescue: a creator whose CAPTIONS aren't clearly German but who has
        # a DACH hint (some German posts, or DACH upload region) -- verify via AUDIENCE
        # language in the comments. Common for bigger creators (English captions, German
        # audience). One comment call, only when it can flip the decision.
        comment_de = None
        if market == "other" and (dach_ratio >= 0.08 or country in parse.DACH):
            comment_de = self._comment_german_ratio(posts)
            if comment_de is not None and comment_de >= 0.4:
                market = "dach"

        # brands the creator worked with: the source brand + brands @-mentioned in
        # sponsored posts -> a strong niche vote alongside hashtags/captions/bio.
        brands = [stub["source_brand"]] if stub.get("source_brand") else []
        for p in posts:
            if parse.is_sponsored(p.get("caption")):
                brands += p.get("mentions") or []
        cat, cat2, cat_conf, cat_src = parse.categorize_rich(posts, bio=stub.get("bio"), brands=brands)
        cutoff = time.time() - self.since_days * 86400
        recent = [p for p in posts if p.get("create_time") and int(p["create_time"]) >= cutoff]

        self.db.update_creator(sec, {
            "language": parse.dominant_language(posts),
            "country": country,
            "country_confidence": conf,
            "dach_lang_ratio": dach_ratio,
            "market": market,
            "comment_de_ratio": comment_de,
            "region_hint": stub.get("region_hint") or (country if country in parse.DACH else None),
            "engagement_median": parse.engagement_rate(posts),
            "posting_per_week": parse.posting_per_week(posts),
            "category": cat,
            "category_secondary": cat2,
            "category_confidence": cat_conf,
            "category_source": cat_src if cat else None,
            "sponsored_count": sum(1 for p in posts if parse.is_sponsored(p.get("caption"))),
            "video_count": stub.get("video_count"),
            "enrichment_status": "enriched",
            "qualify_status": "qualified" if market == "dach" else "out_of_market",
        })
        for p in posts:
            self.db.upsert_post({
                "aweme_id": p["aweme_id"], "creator_sec_uid": sec,
                "caption": p["caption"], "hashtags": p["hashtags"], "mentions": p["mentions"],
                "sound_id": p["sound_id"], "sound_title": p["sound"], "sound_author": p["sound_author"],
                "sound_is_original": _b(p["sound_is_original"]), "sound_is_commerce": _b(p["sound_is_commerce"]),
                "play": p["play"], "digg": p["digg"], "comment": p["comment"],
                "share": p["share"], "collect": p["collect"], "duration_s": p["duration_s"],
                "region": p["region"], "desc_language": p["desc_language"],
                "share_url": p["share_url"], "created_at": p["create_time"],
            })
        # feed channel B: this creator's hashtags become DACH-premium discovery seeds
        new = self._harvest(None, posts, sec) if market == "dach" else 0
        summary = {
            "sec_uid": sec, "handle": stub.get("handle"), "followers": stub.get("follower_count"),
            "market": market, "email": stub.get("email"),
            "engagement_median": parse.engagement_rate(posts),
            "category": cat, "posts": len(posts), "recent": len(recent),
        }
        return new, ("qualified" if market == "dach" else "out_of_market"), summary

    def _harvest(self, pf, posts, sec) -> int:
        """Grow discovery ONLY via the hashtag loop -- this qualified DACH creator's
        own German hashtags become new tag-seeds. The following/@-mention graph is
        deliberately dropped: measured at ~0% qualify yield (global accounts + brands),
        it only burned budget. Hashtags keep ~95% and stay on the target tier."""
        tc = Counter()
        for p in posts:
            for t in p.get("hashtags") or []:
                tc[t.lower().strip()] += 1
        for t, _ in tc.most_common(6):
            if len(t) >= 4 and t not in HASHTAG_STOP and not t.isdigit() \
                    and not self.db.hashtag_seen(t):
                self.db.enqueue_hashtag(t, source="loop")
        return 0

    @staticmethod
    def _completeness(pf, posts) -> float:
        keys = [pf.get("followers"), pf.get("sec_uid"), pf.get("bio"), pf.get("nickname"), posts]
        return round(sum(1 for k in keys if k) / len(keys), 2)


def _b(v):
    return None if v is None else int(bool(v))
