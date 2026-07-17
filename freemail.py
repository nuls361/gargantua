"""
Email classification — mirrors the lead tool's freemail allowlist
(email lead management/supabase/functions/_shared/freemail.ts) so our split is
identical to the tool's import filter. We do NOT discard anything here; we TAG:

  freemail   -> private address, directly reachable creator (cold-outreach target)
  management -> valid email on a custom/agency domain (managed creator; agency contact)
  none       -> no email
  invalid    -> malformed
"""
from __future__ import annotations

import re

FREEMAIL_ALLOWLIST = {
    # Global majors
    "gmail.com", "googlemail.com", "icloud.com", "icloud.de", "me.com", "mac.com",
    "outlook.com", "outlook.de", "outlook.fr", "outlook.co.uk",
    "hotmail.com", "hotmail.co.uk", "hotmail.de", "hotmail.fr", "hotmail.it", "hotmail.es",
    "live.com", "live.co.uk", "live.de", "live.fr", "live.at", "msn.com", "windowslive.com",
    "yahoo.com", "yahoo.co.uk", "yahoo.de", "yahoo.fr", "yahoo.it", "yahoo.es",
    "yahoo.com.tw", "ymail.com", "rocketmail.com", "myyahoo.com",
    "aol.com", "aol.co.uk", "aol.de",
    "proton.me", "protonmail.com", "pm.me",
    "tutanota.com", "tutanota.de", "tuta.io", "tutamail.com", "keemail.me",
    "fastmail.com", "hey.com", "mail.com", "email.com", "zoho.com", "zohomail.eu",
    "yandex.com", "mail.ru",
    # GMX / United Internet
    "gmx.com", "gmx.net", "gmx.de", "gmx.at", "gmx.ch", "gmx.eu", "gmx.co.uk", "gmx.fr", "mein.gmx",
    # United Kingdom
    "btinternet.com", "btopenworld.com", "btconnect.com", "talktalk.net", "talk21.com",
    "tiscali.co.uk", "sky.com", "virginmedia.com", "virgin.net", "blueyonder.co.uk",
    "ntlworld.com", "o2.co.uk", "plus.com", "plus.net", "wanadoo.co.uk", "orange.net",
    "freeserve.co.uk", "freeuk.com", "lineone.net", "supanet.com", "madasafish.com", "fsmail.net",
    # Germany
    "web.de", "t-online.de", "magenta.de", "freenet.de", "arcor.de", "online.de",
    "posteo.de", "posteo.net", "mailbox.org", "mail.de", "vodafone.de", "vodafonemail.de",
    "kabelmail.de", "unitybox.de", "gmx-topmail.de",
    # Austria
    "a1.net", "aon.at", "chello.at", "kabsi.at", "utanet.at", "liwest.at", "drei.at", "inode.at",
    # Switzerland
    "bluewin.ch", "hispeed.ch", "sunrise.ch", "green.ch", "quickline.ch", "bluemail.ch",
    "swissonline.ch", "mail.ch",
}

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def domain_of(email: str) -> str:
    at = email.rfind("@")
    return email[at + 1:].lower().strip() if at != -1 else ""


def classify_email(email: str | None) -> str:
    e = (email or "").strip()
    if not e:
        return "none"
    if not _EMAIL_RE.match(e):
        return "invalid"
    return "freemail" if domain_of(e) in FREEMAIL_ALLOWLIST else "management"
