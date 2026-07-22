#!/usr/bin/env python3
"""Backfill tt_creators.avatar_url by caching each creator's TikTok avatar into Supabase
Storage (permanent — TikTok CDN URLs are signed and expire). One profile call each.
Shardable via CRAWL_SHARDS/CRAWL_SHARD.

    SUPABASE_URL=.. SUPABASE_SECRET_KEY=.. TIKHUB_API_KEY=.. python3 backfill_avatars.py
"""
from __future__ import annotations
import base64, os, subprocess, sys, time, uuid
import requests
from provider import TikHubProvider, ProviderError
from store import Supa

SB_URL = os.environ["SUPABASE_URL"].rstrip("/")
SB_KEY = os.environ["SUPABASE_SECRET_KEY"]
BUCKET = "avatars"
SC = "/tmp"


def ensure_bucket():
    requests.post(f"{SB_URL}/storage/v1/bucket",
                  headers={"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}", "Content-Type": "application/json"},
                  json={"id": BUCKET, "name": BUCKET, "public": True}, timeout=30)  # 200 or 409 if exists


def to_jpeg(raw: bytes) -> bytes:
    if raw[:2] == b"\xff\xd8" or raw[:8] == b"\x89PNG\r\n\x1a\n":
        return raw
    s = f"{SC}/av_{uuid.uuid4().hex}.heic"; d = s + ".jpg"
    open(s, "wb").write(raw)
    subprocess.run(["sips", "-s", "format", "jpeg", s, "--out", d], capture_output=True, check=True)
    return open(d, "rb").read()


def upload(sec_uid: str, jpg: bytes) -> str | None:
    key = sec_uid.replace("/", "_") + ".jpg"
    r = requests.post(f"{SB_URL}/storage/v1/object/{BUCKET}/{key}", data=jpg,
                      headers={"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}",
                               "Content-Type": "image/jpeg", "x-upsert": "true"}, timeout=30)
    if r.status_code in (200, 201):
        return f"{SB_URL}/storage/v1/object/public/{BUCKET}/{key}"
    return None


def targets(supa: Supa) -> list:
    out, off = [], 0
    while True:
        rows = supa._get("tt_creators", {"select": "sec_uid,handle", "avatar_url": "is.null",
                                          "platform": "eq.tiktok", "handle": "not.is.null",
                                          "order": "follower_count.desc", "limit": "1000", "offset": str(off)})
        out.extend(rows)
        if len(rows) < 1000:
            break
        off += 1000
    return out


def main():
    supa, prov = Supa(), TikHubProvider()
    ensure_bucket()
    shards = int(os.environ.get("CRAWL_SHARDS", "1")); shard = int(os.environ.get("CRAWL_SHARD", "0"))
    rows = targets(supa)
    if shards > 1:
        rows = [r for i, r in enumerate(rows) if i % shards == shard]
    print(f"[av] shard {shard}/{shards}: {len(rows)}", flush=True)
    ok = fail = 0; t0 = time.time()
    import parse
    for r in rows:
        sec, h = r["sec_uid"], r["handle"]
        try:
            raw = prov.fetch_profile(h)
            supa.record_spend("avatar", 0.001)
            u = raw.get("data", {}).get("userInfo", {}).get("user", {})
            url = u.get("avatarMedium") or u.get("avatarLarger") or u.get("avatarThumb")
            if not url:
                fail += 1; continue
            img = requests.get(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://www.tiktok.com/"}, timeout=20)
            if img.status_code != 200 or len(img.content) < 500:
                fail += 1; continue
            pub = upload(sec, to_jpeg(img.content))
            if pub:
                supa._patch("tt_creators", {"sec_uid": f"eq.{sec}"}, {"avatar_url": pub}); ok += 1
            else:
                fail += 1
        except (ProviderError, Exception):
            fail += 1
        if (ok + fail) % 100 == 0:
            supa.flush_spend(channel="avatar")
            print(f"[av s{shard}] {ok+fail}/{len(rows)} ok={ok} fail={fail} {(time.time()-t0)/60:.1f}m", flush=True)
    supa.flush_spend(channel="avatar")
    print(f"[av s{shard}] DONE ok={ok} fail={fail}", flush=True)


if __name__ == "__main__":
    main()
