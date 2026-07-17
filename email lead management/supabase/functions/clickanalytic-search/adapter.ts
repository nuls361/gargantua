// Search adapter — Naht A. THE ONLY FILE THAT KNOWS THE BACKEND.
// ---------------------------------------------------------------------------
// Reworked off ClickAnalytic onto WePush's OWN index (tt_creators in Supabase,
// loaded from the Creator-DB pipeline). `searchIndex` maps the UI's SearchFilters
// onto a Postgres query over tt_creators and maps each row → SearchResult. The
// request/response contract is unchanged, so the whole Search UI is untouched.
//
// `mockSearch` is kept as a fallback (used until tt_creators has rows, or when
// SEARCH_MOCK=1). buildSearchRequest/normalizeResults (the old vendor path) are
// gone — the backend is now our DB, not an external API.
// ---------------------------------------------------------------------------

export interface SearchFilters {
  platform: "tiktok" | "instagram" | "youtube";
  location: string;
  gender: "any" | "female" | "male";
  lookalikeHandle: string;
  niche: string;
  followersMin: number | null;
  followersMax: number | null;
  avgViewsMin: number | null;
  avgViewsMax: number | null;
  engagementMin: number | null;
  ageMin: number | null;
  ageMax: number | null;
  emailValidOnly: boolean;
  activityDays: number | null;
  postsMin: number | null;
}

export interface SearchResult {
  id: string;
  handle: string;
  displayName: string;
  platform: string;
  profileImage: string | null;
  profileUrl: string;
  verified: boolean;
  primaryMarket: string | null;
  followers: number | null;
  engagementPct: number | null;
  engagedFollowers: number | null;
  avgViews: number | null;
  interests: string[];
  emailAvailable: boolean;
  postsTotal: number | null;
  postingFrequency90d: number | null;
  growthPct: number | null;
  qualityScore: number | null;
  femalePct: number | null;
  malePct: number | null;
  raw: unknown;
}

function profileUrlFor(platform: string, handle: string): string {
  const h = handle.replace(/^@/, "");
  if (platform === "instagram") return `https://www.instagram.com/${h}`;
  if (platform === "youtube") return `https://www.youtube.com/@${h}`;
  return `https://www.tiktok.com/@${h}`;
}

// ---------------------------------------------------------------------------
// REAL PATH — query WePush's own index (tt_creators) via the Supabase client.
// ---------------------------------------------------------------------------

const RESULT_LIMIT = 60;

// UI location label → the country codes our index stores (DACH + UK).
const COUNTRY_CODE: Record<string, string> = {
  "Germany": "DE",
  "Austria": "AT",
  "Switzerland": "CH",
  "United Kingdom": "GB",
};

// tt_creators is TikTok-only. Non-tiktok platforms have no owned data yet.
export function indexHasPlatform(filters: SearchFilters): boolean {
  return filters.platform === "tiktok";
}

export async function searchIndex(
  filters: SearchFilters,
  supabase: any
): Promise<SearchResult[]> {
  // Lookalike: no embeddings yet (Stage 5). Degrade to "same niche as the seed,
  // ranked by engagement" so the control still does something sensible.
  let seedCategory: string | null = null;
  const seed = filters.lookalikeHandle.trim().replace(/^@/, "");
  if (seed) {
    const { data: s } = await supabase
      .from("tt_creators")
      .select("category")
      .ilike("handle", seed)
      .limit(1)
      .maybeSingle();
    seedCategory = s?.category ?? null;
  }

  let q = supabase.from("tt_creators").select("*");

  const country = COUNTRY_CODE[filters.location];
  if (country) q = q.eq("country", country);

  const niche = seedCategory ?? (filters.niche.trim() || null);
  if (niche) q = q.eq("category", niche);

  if (filters.followersMin != null) q = q.gte("follower_count", filters.followersMin);
  if (filters.followersMax != null) q = q.lte("follower_count", filters.followersMax);
  if (filters.avgViewsMin != null) q = q.gte("avg_views", filters.avgViewsMin);
  if (filters.avgViewsMax != null) q = q.lte("avg_views", filters.avgViewsMax);
  if (filters.engagementMin != null) q = q.gte("engagement_median", filters.engagementMin);
  if (filters.postsMin != null) q = q.gte("video_count", filters.postsMin);
  if (filters.emailValidOnly) q = q.in("email_type", ["freemail", "management"]);
  if (filters.activityDays != null) {
    const since = new Date(Date.now() - filters.activityDays * 86_400_000).toISOString();
    q = q.gte("last_post_at", since);
  }
  // gender / age filters have no counterpart in the index yet — intentionally ignored.

  q = q.order(seedCategory ? "engagement_median" : "follower_count", { ascending: false })
       .limit(RESULT_LIMIT);

  const { data, error } = await q;
  if (error) throw new Error(`index query failed: ${error.message}`);
  return (data ?? []).map(rowToResult);
}

