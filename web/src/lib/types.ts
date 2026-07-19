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

export type ListKind = "working" | "legacy" | "filtered" | "recycle";

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
  // Reach signals carried over from the harvest base (null on older imported rows).
  follower_count?: number | null;
  engagement_median?: number | null;
  category?: string | null;
  filter_reason: string | null;
  enriched_at: string | null;
  enriched_payload: unknown;
  date_added: string;
  added_to_instantly_at: string | null;
  campaigns?: { name: string } | null;
  // Axis 2 — contact-state (denormalized from campaign_sends + webhook outcomes)
  first_contacted_at: string | null;
  last_contacted_at: string | null;
  contact_count: number;
  last_outcome: string | null; // sent | replied | bounced | unsubscribed | null
  next_eligible_at: string | null;
  do_not_contact: boolean;
}

// ---- Axis 2: contact-state -------------------------------------------------
// The one thing every view shows at a glance: have we talked to this person, and
// may we talk to them now? Mirrors the SQL contact_state() function 1:1.
export type ContactState =
  | "never" | "cooldown" | "contacted" | "replied" | "bounced" | "dnc";

export const CONTACT_STATE: Record<ContactState, { label: string; emoji: string; cls: string }> = {
  never:     { label: "Never",      emoji: "🟢", cls: "cs-never" },
  cooldown:  { label: "Cooldown",   emoji: "⏳", cls: "cs-cooldown" },
  contacted: { label: "Ready",      emoji: "🟡", cls: "cs-contacted" },
  replied:   { label: "Replied",    emoji: "✅", cls: "cs-replied" },
  bounced:   { label: "Bounced",    emoji: "❌", cls: "cs-bounced" },
  dnc:       { label: "DNC",        emoji: "⛔", cls: "cs-dnc" },
};

export function contactState(c: {
  last_outcome?: string | null;
  do_not_contact?: boolean | null;
  next_eligible_at?: string | null;
  contact_count?: number | null;
}): ContactState {
  if (c.do_not_contact || c.last_outcome === "unsubscribed") return "dnc";
  if (c.last_outcome === "bounced") return "bounced";
  if (c.last_outcome === "replied") return "replied";
  if (!c.contact_count) return "never";
  if (c.next_eligible_at && new Date(c.next_eligible_at).getTime() > Date.now()) return "cooldown";
  return "contacted";
}

// ---- Axis 1: pipeline (where a lead is on the way to outreach) -------------
export type PipelineStage = "roh" | "angereichert" | "ausgespielt" | "aussortiert";

export const PIPELINE: Record<PipelineStage, { label: string; cls: string }> = {
  roh:          { label: "Raw",          cls: "pl-roh" },
  angereichert: { label: "Enriched",     cls: "pl-angereichert" },
  ausgespielt:  { label: "Sent",         cls: "pl-ausgespielt" },
  aussortiert:  { label: "Filtered",     cls: "pl-aussortiert" },
};

// The pipeline axis is derived from the (legacy, overloaded) status. Contact
// outcomes (replied/bounced/do_not_contact) mean the lead WAS played out — that's
// pipeline-complete; the outcome itself lives on the contact-state axis.
export function pipelineStage(status: LeadStatus): PipelineStage {
  switch (status) {
    case "sourced":
    case "new":
      return "roh";
    case "enriched":
    case "queued":
      return "angereichert";
    case "filtered":
      return "aussortiert";
    default:
      return "ausgespielt"; // in_instantly, replied, bounced, do_not_contact
  }
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
