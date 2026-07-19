"""
Minimal extractors. Their job is ONLY to prove that the fields the whole system
depends on are actually derivable from a raw provider response -- not to be the
final production parsers. They are deliberately tolerant: TikHub wraps TikTok's
own JSON, and TikTok's shape drifts, so everything here searches the payload by
key name instead of assuming a fixed path. When something comes back None, the
raw JSON dumped by validate.py is the source of truth to adjust against.
"""

from __future__ import annotations

import re
import statistics
from collections import Counter

DACH = {"DE", "AT", "CH"}

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")

# Cheap DE/AT/CH signal: umlauts, common German words/TLDs. Good enough to prove
# the language gate is buildable; not the final classifier.
_DACH_HINTS = re.compile(
    r"(?i)\b(und|oder|nicht|ich|mein|deine|für|über|schön|liebe|grüße|hallo|"
    r"kontakt|anfrage|zusammenarbeit|kooperation|geschäftlich)\b|[äöüß]|\.de\b|\.at\b|\.ch\b"
)


def _walk(obj):
    """Yield every (key, value) pair anywhere in a nested dict/list."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k, v
            yield from _walk(v)
    elif isinstance(obj, list):
        for item in obj:
            yield from _walk(item)


def find_first(obj, keys):
    """First value found under any of `keys`, searching the whole payload."""
    wanted = set(keys)
    for k, v in _walk(obj):
        if k in wanted and v not in (None, "", [], {}):
            return v
    return None


def find_first_list(obj, keys):
    """First non-empty list found under any of `keys` (e.g. itemList, user_list)."""
    wanted = set(keys)
    for k, v in _walk(obj):
        if k in wanted and isinstance(v, list) and v:
            return v
    return []


# --------------------------------------------------------------------------- #
# Profile
# --------------------------------------------------------------------------- #

def profile_fields(payload: dict) -> dict:
    return {
        "handle": find_first(payload, ["uniqueId", "unique_id"]),
        "nickname": find_first(payload, ["nickname"]),
        "sec_uid": find_first(payload, ["secUid", "sec_uid"]),
        "user_id": find_first(payload, ["id", "uid"]),
        "followers": find_first(payload, ["followerCount", "follower_count"]),
        "following": find_first(payload, ["followingCount", "following_count"]),
        "likes": find_first(payload, ["heartCount", "heart", "total_favorited"]),
        "videos": find_first(payload, ["videoCount", "aweme_count"]),
        "verified": find_first(payload, ["verified"]),
        "private": find_first(payload, ["privateAccount", "secret"]),
        "bio": find_first(payload, ["signature", "desc"]) or "",
        "bio_link": _bio_link(payload),   # linktree/beacons -> the on-demand email path
    }


def _bio_link(payload):
    bl = find_first(payload, ["bioLink"])
    if isinstance(bl, dict):
        return bl.get("link")
    return bl if isinstance(bl, str) and bl else None


# --------------------------------------------------------------------------- #
# Posts
# --------------------------------------------------------------------------- #

def posts_list(payload: dict) -> list:
    return find_first_list(payload, ["itemList", "item_list", "aweme_list", "videos"])


def post_fields(post: dict) -> dict:
    stats = post.get("stats") or post.get("statistics") or post.get("statsV2") or {}
    music = post.get("music") or {}
    caption = post.get("desc") or ""
    mentions, hashtags = [], []
    for te in post.get("textExtra") or post.get("text_extra") or []:
        tag = te.get("hashtagName") or te.get("hashtag_name")
        if tag:
            hashtags.append(tag)
            continue
        # A user mention. Web gives userUniqueId; app v3 gives only user_id/sec_uid
        # and the @name must be sliced out of the caption at start:end.
        if te.get("userUniqueId") or te.get("user_unique_id") or te.get("user_id") or te.get("sec_uid"):
            uname = te.get("userUniqueId") or te.get("user_unique_id")
            if not uname:
                s, e = te.get("start"), te.get("end")
                if isinstance(s, int) and isinstance(e, int) and 0 <= s < e <= len(caption):
                    uname = caption[s:e].lstrip("@").strip()
            if uname:
                mentions.append(uname)
    # fallbacks straight from the caption text
    if not hashtags:
        hashtags = re.findall(r"#(\w+)", caption)
    video = post.get("video") or {}
    dur_ms = video.get("duration") or 0
    handle = (post.get("author") or {}).get("unique_id") if isinstance(post.get("author"), dict) else None
    aweme_id = post.get("aweme_id") or post.get("id")
    return {
        "aweme_id": aweme_id,
        "caption": caption,
        "hashtags": hashtags,
        "mentions": mentions,
        "sound": music.get("title") or music.get("music_name"),
        "sound_id": music.get("id") or music.get("mid"),
        "sound_author": music.get("author"),
        "sound_is_original": music.get("is_original"),
        "sound_is_commerce": music.get("is_commerce_music"),
        "play": _num(stats, ["playCount", "play_count"]),
        "digg": _num(stats, ["diggCount", "digg_count"]),
        "comment": _num(stats, ["commentCount", "comment_count"]),
        "share": _num(stats, ["shareCount", "share_count"]),
        "collect": _num(stats, ["collectCount", "collect_count"]),
        "duration_s": round(dur_ms / 1000, 1) if dur_ms and dur_ms > 100 else (dur_ms or None),
        # per-post signals confirmed populated in Stage 1:
        "region": post.get("region"),                 # upload country (noisy -> derived)
        "desc_language": post.get("desc_language"),    # TikTok's per-post language
        "create_time": post.get("createTime") or post.get("create_time"),
        "location": (post.get("locationCreated") or post.get("location_created")
                     or (post.get("poi") or {}).get("country")),
        "share_url": (post.get("share_url", "").split("?")[0] or None) if post.get("share_url")
                     else (f"https://www.tiktok.com/@{handle}/video/{aweme_id}" if handle and aweme_id else None),
    }


# Sponsored-post signal: caption heuristic beats the (empty) is_ads field for DACH.
_AD_RE = re.compile(r"(?i)\b(anzeige|werbung|sponsored|paid partnership|ad)\b|/ad\b|#ad\b|#werbung\b")


def is_sponsored(caption: str) -> bool:
    return bool(_AD_RE.search(caption or ""))


# Audience-language verification from a post's COMMENTS. TikTok gives no per-comment
# language, so a lightweight heuristic: umlauts/ß or common German function/slang words.
# A mostly-German comment section = DACH audience even when the caption is English
# (frequent for bigger creators) -> a second DACH signal beyond the caption.
_GER_WORDS = {
    "und", "ist", "das", "ich", "nicht", "auch", "der", "die", "ein", "eine", "mit",
    "für", "wie", "was", "wenn", "aber", "mehr", "sehr", "immer", "haben", "machen",
    "schön", "krass", "mega", "hier", "noch", "mal", "nur", "schon", "gut", "danke",
    "bitte", "liebe", "süß", "geil", "hübsch", "richtig", "einfach", "würde", "kann",
    "du", "wo", "warum", "wieso", "brauche", "genau", "leider", "vielleicht", "wirklich",
}


def _looks_german(text: str) -> bool:
    t = (text or "").lower()
    if any(c in t for c in "äöüß"):
        return True
    return bool(set(re.findall(r"[a-zäöüß]{2,}", t)) & _GER_WORDS)


def comment_german_ratio(texts) -> float:
    """Fraction of word-bearing comments that look German. Pure-emoji / one-token
    comments carry no language signal and are ignored. Returns -1 when too few
    scoreable comments to judge (don't decide on noise)."""
    scored = [t for t in texts if len(re.findall(r"[a-zäöüß]{3,}", (t or "").lower())) >= 1]
    if len(scored) < 4:
        return -1.0
    return round(sum(1 for t in scored if _looks_german(t)) / len(scored), 2)


def _num(d: dict, keys) -> int:
    for k in keys:
        v = d.get(k)
        if v is not None:
            try:
                return int(v)
            except (TypeError, ValueError):
                pass
    return 0


# --------------------------------------------------------------------------- #
# Derived fields (the "extrapolated without extra calls" proof)
# --------------------------------------------------------------------------- #

def email_from_bio(bio: str):
    m = EMAIL_RE.search(bio or "")
    return m.group(0) if m else None


def engagement_rate(post_field_list: list) -> float | None:
    """
    Median per-post engagement = (digg+comment+share+collect) / play.
    Median, not mean -- one viral post shouldn't define a creator (doc rule).
    """
    rates = []
    for p in post_field_list:
        plays = p.get("play") or 0
        if plays > 0:
            inter = p["digg"] + p["comment"] + p["share"] + p["collect"]
            rates.append(inter / plays)
    return round(statistics.median(rates) * 100, 2) if rates else None


def dach_language_signal(bio: str, captions: list) -> bool:
    text = " ".join([bio or ""] + [c or "" for c in captions])
    return bool(_DACH_HINTS.search(text))


def country_from_regions(post_field_list: list):
    """Most-common per-post upload region + its share as a confidence (travel-noisy)."""
    regs = [p.get("region") for p in post_field_list if p.get("region")]
    if not regs:
        return None, 0.0
    top, n = Counter(regs).most_common(1)[0]
    return top, round(n / len(regs), 2)


def dominant_language(post_field_list: list):
    """Creator language = most common per-post desc_language (ignoring 'un').
    The profile carries no reliable language field, so we derive it from posts."""
    langs = [p.get("desc_language") for p in post_field_list
             if p.get("desc_language") and p.get("desc_language") != "un"]
    return Counter(langs).most_common(1)[0][0] if langs else None


def dach_language_ratio(post_field_list: list) -> float:
    """Share of captioned posts whose TikTok-detected language is German."""
    langs = [p.get("desc_language") for p in post_field_list
             if p.get("desc_language") and p.get("desc_language") != "un"]
    if not langs:
        return 0.0
    return round(sum(1 for l in langs if l == "de") / len(langs), 2)


# --------------------------------------------------------------------------- #
# Category (Layer 1: hashtag rules). Taxonomy is the lead tool's NICHES exactly,
# so a category here maps 1:1 onto the tool's Search filter -- no translation.
# German + English signal stems, substring-matched against a creator's hashtags.
# The ~6% this misses + low-confidence rows are upgraded by the LLM pass.
# --------------------------------------------------------------------------- #

CATEGORY_SIGNALS = {
    "beauty":          ["makeup","beauty","cosmetic","mascara","foundation","lippen","lipstick","contouring","blush","glowup","parfum","fragrance","nails","naegel","maniküre","augen","hautpflege","beauty","pflegeroutine","serum","retinol","akne","unreinheiten","feuchtigkeit","haut"],
    "wellness":        ["wellness","selfcare","mentalhealth","achtsamkeit","yoga","meditation","gesundheit","wohlbefinden","journaling","selflove"],
    "fitness":         ["fitness","gym","workout","abnehmen","muskel","training","protein","gains","homeworkout","laufen","running","sport"],
    "fashion":         ["outfit","mode","fashion","style","ootd","streetwear","haul","dress","kleid","zara","shopping","inspo","lookbook"],
    "food":            ["rezept","kochen","backen","essen","foodie","mealprep","recipe","kuchen","lecker","abendessen","foodtok","baking","food"],
    "travel":          ["reise","urlaub","travel","vacation","roadtrip","strand","wanderlust","trip"],
    "gaming":          ["gaming","gamer","twitch","valorant","minecraft","fortnite","gameplay","zocken","konsole","playstation"],
    "tech":            ["technik","gadget","iphone","android","coding","programmier","software","smarthome","gadgets"],
    "finance":         ["finanzen","aktien","invest","sparen","etf","boerse","krypto","crypto","trading","vermoegen","finance"],
    "music":           ["techno","rave","tekk","schranz","festival","konzert","musik","rap","kpop","singen","sänger","gesang","produzent","cover","song","music"],
    "comedy":          ["comedy","funny","witzig","humor","meme","sketch","lustig","satire"],
    "parenting":       ["mama","kita","familie","kinder","mamalife","erzieherin","schwanger","baby","kleinkind","elternschaft","papa","familienleben","mom"],
    "home & interior": ["haushalt","putzen","cleaning","interior","deko","wohnung","zuhause","einrichtung","garten","wohnen","möbel","renovier"],
    "sustainability":  ["nachhaltig","sustainab","zerowaste","vegan","umwelt","klima","secondhand","upcycling","fairfashion"],
    "lifestyle":       ["vlog","grwm","dayinmylife","alltag","morgenroutine","lifestyle","dailylife","routine"],
}


def categorize(post_field_list: list):
    """Aggregate a creator's hashtags -> (primary, secondary, confidence).
    Confidence = winner's share of all category-matched hashtag hits. Returns
    (None, None, 0.0) when nothing matches (-> handed to the LLM pass)."""
    score = Counter()
    for p in post_field_list:
        for t in p.get("hashtags") or []:
            t = t.lower().strip()
            for cat, stems in CATEGORY_SIGNALS.items():
                if any(s in t for s in stems):
                    score[cat] += 1
                    break  # one hashtag -> at most one category (first match wins)
    total = sum(score.values())
    if not total:
        return None, None, 0.0
    ranked = score.most_common(2)
    primary = ranked[0][0]
    secondary = ranked[1][0] if len(ranked) > 1 else None
    return primary, secondary, round(ranked[0][1] / total, 2)


# Brands -> niche. A creator a brand chose to work with (reposted them, or they tag
# it as #anzeige) is a strong category vote. Substring-matched against brand handles,
# so "barebellsgermany" hits "barebells". Extend freely.
BRAND_CATEGORY = {
    # fitness / nutrition
    "barebells": "fitness", "gymshark": "fitness", "myprotein": "fitness", "esnofficial": "fitness",
    "foodspring": "fitness", "smilodox": "fitness", "prozis": "fitness", "weider": "fitness",
    # wellness / supplements
    "noritual": "wellness", "yfood": "wellness", "ahead": "wellness", "sunday natural": "wellness",
    # beauty / skincare
    "douglas": "beauty", "sephora": "beauty", "rossmann": "beauty", "dm": "beauty",
    "loreal": "beauty", "maybelline": "beauty", "catrice": "beauty", "essence": "beauty",
    "rhode": "beauty", "cerave": "beauty", "paulaschoice": "beauty", "yepoda": "beauty",
    "caiacosmetics": "beauty", "kessberlin": "beauty", "luamaya": "beauty",
    # fashion
    "zara": "fashion", "nakdfashion": "fashion", "aboutyou": "fashion", "hm": "fashion",
    "shein": "fashion", "edited": "fashion", "mango": "fashion", "ginatricot": "fashion",
    "organicbasics": "fashion", "purelei": "fashion", "nakd": "fashion",
    # food
    "koro": "food", "hellofresh": "food", "kochhaus": "food", "purish": "food",
}


def _hashtag_category(tag: str):
    tag = tag.lower().strip()
    for cat, stems in CATEGORY_SIGNALS.items():
        if any(s in tag for s in stems):
            return cat
    return None


def _brand_category(handle: str):
    h = re.sub(r"[^a-z0-9]", "", (handle or "").lower().lstrip("@"))
    if not h:
        return None
    for brand, cat in BRAND_CATEGORY.items():
        b = re.sub(r"[^a-z0-9]", "", brand)
        if b and b in h:
            return cat
    return None


def categorize_rich(post_field_list: list, bio: str | None = None, brands=None):
    """Signal-rich categorization: hashtags + caption text + bio + brand collaborations,
    each weighted by how much it says about a creator's niche. Free (no API/LLM). Returns
    (primary, secondary, confidence, 'rich'). Falls back to (None, None, 0.0, 'rich')."""
    score = Counter()

    # hashtags — the cleanest signal (weight 2)
    for p in post_field_list:
        for t in p.get("hashtags") or []:
            c = _hashtag_category(t)
            if c:
                score[c] += 2

    # caption free-text — one vote per post per category it mentions (weight 1)
    for p in post_field_list:
        cap = (p.get("caption") or "").lower()
        if not cap:
            continue
        for cat, stems in CATEGORY_SIGNALS.items():
            if any(s in cap for s in stems):
                score[cat] += 1

    # bio — creators often state their niche outright (weight 3)
    if bio:
        b = bio.lower()
        for cat, stems in CATEGORY_SIGNALS.items():
            if any(s in b for s in stems):
                score[cat] += 3

    # brands worked with — source_brand + sponsored @-mentions (weight 2)
    for h in brands or []:
        c = _brand_category(h)
        if c:
            score[c] += 2

    total = sum(score.values())
    if not total:
        return None, None, 0.0, "rich"
    ranked = score.most_common(2)
    return ranked[0][0], (ranked[1][0] if len(ranked) > 1 else None), round(ranked[0][1] / total, 2), "rich"


def posting_per_week(post_field_list: list):
    ts = sorted(int(p["create_time"]) for p in post_field_list if p.get("create_time"))
    if len(ts) < 2:
        return None
    weeks = (ts[-1] - ts[0]) / (86400 * 7)
    return round(len(ts) / weeks, 2) if weeks > 0 else None
