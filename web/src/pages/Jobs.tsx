import { useCallback, useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { supabase } from "../lib/supabase";

// Jobs — the campaign-driven outreach unit. A job holds a brief, the sample creators
// the brand likes (→ lookalike match), earning, and targeting. Replaces working Lists.

type Job = {
  id: string; title: string; status: string; subject: string | null; briefing: string | null;
  sample_creators: string[] | null; deliverable: string | null;
  earning_model: string | null; earning_min: number | null; earning_max: number | null; view_goal: number | null;
  target_market: string | null; foll_min: number | null; foll_max: number | null;
  instantly_campaign_id: string | null; created_at: string;
};
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

// Pull a handle out of a pasted line: URL, @handle, or plain.
function parseHandles(text: string): string[] {
  return text.split(/[\n,]+/).map(line => {
    const t = line.trim();
    if (!t) return "";
    const m = t.match(/(?:tiktok\.com\/@|instagram\.com\/)([\w.]+)/i);
    return (m ? m[1] : t).replace(/^@+/, "").trim();
  }).filter(Boolean);
}

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
  const [samples, setSamples] = useState((job?.sample_creators ?? []).join("\n"));
  const [deliverable, setDeliverable] = useState(job?.deliverable ?? "");
  const [earnMin, setEarnMin] = useState(job?.earning_min != null ? String(job.earning_min) : "");
  const [earnMax, setEarnMax] = useState(job?.earning_max != null ? String(job.earning_max) : "");
  const [viewGoal, setViewGoal] = useState(job?.view_goal != null ? String(job.view_goal) : "");
  const [market, setMarket] = useState(job?.target_market ?? "dach");
  const [follMin, setFollMin] = useState(job?.foll_min != null ? String(job.foll_min) : "");
  const [follMax, setFollMax] = useState(job?.foll_max != null ? String(job.foll_max) : "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!title.trim()) { setErr("Give the job a title."); return; }
    setSaving(true); setErr(null);
    const payload = {
      title: title.trim(), status, subject: subject.trim() || null, briefing: briefing.trim() || null,
      sample_creators: parseHandles(samples), deliverable: deliverable.trim() || null,
      earning_min: earnMin ? Number(earnMin) : null, earning_max: earnMax ? Number(earnMax) : null,
      view_goal: viewGoal ? Number(viewGoal) : null,
      target_market: market || null, foll_min: follMin ? Number(follMin) : null, foll_max: follMax ? Number(follMax) : null,
    };
    const res = job
      ? await supabase.from("jobs").update(payload).eq("id", job.id).select("id").single()
      : await supabase.from("jobs").insert(payload).select("id").single();
    setSaving(false);
    if (res.error) { setErr(res.error.message); return; }
    onSaved((res.data as { id: string }).id);
  }

  return (
    <div className="wp-scrim" onClick={onClose}>
      <div className="wp-panel jobform" onClick={e => e.stopPropagation()}>
        <div className="p-head"><div><div className="eyebrow">{job ? "Edit job" : "New job"}</div><h2 style={{ margin: 0 }}>{job ? title || "Job" : "From a brand brief"}</h2></div><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="fcard" style={{ marginTop: 12 }}>
          <div className="fgrid" style={{ gridTemplateColumns: job ? "2fr 1fr" : "1fr" }}>
            <div className="field"><label>Job title *</label><input className="inp" placeholder="ABOUT YOU – Fashion Inspiration" value={title} onChange={e => setTitle(e.target.value)} /></div>
            {job && <div className="field"><label>Status</label><select value={status} onChange={e => setStatus(e.target.value)}><option value="draft">Draft</option><option value="active">Active</option><option value="paused">Paused</option><option value="closed">Closed</option></select></div>}
          </div>
          <div className="field"><label>Brand / artist / song</label><input className="inp" placeholder="ABOUT YOU" value={subject} onChange={e => setSubject(e.target.value)} /></div>
          <div className="field"><label>Briefing</label><textarea className="inp" rows={5} placeholder="Paste the full brief — deliverable, hooks, do's & don'ts, voucher/CTA…" value={briefing} onChange={e => setBriefing(e.target.value)} /></div>
          <div className="field"><label>Sample creators the brand likes <span style={{ color: "var(--wp-muted)" }}>(handles or profile URLs, one per line → lookalike match)</span></label><textarea className="inp" rows={4} placeholder={"@thatsonyi\nhttps://www.tiktok.com/@alicelich\ncassyverse_"} value={samples} onChange={e => setSamples(e.target.value)} /></div>
          <div className="field"><label>Deliverable</label><input className="inp" placeholder="<30s video, strong hook, tag @aboutyou, voucher CTA" value={deliverable} onChange={e => setDeliverable(e.target.value)} /></div>
          <div className="fsec">Earning (WePush view-goal model)</div>
          <div className="fgrid">
            <div className="field"><label>Payout min €</label><input className="inp num" placeholder="40" value={earnMin} onChange={e => setEarnMin(e.target.value)} /></div>
            <div className="field"><label>Payout max €</label><input className="inp num" placeholder="500" value={earnMax} onChange={e => setEarnMax(e.target.value)} /></div>
            <div className="field"><label>View goal</label><input className="inp num" placeholder="e.g. 50000" value={viewGoal} onChange={e => setViewGoal(e.target.value)} /></div>
          </div>
          <div className="fsec">Targeting</div>
          <div className="fgrid">
            <div className="field"><label>Market</label><select value={market} onChange={e => setMarket(e.target.value)}><option value="">Any</option><option value="dach">DACH</option><option value="uk">UK</option><option value="us">US</option></select></div>
            <div className="field"><label>Followers min</label><input className="inp num" placeholder="1000" value={follMin} onChange={e => setFollMin(e.target.value)} /></div>
            <div className="field"><label>Followers max</label><input className="inp num" placeholder="250000" value={follMax} onChange={e => setFollMax(e.target.value)} /></div>
          </div>
          {err && <div className="notice err" style={{ marginTop: 10 }}>{err}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button className="sbtn2" onClick={save} disabled={saving}>{saving ? "Creating…" : "Create job & match"}</button>
            <button className="dirbtn" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function JobDetail({ id }: { id: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [matches, setMatches] = useState<Match[]>([]);
  const [loading, setLoading] = useState(true);
  const [matching, setMatching] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [emails, setEmails] = useState<Record<string, { subject: string; icebreaker: string; pitch: string }>>({});
  const [generating, setGenerating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const reloadJob = useCallback(async () => {
    const { data } = await supabase.from("jobs").select("*").eq("id", id).single();
    setJob(data as Job);
  }, [id]);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase.from("jobs").select("*").eq("id", id).single();
      setJob(data as Job); setLoading(false);
      const { count } = await supabase.from("job_creators").select("sec_uid", { count: "exact", head: true }).eq("job_id", id);
      setSavedCount(count ?? 0);
      const { data: jc } = await supabase.from("job_creators").select("sec_uid,ai_subject,ai_icebreaker,ai_pitch").eq("job_id", id).not("ai_subject", "is", null);
      setEmails(Object.fromEntries(((jc ?? []) as { sec_uid: string; ai_subject: string; ai_icebreaker: string; ai_pitch: string }[])
        .map(r => [r.sec_uid, { subject: r.ai_subject, icebreaker: r.ai_icebreaker, pitch: r.ai_pitch }])));
    })();
  }, [id]);

  async function generate() {
    if (!matches.length) return;
    setGenerating(true); setNotice(null);
    const ids = matches.slice(0, 20).map(m => m.sec_uid);
    const { data, error } = await supabase.functions.invoke("generate-job-emails", { body: { job_id: id, sec_uids: ids } });
    if (error) setNotice(error.message);
    else {
      const map = { ...emails };
      for (const e of ((data?.emails ?? []) as { sec_uid: string; subject: string; icebreaker: string; pitch: string }[]))
        map[e.sec_uid] = { subject: e.subject, icebreaker: e.icebreaker, pitch: e.pitch };
      setEmails(map);
      setSavedCount(Object.keys(map).length);
      setNotice(`Generated ${(data?.emails ?? []).length} personalized emails.`);
    }
    setGenerating(false);
  }

  const runMatch = useCallback(async () => {
    if (!job) return;
    setMatching(true); setNotice(null);
    const { data, error } = await supabase.rpc("match_job_by_samples", {
      sample_handles: job.sample_creators || [], p_market: job.target_market,
      p_foll_min: job.foll_min, p_foll_max: job.foll_max, p_count: 100,
    });
    if (error) { setNotice(error.message); setMatching(false); return; }
    const ranked = (data ?? []) as { sec_uid: string; similarity: number }[];
    if (!ranked.length) { setMatches([]); setMatching(false); return; }
    const sim = new Map(ranked.map(r => [r.sec_uid, r.similarity]));
    // pull the full rows (same fields as Search) so the rows render identically
    const { data: full } = await supabase.from("tt_creators_x").select(ROWCOLS).in("sec_uid", ranked.map(r => r.sec_uid));
    const rows = ((full ?? []) as Omit<Match, "similarity">[])
      .map(r => ({ ...r, similarity: sim.get(r.sec_uid) ?? 0 }))
      .sort((a, b) => b.similarity - a.similarity);
    setMatches(rows);
    setMatching(false);
  }, [job]);

  useEffect(() => { if (job && (job.sample_creators || []).length) void runMatch(); }, [job, runMatch]);

  async function saveMatches() {
    if (!matches.length) return;
    const rows = matches.map(m => ({ job_id: id, sec_uid: m.sec_uid, handle: m.handle, fit_score: m.similarity, state: "matched" }));
    const { error } = await supabase.from("job_creators").upsert(rows, { onConflict: "job_id,sec_uid", ignoreDuplicates: false });
    if (error) { setNotice(error.message); return; }
    setSavedCount(rows.length);
    setNotice(`Saved ${rows.length} matched creators to this job.`);
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
        <div className="jm"><div className="k">Market</div><div className="v">{job.target_market?.toUpperCase() || "Any"}</div></div>
        <div className="jm"><div className="k">Followers</div><div className="v">{job.foll_min ? fmt(job.foll_min) : "0"}–{job.foll_max ? fmt(job.foll_max) : "∞"}</div></div>
        <div className="jm"><div className="k">Samples</div><div className="v">{(job.sample_creators || []).length}</div></div>
      </div>

      {job.deliverable && <div className="jobbrief"><b>Deliverable:</b> {job.deliverable}</div>}
      {job.briefing && <details className="jobbrief"><summary><b>Briefing</b></summary><div style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{job.briefing}</div></details>}

      <div className="listhead" style={{ marginTop: 16 }}>
        <b>{matches.length}</b><span>lookalike matches</span>
        <span style={{ color: "var(--wp-muted)", fontSize: 13, marginLeft: 8 }}>agencies excluded · email-ready only</span>
        <span className="grow" />
        {savedCount > 0 && <span className="pill" style={{ background: "var(--wp-good)", color: "#fff", marginRight: 8 }}>{savedCount} saved</span>}
        <button className="dirbtn" style={{ width: "auto", padding: "0 12px" }} onClick={saveMatches} disabled={!matches.length}>Save matches</button>
        <button className="sbtn2" onClick={generate} disabled={!matches.length || generating}>
          <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2l1.6 4.4L18 8l-4.4 1.6L12 14l-1.6-4.4L6 8l4.4-1.6L12 2z"/></svg>{generating ? "Generating…" : "Generate emails"}
        </button>
      </div>

      {notice && <div className="notice">{notice}</div>}

      <div className="rows">
        {matching ? <div className="empty">Matching lookalikes…</div>
          : !(job.sample_creators || []).length ? <div className="empty">No sample creators on this job — add some to match.</div>
          : matches.length === 0 ? <div className="empty">No matches (none of the sample handles are in the pool yet).</div>
          : matches.map(m => {
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
                  <div className="metric"><div className="v num" style={{ color: "var(--wp-acc)" }}>{Math.round(m.similarity * 100)}</div><div className="k">Fit</div></div>
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
