"""
Provider interface + TikHub implementation.

The whole Creator-DB strategy rests on renting the raw TikTok access and owning
everything above it. That rented layer WILL break, get pricier, or vanish -- so it
lives behind ONE interface. Swapping providers later = writing one new subclass,
not touching anything else. Stage 2+ imports this file unchanged.

Every valuable endpoint (posts, following) needs `secUid`, which only the profile
call returns. So one creator = at least two requests (the "secUid chain").
"""

from __future__ import annotations

import os
import time
from abc import ABC, abstractmethod

import requests


class Provider(ABC):
    """The only surface the rest of the system is allowed to depend on."""

    @abstractmethod
    def fetch_profile(self, handle: str) -> dict:
        """Handle -> raw profile JSON (must contain secUid + follower stats)."""

    @abstractmethod
    def search_users(self, keyword: str) -> dict:
        """Keyword -> raw search JSON. THE make-or-break discovery endpoint."""

    @abstractmethod
    def fetch_posts(self, sec_uid: str, count: int = 30) -> dict:
        """secUid -> raw posts JSON (captions, hashtags, sounds, stats, @-mentions)."""

    @abstractmethod
    def fetch_following(self, sec_uid: str, count: int = 30) -> dict:
        """secUid -> raw following JSON. The free public nano-creator channel."""


class ProviderError(RuntimeError):
    pass


