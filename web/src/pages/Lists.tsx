import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import {
  PIPELINE, pipelineStage, CONTACT_STATE,
  type Campaign, type Creator, type List, type PipelineStage, type ContactState, type LeadStatus,
} from "../lib/types";
import CreatorTable from "../components/CreatorTable";
import ListsTable, { type ListRow } from "../components/ListsTable";
import Pager from "../components/Pager";

const CREATOR_COLS =
  "id, handle, tiktok_username, platform, email, region_label, label, sample_creator, status, filter_reason, enriched_at, enriched_payload, campaign_id, date_added, added_to_instantly_at, list_id, source_file, email_normalized, first_contacted_at, last_contacted_at, contact_count, last_outcome, next_eligible_at, do_not_contact, campaigns(name)";

export default function Lists() {
  const { id } = useParams();
  return id ? <ListDetail id={id} /> : <ListsOverview />;
}

function ListsOverview() {
  const [rows, setRows] = useState<ListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [recycle, setRecycle] = useState<Record<number, number>>({});

  useEffect(() => {
    [30, 60, 90].forEach(async (d) => {
      const cutoff = new Date(Date.now() - d * 86_400_000).toISOString();
      const { count } = await supabase
        .from("creators")
        .select("id", { count: "exact", head: true })
        .gt("contact_count", 0)
        .eq("do_not_contact", false)
        .or("last_outcome.is.null,last_outcome.eq.sent")
        .lte("last_contacted_at", cutoff);
      setRecycle((r) => ({ ...r, [d]: count ?? 0 }));
    });
  }, []);

  useEffect(() => {
    void (async () => {
      const { data: lists } = await supabase.from("lists").select("*").order("kind").order("name");
      const countFor = (listId: string, status?: string) => {
        let q = supabase.from("creators").select("id", { count: "exact", head: true }).eq("list_id", listId);
        if (status) q = q.eq("status", status);
        return q.then((r) => r.count ?? 0);
      };
      const withCounts = await Promise.all(
        (lists ?? []).map(async (l) => {
          const [total, sourced, enriched, filtered, in_instantly] = await Promise.all([
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

  // The idle/recycle segments render as ordinary rows at the top of the lists table.
  const idleRows: ListRow[] = [30, 60, 90].map((d) => ({
    id: `recycle-${d}`, name: `♻️ ${d}+ days idle`, kind: "recycle",
    created_at: "", total: recycle[d] ?? 0, sourced: 0, enriched: 0, filtered: 0,
    in_instantly: 0, href: `/lists/recycle?days=${d}`,
  }));

  return (
    <div>
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Lists</h2>
        <div className="grow" />
      </div>
      <p className="muted">
        Each list is a batch. <strong>Source</strong> in Search → <strong>send to Instantly</strong>.
        The contact state prevents double-contacts. The <strong>♻️ idle</strong> lists are
        auto-built: contacted leads that never replied, ready to re-approach.
      </p>

      <ListsTable rows={[...idleRows, ...rows]} loading={loading} />
    </div>
  );
}

const STAGES: PipelineStage[] = ["roh", "angereichert", "ausgespielt", "aussortiert"];
const CS_ORDER: ContactState[] = ["never", "cooldown", "contacted", "replied", "bounced", "dnc"];
const PAGE = 50;
const NICHES = [
  "beauty", "wellness", "fitness", "fashion", "food", "travel", "gaming", "tech",
  "finance", "music", "comedy", "parenting", "home & interior", "sustainability", "lifestyle",
];
const cap = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

type Stats = { total: number; status: Record<string, number>; contact: Record<string, number> };

function ListDetail({ id }: { id: string }) {
  const [list, setList] = useState<List | null>(null);
  const [members, setMembers] = useState<Creator[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, status: {}, contact: {} });
  const [page, setPage] = useState(0);
  const [filteredTotal, setFilteredTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [qDeb, setQDeb] = useState("");
  const [fCategory, setFCategory] = useState("");
  const [fEmail, setFEmail] = useState("");
  const [fMarket, setFMarket] = useState("");
  const [fContact, setFContact] = useState("");
  const [fIdle, setFIdle] = useState("");
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [sendCampaign, setSendCampaign] = useState("");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    const [{ data: l }, { data: s }] = await Promise.all([
      supabase.from("lists").select("*").eq("id", id).single(),
      supabase.rpc("list_stats", { p_list_id: id }),
    ]);
    setList((l as List) ?? null);
    setStats((s as Stats) ?? { total: 0, status: {}, contact: {} });
  }, [id]);

  useEffect(() => { const t = setTimeout(() => setQDeb(query), 300); return () => clearTimeout(t); }, [query]);

  const loadPage = useCallback(async () => {
    setLoading(true);
    let q: ReturnType<typeof supabase.from> extends never ? never : any =
      supabase.from("creators").select(CREATOR_COLS, { count: "exact" }).eq("list_id", id);
    const qq = qDeb.trim().replace(/^@/, "").replace(/[,()%*]/g, "");
    if (qq) q = q.or(`handle.ilike.*${qq}*,tiktok_username.ilike.*${qq}*,email.ilike.*${qq}*`);
    if (fCategory) q = q.eq("category", fCategory);
    if (fMarket) q = q.eq("region_label", fMarket);
    if (fEmail === "has") q = q.not("email", "is", null);
    else if (fEmail === "none") q = q.is("email", null);
    if (fContact === "contacted") q = q.gt("contact_count", 0);
    else if (fContact === "not") q = q.or("contact_count.is.null,contact_count.eq.0");
    if (fIdle) q = q.lte("last_contacted_at", new Date(Date.now() - Number(fIdle) * 86_400_000).toISOString());
    const { data, count } = await q.order("date_added", { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
    setMembers((data ?? []) as unknown as Creator[]);
    setFilteredTotal(count ?? 0);
    setLoading(false);
  }, [id, page, qDeb, fCategory, fEmail, fMarket, fContact, fIdle]);

  useEffect(() => { setPage(0); }, [qDeb, fCategory, fEmail, fMarket, fContact, fIdle]);
  useEffect(() => { void loadStats(); }, [loadStats]);
  useEffect(() => { void loadPage(); }, [loadPage]);
  useEffect(() => {
    void (async () => {
      // Pull the latest Instantly campaigns first so the send-dropdown is current
      // (best-effort; the campaigns table still loads even if the sync hiccups).
      try { await supabase.functions.invoke("sync-campaigns", { body: {} }); } catch { /* ignore */ }
      const { data } = await supabase.from("campaigns").select("*").order("name");
      setCampaigns((data ?? []) as Campaign[]);
    })();
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([loadStats(), loadPage()]);
  }, [loadStats, loadPage]);

  const stage = useMemo(() => {
    const c: Record<PipelineStage, number> = { roh: 0, angereichert: 0, ausgespielt: 0, aussortiert: 0 };
    for (const [st, n] of Object.entries(stats.status)) c[pipelineStage(st as LeadStatus)] += n;
    return c;
  }, [stats]);

  const sourced = stats.status.sourced ?? 0;
  const enriched = stats.status.enriched ?? 0;
  const sent = stats.status.in_instantly ?? 0;

  function flash(msg: string) {
    setNotice(msg);
    setError(null);
    setTimeout(() => setNotice(null), 6000);
  }

  async function enrich() {
    if (!window.confirm("Enrich all raw creators in this list? Pulls profiles, cleans emails, moves filtered ones out.")) return;
    setWorking(true);
    setError(null);
    const { data, error: err } = await supabase.functions.invoke("enrich-list", { body: { list_id: id } });
    setWorking(false);
    if (err) { setError(`Enrich failed: ${err.message}`); return; }
    flash(`${data?.enriched ?? 0} enriched, ${data?.filtered ?? 0} filtered.`);
    await refresh();
  }

  async function send(resend = false) {
    const camp = campaigns.find((c) => c.id === sendCampaign);
    if (!camp?.instantly_campaign_id) { setError("Choose a campaign with an Instantly campaign ID."); return; }
    const n = resend ? enriched + sent : enriched;
    if (!window.confirm(`Send ${n} creators from “${list?.name}” to “${camp.name}”?${resend ? " (incl. already-sent — cooldown is only a guide)" : ""}`)) return;
    setWorking(true);
    setError(null);
    // Resend: cooldown is only orientation — flip the already-sent creators back to
    // 'enriched' so the existing push-function re-sends them (no edge-fn change needed).
    if (resend && sent > 0) {
      const { error: flipErr } = await supabase.from("creators")
        .update({ status: "enriched" }).eq("list_id", id).eq("status", "in_instantly");
      if (flipErr) { setWorking(false); setError(`Resend prep failed: ${flipErr.message}`); return; }
    }
    const { data, error: err } = await supabase.functions.invoke("push-to-instantly", {
      body: { list_id: id, instantly_campaign_id: camp.instantly_campaign_id },
    });
    setWorking(false);
    if (err) { setError(`Send failed: ${err.message}`); return; }
    const failed = (data?.summaries ?? []).filter((s: { ok: boolean }) => !s.ok);
    if (failed.length > 0) setError(`${data?.total_pushed ?? 0} sent, but some parts failed: ` + failed.map((x: { error?: string }) => x.error).join("; "));
    else flash(`${data?.total_pushed ?? 0} creators sent to Instantly.`);
    await refresh();
  }

  if (!list) return <div className="center-loading">Loading…</div>;

  const isWorking = list.kind === "working";
  const activeStage: PipelineStage = stage.roh > 0 ? "roh" : stage.angereichert > 0 ? "angereichert" : "ausgespielt";

  return (
    <div>
      <div className="ws-head">
        <Link to="/lists" className="ws-back">← Lists</Link>
        <h2>{list.name}</h2>
        <span className="pill pill-neutral">{list.kind}</span>
        <span className="muted" style={{ fontSize: 13 }}>{stats.total.toLocaleString("en-GB")} creators</span>
      </div>

      {error && <div className="error">{error}</div>}
      {notice && <div className="success">{notice}</div>}

      <div className="funnel">
        {STAGES.map((st, i) => (
          <div key={st} className={`funnel-step ${st === activeStage ? "active" : ""} ${PIPELINE[st].cls}`}>
            <div className="funnel-n">{stage[st].toLocaleString("en-GB")}</div>
            <div className="funnel-l">{PIPELINE[st].label}</div>
            {i < STAGES.length - 1 && <span className="funnel-arrow">→</span>}
          </div>
        ))}
      </div>

      <div className="cs-strip">
        {CS_ORDER.filter((s) => (stats.contact[s] ?? 0) > 0).map((s) => (
          <span key={s} className={`pill ${CONTACT_STATE[s].cls}`} style={{ textTransform: "none" }}>
            {CONTACT_STATE[s].emoji} {CONTACT_STATE[s].label} · {stats.contact[s].toLocaleString("en-GB")}
          </span>
        ))}
      </div>

      {isWorking && (
        <div className="action-card">
          <div className="action-step">
            <div className="action-body">
              <div className="action-title">Send to Instantly</div>
              <div className="action-sub">
                {enriched.toLocaleString("en-GB")} ready
                {sourced > 0 ? ` · ${sourced.toLocaleString("en-GB")} still need an email` : ""}
              </div>
            </div>
            <select value={sendCampaign} onChange={(e) => setSendCampaign(e.target.value)} style={{ minWidth: 200 }}>
              <option value="">Choose a campaign…</option>
              {campaigns.filter((c) => c.instantly_campaign_id).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <button className={enriched > 0 && sendCampaign ? "primary" : ""} onClick={() => send(false)} disabled={working || !sendCampaign || enriched === 0}>
              {working ? "Working…" : enriched > 0 ? `▶ Send ${enriched.toLocaleString("en-GB")} to Instantly` : "Nothing ready"}
            </button>
            {sent > 0 && (
              <button onClick={() => send(true)} disabled={working || !sendCampaign}
                title="Cooldown ist nur Orientierung — erneut an die Kampagne senden">
                ↻ Resend {sent.toLocaleString("en-GB")}
              </button>
            )}
          </div>
          {sourced > 0 && (
            <button className="link-btn" onClick={enrich} disabled={working} title="Pull profiles & clean emails for the raw creators">
              {working ? "Enriching…" : `Enrich ${sourced.toLocaleString("en-GB")} raw first`}
            </button>
          )}
        </div>
      )}

      <div className="toolbar">
        <input placeholder="Handle / email…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ minWidth: 180 }} />
        <select value={fCategory} onChange={(e) => setFCategory(e.target.value)}>
          <option value="">All topics</option>
          {NICHES.map((c) => <option key={c} value={c}>{cap(c)}</option>)}
        </select>
        <select value={fMarket} onChange={(e) => setFMarket(e.target.value)}>
          <option value="">All markets</option>
          <option value="dach">DACH</option>
          <option value="uk">UK</option>
        </select>
        <select value={fEmail} onChange={(e) => setFEmail(e.target.value)}>
          <option value="">Email any</option>
          <option value="has">Has email</option>
          <option value="none">No email</option>
        </select>
        <select value={fContact} onChange={(e) => setFContact(e.target.value)}>
          <option value="">Contacted or not</option>
          <option value="contacted">Contacted</option>
          <option value="not">Not contacted</option>
        </select>
        <select value={fIdle} onChange={(e) => setFIdle(e.target.value)}>
          <option value="">Any time</option>
          <option value="30">Last contact 30+ days ago</option>
          <option value="60">60+ days ago</option>
          <option value="90">90+ days ago</option>
        </select>
        <div className="grow" />
        <span className="muted" style={{ fontSize: 12 }}>{filteredTotal.toLocaleString("en-GB")} shown</span>
      </div>

      <CreatorTable creators={members} loading={loading} searchable={false} emptyText="No members for this filter." />
      <Pager page={page} pageSize={PAGE} total={filteredTotal} onPage={setPage} />
    </div>
  );
}
