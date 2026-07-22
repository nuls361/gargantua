import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { extractBriefing } from "../lib/briefing";

// Jobs — the campaign-driven outreach unit. A job holds a brief, the sample creators
// the brand likes (→ lookalike match), earning, and targeting. Replaces working Lists.

type Job = {
  id: string; title: string; status: string; subject: string | null; briefing: string | null;
  sample_creators: string[] | null; deliverable: string | null;
  earning_model: string | null; earning_min: number | null; earning_max: number | null; view_goal: number | null;
  target_market: string | null; foll_min: number | null; foll_max: number | null;
  instantly_campaign_id: string | null; created_at: string;
  campaign_google: string | null; campaign_outlook: string | null; campaign_custom: string | null;
};
type Campaign = { instantly_campaign_id: string; name: string };
// Match row = same shape/fields the Search page renders, + a fit score.
type Match = {
  sec_uid: string; handle: string; display_name: string | null; category: string | null;
  content_format: string[] | null; persona: string | null; original_sound_ratio: number | null;
  follower_count: number | null; engagement_median: number | null; avg_views: number | null;
  avatar_url: string | null; platform: string | null; is_songpush_user: boolean | null;
  email: string | null; email_difficulty: string | null; similarity: number;
};
const ROWCOLS = "sec_uid,handle,display_name,category,content_format,persona,original_sound_ratio,follower_count,engagement_median,avg_views,avatar_url,platform,is_songpush_user,email,email_difficulty";