class TikHubProvider(Provider):
    """
    TikHub TikTok *Web* API. Pay-as-you-go, ~$0.001/request, no minimum.
    Endpoint paths + param names live HERE and nowhere else -- if TikHub renames
    something, this is the only block that changes. Confirmed against
    https://api.tikhub.io/openapi.json on 2026-07-15.
    """

    BASE = "https://api.tikhub.io"
    EP_PROFILE = "/api/v1/tiktok/web/fetch_user_profile"
    # Posts: the WEB endpoint (fetch_user_post) is unreliable -- returns HTTP 400
    # ~always in practice. The APP v3 endpoint is the one that actually works
    # (needs account balance). Classic "swap the endpoint behind the interface".
    EP_POSTS = "/api/v1/tiktok/app/v3/fetch_user_post_videos"
    EP_POSTS_WEB = "/api/v1/tiktok/web/fetch_user_post"  # kept for reference; flaky
    EP_SEARCH = "/api/v1/tiktok/web/fetch_search_user"
    EP_FOLLOWING = "/api/v1/tiktok/web/fetch_user_follow"
    # Hashtag discovery (the productive channel): tag name -> challengeID -> videos.
    EP_TAG_DETAIL = "/api/v1/tiktok/web/fetch_tag_detail"
    EP_TAG_POST = "/api/v1/tiktok/web/fetch_tag_post"
    # Brand-repost discovery: a brand's secUid -> videos it reposted. Each reposted
    # video's author is a creator the BRAND itself amplified (pre-vetted UGC partner).
    EP_REPOST = "/api/v1/tiktok/web/fetch_user_repost"
    # Post comments -> used to VERIFY audience language (German comments = DACH audience),
    # a second DACH signal beyond the caption. Commenter follower stats are NOT inline.
    EP_COMMENTS = "/api/v1/tiktok/app/v3/fetch_video_comments"
    # Sound discovery: a music_id -> videos using that sound. Each video's author is a
    # creator riding that trend. Resolve a sound name/URL to a music_id first.
    EP_MUSIC_SEARCH = "/api/v1/tiktok/app/v3/fetch_music_search_result"
    EP_MUSIC_VIDEOS = "/api/v1/tiktok/app/v3/fetch_music_video_list"
    EP_MUSIC_DETAIL = "/api/v1/tiktok/app/v3/fetch_music_detail"

    def __init__(self, api_key: str | None = None, timeout: int = 30):
        self.api_key = api_key or os.environ.get("TIKHUB_API_KEY")
        if not self.api_key:
            raise ProviderError(
                "TIKHUB_API_KEY not set. Get a free trial key at https://tikhub.io "
                "then:  export TIKHUB_API_KEY=your_key"
            )
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Authorization": f"Bearer {self.api_key}",
                "Accept": "application/json",
                "User-Agent": "creator-db-validate/0.1",
            }
        )

    # TikHub is flaky by design of the underlying scrape: transient 400s and
    # 429/5xx are normal and NOT charged, so we retry them. It also returns
    # HTTP 200 with an ERROR ENVELOPE ({"code": 400, "message": ...}) -- that must
    # be rejected, never handed to the parser, or it fabricates believable garbage
    # (the doc's "silent decay"). This is the trust boundary of the whole system.
    MAX_RETRIES = 4

    def _get(self, path: str, params: dict) -> dict:
        params = {k: v for k, v in params.items() if v is not None}
        last = "unknown error"
        for attempt in range(self.MAX_RETRIES):
            try:
                r = self.session.get(self.BASE + path, params=params, timeout=self.timeout)
            except requests.RequestException as e:
                last = f"network error: {e}"
                time.sleep(1.5 * (attempt + 1))
                continue
            if r.status_code == 401:
                raise ProviderError("401 Unauthorized -- check TIKHUB_API_KEY.")
            if r.status_code in (400, 429) or 500 <= r.status_code < 600:
                last = f"HTTP {r.status_code}: {r.text[:160]}"
                time.sleep(1.5 * (attempt + 1))
                continue
            if not r.ok:
                raise ProviderError(f"{r.status_code} from {path}: {r.text[:300]}")
            try:
                body = r.json()
            except ValueError as e:
                raise ProviderError(f"non-JSON from {path}: {r.text[:200]}") from e
            # Reject TikHub's HTTP-200 error envelope. Success code is 200.
            code = body.get("code") if isinstance(body, dict) else None
            if code not in (None, 200, 0):
                msg = body.get("message") or body.get("detail") or body
                last = f"envelope code {code}: {str(msg)[:160]}"
                time.sleep(1.5 * (attempt + 1))
                continue
            return body
        raise ProviderError(f"{path} failed after {self.MAX_RETRIES} tries -- {last}")

    def fetch_profile(self, handle: str) -> dict:
        return self._get(self.EP_PROFILE, {"uniqueId": handle.lstrip("@")})

    def fetch_posts(self, sec_uid: str, count: int = 30, max_cursor: int = 0) -> dict:
        # App v3 uses sec_user_id + max_cursor pagination; response carries the
        # next max_cursor and has_more.
        return self._get(
            self.EP_POSTS,
            {"sec_user_id": sec_uid, "count": count, "max_cursor": max_cursor},
        )

    def search_users(self, keyword: str) -> dict:
        return self._get(self.EP_SEARCH, {"keyword": keyword, "cursor": 0})

    def fetch_following(self, sec_uid: str, count: int = 30) -> dict:
        return self._get(self.EP_FOLLOWING, {"secUid": sec_uid, "count": count})

    def account(self) -> dict:
        """Balance + free_credit. A near-zero total is why calls start 400/402'ing."""
        return self._get("/api/v1/tikhub/user/get_user_info", {}).get("user_data", {})

    def fetch_tag_detail(self, tag_name: str) -> dict:
        """Hashtag name -> tag detail (contains challengeID)."""
        return self._get(self.EP_TAG_DETAIL, {"tag_name": tag_name})

    def fetch_tag_post(self, challenge_id: str, cursor: int = 0, count: int = 30) -> dict:
        """challengeID -> videos using that hashtag (each carries its author)."""
        return self._get(self.EP_TAG_POST,
                         {"challengeID": challenge_id, "count": count, "cursor": cursor})

    def fetch_user_repost(self, sec_uid: str, cursor: int = 0, count: int = 30) -> dict:
        """secUid -> videos this user reposted (each carries its ORIGINAL author).
        For a brand handle, the reposted authors are creators the brand amplified."""
        return self._get(self.EP_REPOST,
                         {"secUid": sec_uid, "count": count, "cursor": cursor})

    def fetch_video_comments(self, aweme_id: str, cursor: int = 0, count: int = 30) -> dict:
        """aweme_id -> comments (text + likes + commenter). Used to verify audience
        language: a mostly-German comment section = DACH audience, even if the caption
        is English (common for bigger creators)."""
        return self._get(self.EP_COMMENTS,
                         {"aweme_id": aweme_id, "count": count, "cursor": cursor})

    def fetch_music_search(self, keyword: str, offset: int = 0, count: int = 20) -> dict:
        """Keyword -> matching sounds. Used to resolve a sound name to a music_id."""
        return self._get(self.EP_MUSIC_SEARCH,
                         {"keyword": keyword, "offset": offset, "count": count})

    def fetch_music_video_list(self, music_id: str, cursor: int = 0, count: int = 30) -> dict:
        """music_id -> videos using that sound (each carries its author = a creator
        riding the trend). The sound-channel's core call."""
        return self._get(self.EP_MUSIC_VIDEOS,
                         {"music_id": music_id, "count": count, "cursor": cursor})

    def fetch_music_detail(self, music_id: str) -> dict:
        """music_id -> sound metadata (title, author, play count)."""
        return self._get(self.EP_MUSIC_DETAIL, {"music_id": music_id})