function rowToResult(r: any): SearchResult {
  const followers = r.follower_count ?? null;
  const er = r.engagement_median ?? null;
  const interests = [r.category, r.sub_niche, r.category_secondary]
    .filter((x: unknown): x is string => !!x)
    .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);
  return {
    id: r.sec_uid,
    handle: r.handle ?? "",
    displayName: r.display_name || r.handle || "",
    platform: "tiktok",
    profileImage: null, // avatar not captured in the index
    profileUrl: profileUrlFor("tiktok", r.handle ?? ""),
    verified: !!r.verified,
    primaryMarket: r.country ?? null,
    followers,
    engagementPct: er,
    engagedFollowers: followers != null && er != null ? Math.round(followers * (er / 100)) : null,
    avgViews: r.avg_views ?? null,
    interests,
    emailAvailable: !!r.email && r.email_type !== "none" && r.email_type !== "invalid",
    postsTotal: r.video_count ?? null,
    postingFrequency90d: r.posting_per_week ?? null,
    growthPct: null, // no growth snapshots (feature intentionally dropped)
    qualityScore: r.completeness != null ? Math.round(r.completeness * 100) : null,
    femalePct: null, // no audience demographics in the index
    malePct: null,
    raw: r,
  };
}

// Maps a single sample-shaped profile → SearchResult. Used by the mock path.
function toResult(p: any): SearchResult {
  const platform = p?.creator?.platform ?? "tiktok";
  const handle = (p?.creator?.handle ?? "").replace(/^@/, "");
  return {
    id: p?.creator?.id ?? crypto.randomUUID(),
    handle,
    displayName: p?.creator?.display_name ?? "",
    platform,
    profileImage:
      p?.creator?.profile_image_url ?? p?.creator?.avatar_url ?? null,
    profileUrl: profileUrlFor(platform, handle),
    verified: !!p?.creator?.verified,
    primaryMarket: p?.creator?.primary_market ?? null,
    followers: p?.audience?.followers ?? null,
    engagementPct: p?.performance?.engagement_rate_last_10_posts_pct ?? null,
    engagedFollowers: p?.audience?.engaged_followers ?? null,
    avgViews: p?.performance?.avg_views_last_10_posts ?? null,
    interests: p?.audience?.audience_interest_clusters ?? [],
    emailAvailable: !!p?.commercial?.public_email_available,
    postsTotal: p?.performance?.total_posts ?? null,
    postingFrequency90d: p?.performance?.posting_frequency_90d ?? null,
    growthPct: p?.performance?.six_month_growth_pct ?? null,
    qualityScore: p?.quality?.audience_quality_score ?? null,
    femalePct: p?.audience?.female_audience_pct ?? null,
    malePct: p?.audience?.male_audience_pct ?? null,
    raw: p,
  };
}

// ---------------------------------------------------------------------------
// MOCK — remove or ignore once the real path is wired.
// ---------------------------------------------------------------------------

