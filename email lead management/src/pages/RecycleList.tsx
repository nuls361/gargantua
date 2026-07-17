import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { toCsv } from "../lib/csv";
import CreatorTable from "../components/CreatorTable";
import type { Creator } from "../lib/types";

const DAY_OPTIONS = [7, 14, 30, 60, 90];

const CREATOR_SELECT =
  "id, handle, tiktok_username, platform, email, region_label, label, sample_creator, status, filter_reason, enriched_at, enriched_payload, campaign_id, date_added, added_to_instantly_at";

export default function RecycleList() {
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState<Creator[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    // 1. Which creators are idle for >= `days` (server-side, ordered most-idle first).
    const { data: cand } = await supabase.rpc("recycle_candidates", { p_days: days });
    const ids = ((cand ?? []) as { id: string }[]).map((c) => c.id);
    if (ids.length === 0) {
      setRows([]);
      setLoading(false);
      return;
    }
    // 2. Fetch the full creator rows for the single lead table (chunked).
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));
    const fetched = (
      await Promise.all(
        chunks.map((ch) =>
          supabase.from("creators").select(CREATOR_SELECT).in("id", ch).then((r) => r.data ?? [])
        )
      )
    ).flat() as unknown as Creator[];
    // Preserve the RPC's most-idle-first ordering.
    const byId = new Map(fetched.map((c) => [c.id, c]));
    setRows(ids.map((id) => byId.get(id)).filter(Boolean) as Creator[]);
    setLoading(false);
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  function exportCsv() {
    if (rows.length === 0) return;
    const csv = toCsv(
      rows.map((r) => ({
        username: r.handle || r.tiktok_username || "",
        email: r.email ?? "",
      }))
    );
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `recycle-${days}d-${rows.length}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="toolbar">
        <Link to="/lists">← Lists</Link>
        <h2 style={{ margin: 0 }}>♻️ Recycle</h2>
        <span className="pill pill-new">dynamic</span>
      </div>

      <p className="muted">
        Active leads (in Instantly) that haven’t been mailed in the selected
        window — ready to recycle into a new campaign. The “Campaigns” and “Idle”
        columns show what each creator already received and how long they’ve been
        cold.
      </p>

      <div className="toolbar">
        <div>
          <label>Idle for at least</label>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {DAY_OPTIONS.map((d) => (
              <option key={d} value={d}>{d} days</option>
            ))}
          </select>
        </div>
        <div className="grow" />
        <span className="muted" style={{ fontSize: 12 }}>
          {loading ? "Loading…" : `${rows.length.toLocaleString("en-GB")} candidates`}
        </span>
        <button onClick={exportCsv} disabled={rows.length === 0}>
          Export CSV
        </button>
      </div>

      <CreatorTable
        creators={rows}
        loading={loading}
        emptyText="No creators to recycle in this window."
      />

      {rows.length >= 1000 && (
        <p className="muted" style={{ fontSize: 12 }}>
          Showing the first 1,000 (most idle first).
        </p>
      )}
    </div>
  );
}
