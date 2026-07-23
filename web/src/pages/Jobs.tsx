import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { extractBriefing } from "../lib/briefing";
import { Detail, Mono, PlatIcon, erClass, fmt, profileUrl, DIFF, PERSONA, COLS, type Row } from "../components/CreatorPanel";

// Jobs — the campaign container. Definition (brief/earning/campaigns) lives here;
// members are sourced in Search and added. No searching happens in the job.

type Job = {
  id: string; title: string; status: string; subject: string | null; briefing: string | null;
  earning_min: number | null; earning_max: number | null; created_at: string;
  campaign_google: string | null; campaign_outlook: string | null; campaign_custom: string | null;
};
type Campaign = { instantly_campaign_id: string; name: string };
type Member = Row & { similarity: number };   // full creator row + fit score
const STATUS: Record<string, string> = { draft:"#8A8F9C", active:"#12A150", paused:"#C2860B", closed:"#6B7280" };

export default function Jobs() {
  const { id } = useParams();
  return id ? <JobDetail id={id} /> : <JobsList />;
}

function JobsList() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const nav = useNavigate();

  const load = useCallback(async () => {
    const { data } = await supabase.from("jobs").select("*").order("created_at", { ascending: false });
    setJobs((data ?? []) as Job[]); setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="wp">
      <div className="eyebrow">Outreach</div>
      <h1>Jobs</h1>
      <div className="sub">A job = a brand brief + who it's for + the earning. Match creators, then reach out.</div>

      <div className="listhead" style={{ marginTop: 8 }}>
        <b>{jobs.length}</b><span>jobs</span>
        <span className="grow" />
        <button className="sbtn2" onClick={() => setCreating(true)}>
          <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>New job
        </button>
      </div>

      <div className="rows">
        {loading ? <div className="empty">Loading…</div>
          : jobs.length === 0 ? <div className="empty">No jobs yet. Create one from a brand brief.</div>
          : jobs.map(j => (
            <Link key={j.id} className="crow" to={`/jobs/${j.id}`} style={{ textDecoration: "none" }}>
              <div className="idcol">
                <div className="nm">{j.title}</div>
                <div className="hd">{j.subject || "—"}{j.briefing ? ` · ${j.briefing.slice(0, 80)}…` : ""}</div>
              </div>
            </Link>
          ))}
      </div>

      {creating && <CreateJob onClose={() => setCreating(false)} onSaved={(jid) => nav(`/jobs/${jid}`)} />}
    </div>
  );
}

