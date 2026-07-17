export type Region = "uk" | "dach";

export type LeadStatus =
  | "new"
  | "queued"
  | "in_instantly"
  | "replied"
  | "bounced"
  | "do_not_contact"
  | "sourced"
  | "enriched"
  | "filtered";

export type ListKind = "working" | "legacy" | "filtered";

export interface List {
  id: string;
  name: string;
  kind: ListKind;
  created_at: string;
}

export interface ImportBatch {
  id: string;
  file_name: string | null;
  region_label: Region | null;
  label: string | null;
  sample_creator: string | null;
  list_id: string | null;
  total_rows: number;
  kept: number;
  inserted: number;
  updated: number;
  skipped_duplicates: number;
  removed_breakdown: Record<string, number> | null;
  uploaded_by: string | null;
  created_at: string;
}

export interface Campaign {
  id: string;
  name: string;
  instantly_campaign_id: string | null;
  instantly_status: number | null;
  synced_at: string | null;
  created_at: string;
}

// Instantly campaign status codes → readable labels (best-effort mapping).
export const INSTANTLY_STATUS_LABELS: Record<number, string> = {
  0: "Draft",
  1: "Active",
  2: "Paused",
  3: "Completed",
  4: "Subsequences",
};

export interface Creator {
  id: string;
  email: string;
  email_normalized: string;
  tiktok_username: string | null;
  handle: string | null;
  platform: string | null;
  region_label: Region | null;
  label: string | null;
  sample_creator: string | null;
  source_file: string | null;
  status: LeadStatus;
  list_id: string | null;
  campaign_id: string | null;
  filter_reason: string | null;
  enriched_at: string | null;
  enriched_payload: unknown;
  date_added: string;
  added_to_instantly_at: string | null;
  campaigns?: { name: string } | null;
}

export const STATUS_LABELS: Record<LeadStatus, string> = {
  new: "New",
  queued: "Queued",
  in_instantly: "In Instantly",
  replied: "Replied",
  bounced: "Bounced",
  do_not_contact: "Do not contact",
  sourced: "Sourced",
  enriched: "Enriched",
  filtered: "Filtered",
};
