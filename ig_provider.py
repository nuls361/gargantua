"""
Instagram provider — thin wrapper around TikHub's Instagram endpoints, mirroring
provider.TikHubProvider (same key, same retry discipline). Only the calls the brand→
creator discovery needs; more endpoints plug in as required.

Discovery flow (mirrors the TikTok brand/repost channel):
    fetch_user_info(brand)  -> user_id
    fetch_tagged_posts(id)  -> creators who tagged the brand   (= the repost feed on IG)
    fetch_user_info(creator)-> followers / bio / email
    fetch_reels(id)         -> engagement rate
"""
from __future__ import annotations

import os
import time

import requests

from provider import ProviderError   # reuse the same error type


class IGProvider:
    BASE = "https://api.tikhub.io"
    EP_USER = "/api/v1/instagram/v1/fetch_user_info_by_username_v2"
    EP_TAGGED = "/api/v1/instagram/v1/fetch_user_tagged_posts"
    EP_POSTS = "/api/v1/instagram/v1/fetch_user_posts"
    EP_REELS = "/api/v1/instagram/v1/fetch_user_reels"
    EP_HASHTAG = "/api/v1/instagram/v1/fetch_hashtag_posts"
    MAX_RETRIES = 4

    def __init__(self, api_key: str | None = None, timeout: int = 40, meter=None):
        self.api_key = api_key or os.environ.get("TIKHUB_API_KEY")
        if not self.api_key:
            raise ProviderError("TIKHUB_API_KEY not set")
        self.timeout = timeout
        self.meter = meter          # called once per charged call (for the budget ledger)
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "application/json",
            "User-Agent": "creator-db-ig/0.1",
        })

    def _get(self, path: str, params: dict) -> dict:
        params = {k: v for k, v in params.items() if v is not None}
        last = "unknown error"
        for attempt in range(self.MAX_RETRIES):
            try:
                r = self.session.get(self.BASE + path, params=params, timeout=self.timeout)
            except requests.RequestException as e:
                last = f"network: {e}"; time.sleep(1.5 * (attempt + 1)); continue
            if r.status_code == 401:
                raise ProviderError("401 Unauthorized -- check TIKHUB_API_KEY.")
            if r.status_code in (400, 429) or 500 <= r.status_code < 600:
                last = f"HTTP {r.status_code}: {r.text[:120]}"; time.sleep(1.5 * (attempt + 1)); continue
            if not r.ok:
                raise ProviderError(f"{r.status_code} from {path}: {r.text[:200]}")
            try:
                body = r.json()
            except ValueError as e:
                raise ProviderError(f"non-JSON from {path}: {r.text[:150]}") from e
            code = body.get("code") if isinstance(body, dict) else None
            if code not in (None, 200, 0):
                last = f"envelope {code}: {str(body.get('message'))[:120]}"; time.sleep(1.5 * (attempt + 1)); continue
            if self.meter:
                self.meter()
            return body
        raise ProviderError(f"{path} failed after {self.MAX_RETRIES} tries -- {last}")

    def fetch_user_info(self, username: str) -> dict:
        return self._get(self.EP_USER, {"username": username.lstrip("@")}).get("data", {})

    def fetch_tagged_posts(self, user_id: str, count: int = 30, cursor: str | None = None) -> dict:
        return self._get(self.EP_TAGGED, {"user_id": user_id, "count": count, "end_cursor": cursor}).get("data", {})

    def fetch_user_posts(self, user_id: str, count: int = 12, cursor: str | None = None) -> dict:
        return self._get(self.EP_POSTS, {"user_id": user_id, "count": count, "end_cursor": cursor}).get("data", {})

    def fetch_reels(self, user_id: str, count: int = 12, cursor: str | None = None) -> dict:
        return self._get(self.EP_REELS, {"user_id": user_id, "count": count, "end_cursor": cursor}).get("data", {})

    def fetch_hashtag_posts(self, hashtag: str, count: int = 30, cursor: str | None = None) -> dict:
        return self._get(self.EP_HASHTAG, {"name": hashtag.lstrip("#"), "count": count, "end_cursor": cursor}).get("data", {})

    def account_ok(self) -> bool:
        try:
            self.fetch_user_info("instagram")
            return True
        except ProviderError:
            return False
