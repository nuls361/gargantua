// ClickAnalytic ENRICHMENT adapter — THE ONLY FILE TO CHANGE WHEN GOING LIVE.
// ---------------------------------------------------------------------------
// Enrichment turns a sourced handle into a full creator profile + a contact
// email. Until the real API is connected, `mockEnrich` returns sample-shaped
// JSON and a generated email (mostly freemail, some agency/blocked/none) so the
// enrich → clean → Filtered flow is fully exercised.
//
// TO GO LIVE: set CLICKANALYTIC_API_KEY, fill buildEnrichRequest +
// normalizeEnrichment below, redeploy. Nothing else changes.
// ---------------------------------------------------------------------------

export interface SourcedCreator {
  id: string;
  handle: string;
  platform: string;
  tiktok_username: string | null;
}

export interface Enrichment {
  email: string | null;
  payload: unknown; // full creator JSON (stored verbatim in enriched_payload)
}

const CLICKANALYTIC_ENRICH_URL = "https://api.clickanalytic.com/v1/enrich"; // TODO: confirm

export function buildEnrichRequest(
  handle: string,
  platform: string,
  apiKey: string
): { url: string; init: RequestInit } {
  // TODO(go-live): use ClickAnalytic's enrichment endpoint + params.
  return {
    url: CLICKANALYTIC_ENRICH_URL,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ handle, platform }),
    },
  };
}

export function normalizeEnrichment(apiJson: any): Enrichment {
  // TODO(go-live): map the real response. Email location TBD — try common paths.
  const email =
    apiJson?.commercial?.public_email ??
    apiJson?.contact?.email ??
    apiJson?.email ??
    null;
  return { email, payload: apiJson };
}

// ---------------------------------------------------------------------------
// MOCK
// ---------------------------------------------------------------------------

const FREEMAIL = ["gmail.com", "web.de", "gmx.de", "icloud.com", "yahoo.co.uk", "outlook.com", "hotmail.com", "t-online.de"];
const AGENCY = ["mediacreators.com", "talenthouse.co", "creatoragency.de", "influence.io"]; // custom, not freemail
const BLOCKED = ["flairmgmt.com", "hushmanagement.co.uk", "lyntheagency.de"]; // in blocked_domains seed
const NICHE_SETS = [
  ["skincare", "beauty", "wellness"],
  ["fitness", "wellness", "nutrition"],
  ["fashion", "lifestyle", "beauty"],
  ["food", "cooking", "lifestyle"],
];

function seedFrom(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) + 1;
}
function rng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export function mockEnrich(c: SourcedCreator): Enrichment {
  const handle = (c.handle || c.tiktok_username || "creator").replace(/^@/, "");
  const rand = rng(seedFrom(handle));
  const local = handle.replace(/[^a-z0-9]/gi, "").toLowerCase() || "creator";

  // Distribution: 70% freemail (pass), 15% agency, 10% blocked, 5% no email.
  const r = rand();
  let email: string | null;
  if (r < 0.7) email = `${local}@${FREEMAIL[Math.floor(rand() * FREEMAIL.length)]}`;
  else if (r < 0.85) email = `${local}@${AGENCY[Math.floor(rand() * AGENCY.length)]}`;
  else if (r < 0.95) email = `hello@${BLOCKED[Math.floor(rand() * BLOCKED.length)]}`;
  else email = null;

  const followers = Math.round(10_000 + rand() * 800_000);
  const engagement = +(1 + rand() * 8).toFixed(2);
  const niches = NICHE_SETS[Math.floor(rand() * NICHE_SETS.length)];
  const female = Math.round(40 + rand() * 55);

  const payload = {
    creator: {
      id: `${c.platform}_${Math.floor(rand() * 1e10)}`,
      platform: c.platform,
      handle: `@${handle}`,
      display_name: handle
        .split(/[._]/)
        .map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s))
        .join(" "),
      account_type: rand() > 0.5 ? "business" : "creator",
      profile_image_url: `https://i.pravatar.cc/100?u=${handle}`,
    },
    audience: {
      followers,
      female_audience_pct: female,
      male_audience_pct: 100 - female - 2,
      top_age_ranges: ["25-34", "18-24", "35-44"],
      audience_interest_clusters: niches,
    },
    performance: {
      avg_views_last_10_posts: Math.round(followers * (0.1 + rand() * 0.4)),
      engagement_rate_last_10_posts_pct: engagement,
      posting_frequency_90d: Math.round(6 + rand() * 40),
      total_posts: Math.round(80 + rand() * 3000),
      six_month_growth_pct: +(rand() * 25 - 3).toFixed(1),
    },
    quality: {
      audience_quality_score: Math.round(60 + rand() * 39),
      estimated_fake_follower_share_pct: Math.round(rand() * 20),
    },
    commercial: {
      public_email_available: !!email,
      public_email: email,
      brand_fit_categories: niches,
    },
    meta: { last_profile_refresh: "2026-04-18T14:22:31Z" },
  };

  return { email, payload };
}