// ---- helpers copied verbatim from the Search page so rows render identically ----
const CAT_HUE: Record<string, number> = { beauty:330,wellness:160,fitness:14,fashion:280,food:26,travel:200,gaming:250,tech:210,finance:150,music:190,comedy:45,parenting:340,"home & interior":175,sustainability:135,relationship:350,dance:300,pets:32,cars:220,education:230,art:265,lifestyle:255 };
const PERSONA: Record<string, string> = { solo:"Solo", couple:"Couple", family:"Family", group:"Group" };
const DIFF: Record<string, { label: string; color: string }> = {
  very_easy:{label:"Very easy",color:"#12A150"}, easy:{label:"Easy",color:"#4E9F2E"}, easy_medium:{label:"Easy–med",color:"#8A9A1B"},
  medium:{label:"Medium",color:"#C2860B"}, hard:{label:"Hard",color:"#D9600F"}, very_hard:{label:"Very hard",color:"#C0341D"}, skip:{label:"Skip · t-online",color:"#6B7280"},
};
const catColor = (c: string | null) => `hsl(${(c && CAT_HUE[c]) ?? 255} 62% 52%)`;
const initials = (r: { display_name: string | null; handle: string }) => ((r.display_name || r.handle).replace(/[^\p{L}\p{N} ]/gu,"").trim().split(/\s+/).map(w=>w[0]).slice(0,2).join("").toUpperCase() || r.handle[0].toUpperCase());
const erClass = (e: number | null) => e == null ? "" : e < 2 ? "er-bad" : e > 14 ? "er-warn" : "er-good";
const fmt = (n: number | null) => n == null ? "—" : n >= 1e6 ? `${(n/1e6).toFixed(1)}m` : n >= 1e3 ? `${(n/1e3).toFixed(n>=1e5?0:1)}k` : `${n}`;
const profileUrl = (r: { platform: string | null; handle: string }) => r.platform === "instagram" ? `https://www.instagram.com/${r.handle}` : `https://www.tiktok.com/@${r.handle}`;
function PlatIcon({ p }: { p: string | null }) {
  return p === "instagram"
    ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1.1" fill="currentColor" stroke="none"/></svg>
    : <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.6 5.82A4.28 4.28 0 0 1 15.54 3h-3.2v12.9a2.59 2.59 0 1 1-2.03-2.53v-3.26a5.76 5.76 0 1 0 5.03 5.71V8.9a7.5 7.5 0 0 0 4.3 1.34V7.06a4.28 4.28 0 0 1-2.99-1.24z"/></svg>;
}
function Mono({ r }: { r: Match }) {
  return <div className="mono" style={{ background: catColor(r.category) }}>{initials(r)}{r.avatar_url && <img src={r.avatar_url} alt="" onError={e => { e.currentTarget.style.display = "none"; }} />}</div>;
}
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
                <div className="nm">{j.title}<span className="pill" style={{ background: STATUS[j.status] || "#8A8F9C", color: "#fff", marginLeft: 8 }}>{j.status}</span></div>
                <div className="hd">{j.subject || "—"}{j.briefing ? ` · ${j.briefing.slice(0, 80)}…` : ""}</div>
              </div>
              <div className="metrics">
                <div className="metric"><div className="v num">{j.earning_min != null || j.earning_max != null ? `€${j.earning_min ?? 0}–${j.earning_max ?? "?"}` : "—"}</div><div className="k">Payout</div></div>
                <div className="metric"><div className="v num">{(j.sample_creators || []).length}</div><div className="k">Samples</div></div>
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
  const [viewGoal, setViewGoal] = useState(job?.view_goal != null ? String(job.view_goal) : "");
  const [cGoogle, setCGoogle] = useState(job?.campaign_google ?? "");
  const [cOutlook, setCOutlook] = useState(job?.campaign_outlook ?? "");
  const [cCustom, setCCustom] = useState(job?.campaign_custom ?? "");
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  useEffect(() => { void supabase.from("campaigns").select("instantly_campaign_id,name").order("name").then(({ data }) => setCampaigns((data ?? []) as Campaign[])); }, []);
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
      view_goal: viewGoal ? Number(viewGoal) : null,
      campaign_google: cGoogle || null, campaign_outlook: cOutlook || null, campaign_custom: cCustom || null,
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
            <div className="field"><label>View goal</label><input className="inp num" placeholder="e.g. 50000" value={viewGoal} onChange={e => setViewGoal(e.target.value)} /></div>
          </div>
          <div className="fsec">Instantly campaign per email provider <span style={{ color: "var(--wp-muted)", textTransform: "none", letterSpacing: 0, fontWeight: 500 }}>— routes each creator by their inbox provider</span></div>
          <div className="fgrid">
            <div className="field"><label>Google inbox → campaign</label><select value={cGoogle} onChange={e => setCGoogle(e.target.value)}><option value="">— none —</option>{campaigns.map(c => <option key={c.instantly_campaign_id} value={c.instantly_campaign_id}>{c.name}</option>)}</select></div>
            <div className="field"><label>Outlook inbox → campaign</label><select value={cOutlook} onChange={e => setCOutlook(e.target.value)}><option value="">— none —</option>{campaigns.map(c => <option key={c.instantly_campaign_id} value={c.instantly_campaign_id}>{c.name}</option>)}</select></div>
            <div className="field"><label>Custom SMTP → campaign</label><select value={cCustom} onChange={e => setCCustom(e.target.value)}><option value="">— none —</option>{campaigns.map(c => <option key={c.instantly_campaign_id} value={c.instantly_campaign_id}>{c.name}</option>)}</select></div>
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
  const [members, setMembers] = useState<Match[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [emails, setEmails] = useState<Record<string, { subject: string; icebreaker: string; pitch: string }>>({});
  const [generating, setGenerating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const reloadJob = useCallback(async () => {
    const { data } = await supabase.from("jobs").select("*").eq("id", id).single();
    setJob(data as Job);
  }, [id]);

  const loadMembers = useCallback(async () => {
    const { data: jc } = await supabase.from("job_creators")
      .select("sec_uid,fit_score,ai_subject,ai_icebreaker,ai_pitch").eq("job_id", id).order("added_at", { ascending: false });
    const jrows = (jc ?? []) as { sec_uid: string; fit_score: number | null; ai_subject: string | null; ai_icebreaker: string | null; ai_pitch: string | null }[];
    const em: Record<string, { subject: string; icebreaker: string; pitch: string }> = {};
    for (const r of jrows) if (r.ai_subject) em[r.sec_uid] = { subject: r.ai_subject, icebreaker: r.ai_icebreaker ?? "", pitch: r.ai_pitch ?? "" };
    setEmails(em);
    if (!jrows.length) { setMembers([]); return; }
    const { data: full } = await supabase.from("tt_creators_x").select(ROWCOLS).in("sec_uid", jrows.map(r => r.sec_uid));
    const fitBy = new Map(jrows.map(r => [r.sec_uid, r.fit_score]));
    const order = new Map(jrows.map((r, i) => [r.sec_uid, i]));
    const merged = ((full ?? []) as Omit<Match, "similarity">[])
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

  return (
    <div className="wp">
      <Link to="/jobs" className="backlink">← Jobs</Link>
      <div className="eyebrow">{job.subject || "Job"}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ flex: 1 }}>{job.title}<span className="pill" style={{ background: STATUS[job.status] || "#8A8F9C", color: "#fff", marginLeft: 10, fontSize: 13, verticalAlign: "middle" }}>{job.status}</span></h1>
        <button className="dirbtn" style={{ width: "auto", padding: "0 14px", height: 34 }} onClick={() => setEditing(true)}>Edit job</button>
      </div>
      {editing && <CreateJob job={job} onClose={() => setEditing(false)} onSaved={async () => { setEditing(false); await reloadJob(); }} />}

      <div className="jobmeta">
        {(job.earning_min != null || job.earning_max != null) && <div className="jm"><div className="k">Payout</div><div className="v">€{job.earning_min ?? 0}–{job.earning_max ?? "?"}</div></div>}
        {job.view_goal != null && <div className="jm"><div className="k">View goal</div><div className="v">{fmt(job.view_goal)}</div></div>}
        <div className="jm"><div className="k">Members</div><div className="v">{members.length}</div></div>
        <div className="jm"><div className="k">Campaigns set</div><div className="v">{[job.campaign_google, job.campaign_outlook, job.campaign_custom].filter(Boolean).length}/3</div></div>
      </div>

      {job.briefing && <details className="jobbrief"><summary><b>Briefing</b></summary><div style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{job.briefing}</div></details>}

      <div className="listhead" style={{ marginTop: 16 }}>
        <b>{members.length}</b><span>members</span>
        <span className="grow" />
        <Link className="dirbtn" style={{ width: "auto", padding: "0 12px", textDecoration: "none", display: "inline-flex", alignItems: "center" }} to="/search">＋ Source in Search</Link>
        <button className="sbtn2" onClick={generate} disabled={!members.length || generating}>
          <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2l1.6 4.4L18 8l-4.4 1.6L12 14l-1.6-4.4L6 8l4.4-1.6L12 2z"/></svg>{generating ? "Generating…" : "Generate emails"}
        </button>
      </div>

      {notice && <div className="notice">{notice}</div>}

      <div className="rows">
        {members.length === 0 ? <div className="empty">No members yet. Source creators in <Link to="/search" style={{ color: "var(--wp-accink)" }}>Search</Link> (semantic, filters, or lookalike) and “Add to job”.</div>
          : members.map(m => {
            const em = emails[m.sec_uid];
            const isOpen = open === m.sec_uid;
            return (
            <div key={m.sec_uid}>
              <div className={"crow" + (m.is_songpush_user ? " wepush" : "")} style={{ cursor: em ? "pointer" : "default" }} onClick={() => em && setOpen(isOpen ? null : m.sec_uid)}>
                <Mono r={m} />
                <div className="idcol">
                  <div className="nm">{m.display_name || m.handle}<span className="pf" title={m.platform === "instagram" ? "Instagram" : "TikTok"}><PlatIcon p={m.platform} /></span></div>
                  <div className="hd">@{m.handle}</div>
                  <div className="tags">
                    {m.category && <span className="pill cat">{m.category}</span>}
                    {(m.content_format || []).slice(0, 2).map(f => <span key={f} className="pill">{f}</span>)}
                    {m.persona && <span className="pill ghost">{PERSONA[m.persona] || m.persona}</span>}
                    {(m.original_sound_ratio ?? 0) >= 0.5 && <span className="pill ghost">🎤 speaks</span>}
                    {em && <span className="pill" style={{ background: "var(--wp-acc)", color: "#fff" }}>✉ email {isOpen ? "▲" : "▼"}</span>}
                  </div>
                </div>
                <div className="metrics">
                  <div className="metric"><div className="v num">{fmt(m.follower_count)}</div><div className="k">Followers</div></div>
                  <div className="metric"><div className={"v num " + erClass(m.engagement_median)}>{m.engagement_median ?? "—"}%</div><div className="k">ER</div></div>
                  <div className="metric"><div className="v num">{fmt(m.avg_views)}</div><div className="k">Avg views</div></div>
                  {m.similarity >= 0 && <div className="metric"><div className="v num" style={{ color: "var(--wp-acc)" }}>{Math.round(m.similarity * 100)}</div><div className="k">Fit</div></div>}
                  {m.email && <span className="mail-dot" title={m.email_difficulty && DIFF[m.email_difficulty] ? `Email · ${DIFF[m.email_difficulty].label} to reach` : "Email available"} style={m.email_difficulty && DIFF[m.email_difficulty] ? { background: DIFF[m.email_difficulty].color } : undefined} />}
                  <a className="iconbtn" href={profileUrl(m)} target="_blank" rel="noreferrer" title="Open profile" onClick={e => e.stopPropagation()}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M7 17 17 7M9 7h8v8"/></svg></a>
                </div>
              </div>
              {em && isOpen && (
                <div className="emailprev">
                  <div className="ep-label">Subject</div>
                  <div className="ep-sub">{em.subject}</div>
                  <div className="ep-body">{em.icebreaker}{"\n\n"}{em.pitch}</div>
                </div>
              )}
            </div>
            );
          })}
      </div>
    </div>
  );
}
