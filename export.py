#!/usr/bin/env python3
"""Export the index to CSV so it opens in Numbers/Excel. Read-only, no API calls.
Creators get two computed columns: tiktok_url and email_type (freemail/management/none)."""
import csv
import sqlite3
from collections import Counter

from freemail import classify_email

DB = "creatordb.sqlite"


def tiktok_url(handle):
    return f"https://www.tiktok.com/@{handle}" if handle else ""


def dump_creators(conn, path):
    cur = conn.execute("SELECT * FROM creators ORDER BY follower_count DESC")
    cols = [d[0] for d in cur.description]
    rows = cur.fetchall()
    out_cols = ["tiktok_url", "email_type"] + cols   # computed columns first
    split = Counter()
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(out_cols)
        for r in rows:
            etype = classify_email(r["email"])
            split[etype] += 1
            w.writerow([tiktok_url(r["handle"]), etype] + [r[c] for c in cols])
    print(f"  {path:16s} {len(rows):>5} rows")
    print(f"    email split: " + " · ".join(f"{k}={v}" for k, v in split.most_common()))


def dump_posts(conn, path):
    cur = conn.execute("SELECT * FROM posts ORDER BY play DESC")
    cols = [d[0] for d in cur.description]
    rows = cur.fetchall()
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for r in rows:
            w.writerow([r[c] for c in cols])
    print(f"  {path:16s} {len(rows):>5} rows")


def main():
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    print("exported:")
    dump_creators(c, "creators.csv")
    dump_posts(c, "posts.csv")


if __name__ == "__main__":
    main()