const NICHE_SETS = [
  ["skincare", "beauty", "wellness"],
  ["fitness", "wellness", "nutrition"],
  ["fashion", "lifestyle", "beauty"],
  ["food", "cooking", "lifestyle"],
  ["travel", "lifestyle", "photography"],
  ["gaming", "tech", "esports"],
];
const MARKETS = ["United Kingdom", "Germany", "Austria", "Switzerland", "France"];
const FIRST = ["Amelie", "Mia", "Jonas", "Lena", "Oliver", "Sophie", "Ben", "Emma", "Noah", "Lea", "Finn", "Marie"];
const LAST = ["Durand", "Weber", "Bauer", "Klein", "Smith", "Jones", "Fischer", "Wagner", "Koch", "Meyer", "Hughes", "Braun"];

function rng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export function mockSearch(filters: SearchFilters): SearchResult[] {
  const seedStr = JSON.stringify(filters);
  let seed = 0;
  for (let i = 0; i < seedStr.length; i++) seed = (seed * 31 + seedStr.charCodeAt(i)) | 0;
  const rand = rng(Math.abs(seed) + 1);

  const fMin = filters.followersMin ?? 10_000;
  const fMax = filters.followersMax ?? 900_000;
  const eFloor = filters.engagementMin ?? 1;

  const out: SearchResult[] = [];
  for (let i = 0; i < 12; i++) {
    const niches =
      filters.niche && filters.niche.trim()
        ? [filters.niche.trim(), "lifestyle"]
        : NICHE_SETS[Math.floor(rand() * NICHE_SETS.length)];
    const followers = Math.round(fMin + rand() * Math.max(1, fMax - fMin));
    const engagement = +(eFloor + rand() * Math.max(0.5, 9 - eFloor)).toFixed(2);
    const female = Math.round(40 + rand() * 55);
    const emailAvailable = filters.emailValidOnly ? true : rand() > 0.35;
    const handle =
      (FIRST[Math.floor(rand() * FIRST.length)] +
        "." +
        LAST[Math.floor(rand() * LAST.length)]).toLowerCase();
    const market = filters.location || MARKETS[Math.floor(rand() * MARKETS.length)];

    const profile = {
      creator: {
        id: `${filters.platform}_${Math.floor(rand() * 1e10)}`,
        platform: filters.platform,
        handle: `@${handle}`,
        display_name: handle
          .split(".")
          .map((s) => s[0].toUpperCase() + s.slice(1))
          .join(" "),
        account_type: rand() > 0.5 ? "business" : "creator",
        primary_market: market,
        verified: rand() > 0.7,
        // Deterministic placeholder avatar per handle (real API supplies its own).
        profile_image_url: `https://i.pravatar.cc/100?u=${handle}`,
      },
      audience: {
        followers,
        engaged_followers: Math.round(followers * (engagement / 100)),
        female_audience_pct: female,
        male_audience_pct: 100 - female - 2,
        unclassified_audience_pct: 2,
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
        public_email_available: emailAvailable,
        brand_fit_categories: niches,
      },
      meta: { last_profile_refresh: "2026-04-18T14:22:31Z" },
    };
    out.push(toResult(profile));
  }

  // Honor the "min"/range dropdown filters so the mock feels real.
  return out
    .filter(
      (r) =>
        (filters.postsMin == null || (r.postsTotal ?? 0) >= filters.postsMin) &&
        (filters.avgViewsMin == null || (r.avgViews ?? 0) >= filters.avgViewsMin) &&
        (filters.avgViewsMax == null || (r.avgViews ?? 0) <= filters.avgViewsMax) &&
        (filters.engagementMin == null ||
          (r.engagementPct ?? 0) >= filters.engagementMin) &&
        (!filters.emailValidOnly || r.emailAvailable)
    )
    .sort((a, b) => (b.followers ?? 0) - (a.followers ?? 0));
}
