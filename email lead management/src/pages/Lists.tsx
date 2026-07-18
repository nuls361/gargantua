import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { STATUS_LABELS, type Campaign, type Creator, type List } from "../lib/types";
import CreatorTable from "../components/CreatorTable";
import ListsTable, { type ListRow } from "../components/ListsTable";

export default function Lists() {
  const { id } = useParams();
  return id ? <ListDetail id={id} /> : <ListsOverview />;
}

function ListsOverview() {
  const [rows, setRows] = useState<ListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [recycleCount, setRecycleCount] = useState<number | null>(null);

  useEffect(() => {
    supabase
      .rpc("recycle_count", { p_days: 30 })
      .then(({ data }) => setRecycleCount(typeof data === "number" ? data : Number(data ?? 0)));
  }, []);

  useEffect(() => {
    void (async () => {
      const { data: lists } = await supabase
        .from("lists")
        .select("*")
        .order("kind")
        .order("name");
      const countFor = (listId: string, status?: string) => {
        let q = supabase
          .from("creators")
          .select("id", { count: "exact", head: true })
          .eq("list_id", listId);
        if (status) q = q.eq("status", status);
        return q.then((r) => r.count ?? 0);
      };
      const withCounts = await Promise.all(
        (lists ?? []).map(async (l) => {
          const [total, sourced, enriched, filtered, in_instantly] =
            await Promise.all([
              countFor(l.id),
              countFor(l.id, "sourced"),
              countFor(l.id, "enriched"),
              countFor(l.id, "filtered"),
              countFor(l.id, "in_instantly"),
            ]);
          return { ...(l as List), total, sourced, enriched, filtered, in_instantly };
        })
      );
      setRows(withCounts);
      setLoading(false);
    })();
  }, []);

  return (
    <div>
      <h2>Lists</h2>
      <p className="muted">
        Import or source creators into a list → enrich the list (cleans +
        filters) → send the enriched block to Instantly.
      </p>

      <Link to="/lists/recycle" className="recycle-card">
        <span className="recycle-emoji">♻️</span>
        <div>
          <div className="recycle-title">Recycle</div>
          <div className="recycle-sub">
            Active leads not mailed in 30+ days — ready to re-use
          </div>
        </div>
        <span className="recycle-count">
          {recycleCount == null ? "…" : recycleCount.toLocaleString("en-GB")}
        </span>
      </Link>

      <ListsTable rows={rows} loading={loading} />
    </div>
  );
}

