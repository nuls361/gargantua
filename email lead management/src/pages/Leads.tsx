import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { toCsv } from "../lib/csv";
import CreatorTable from "../components/CreatorTable";
import {
  STATUS_LABELS,
  type Campaign,
  type Creator,
  type LeadStatus,
  type Region,
} from "../lib/types";

const PAGE_SIZE = 500;

export default function Leads() {
  const [rows, setRows] = useState<Creator[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // filters
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<LeadStatus | "">("");
  const [regionFilter, setRegionFilter] = useState<Region | "">("");
  const [campaignFilter, setCampaignFilter] = useState<string>("");
  const [labelFilter, setLabelFilter] = useState<string>("");

  // selection
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignCampaign, setAssignCampaign] = useState<string>("");
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    let q = supabase
      .from("creators")
      .select(
        "id, email, email_normalized, tiktok_username, handle, platform, region_label, label, sample_creator, source_file, status, filter_reason, enriched_at, enriched_payload, campaign_id, date_added, added_to_instantly_at, campaigns(name)"
      )
      .order("date_added", { ascending: false })
      .limit(PAGE_SIZE);

    if (statusFilter) q = q.eq("status", statusFilter);
    if (regionFilter) q = q.eq("region_label", regionFilter);
    if (campaignFilter) q = q.eq("campaign_id", campaignFilter);
    if (labelFilter.trim()) q = q.ilike("label", `%${labelFilter.trim()}%`);
    if (search.trim()) {
      const term = `%${search.trim()}%`;
      q = q.or(`tiktok_username.ilike.${term},handle.ilike.${term},email.ilike.${term}`);
    }

    const { data, error: err } = await q;
    if (err) {
      setError(err.message);
      setRows([]);
    } else {
      setRows((data ?? []) as unknown as Creator[]);
      // prune selection to still-visible rows
      setSelected((prev) => {
        const visible = new Set((data ?? []).map((r) => r.id));
        return new Set([...prev].filter((id) => visible.has(id)));
      });
    }
    setLoading(false);
  }, [search, statusFilter, regionFilter, campaignFilter, labelFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    supabase
      .from("campaigns")
      .select("*")
      .order("name")
      .then(({ data }) => setCampaigns((data ?? []) as Campaign[]));
  }, []);

  const selectedRows = useMemo(
    () => rows.filter((r) => selected.has(r.id)),
    [rows, selected]
  );

  const allVisibleSelected =
    rows.length > 0 && rows.every((r) => selected.has(r.id));

  function toggleAll() {
    setSelected(allVisibleSelected ? new Set() : new Set(rows.map((r) => r.id)));
  }
  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function flash(msg: string) {
    setNotice(msg);
    setError(null);
    setTimeout(() => setNotice(null), 6000);
  }

  // --- Actions ---

  async function assignToCampaign() {
    if (!assignCampaign || selectedRows.length === 0) return;
    // Only leads in status new/queued may be (re)assigned.
    const eligible = selectedRows.filter(
      (r) => r.status === "new" || r.status === "queued"
    );
    if (eligible.length === 0) {
      setError(
        "None of the selected leads is in status New/Queued. Only those can be assigned."
      );
      return;
    }
    setWorking(true);
    setError(null);
    const { error: err } = await supabase
      .from("creators")
      .update({ campaign_id: assignCampaign, status: "queued" })
      .in(
        "id",
        eligible.map((r) => r.id)
      );
    setWorking(false);
    if (err) {
      setError(err.message);
      return;
    }
    const skipped = selectedRows.length - eligible.length;
    flash(
      `${eligible.length} leads assigned to the campaign (status → Queued)` +
        (skipped ? `; ${skipped} skipped (wrong status).` : ".")
    );
    await load();
  }

  async function pushToInstantly() {
    const eligible = selectedRows.filter((r) => r.status === "queued");
    if (eligible.length === 0) {
      setError(
        "Only leads in status 'Queued' can be pushed. Assign them to a campaign first."
      );
      return;
    }
    if (
      !window.confirm(
        `Send ${eligible.length} leads to Instantly? This adds them to their respective Instantly campaign.`
      )
    ) {
      return;
    }
    setWorking(true);
    setError(null);
    const { data, error: err } = await supabase.functions.invoke(
      "push-to-instantly",
      { body: { creator_ids: eligible.map((r) => r.id) } }
    );
    setWorking(false);
    if (err) {
      setError(`Push failed: ${err.message}`);
      return;
    }
    const pushed = data?.total_pushed ?? 0;
    const failed = (data?.summaries ?? []).filter(
      (s: { ok: boolean }) => !s.ok
    );
    if (failed.length > 0) {
      setError(
        `${pushed} pushed, but ${failed.length} chunk(s) failed: ` +
          failed.map((f: { error?: string }) => f.error).join("; ")
      );
    } else {
      flash(`${pushed} leads successfully sent to Instantly.`);
    }
    await load();
  }

  async function markDoNotContact() {
    if (selectedRows.length === 0) return;
    if (
      !window.confirm(
        `Mark ${selectedRows.length} leads as 'Do not contact'?`
      )
    ) {
      return;
    }
    setWorking(true);
    setError(null);
    const { error: err } = await supabase
      .from("creators")
      .update({ status: "do_not_contact" })
      .in(
        "id",
        selectedRows.map((r) => r.id)
      );
    setWorking(false);
    if (err) {
      setError(err.message);
      return;
    }
    flash(`${selectedRows.length} leads marked as 'Do not contact'.`);
    await load();
  }

  function exportCsv() {
    if (selectedRows.length === 0) return;
    const csv = toCsv(
      selectedRows.map((r) => ({
        username: r.tiktok_username ?? "",
        email: r.email,
      }))
    );
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `leads-export-${selectedRows.length}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <h2>Leads</h2>

      {error && <div className="error">{error}</div>}
      {notice && <div className="success">{notice}</div>}

      <div className="toolbar">
        <input
          type="search"
          placeholder="Search handle / email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 220 }}
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as LeadStatus | "")}
        >
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select
          value={regionFilter}
          onChange={(e) => setRegionFilter(e.target.value as Region | "")}
        >
          <option value="">All regions</option>
          <option value="uk">UK</option>
          <option value="dach">DACH</option>
        </select>
        <select
          value={campaignFilter}
          onChange={(e) => setCampaignFilter(e.target.value)}
        >
          <option value="">All campaigns</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input
          type="search"
          placeholder="Label…"
          value={labelFilter}
          onChange={(e) => setLabelFilter(e.target.value)}
          style={{ minWidth: 130 }}
        />
        <button onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
      </div>

      {/* Selection action bar */}
      <div className="toolbar">
        <strong>{selected.size} selected</strong>
        <select
          value={assignCampaign}
          onChange={(e) => setAssignCampaign(e.target.value)}
        >
          <option value="">Select campaign…</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          onClick={assignToCampaign}
          disabled={working || selected.size === 0 || !assignCampaign}
        >
          Assign campaign
        </button>
        <button
          className="primary"
          onClick={pushToInstantly}
          disabled={working || selected.size === 0}
        >
          Push to Instantly
        </button>
        <button onClick={exportCsv} disabled={selected.size === 0}>
          Export as CSV
        </button>
        <button
          className="danger"
          onClick={markDoNotContact}
          disabled={working || selected.size === 0}
        >
          Do not contact
        </button>
      </div>

      <CreatorTable
        creators={rows}
        loading={loading}
        emptyText="No leads found."
        searchable={false}
        selectable
        selectedIds={selected}
        allSelected={allVisibleSelected}
        onToggle={toggleOne}
        onToggleAll={toggleAll}
      />
      {rows.length >= PAGE_SIZE && (
        <p className="muted" style={{ fontSize: 12 }}>
          Showing the newest {PAGE_SIZE} leads. Use the filters to narrow the
          list.
        </p>
      )}
    </div>
  );
}
