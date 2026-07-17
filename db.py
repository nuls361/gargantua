"""
SQLite store for the creator index. Local + zero-infra for the first run; the
schema ports cleanly to Supabase Postgres later (add a pgvector column on posts
when embeddings arrive in Stage 5).

Design rules from the strategy doc:
  - sec_uid is the dedupe key (handles change, secUid doesn't).
  - measured columns stay raw; derived columns (email/country/engagement) are kept
    separate with a source/confidence so a fact is never confused with a guess.
  - the spend ledger is persisted so the €5 budget survives restarts.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone

DB_PATH = "creatordb.sqlite"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


SCHEMA = """
CREATE TABLE IF NOT EXISTS creators (
    sec_uid           TEXT PRIMARY KEY,
    handle            TEXT,
    tiktok_id         TEXT,
    nickname          TEXT,
    bio               TEXT,
    -- measured (raw from API)
    follower_count    INTEGER,
    following_count   INTEGER,
    heart_count       INTEGER,
    video_count       INTEGER,
    verified          INTEGER,
    is_private        INTEGER,
    language          TEXT,
    bio_link          TEXT,
    -- derived (with source / confidence)
    email             TEXT,
    email_source      TEXT,
    email_type        TEXT,   -- freemail | management | none (do NOT discard management)
    country           TEXT,
    country_confidence REAL,
    dach_lang_ratio   REAL,
    engagement_median REAL,
    posting_per_week  REAL,
    sponsored_count   INTEGER,
    category            TEXT,   -- PRIMARY: lead-tool NICHES (tool-facing, 1:1 with Search filter)
    category_secondary  TEXT,
    sub_niche           TEXT,   -- free DACH-native label (rave, kita, malle, anime, medizin...)
    category_confidence REAL,
    category_source     TEXT,   -- rules | llm | llm-v2
    -- two-tier storage (repost/lead-stub model)
    source_channel    TEXT,   -- hashtag | repost | sample | search
    source_brand      TEXT,   -- for repost stubs: which brand amplified them (@kessberlin)
    enrichment_status TEXT,   -- stub (free, from repost) | enriched | enrich_failed
    region_hint       TEXT,   -- cheap guess: dach | nl | uk | us | eu | null (from email TLD / brand market)
    market            TEXT,   -- CONFIRMED after enrich: dach | other | null (post language/region)
    -- housekeeping
    qualify_status    TEXT,
    discovered_via    TEXT,
    discovered_from   TEXT,
    completeness      REAL,
    first_seen_at     TEXT,
    last_enriched_at  TEXT,
    raw               TEXT
);

CREATE TABLE IF NOT EXISTS posts (
    aweme_id          TEXT PRIMARY KEY,
    creator_sec_uid   TEXT,
    caption           TEXT,
    hashtags          TEXT,   -- json array
    mentions          TEXT,   -- json array
    sound_id          TEXT,
    sound_title       TEXT,
    sound_author      TEXT,
    sound_is_original INTEGER,
    sound_is_commerce INTEGER,
    play              INTEGER,
    digg              INTEGER,
    comment           INTEGER,
    share             INTEGER,
    collect           INTEGER,
    duration_s        REAL,
    region            TEXT,
    desc_language     TEXT,
    share_url         TEXT,
    created_at        INTEGER,
    captured_at       TEXT
);
CREATE INDEX IF NOT EXISTS posts_creator_idx ON posts (creator_sec_uid);

CREATE TABLE IF NOT EXISTS queue (
    identity          TEXT PRIMARY KEY,   -- sec_uid if known else '@'+handle
    handle            TEXT,
    sec_uid           TEXT,
    source            TEXT,               -- search | following | mention | followers | seed
    profile_json      TEXT,               -- pre-harvested profile fields, if any (no re-fetch)
    discovered_from   TEXT,
    state             TEXT DEFAULT 'pending',   -- pending | done | rejected | failed
    round             INTEGER DEFAULT 0,
    created_at        TEXT,
    processed_at      TEXT
);

CREATE TABLE IF NOT EXISTS spend (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint          TEXT,
    cost_usd          REAL,
    at                TEXT
);