function ListDetail({ id }: { id: string }) {
  const [list, setList] = useState<List | null>(null);
  const [members, setMembers] = useState<Creator[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [sendCampaign, setSendCampaign] = useState("");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: l }, { data: m }] = await Promise.all([
      supabase.from("lists").select("*").eq("id", id).single(),
      supabase
        .from("creators")
        .select("id, handle, tiktok_username, platform, email, region_label, label, sample_creator, status, filter_reason, enriched_at, enriched_payload, campaign_id, date_added, added_to_instantly_at, list_id, source_file, email_normalized, first_contacted_at, last_contacted_at, contact_count, last_outcome, next_eligible_at, do_not_contact, campaigns(name)")
        .eq("list_id", id)
        .order("date_added", { ascending: false })
        .limit(500),
    ]);
    setList((l as List) ?? null);
    setMembers((m ?? []) as unknown as Creator[]);
    setLoading(false);
  }, [id]);

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

  const counts = members.reduce<Record<string, number>>((acc, m) => {
    acc[m.status] = (acc[m.status] ?? 0) + 1;
    return acc;
  }, {});

  const uniq = (vals: (string | null)[]) =>
    [...new Set(vals.filter((v): v is string => !!v))];
  const labels = uniq(members.map((m) => m.label));
  const regions = uniq(members.map((m) => m.region_label));
  const samples = uniq(members.map((m) => m.sample_creator));

  function flash(msg: string) {
    setNotice(msg);
    setError(null);
    setTimeout(() => setNotice(null), 6000);
  }

  async function enrich() {
    if (!window.confirm("Enrich all sourced creators in this list? This fetches full profiles, cleans emails, and moves filtered leads to the Filtered list.")) return;
    setWorking(true);
    setError(null);
    const { data, error: err } = await supabase.functions.invoke("enrich-list", {
      body: { list_id: id },
    });
    setWorking(false);
    if (err) {
      setError(`Enrich failed: ${err.message}`);
      return;
    }
    const reasons = data?.reasons
      ? Object.entries(data.reasons).map(([k, v]) => `${v} ${k}`).join(", ")
      : "";
    flash(
      `Enriched ${data?.enriched ?? 0}, filtered ${data?.filtered ?? 0}` +
        (reasons ? ` (${reasons})` : "") +
        "."
    );
    await load();
  }

  async function send() {
    const camp = campaigns.find((c) => c.id === sendCampaign);
    if (!camp?.instantly_campaign_id) {
      setError("Pick a campaign that has an Instantly Campaign ID.");
      return;
    }
    if (!window.confirm(`Send all enriched creators in "${list?.name}" to Instantly campaign "${camp.name}"?`)) return;
    setWorking(true);
    setError(null);
    const { data, error: err } = await supabase.functions.invoke("push-to-instantly", {
      body: { list_id: id, instantly_campaign_id: camp.instantly_campaign_id },
    });
    setWorking(false);
    if (err) {
      setError(`Send failed: ${err.message}`);
      return;
    }
    const failed = (data?.summaries ?? []).filter((s: { ok: boolean }) => !s.ok);
    if (failed.length > 0) {
      setError(`${data?.total_pushed ?? 0} sent, but some chunks failed: ` + failed.map((x: { error?: string }) => x.error).join("; "));
    } else {
      flash(`${data?.total_pushed ?? 0} creators sent to Instantly.`);
    }
    await load();
  }

  if (loading) return <div className="center-loading">Loading…</div>;
  if (!list) return <div className="error">List not found.</div>;

  const isWorking = list.kind === "working";

  return (
    <div>
      <div className="toolbar">
        <Link to="/lists">← Lists</Link>
        <h2 style={{ margin: 0 }}>{list.name}</h2>
        <span className="pill pill-new">{list.kind}</span>
      </div>

      {error && <div className="error">{error}</div>}
      {notice && <div className="success">{notice}</div>}

      <div className="muted" style={{ marginBottom: 12 }}>
        {members.length} loaded ·{" "}
        {Object.entries(counts)
          .map(([s, n]) => `${STATUS_LABELS[s as keyof typeof STATUS_LABELS] ?? s}: ${n}`)
          .join(" · ")}
      </div>

      {(labels.length > 0 || regions.length > 0 || samples.length > 0) && (
        <div className="toolbar" style={{ gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          {regions.map((r) => (
            <span key={`r-${r}`} className="pill pill-new">Region: {r.toUpperCase()}</span>
          ))}
          {labels.map((l) => (
            <span key={`l-${l}`} className="pill pill-new">Label: {l}</span>
          ))}
          {samples.map((s) => (
            <span key={`s-${s}`} className="pill pill-new">Sample: {s}</span>
          ))}
        </div>
      )}

      {isWorking && (
        <div className="panel">
          <div className="toolbar" style={{ margin: 0 }}>
            <button onClick={enrich} disabled={working || !(counts.sourced > 0)}>
              {working ? "Working…" : `Enrich list${counts.sourced ? ` (${counts.sourced} sourced)` : ""}`}
            </button>
            <div className="grow" />
            <select value={sendCampaign} onChange={(e) => setSendCampaign(e.target.value)}>
              <option value="">Send to campaign…</option>
              {campaigns
                .filter((c) => c.instantly_campaign_id)
                .map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
            </select>
            <button
              className="primary"
              onClick={send}
              disabled={working || !sendCampaign || !(counts.enriched > 0)}
            >
              Send enriched to Instantly{counts.enriched ? ` (${counts.enriched})` : ""}
            </button>
          </div>
        </div>
      )}

      <CreatorTable creators={members} emptyText="No members." />

      {members.length >= 500 && (
        <p className="muted" style={{ fontSize: 12 }}>Showing the newest 500 members.</p>
      )}
    </div>
  );
}
