// Types + dropdown option constants for the ClickAnalytic creator search.

export type SearchPlatform = "tiktok" | "instagram" | "youtube";
export type SearchGender = "any" | "female" | "male";

export interface SearchFilters {
  platform: SearchPlatform;
  location: string; // "" = any
  gender: SearchGender;
  lookalikeHandle: string;
  niche: string; // topic, "" = any
  followersMin: number | null;
  followersMax: number | null;
  avgViewsMin: number | null;
  avgViewsMax: number | null;
  engagementMin: number | null; // "≥ X%"
  ageMin: number | null;
  ageMax: number | null;
  emailValidOnly: boolean;
  activityDays: number | null; // 30 | 90 | null(any)
  postsMin: number | null; // 10 | 50 | 100 | 1000 | null(any)
}

export const DEFAULT_FILTERS: SearchFilters = {
  platform: "tiktok",
  location: "",
  gender: "any",
  lookalikeHandle: "",
  niche: "",
  followersMin: null,
  followersMax: null,
  avgViewsMin: null,
  avgViewsMax: null,
  engagementMin: null,
  ageMin: null,
  ageMax: null,
  emailValidOnly: false,
  activityDays: null,
  postsMin: null,
};

// Normalized result shape the UI renders. `raw` keeps the full API payload.
export interface SearchResult {
  id: string;
  handle: string; // without leading @
  displayName: string;
  platform: string;
  profileImage: string | null;
  profileUrl: string; // link to open the creator on their platform
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

export interface Option {
  value: number | null;
  label: string;
}

// Threshold steps shared by Followers + Avg. Views From/To dropdowns.
export const COUNT_STEPS: Option[] = [
  { value: 1_000, label: "1K" },
  { value: 5_000, label: "5K" },
  { value: 10_000, label: "10K" },
  { value: 25_000, label: "25K" },
  { value: 50_000, label: "50K" },
  { value: 100_000, label: "100K" },
  { value: 250_000, label: "250K" },
  { value: 500_000, label: "500K" },
  { value: 1_000_000, label: "1M" },
  { value: 5_000_000, label: "5M" },
  { value: 10_000_000, label: "10M" },
];

export const ENGAGEMENT_OPTIONS: Option[] = [
  { value: null, label: "Any" },
  { value: 1, label: "≥ 1%" },
  { value: 2, label: "≥ 2%" },
  { value: 3, label: "≥ 3%" },
  { value: 5, label: "≥ 5%" },
  { value: 8, label: "≥ 8%" },
  { value: 10, label: "≥ 10%" },
];

export const POSTS_OPTIONS: Option[] = [
  { value: null, label: "Any" },
  { value: 10, label: "10+" },
  { value: 50, label: "50+" },
  { value: 100, label: "100+" },
  { value: 1_000, label: "1,000+" },
];

export const ACTIVITY_OPTIONS: Option[] = [
  { value: null, label: "Any" },
  { value: 30, label: "Posted in the last 30 days" },
  { value: 90, label: "Posted in the last 3 months" },
];

// Ages 13–65 for the Creator Age From/To dropdowns.
export const AGE_OPTIONS: Option[] = Array.from({ length: 53 }, (_, i) => ({
  value: 13 + i,
  label: String(13 + i),
}));

export const GENDER_OPTIONS: { value: SearchGender; label: string }[] = [
  { value: "any", label: "Any" },
  { value: "female", label: "Female" },
  { value: "male", label: "Male" },
];

export const COUNTRY_OPTIONS: string[] = [
  "United Kingdom",
  "Germany",
  "Austria",
  "Switzerland",
  "France",
  "Netherlands",
  "Spain",
  "Italy",
  "United States",
];

export const NICHES: string[] = [
  "beauty",
  "skincare",
  "wellness",
  "fitness",
  "fashion",
  "food",
  "travel",
  "lifestyle",
  "gaming",
  "tech",
  "finance",
  "music",
  "comedy",
  "parenting",
  "home & interior",
  "sustainability",
];
