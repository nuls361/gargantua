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
type Match = {
  sec_uid: string; handle: string; display_name: string | null; category: string | null; market: string | null;
  follower_count: number | null; engagement_median: number | null; avatar_url: string | null; email: string | null;
  email_provider: string | null; email_difficulty: string | null; similarity: number;
};

const CAT_HUE: Record<string, number> = { beauty:330,wellness:160,fitness:14,fashion:280,food:26,travel:200,gaming:250,tech:210,finance:150,music:190,comedy:45,parenting:340,"home & interior":175,sustainability:135,relationship:350,dance:300,pets:32,cars:220,education:230,art:265,lifestyle:255 };
const catColor = (c: string | null) => c && CAT_HUE[c] != null ? `hsl(${CAT_HUE[c]} 55% 50%)` : "#8A8F9C";
const fmt = (n: number | null) => n == null ? "—" : n >= 1e6 ? `${(n/1e6).toFixed(1)}m` : n >= 1e3 ? `${(n/1e3).toFixed(n>=1e5?0:1)}k` : `${n}`;
const initials = (m: { display_name: string | null; handle: string }) => ((m.display_name || m.handle).replace(/[^\p{L}\p{N} ]/gu,"").trim().split(/\s+/).map(w=>w[0]).slice(0,2).join("").toUpperCase() || m.handle[0]?.toUpperCase() || "?");
const PROV: Record<string, { label: string; color: string }> = {
  google:{label:"Google",color:"#D9600F"}, microsoft:{label:"Outlook",color:"#C0341D"},
  icloud:{label:"iCloud",color:"#4E9F2E"}, gmx_webde:{label:"GMX/Web",color:"#8A9A1B"},
  yahoo_aol:{label:"Yahoo",color:"#C2860B"}, other:{label:"Custom",color:"#12A150"}, tonline:{label:"t-online",color:"#6B7280"},
};
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

function CreateJob({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("");
  const [briefing, setBriefing] = useState("");
  const [samples, setSamples] = useState("");
  const [deliverable, setDeliverable] = useState("");
  const [earnMin, setEarnMin] = useState(""); const [earnMax, setEarnMax] = useState("");
  const [viewGoal, setViewGoal] = useState("");
  const [market, setMarket] = useState("dach");
  const [follMin, setFollMin] = useState(""); const [follMax, setFollMax] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!title.trim()) { setErr("Give the job a title."); return; }
    setSaving(true); setErr(null);
    const { data, error } = await supabase.from("jobs").insert({
      title: title.trim(), subject: subject.trim() || null, briefing: briefing.trim() || null,
      sample_creators: parseHandles(samples), deliverable: deliverable.trim() || null,
      earning_min: earnMin ? Number(earnMin) : null, earning_max: earnMax ? Number(earnMax) : null,
      view_goal: viewGoal ? Number(viewGoal) : null,
      target_market: market || null, foll_min: follMin ? Number(follMin) : null, foll_max: follMax ? Number(follMax) : null,
    }).select("id").single();
    setSaving(false);
    if (error) { setErr(error.message); return; }
    onSaved((data as { id: string }).id);
  }

  return (
    <div className="wp-scrim" onClick={onClose}>
      <div className="wp-panel jobform" onClick={e => e.stopPropagation()}>
        <div className="p-head"><div><div className="eyebrow">New job</div><h2 style={{ margin: 0 }}>From a brand brief</h2></div><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="fcard" style={{ marginTop: 12 }}>
          <div className="field"><label>Job title *</label><input className="inp" placeholder="ABOUT YOU – Fashion Inspiration" value={title} onChange={e => setTitle(e.target.value)} /></div>
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

  useEffect(() => {
    void (async () => {
      const { data } = await supabase.from("jobs").select("*").eq("id", id).single();
      setJob(data as Job); setLoading(false);
      const { count } = await supabase.from("job_creators").select("sec_uid", { count: "exact", head: true }).eq("job_id", id);
      setSavedCount(count ?? 0);
    })();
  }, [id]);

  const runMatch = useCallback(async () => {
    if (!job) return;
    setMatching(true); setNotice(null);
    const { data, error } = await supabase.rpc("match_job_by_samples", {
      sample_handles: job.sample_creators || [], p_market: job.target_market,
      p_foll_min: job.foll_min, p_foll_max: job.foll_max, p_count: 100,
    });
    if (error) setNotice(error.message);
    else setMatches((data ?? []) as Match[]);
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
      <h1>{job.title}<span className="pill" style={{ background: STATUS[job.status] || "#8A8F9C", color: "#fff", marginLeft: 10, fontSize: 13, verticalAlign: "middle" }}>{job.status}</span></h1>

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
        <button className="sbtn2" onClick={saveMatches} disabled={!matches.length}>Save matches to job</button>
      </div>

      {notice && <div className="notice">{notice}</div>}

      <div className="rows">
        {matching ? <div className="empty">Matching lookalikes…</div>
          : !(job.sample_creators || []).length ? <div className="empty">No sample creators on this job — add some to match.</div>
          : matches.length === 0 ? <div className="empty">No matches (none of the sample handles are in the pool yet).</div>
          : matches.map(m => (
            <div key={m.sec_uid} className="crow">
              <div className="mono" style={{ background: catColor(m.category) }}>{initials(m)}{m.avatar_url && <img src={m.avatar_url} alt="" onError={e => { e.currentTarget.style.display = "none"; }} />}</div>
              <div className="idcol">
                <div className="nm">{m.display_name || m.handle}</div>
                <div className="hd">@{m.handle}</div>
                <div className="tags">
                  {m.category && <span className="pill cat">{m.category}</span>}
                  {m.market && <span className="pill ghost">{m.market.toUpperCase()}</span>}
                  {m.email_provider && PROV[m.email_provider] && <span className="pill" style={{ background: PROV[m.email_provider].color, color: "#fff" }}>{PROV[m.email_provider].label}</span>}
                </div>
              </div>
              <div className="metrics">
                <div className="metric"><div className="v num">{fmt(m.follower_count)}</div><div className="k">Followers</div></div>
                <div className="metric"><div className="v num">{m.engagement_median ?? "—"}%</div><div className="k">ER</div></div>
                <div className="metric"><div className="v num" style={{ color: "var(--wp-acc)" }}>{Math.round(m.similarity * 100)}</div><div className="k">Fit</div></div>
                <a className="iconbtn" href={`https://www.tiktok.com/@${m.handle}`} target="_blank" rel="noreferrer" title="Open profile"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M7 17 17 7M9 7h8v8"/></svg></a>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
