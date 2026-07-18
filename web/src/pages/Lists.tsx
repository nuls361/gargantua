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
  const [recycleCount, setRecycleCount] = useState<number | null>(null);

  useEffect(() => {
    supabase
      .rpc("recycle_count", { p_days: 30 })
      .then(({ data }) => setRecycleCount(typeof data === "number" ? data : Number(data ?? 0)));
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

  return (
    <div>
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Listen</h2>
        <div className="grow" />
      </div>
      <p className="muted">
        Jede Liste ist ein Batch. <strong>Sourcen</strong> → <strong>anreichern</strong> → <strong>an
        Instantly</strong>. Der Kontaktstand verhindert Doppel-Kontakte.
      </p>

      <Link to="/lists/recycle" className="recycle-card">
        <span className="recycle-emoji">♻️</span>
        <div>
          <div className="recycle-title">Recycle</div>
          <div className="recycle-sub">Leads, seit 30+ Tagen nicht gemailt — wieder frei</div>
        </div>
        <span className="recycle-count">
          {recycleCount == null ? "…" : recycleCount.toLocaleString("de-DE")}
        </span>
      </Link>

      <ListsTable rows={rows} loading={loading} />
    </div>
  );
}

const STAGES: PipelineStage[] = ["roh", "angereichert", "ausgespielt", "aussortiert"];
const CS_ORDER: ContactState[] = ["never", "cooldown", "contacted", "replied", "bounced", "dnc"];
const PAGE = 50;

type Stats = { total: number; status: Record<string, number>; contact: Record<string, number> };

function ListDetail({ id }: { id: string }) {
  const [list, setList] = useState<List | null>(null);
  const [members, setMembers] = useState<Creator[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, status: {}, contact: {} });
  const [page, setPage] = useState(0);
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

  const loadPage = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("creators")
      .select(CREATOR_COLS)
      .eq("list_id", id)
      .order("date_added", { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    setMembers((data ?? []) as unknown as Creator[]);
    setLoading(false);
  }, [id, page]);

  useEffect(() => { void loadStats(); }, [loadStats]);
  useEffect(() => { void loadPage(); }, [loadPage]);
  useEffect(() => {
    supabase.from("campaigns").select("*").order("name")
      .then(({ data }) => setCampaigns((data ?? []) as Campaign[]));
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

  function flash(msg: string) {
    setNotice(msg);
    setError(null);
    setTimeout(() => setNotice(null), 6000);
  }

  async function enrich() {
    if (!window.confirm("Alle rohen Creator dieser Liste anreichern? Zieht Profile, säubert Emails, verschiebt Aussortierte.")) return;
    setWorking(true);
    setError(null);
    const { data, error: err } = await supabase.functions.invoke("enrich-list", { body: { list_id: id } });
    setWorking(false);
    if (err) { setError(`Anreichern fehlgeschlagen: ${err.message}`); return; }
    flash(`${data?.enriched ?? 0} angereichert, ${data?.filtered ?? 0} aussortiert.`);
    await refresh();
  }

  async function send() {
    const camp = campaigns.find((c) => c.id === sendCampaign);
    if (!camp?.instantly_campaign_id) { setError("Wähle eine Kampagne mit Instantly-Campaign-ID."); return; }
    if (!window.confirm(`Alle ${enriched} angereicherten Creator aus „${list?.name}" an „${camp.name}" senden?`)) return;
    setWorking(true);
    setError(null);
    const { data, error: err } = await supabase.functions.invoke("push-to-instantly", {
      body: { list_id: id, instantly_campaign_id: camp.instantly_campaign_id },
    });
    setWorking(false);
    if (err) { setError(`Senden fehlgeschlagen: ${err.message}`); return; }
    const failed = (data?.summaries ?? []).filter((s: { ok: boolean }) => !s.ok);
    if (failed.length > 0) setError(`${data?.total_pushed ?? 0} gesendet, aber Teile scheiterten: ` + failed.map((x: { error?: string }) => x.error).join("; "));
    else flash(`${data?.total_pushed ?? 0} Creator an Instantly gesendet.`);
    await refresh();
  }

  if (!list) return <div className="center-loading">Loading…</div>;

  const isWorking = list.kind === "working";
  const activeStage: PipelineStage = stage.roh > 0 ? "roh" : stage.angereichert > 0 ? "angereichert" : "ausgespielt";

  return (
    <div>
      <div className="ws-head">
        <Link to="/lists" className="ws-back">← Listen</Link>
        <h2>{list.name}</h2>
        <span className="pill pill-neutral">{list.kind}</span>
        <span className="muted" style={{ fontSize: 13 }}>{stats.total.toLocaleString("de-DE")} Creator</span>
      </div>

      {error && <div className="error">{error}</div>}
      {notice && <div className="success">{notice}</div>}

      <div className="funnel">
        {STAGES.map((st, i) => (
          <div key={st} className={`funnel-step ${st === activeStage ? "active" : ""} ${PIPELINE[st].cls}`}>
            <div className="funnel-n">{stage[st].toLocaleString("de-DE")}</div>
            <div className="funnel-l">{PIPELINE[st].label}</div>
            {i < STAGES.length - 1 && <span className="funnel-arrow">→</span>}
          </div>
        ))}
      </div>

      <div className="cs-strip">
        {CS_ORDER.filter((s) => (stats.contact[s] ?? 0) > 0).map((s) => (
          <span key={s} className={`pill ${CONTACT_STATE[s].cls}`} style={{ textTransform: "none" }}>
            {CONTACT_STATE[s].emoji} {CONTACT_STATE[s].label} · {stats.contact[s].toLocaleString("de-DE")}
          </span>
        ))}
      </div>

      {isWorking && (
        <div className="action-card">
          <div className="action-step">
            <div className="action-num">1</div>
            <div className="action-body">
              <div className="action-title">Anreichern</div>
              <div className="action-sub">Emails säubern & Profile ziehen</div>
            </div>
            <button className={sourced > 0 ? "primary" : ""} onClick={enrich} disabled={working || sourced === 0}>
              {working ? "Läuft…" : sourced > 0 ? `▶ ${sourced.toLocaleString("de-DE")} anreichern` : "Nichts Rohes"}
            </button>
          </div>
          <div className="action-divider" />
          <div className="action-step">
            <div className="action-num">2</div>
            <div className="action-body">
              <div className="action-title">An Instantly spielen</div>
              <div className="action-sub">Angereicherte in eine Kampagne</div>
            </div>
            <select value={sendCampaign} onChange={(e) => setSendCampaign(e.target.value)} style={{ minWidth: 180 }}>
              <option value="">Kampagne wählen…</option>
              {campaigns.filter((c) => c.instantly_campaign_id).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <button className={enriched > 0 && sendCampaign ? "primary" : ""} onClick={send} disabled={working || !sendCampaign || enriched === 0}>
              {enriched > 0 ? `▶ ${enriched.toLocaleString("de-DE")} senden` : "Nichts Bereites"}
            </button>
          </div>
        </div>
      )}

      <CreatorTable creators={members} loading={loading} searchable={false} emptyText="Keine Mitglieder." />
      <Pager page={page} pageSize={PAGE} total={stats.total} onPage={setPage} />
    </div>
  );
}
