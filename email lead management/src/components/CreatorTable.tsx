import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { STATUS_LABELS, type Creator } from "../lib/types";

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

const dash = <span className="muted">—</span>;

interface Aggregate {
  count: number; // distinct campaigns received
  names: string[]; // campaign names
  daysIdle: number | null; // days since last send
}

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
// It self-enriches each creator with campaign history: how many campaigns they
// received and how many days since the last send ("idle").
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
  const [agg, setAgg] = useState<Map<string, Aggregate>>(new Map());
  const colSpan = selectable ? 11 : 10;

  const idsKey = useMemo(
    () => creators.map((c) => c.id).sort().join(","),
    [creators]
  );

  // Fetch campaign-send history for the visible creators and aggregate it.
  useEffect(() => {
    const ids = idsKey ? idsKey.split(",") : [];
    if (ids.length === 0) {
      setAgg(new Map());
      return;
    }
    let cancelled = false;
    void (async () => {
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));
      const rows = (
        await Promise.all(
          chunks.map((chunk) =>
            supabase
              .from("campaign_sends")
              .select("creator_id, campaign_id, sent_at, campaigns(name)")
              .in("creator_id", chunk)
              .then((r) => r.data ?? [])
          )
        )
      ).flat() as unknown as {
        creator_id: string;
        campaign_id: string | null;
        sent_at: string;
        campaigns: { name: string } | { name: string }[] | null;
      }[];

      const map = new Map<string, { campaignIds: Set<string>; names: Set<string>; last: number }>();
      for (const r of rows) {
        const e = map.get(r.creator_id) ?? { campaignIds: new Set(), names: new Set(), last: 0 };
        if (r.campaign_id) e.campaignIds.add(r.campaign_id);
        const camp = Array.isArray(r.campaigns) ? r.campaigns[0] : r.campaigns;
        if (camp?.name) e.names.add(camp.name);
        const t = new Date(r.sent_at).getTime();
        if (t > e.last) e.last = t;
        map.set(r.creator_id, e);
      }
      const now = Date.now();
      const out = new Map<string, Aggregate>();
      for (const [id, e] of map) {
        out.set(id, {
          count: e.campaignIds.size,
          names: [...e.names],
          daysIdle: e.last ? Math.floor((now - e.last) / 86_400_000) : null,
        });
      }
      if (!cancelled) setAgg(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [idsKey]);

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
        ...(agg.get(m.id)?.names ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [creators, query, agg]);

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
              <th>Sample creator</th>
              <th>Status</th>
              <th style={{ textAlign: "center" }}>Campaigns</th>
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
                const a = agg.get(m.id);
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
                      {m.sample_creator ? (
                        <a
                          href={profileUrl(m.platform, m.sample_creator)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {m.sample_creator.startsWith("@") ? m.sample_creator : `@${m.sample_creator}`}
                        </a>
                      ) : dash}
                    </td>
                    <td>
                      <span className={`pill pill-${m.status}`}>{STATUS_LABELS[m.status]}</span>
                    </td>
                    <td style={{ textAlign: "center" }}>
                      {a && a.count > 0 ? (
                        <span
                          className="pill pill-in_instantly"
                          title={a.names.join(", ")}
                          style={{ cursor: a.names.length ? "help" : "default" }}
                        >
                          {a.count}
                        </span>
                      ) : dash}
                    </td>
                    <td className="muted">{a?.daysIdle != null ? `${a.daysIdle}d` : "—"}</td>
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