CREATE TABLE IF NOT EXISTS hashtags (
    name              TEXT PRIMARY KEY,
    challenge_id      TEXT,
    state             TEXT DEFAULT 'pending',   -- pending | done | failed
    source            TEXT,                     -- seed | loop
    found             INTEGER DEFAULT 0,        -- creator candidates enqueued
    created_at        TEXT,
    processed_at      TEXT
);
"""


class DB:
    def __init__(self, path: str = DB_PATH):
        self.conn = sqlite3.connect(path)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        self._migrate()
        self.conn.commit()

    def _migrate(self):
        """Add columns to a pre-existing creators table (SQLite has no
        ADD COLUMN IF NOT EXISTS; try/except is the idiom)."""
        for col, decl in [
            ("email_type", "TEXT"), ("bio_link", "TEXT"),
            ("category", "TEXT"), ("category_secondary", "TEXT"),
            ("sub_niche", "TEXT"),
            ("category_confidence", "REAL"), ("category_source", "TEXT"),
            ("source_channel", "TEXT"), ("source_brand", "TEXT"),
            ("enrichment_status", "TEXT"), ("region_hint", "TEXT"), ("market", "TEXT"),
            ("comment_de_ratio", "REAL"),
        ]:
            try:
                self.conn.execute(f"ALTER TABLE creators ADD COLUMN {col} {decl}")
            except sqlite3.OperationalError:
                pass  # column already present

    # ---- spend ledger ----------------------------------------------------
    def record_spend(self, endpoint: str, cost_usd: float) -> None:
        self.conn.execute(
            "INSERT INTO spend (endpoint, cost_usd, at) VALUES (?,?,?)",
            (endpoint, cost_usd, _now()),
        )
        self.conn.commit()

    def total_spent(self) -> float:
        row = self.conn.execute("SELECT COALESCE(SUM(cost_usd),0) s FROM spend").fetchone()
        return float(row["s"])

    # ---- queue -----------------------------------------------------------
    def enqueue(self, identity, handle=None, sec_uid=None, source="", profile=None,
                discovered_from=None, round=0) -> bool:
        """Insert a seed; ignore if we've already seen this identity. Returns True if new."""
        try:
            self.conn.execute(
                "INSERT INTO queue (identity, handle, sec_uid, source, profile_json, "
                "discovered_from, round, created_at) VALUES (?,?,?,?,?,?,?,?)",
                (identity, handle, sec_uid, source,
                 json.dumps(profile, ensure_ascii=False) if profile else None,
                 discovered_from, round, _now()),
            )
            self.conn.commit()
            return True
        except sqlite3.IntegrityError:
            return False  # already queued/seen

    def seen(self, identity: str) -> bool:
        return self.conn.execute(
            "SELECT 1 FROM queue WHERE identity=?", (identity,)
        ).fetchone() is not None

    def next_pending(self):
        row = self.conn.execute(
            "SELECT * FROM queue WHERE state='pending' ORDER BY round, rowid LIMIT 1"
        ).fetchone()
        return dict(row) if row else None

    def mark(self, identity: str, state: str) -> None:
        self.conn.execute(
            "UPDATE queue SET state=?, processed_at=? WHERE identity=?",
            (state, _now(), identity),
        )
        self.conn.commit()

    def pending_count(self) -> int:
        return self.conn.execute(
            "SELECT COUNT(*) c FROM queue WHERE state='pending'"
        ).fetchone()["c"]

    # ---- creators / posts ------------------------------------------------
    def upsert_creator(self, c: dict) -> None:
        c = dict(c)
        existing = self.conn.execute(
            "SELECT first_seen_at FROM creators WHERE sec_uid=?", (c["sec_uid"],)
        ).fetchone()
        c["first_seen_at"] = existing["first_seen_at"] if existing else _now()
        c["last_enriched_at"] = _now()
        cols = list(c.keys())
        self.conn.execute(
            f"INSERT OR REPLACE INTO creators ({','.join(cols)}) "
            f"VALUES ({','.join('?' for _ in cols)})",
            [c[k] for k in cols],
        )
        self.conn.commit()

    def upsert_stub(self, c: dict) -> bool:
        """Store a cheap 'lead-stub' from a repost harvest (followers+bio+email, no
        post pull). Idempotent on sec_uid and NON-DESTRUCTIVE: if the creator already
        exists (e.g. already enriched, or seen via another brand) we do NOT overwrite
        their row -- we only backfill source_brand if it was empty. Returns True if a
        NEW stub row was inserted."""
        c = dict(c)
        sec = c["sec_uid"]
        existing = self.conn.execute(
            "SELECT enrichment_status, source_brand FROM creators WHERE sec_uid=?", (sec,)
        ).fetchone()
        if existing:
            # already known -- never downgrade an enriched row back to a stub.
            if not existing["source_brand"] and c.get("source_brand"):
                self.conn.execute("UPDATE creators SET source_brand=? WHERE sec_uid=?",
                                  (c["source_brand"], sec))
                self.conn.commit()
            return False
        c.setdefault("enrichment_status", "stub")
        c.setdefault("source_channel", "repost")
        c["first_seen_at"] = _now()
        cols = list(c.keys())
        self.conn.execute(
            f"INSERT INTO creators ({','.join(cols)}) VALUES ({','.join('?' for _ in cols)})",
            [c[k] for k in cols],
        )
        self.conn.commit()
        return True

    def update_creator(self, sec_uid: str, fields: dict) -> None:
        """Targeted UPDATE (unlike upsert_creator's INSERT OR REPLACE, this preserves
        columns not named -- so enriching a stub keeps its source_brand/channel)."""
        fields = dict(fields)
        fields["last_enriched_at"] = _now()
        sets = ",".join(f"{k}=?" for k in fields)
        self.conn.execute(f"UPDATE creators SET {sets} WHERE sec_uid=?",
                          [*fields.values(), sec_uid])
        self.conn.commit()

    def stubs_to_enrich(self, *, min_followers=1000, max_followers=250000,
                        require_email=True, dach_only=True, limit=0) -> list:
        """The selective-enrich policy: which cheap stubs are worth the post pull.
        Default = in-tier micro + has email + DACH-hinted (region_hint or DACH brand)."""
        q = ("SELECT * FROM creators WHERE enrichment_status='stub' "
             "AND follower_count BETWEEN ? AND ?")
        args = [min_followers, max_followers]
        if require_email:
            q += " AND email IS NOT NULL"
        if dach_only:
            q += " AND region_hint='dach'"
        q += " ORDER BY follower_count DESC"
        if limit:
            q += f" LIMIT {int(limit)}"
        return [dict(r) for r in self.conn.execute(q, args).fetchall()]

    def status_counts(self) -> dict:
        rows = self.conn.execute(
            "SELECT COALESCE(enrichment_status,'(legacy)') s, COUNT(*) c "
            "FROM creators GROUP BY enrichment_status").fetchall()
        return {r["s"]: r["c"] for r in rows}

    def upsert_post(self, p: dict) -> None:
        p = dict(p)
        p["captured_at"] = _now()
        p["hashtags"] = json.dumps(p.get("hashtags") or [], ensure_ascii=False)
        p["mentions"] = json.dumps(p.get("mentions") or [], ensure_ascii=False)
        cols = list(p.keys())
        self.conn.execute(
            f"INSERT OR REPLACE INTO posts ({','.join(cols)}) "
            f"VALUES ({','.join('?' for _ in cols)})",
            [p[k] for k in cols],
        )
        self.conn.commit()

    # ---- hashtag queue ---------------------------------------------------
    def enqueue_hashtag(self, name: str, source: str = "") -> bool:
        try:
            self.conn.execute(
                "INSERT INTO hashtags (name, source, created_at) VALUES (?,?,?)",
                (name, source, _now()),
            )
            self.conn.commit()
            return True
        except sqlite3.IntegrityError:
            return False

    def hashtag_seen(self, name: str) -> bool:
        return self.conn.execute("SELECT 1 FROM hashtags WHERE name=?", (name,)).fetchone() is not None

    def next_pending_hashtag(self):
        row = self.conn.execute(
            "SELECT * FROM hashtags WHERE state='pending' ORDER BY rowid LIMIT 1"
        ).fetchone()
        return dict(row) if row else None

    def mark_hashtag(self, name, state, challenge_id=None, found=0) -> None:
        self.conn.execute(
            "UPDATE hashtags SET state=?, challenge_id=?, found=?, processed_at=? WHERE name=?",
            (state, challenge_id, found, _now(), name),
        )
        self.conn.commit()

    def pending_hashtag_count(self) -> int:
        return self.conn.execute(
            "SELECT COUNT(*) c FROM hashtags WHERE state='pending'"
        ).fetchone()["c"]

    def creator_count(self) -> int:
        return self.conn.execute("SELECT COUNT(*) c FROM creators").fetchone()["c"]

    def post_count(self) -> int:
        return self.conn.execute("SELECT COUNT(*) c FROM posts").fetchone()["c"]