function CreateJob({ onClose, onSaved, job }: { onClose: () => void; onSaved: (id: string) => void; job?: Job }) {
  const [title, setTitle] = useState(job?.title ?? "");
  const [status, setStatus] = useState(job?.status ?? "draft");
  const [subject, setSubject] = useState(job?.subject ?? "");
  const [briefing, setBriefing] = useState(job?.briefing ?? "");
  const [earnMin, setEarnMin] = useState(job?.earning_min != null ? String(job.earning_min) : "");
  const [earnMax, setEarnMax] = useState(job?.earning_max != null ? String(job.earning_max) : "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [docUrl, setDocUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [impErr, setImpErr] = useState<string | null>(null);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; e.target.value = "";
    if (!f) return;
    setImporting(true); setImpErr(null);
    try { const t = await extractBriefing(f); setBriefing(b => b ? `${b}\n\n${t}` : t); }
    catch (er) { setImpErr(er instanceof Error ? er.message : "Import failed"); }
    setImporting(false);
  }
  async function importDoc() {
    if (!docUrl.trim()) return;
    setImporting(true); setImpErr(null);
    const { data, error } = await supabase.functions.invoke("fetch-doc", { body: { url: docUrl.trim() } });
    if (error || data?.error) setImpErr(error?.message || data?.error);
    else { setBriefing(b => b ? `${b}\n\n${data.text}` : data.text); setDocUrl(""); }
    setImporting(false);
  }

  async function save() {
    if (!title.trim()) { setErr("Give the job a title."); return; }
    setSaving(true); setErr(null);
    const payload = {
      title: title.trim(), status, subject: subject.trim() || null, briefing: briefing.trim() || null,
      earning_min: earnMin ? Number(earnMin) : null, earning_max: earnMax ? Number(earnMax) : null,
    };
    const res = job
      ? await supabase.from("jobs").update(payload).eq("id", job.id).select("id").single()
      : await supabase.from("jobs").insert(payload).select("id").single();
    setSaving(false);
    if (res.error) { setErr(res.error.message); return; }
    onSaved((res.data as { id: string }).id);
  }

  return (
    <div className="wp-scrim show" onClick={onClose}>
      <div className="wp-panel jobform show" onClick={e => e.stopPropagation()}>
        <div className="p-head"><div><div className="eyebrow">{job ? "Edit job" : "New job"}</div><h2 style={{ margin: 0 }}>{job ? title || "Job" : "From a brand brief"}</h2></div><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="fcard" style={{ margin: "12px 18px 22px" }}>
          <div className="fgrid" style={{ gridTemplateColumns: job ? "2fr 1fr" : "1fr" }}>
            <div className="field"><label>Job title *</label><input className="inp" placeholder="ABOUT YOU – Fashion Inspiration" value={title} onChange={e => setTitle(e.target.value)} /></div>
            {job && <div className="field"><label>Status</label><select value={status} onChange={e => setStatus(e.target.value)}><option value="draft">Draft</option><option value="active">Active</option><option value="paused">Paused</option><option value="closed">Closed</option></select></div>}
          </div>
          <div className="field"><label>Brand / artist / song</label><input className="inp" placeholder="ABOUT YOU" value={subject} onChange={e => setSubject(e.target.value)} /></div>
          <div className="field">
            <label>Briefing</label>
            <div className="impbar">
              <label className="impbtn">{importing ? "Importing…" : "📄 Upload .txt / .pdf"}<input type="file" accept=".txt,.md,.pdf" onChange={onFile} hidden /></label>
              <input className="inp" style={{ flex: 1 }} placeholder="…or paste a Google Doc / URL" value={docUrl} onChange={e => setDocUrl(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void importDoc(); } }} />
              <button type="button" className="dirbtn" style={{ width: "auto", padding: "0 12px", height: 34 }} onClick={importDoc} disabled={importing || !docUrl.trim()}>Import</button>
            </div>
            {impErr && <div className="notice err" style={{ marginTop: 0, marginBottom: 8 }}>{impErr}</div>}
            <textarea className="inp" rows={6} placeholder="Paste the full brief, or import it above — deliverable, hooks, do's & don'ts, voucher/CTA…" value={briefing} onChange={e => setBriefing(e.target.value)} />
          </div>
          <div className="fsec">Earning (WePush view-goal model)</div>
          <div className="fgrid">
            <div className="field"><label>Payout min €</label><input className="inp num" placeholder="40" value={earnMin} onChange={e => setEarnMin(e.target.value)} /></div>
            <div className="field"><label>Payout max €</label><input className="inp num" placeholder="500" value={earnMax} onChange={e => setEarnMax(e.target.value)} /></div>
          </div>
          {err && <div className="notice err" style={{ marginTop: 10 }}>{err}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button className="sbtn2" onClick={save} disabled={saving}>{saving ? "Saving…" : job ? "Save changes" : "Create job"}</button>
            <button className="dirbtn" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function JobDetail({ id }: { id: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [emails, setEmails] = useState<Record<string, { subject: string; icebreaker: string; pitch: string }>>({});
  const [generating, setGenerating] = useState(false);
  const [panel, setPanel] = useState<Member | null>(null);
  const [editing, setEditing] = useState(false);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [sortKey, setSortKey] = useState("follower_count");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const reloadJob = useCallback(async () => {
    const { data } = await supabase.from("jobs").select("*").eq("id", id).single();
    setJob(data as Job);
  }, [id]);

  useEffect(() => { void supabase.from("campaigns").select("instantly_campaign_id,name").order("name").then(({ data }) => setCampaigns((data ?? []) as Campaign[])); }, []);

  async function assignCampaign(field: "campaign_google" | "campaign_outlook" | "campaign_custom", value: string) {
    setJob(j => j ? { ...j, [field]: value || null } : j);
    await supabase.from("jobs").update({ [field]: value || null }).eq("id", id);
  }

  const loadMembers = useCallback(async () => {
    const { data: jc } = await supabase.from("job_creators")
      .select("sec_uid,fit_score,ai_subject,ai_icebreaker,ai_pitch").eq("job_id", id).order("added_at", { ascending: false });
    const jrows = (jc ?? []) as { sec_uid: string; fit_score: number | null; ai_subject: string | null; ai_icebreaker: string | null; ai_pitch: string | null }[];
    const em: Record<string, { subject: string; icebreaker: string; pitch: string }> = {};
    for (const r of jrows) if (r.ai_subject) em[r.sec_uid] = { subject: r.ai_subject, icebreaker: r.ai_icebreaker ?? "", pitch: r.ai_pitch ?? "" };
    setEmails(em);
    if (!jrows.length) { setMembers([]); return; }
    const { data: full } = await supabase.from("tt_creators_x").select(COLS).in("sec_uid", jrows.map(r => r.sec_uid));
    const fitBy = new Map(jrows.map(r => [r.sec_uid, r.fit_score]));
    const order = new Map(jrows.map((r, i) => [r.sec_uid, i]));
    const merged = ((full ?? []) as Row[])
      .map(r => ({ ...r, similarity: fitBy.get(r.sec_uid) ?? -1 }))
      .sort((a, b) => (order.get(a.sec_uid) ?? 0) - (order.get(b.sec_uid) ?? 0));
    setMembers(merged);
  }, [id]);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase.from("jobs").select("*").eq("id", id).single();
      setJob(data as Job); setLoading(false);
      await loadMembers();
    })();
  }, [id, loadMembers]);

  const [pushing, setPushing] = useState(false);
  async function pushToInstantly() {
    if (!members.length) return;
    if (!(job?.campaign_google || job?.campaign_outlook || job?.campaign_custom)) {
      setNotice("Assign at least one Instantly campaign above before pushing."); return;
    }
    setPushing(true); setNotice(null);
    const { data, error } = await supabase.functions.invoke("push-job-to-instantly", { body: { job_id: id } });
    if (error || data?.error) setNotice(error?.message || data?.error);
    else {
      const s = data?.skipped || {};
      setNotice(`Pushed ${data?.pushed ?? 0} to Instantly. Skipped ${s.no_email || 0} without email · ${s.tonline || 0} t-online · ${s.no_campaign || 0} with no campaign for their provider.`);
      await loadMembers();
    }
    setPushing(false);
  }

  async function generate() {
    const todo = members.filter(m => !emails[m.sec_uid]).slice(0, 20).map(m => m.sec_uid);
    const ids = todo.length ? todo : members.slice(0, 20).map(m => m.sec_uid);
    if (!ids.length) { setNotice("Add members first — source them in Search."); return; }
    setGenerating(true); setNotice(null);
    const { data, error } = await supabase.functions.invoke("generate-job-emails", { body: { job_id: id, sec_uids: ids } });
    if (error) setNotice(error.message);
    else {
      const map = { ...emails };
      for (const e of ((data?.emails ?? []) as { sec_uid: string; subject: string; icebreaker: string; pitch: string }[]))
        map[e.sec_uid] = { subject: e.subject, icebreaker: e.icebreaker, pitch: e.pitch };
      setEmails(map);
      setNotice(`Generated ${(data?.emails ?? []).length} personalized emails.`);
    }
    setGenerating(false);
  }

  if (loading) return <div className="wp"><div className="empty">Loading…</div></div>;
  if (!job) return <div className="wp"><div className="empty">Job not found.</div></div>;
  const sorted = [...members].sort((a, b) => {
    const av = Number((a as Record<string, unknown>)[sortKey] ?? 0);
    const bv = Number((b as Record<string, unknown>)[sortKey] ?? 0);
    return sortDir === "asc" ? av - bv : bv - av;
  });

  return (
    <div className="wp">
      <Link to="/jobs" className="backlink">← Jobs</Link>
      <div className="eyebrow">{job.subject || "Job"}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ flex: 1 }}>{job.title}</h1>
        <span className="pill" title="Synced from the linked Instantly campaigns" style={{ background: STATUS[job.status] || "#8A8F9C", color: "#fff", fontSize: 13, padding: "5px 12px" }}>{job.status}</span>
        <button className="dirbtn" style={{ width: "auto", padding: "0 14px", height: 34 }} onClick={() => setEditing(true)}>Edit job</button>
      </div>
      {editing && <CreateJob job={job} onClose={() => setEditing(false)} onSaved={async () => { setEditing(false); await reloadJob(); }} />}

      <div className="jobmeta">
        <div className="jm"><div className="k">Leads</div><div className="v">{members.length.toLocaleString("en-GB")}</div></div>
        <div className="jm"><div className="k">Approx. new users</div><div className="v" style={{ color: "var(--wp-good)" }}>≈ {Math.round(members.length * 0.025).toLocaleString("en-GB")}</div></div>
      </div>

      {job.briefing && <details className="jobbrief"><summary><b>Briefing</b></summary><div style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{job.briefing}</div></details>}

      <div className="fcard" style={{ marginTop: 12 }}>
        <div className="fsec" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>Instantly campaign per email provider <span style={{ color: "var(--wp-muted)", textTransform: "none", letterSpacing: 0, fontWeight: 500 }}>— routes each member by their inbox provider</span></div>
        <div className="fgrid" style={{ marginTop: 12 }}>
          {([["campaign_google", "Google inbox"], ["campaign_outlook", "Outlook inbox"], ["campaign_custom", "Custom SMTP"]] as const).map(([field, label]) => (
            <div className="field" key={field}><label>{label} → campaign</label>
              <select value={(job[field] as string | null) ?? ""} onChange={e => assignCampaign(field, e.target.value)}>
                <option value="">— none —</option>
                {campaigns.map(c => <option key={c.instantly_campaign_id} value={c.instantly_campaign_id}>{c.name}</option>)}
              </select>
            </div>
          ))}
        </div>
      </div>

      <div className="listhead" style={{ marginTop: 16 }}>
        <b>{members.length}</b><span>leads</span>
        <span className="grow" />
        <select className="sortsel" value={sortKey} onChange={e => setSortKey(e.target.value)}>
          <option value="follower_count">Followers</option>
          <option value="engagement_median">Engagement</option>
          <option value="avg_views">Avg views</option>
        </select>
        <button className="dirbtn" onClick={() => setSortDir(d => d === "desc" ? "asc" : "desc")} title="Sort direction">{sortDir === "desc" ? "↓" : "↑"}</button>
        <button className="dirbtn" style={{ width: "auto", padding: "0 12px", height: 34 }} onClick={generate} disabled={!members.length || generating}>
          {generating ? "Generating…" : "✨ Generate emails"}
        </button>
        <button className="sbtn2" onClick={pushToInstantly} disabled={!members.length || pushing} style={{ background: "var(--wp-good)" }}>
          <svg viewBox="0 0 24 24"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>{pushing ? "Pushing…" : "Push to Instantly"}
        </button>
      </div>

      {notice && <div className="notice">{notice}</div>}

      <div className="rows">
        {members.length === 0 ? <div className="empty">No leads yet. Source creators in <Link to="/search" style={{ color: "var(--wp-accink)" }}>Search</Link> (semantic, filters, or lookalike) and “Add to job”.</div>
          : sorted.map(m => {
            const em = emails[m.sec_uid];
            return (
              <div key={m.sec_uid} className={"crow" + (m.is_songpush_user ? " wepush" : "")} onClick={() => setPanel(m)}>
                <Mono r={m} />
                <div className="idcol">
                  <div className="nm">{m.display_name || m.handle}<span className="pf" title={m.platform === "instagram" ? "Instagram" : "TikTok"}><PlatIcon p={m.platform} /></span></div>
                  <div className="hd">@{m.handle}</div>
                  <div className="tags">
                    {m.category && <span className="pill cat">{m.category}</span>}
                    {(m.content_format || []).slice(0, 2).map(f => <span key={f} className="pill">{f}</span>)}
                    {m.persona && <span className="pill ghost">{PERSONA[m.persona] || m.persona}</span>}
                    {(m.original_sound_ratio ?? 0) >= 0.5 && <span className="pill ghost">🎤 speaks</span>}
                    {em && <span className="pill" style={{ background: "var(--wp-acc)", color: "#fff" }}>✉ email ready</span>}
                  </div>
                </div>
                <div className="metrics">
                  <div className="metric"><div className="v num">{fmt(m.follower_count)}</div><div className="k">Followers</div></div>
                  <div className="metric"><div className={"v num " + erClass(m.engagement_median)}>{m.engagement_median ?? "—"}%</div><div className="k">ER</div></div>
                  <div className="metric"><div className="v num">{fmt(m.avg_views)}</div><div className="k">Avg views</div></div>
                  {m.email && <span className="mail-dot" title={m.email_difficulty && DIFF[m.email_difficulty] ? `Email · ${DIFF[m.email_difficulty].label} to reach` : "Email available"} style={m.email_difficulty && DIFF[m.email_difficulty] ? { background: DIFF[m.email_difficulty].color } : undefined} />}
                  <a className="iconbtn" href={profileUrl(m)} target="_blank" rel="noreferrer" title="Open profile" onClick={e => e.stopPropagation()}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M7 17 17 7M9 7h8v8"/></svg></a>
                </div>
              </div>
            );
          })}
      </div>

      <div className={"wp-scrim" + (panel ? " show" : "")} onClick={() => setPanel(null)} />
      <div className={"wp-panel" + (panel ? " show" : "")}>
        {panel && <Detail r={panel} onClose={() => setPanel(null)} email={emails[panel.sec_uid] ?? null} />}
      </div>
    </div>
  );
}
