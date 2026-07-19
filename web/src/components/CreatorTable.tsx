import { useMemo, useState } from "react";
import { STATUS_LABELS, CONTACT_STATE, contactState, type Creator } from "../lib/types";

// Link to a creator's profile on their platform.
export function profileUrl(platform: string | null, handle: string): string {
  const h = handle.replace(/^@/, "");
  if (platform === "instagram") return `https://www.instagram.com/${h}`;
  if (platform === "youtube") return `https://www.youtube.com/@${h}`;
  return `https://www.tiktok.com/@${h}`;
}

// Human-readable text for why a lead was filtered out.
export const FILTER_REASON_LABELS: Record<string, string> = {
  not_freemail: "Not a private (freemail) address",
  blocked_domain: "Blocked agency/management domain",
  duplicate: "Duplicate email (already in DB)",
  no_email: "No email found",
  invalid_email: "Invalid email format",
};

// Creator's location comes from the enriched profile (primary market).
export function creatorLocation(payload: unknown): string | null {
  const p = payload as { creator?: { primary_market?: string } } | null;
  return p?.creator?.primary_market ?? null;
}

// Contact-state pill — the axis-2 signal, shown on every lead everywhere.
export function ContactPill({ c }: { c: Creator }) {
  const st = contactState(c);
  const m = CONTACT_STATE[st];
  const when = c.last_contacted_at
    ? `last contacted ${new Date(c.last_contacted_at).toLocaleDateString("en-GB")}`
    : "never contacted";
  const free =
    st === "cooldown" && c.next_eligible_at
      ? ` · free from ${new Date(c.next_eligible_at).toLocaleDateString("en-GB")}`
      : "";
  return (
    <span className={`pill ${m.cls}`} title={`${m.label} — ${when}${free}`}>
      {m.emoji} {m.label}
    </span>
  );
}

const dash = <span className="muted">—</span>;

interface Props {
  creators: Creator[];
  emptyText?: string;
  loading?: boolean;
  searchable?: boolean;
  selectable?: boolean;
  selectedIds?: Set<string>;
  allSelected?: boolean;
  onToggle?: (id: string) => void;
  onToggleAll?: () => void;
}

// The single lead table used everywhere (lists, leads, campaigns, recycle).
// Contact-state + contact count come straight off the (denormalized) creator row,
// so the table no longer fans out a per-load query into campaign_sends.
export default function CreatorTable({
  creators,
  emptyText = "No creators.",
  loading = false,
  searchable = true,
  selectable = false,
  selectedIds,
  allSelected = false,
  onToggle,
  onToggleAll,
}: Props) {
  const [query, setQuery] = useState("");
  const colSpan = selectable ? 11 : 10;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return creators;
    return creators.filter((m) => {
      const hay = [
        m.handle,
        m.tiktok_username,
        m.email,
        m.label,
        m.sample_creator,
        m.region_label,
        creatorLocation(m.enriched_payload),
        STATUS_LABELS[m.status],
        m.filter_reason,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [creators, query]);

  const idle = (c: Creator) =>
    c.last_contacted_at
      ? `${Math.floor((Date.now() - new Date(c.last_contacted_at).getTime()) / 86_400_000)}d`
      : "—";

  return (
    <>
      {searchable && (
        <div className="toolbar" style={{ marginBottom: 8 }}>
          <input
            type="search"
            placeholder="Search this list…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ minWidth: 240 }}
          />
          {query.trim() && (
            <span className="muted" style={{ fontSize: 12 }}>
              {filtered.length} of {creators.length} match
            </span>
          )}
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {selectable && (
                <th style={{ width: 30 }}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={onToggleAll}
                    aria-label="Select all"
                  />
                </th>
              )}
              <th>Handle</th>
              <th>Email</th>
              <th>Location</th>
              <th>Label</th>
              <th>Pipeline</th>
              <th>Contact</th>
              <th style={{ textAlign: "center" }}>×</th>
              <th>Idle</th>
              <th>Filter reason</th>
              <th>Enriched</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={colSpan} className="center-loading">Loading…</td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={colSpan} className="center-loading">
                  {query.trim() ? "No creators match your search." : emptyText}
                </td>
              </tr>
            ) : (
              filtered.map((m) => {
                const handle = m.handle || m.tiktok_username;
                return (
                  <tr key={m.id}>
                    {selectable && (
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedIds?.has(m.id) ?? false}
                          onChange={() => onToggle?.(m.id)}
                        />
                      </td>
                    )}
                    <td>
                      {handle ? (
                        <a href={profileUrl(m.platform, handle)} target="_blank" rel="noreferrer">
                          @{handle.replace(/^@/, "")}
                        </a>
                      ) : dash}
                    </td>
                    <td>{m.email || dash}</td>
                    <td>
                      {creatorLocation(m.enriched_payload) ??
                        m.region_label?.toUpperCase() ?? dash}
                    </td>
                    <td>{m.label || dash}</td>
                    <td>
                      <span className={`pill pill-${m.status}`}>{STATUS_LABELS[m.status]}</span>
                    </td>
                    <td><ContactPill c={m} /></td>
                    <td style={{ textAlign: "center" }} className="num">
                      {m.contact_count > 0 ? m.contact_count : dash}
                    </td>
                    <td className="muted">{idle(m)}</td>
                    <td className="muted">
                      {m.filter_reason
                        ? FILTER_REASON_LABELS[m.filter_reason] ?? m.filter_reason
                        : "—"}
                    </td>
                    <td>
                      {m.enriched_at
                        ? new Date(m.enriched_at).toLocaleDateString("en-GB")
                        : "—"}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
