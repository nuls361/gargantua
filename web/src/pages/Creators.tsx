import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { Detail } from "../components/CreatorPanel";

// Search — the one creator database. Semantic (embeddings) / factual filters / lookalike filter.

type Row = {
  sec_uid: string; handle: string; display_name: string | null; bio: string | null;
  follower_count: number | null; engagement_median: number | null; avg_views: number | null; avg_views_pinned: number | null;
  posting_per_week: number | null; video_count: number | null; sponsored_count: number | null; avatar_url: string | null;
  category: string | null; category_secondary: string | null; content_format: string[] | null;
  persona: string | null; audience_lang: string | null; original_sound_ratio: number | null;
  comment_substance_ratio: number | null; comment_lang_match: number | null; creator_reply_rate: number | null;
  top_hashtags: string[] | null; profile_summary: string | null;
  email: string | null; email_type: string | null; email_difficulty: string | null; market: string | null;
  source_type: string | null; source_value: string | null; source_brand: string | null;
  is_songpush_user: boolean | null; songpush_admin_url: string | null; platform: string | null;
  brands_worked_with: string[] | null; last_placement_at: string | null;
};
type JobOpt = { id: string; name: string };

const COLS =
  "sec_uid,handle,display_name,bio,follower_count,engagement_median,avg_views,avg_views_pinned,posting_per_week,video_count,sponsored_count,avatar_url,category,category_secondary,content_format,persona,audience_lang,original_sound_ratio,comment_substance_ratio,comment_lang_match,creator_reply_rate,top_hashtags,profile_summary,email,email_type,email_difficulty,market,source_type,source_value,source_brand,is_songpush_user,songpush_admin_url,platform,brands_worked_with,last_placement_at";
const PAGE = 25;
const TOPICS = ["beauty","wellness","fitness","fashion","food","travel","gaming","tech","finance","music","comedy","parenting","home & interior","sustainability","relationship","dance","pets","cars","education","art","lifestyle"];
const FORMATS = ["grwm","tutorial","vlog","day-in-life","storytime","talking-head","pov","skit","haul","review","recipe","transformation","dance","lip-sync","get-ready","unboxing","asmr"];
const CAT_HUE: Record<string, number> = { beauty:330,wellness:160,fitness:14,fashion:280,food:26,travel:200,gaming:250,tech:210,finance:150,music:190,comedy:45,parenting:340,"home & interior":175,sustainability:135,relationship:350,dance:300,pets:32,cars:220,education:230,art:265,lifestyle:255 };
const PERSONA: Record<string, string> = { solo:"Solo", couple:"Couple", family:"Family", group:"Group" };
// Cold-email deliverability by recipient provider (easiest → hardest). Label + colour.
const DIFF_ORDER = ["very_easy","easy","easy_medium","medium","hard","very_hard","skip"];
const DIFF: Record<string, { label: string; color: string }> = {
  very_easy:   { label: "Very easy",   color: "#12A150" },
  easy:        { label: "Easy",        color: "#4E9F2E" },
  easy_medium: { label: "Easy–med",    color: "#8A9A1B" },
  medium:      { label: "Medium",      color: "#C2860B" },
  hard:        { label: "Hard",        color: "#D9600F" },
  very_hard:   { label: "Very hard",   color: "#C0341D" },
  skip:        { label: "Skip · t-online", color: "#6B7280" },
};

const fmt = (n: number | null) => n == null ? "—" : n >= 1e6 ? `${(n/1e6).toFixed(n>=1e7?0:1).replace(/\.0$/,"")}m` : n >= 1e3 ? `${(n/1e3).toFixed(n>=1e5?0:1).replace(/\.0$/,"")}k` : `${n}`;
const catColor = (c: string | null) => `hsl(${(c && CAT_HUE[c]) ?? 255} 62% 52%)`;
const initials = (r: Row) => ((r.display_name || r.handle).replace(/[^\p{L}\p{N} ]/gu, "").trim().split(/\s+/).map(w=>w[0]).slice(0,2).join("").toUpperCase() || r.handle[0].toUpperCase());
const erClass = (e: number | null) => e == null ? "" : e < 2 ? "er-bad" : e > 14 ? "er-warn" : "er-good";

function PlatIcon({ p }: { p: string | null }) {
  return p === "instagram"
    ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1.1" fill="currentColor" stroke="none"/></svg>
    : <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.6 5.82A4.28 4.28 0 0 1 15.54 3h-3.2v12.9a2.59 2.59 0 1 1-2.03-2.53v-3.26a5.76 5.76 0 1 0 5.03 5.71V8.9a7.5 7.5 0 0 0 4.3 1.34V7.06a4.28 4.28 0 0 1-2.99-1.24z"/></svg>;
}
const profileUrl = (r: Row) => r.platform === "instagram" ? `https://www.instagram.com/${r.handle}` : `https://www.tiktok.com/@${r.handle}`;
// Parse sample-creator handles out of pasted lines (URL, @handle, or plain).
function parseHandles(text: string): string[] {
  return text.split(/[\n,]+/).map(line => {
    const t = line.trim(); if (!t) return "";
    const m = t.match(/(?:tiktok\.com\/@|instagram\.com\/)([\w.]+)/i);
    return (m ? m[1] : t).replace(/^@+/, "").trim();
  }).filter(Boolean);
}

function Mono({ r, big }: { r: Row; big?: boolean }) {
  return (
    <div className="mono" style={{ background: catColor(r.category), ...(big ? { width: 52, height: 52, fontSize: 19, borderRadius: 14 } : {}) }}>
      {initials(r)}
      {r.avatar_url && <img src={r.avatar_url} alt="" onError={(e) => { e.currentTarget.style.display = "none"; }} />}
    </div>
  );
}

export default function Search() {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [mode, setMode] = useState<"semantic" | "factual">("semantic");
  const [prompt, setPrompt] = useState("");
  const [pDeb, setPDeb] = useState("");
  const [semIds, setSemIds] = useState<string[]>([]);
  const [semLoading, setSemLoading] = useState(false);
  const [lookalike, setLookalike] = useState("");
  const [lookDeb, setLookDeb] = useState("");
  const [lookIds, setLookIds] = useState<string[]>([]);
  const [lookLoading, setLookLoading] = useState(false);
  const [adv, setAdv] = useState(false);

  // filters
  const [market, setMarket] = useState("");
  const [platform, setPlatform] = useState("");
  const [category, setCategory] = useState("");
  const [format, setFormat] = useState("");
  const [follMin, setFollMin] = useState(""); const [follMax, setFollMax] = useState("");
  const [erMin, setErMin] = useState(""); const [erMax, setErMax] = useState("");
  const [viewsMin, setViewsMin] = useState("");
  const [persona, setPersona] = useState("");
  const [lang, setLang] = useState("");
  const [speak, setSpeak] = useState(false);
  const [vcMin, setVcMin] = useState(""); const [vcMax, setVcMax] = useState("");
  const [postMin, setPostMin] = useState("");
  const [src, setSrc] = useState("");
  const [srcVal, setSrcVal] = useState("");
  const [srcOpts, setSrcOpts] = useState<{ v: string; n: number }[]>([]);
  const [onmarket, setOnmarket] = useState(false);
  const [engaged, setEngaged] = useState(false);
  const [responsive, setResponsive] = useState(false);
  const [adMin, setAdMin] = useState("");
  const [etype, setEtype] = useState("");
  const [exclWp, setExclWp] = useState(false);
  const [contact, setContact] = useState("");
  const [emailDiff, setEmailDiff] = useState("");
  const [sortKey, setSortKey] = useState("fit");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // take + send
  const [takeN, setTakeN] = useState("");
  const [jobSel, setJobSel] = useState("__new");
  const [newJobTitle, setNewJobTitle] = useState("");
  const [jobOpts, setJobOpts] = useState<JobOpt[]>([]);
  const [sending, setSending] = useState(false);

  const [panel, setPanel] = useState<Row | null>(null);

  useEffect(() => { const t = setTimeout(() => setPDeb(prompt), 300); return () => clearTimeout(t); }, [prompt]);
  useEffect(() => { const t = setTimeout(() => setLookDeb(lookalike), 400); return () => clearTimeout(t); }, [lookalike]);
  const lookHandles = parseHandles(lookDeb);
  const lookActive = lookHandles.length > 0;
  const loadJobOpts = useCallback(() => {
    supabase.from("jobs").select("id,title").order("created_at", { ascending: false })
      .then(({ data }) => setJobOpts(((data ?? []) as { id: string; title: string }[]).map(j => ({ id: j.id, name: j.title }))));
  }, []);
  useEffect(() => { loadJobOpts(); }, [loadJobOpts]);
  // Deep-link from a job's "Find lookalikes →": prefill the lookalike filter.
  useEffect(() => {
    const like = new URLSearchParams(window.location.search).get("like");
    if (like) { setLookalike(like); setAdv(true); }
  }, []);

  const withFilters = useCallback(<T,>(qb: T): T => {
    let q = qb as any;
    if (contact === "never") q = q.is("last_contacted_at", null);
    else if (contact) q = q.lte("last_contacted_at", new Date(Date.now() - Number(contact) * 86400000).toISOString());
    // Semantic mode: constrain to the AI-ranked nearest creators, then let the
    // same factual filters below refine them (market, follower band, ER, …).
    if (mode === "semantic" && pDeb.trim()) {
      q = q.in("sec_uid", semIds.length ? semIds : ["__none__"]);
    }
    // Lookalike advanced filter: constrain to creators similar to the pasted samples.
    // Composes (intersects) with semantic + all factual filters below.
    if (lookActive) {
      q = q.in("sec_uid", lookIds.length ? lookIds : ["__none__"]);
    }
    if (market) q = q.eq("market", market);
    if (platform) q = q.eq("platform", platform);
    if (category) q = q.or(`category.eq.${category},category_secondary.eq.${category}`);
    if (format) q = q.contains("content_format", [format]);
    if (follMin) q = q.gte("follower_count", Number(follMin));
    if (follMax) q = q.lte("follower_count", Number(follMax));
    if (erMin) q = q.gte("engagement_median", Number(erMin));
    if (erMax) q = q.lte("engagement_median", Number(erMax));
    if (viewsMin) q = q.gte("avg_views", Number(viewsMin));
    if (persona) q = q.eq("persona", persona);
    if (lang) q = q.eq("audience_lang", lang);
    if (speak) q = q.gte("original_sound_ratio", 0.4);
    if (vcMin) q = q.gte("video_count", Number(vcMin));
    if (vcMax) q = q.lte("video_count", Number(vcMax));
    if (postMin) q = q.gte("posting_per_week", Number(postMin));
    if (src) q = q.eq("source_type", src);
    if (srcVal) q = q.eq("source_value", srcVal);
    if (onmarket) q = q.gte("comment_lang_match", 0.5);
    if (engaged) q = q.gte("comment_substance_ratio", 0.6);
    if (responsive) q = q.gte("creator_reply_rate", 0.15);
    if (adMin) q = q.gte("sponsored_count", Number(adMin));
    if (etype) q = q.eq("email_type", etype);
    if (emailDiff) q = q.in("email_difficulty", DIFF_ORDER.slice(0, DIFF_ORDER.indexOf(emailDiff) + 1));
    if (exclWp) q = q.or("is_songpush_user.is.null,is_songpush_user.eq.false");
    return q as T;
  }, [mode, pDeb, semIds, lookActive, lookIds, market, platform, category, format, follMin, follMax, erMin, erMax, viewsMin, persona, lang, speak, vcMin, vcMax, postMin, src, srcVal, onmarket, engaged, responsive, adMin, etype, emailDiff, exclWp, contact]);

  // Lookalike: compute the centroid of the pasted samples and get the nearest creators (ranked).
  useEffect(() => {
    if (!lookActive) { setLookIds([]); return; }
    let cancelled = false;
    setLookLoading(true);
    void (async () => {
      const { data, error: err } = await supabase.rpc("lookalike_ids", { sample_handles: lookHandles, p_count: 500 });
      if (cancelled) return;
      if (err) setLookIds([]);
      else setLookIds(((data ?? []) as { sec_uid: string }[]).map(r => r.sec_uid));
      setLookLoading(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookDeb]);

  // Semantic search: embed the prompt server-side (OpenAI, via the edge fn) and
  // get back the cosine-nearest creators, ranked. semIds drives withFilters above.
  useEffect(() => {
    if (mode !== "semantic") { setSemIds([]); return; }
    const p = pDeb.trim();
    if (!p) { setSemIds([]); return; }
    let cancelled = false;
    setSemLoading(true);
    void (async () => {
      const { data, error: err } = await supabase.functions.invoke("semantic-search", { body: { prompt: p, match_count: 400 } });
      if (cancelled) return;
      if (err) { setError(err.message); setSemIds([]); }
      else setSemIds((data?.ids ?? []) as string[]);
      setSemLoading(false);
    })();
    return () => { cancelled = true; };
  }, [mode, pDeb]);

  // When "Found via" type changes, load the specific sources (brands/hashtags/…) to pick from.
  useEffect(() => {
    setSrcVal("");
    if (!src) { setSrcOpts([]); return; }
    void (async () => {
      const { data } = await supabase.from("source_overview")
        .select("source_value,creators_found").eq("source_type", src)
        .order("creators_found", { ascending: false }).limit(500);
      setSrcOpts(((data ?? []) as { source_value: string; creators_found: number }[])
        .filter(r => r.source_value).map(r => ({ v: r.source_value, n: r.creators_found })));
    })();
  }, [src]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const sk = sortKey === "fit" ? "follower_count" : sortKey;
    const semActive = mode === "semantic" && pDeb.trim().length > 0;
    // Either an embedding ranking (semantic prompt) or the lookalike filter drives a
    // client-side ranked path; lookalike takes priority for "Best match" ordering.
    const rankActive = semActive || lookActive;
    const rankIds = lookActive ? lookIds : semIds;

    if (rankActive) {
      // Wait for / handle the ranking, then sort + paginate client-side so
      // "Best match" preserves cosine relevance (Postgres can't order by an id list).
      if (!rankIds.length) { setRows([]); setTotal(0); setLoading(false); return; }
      const { data, error: err } = await withFilters(supabase.from("tt_creators_x").select(COLS)).limit(500);
      if (err) { setError(err.message); setRows([]); setTotal(0); setLoading(false); return; }
      let rs = (data ?? []) as Row[];
      if (sortKey === "fit") {
        const rank = new Map(rankIds.map((id, i) => [id, i]));
        rs = rs.slice().sort((a, b) => (rank.get(a.sec_uid) ?? 1e9) - (rank.get(b.sec_uid) ?? 1e9));
      } else {
        rs = rs.slice().sort((a, b) => {
          const av = Number((a as Record<string, unknown>)[sk] ?? 0), bv = Number((b as Record<string, unknown>)[sk] ?? 0);
          return sortDir === "asc" ? av - bv : bv - av;
        });
      }
      setTotal(rs.length);
      setRows(rs.slice(page * PAGE, page * PAGE + PAGE));
      setLoading(false);
      return;
    }

    const q = withFilters(supabase.from("tt_creators_x").select(COLS, { count: "exact" }))
      .order(sk, { ascending: sortDir === "asc", nullsFirst: false })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    const { data, count, error: err } = await q;
    if (err) setError(err.message);
    else { setRows((data ?? []) as Row[]); setTotal(count ?? 0); }
    setLoading(false);
  }, [withFilters, sortKey, sortDir, page, mode, pDeb, semIds, lookActive, lookIds]);

  useEffect(() => { setPage(0); }, [withFilters, sortKey, sortDir]);
  useEffect(() => { void load(); }, [load]);

  async function send() {
    setSending(true); setError(null); setNotice(null);
    try {
      let jobId = ""; let jobName = "";
      if (jobSel === "__new") {
        const name = newJobTitle.trim(); if (!name) throw new Error("Enter a job title.");
        const { data, error } = await supabase.from("jobs").insert({ title: name }).select("id,title").single();
        if (error) throw error; jobId = data.id; jobName = data.title;
      } else {
        jobId = jobSel; jobName = jobOpts.find(l => l.id === jobSel)?.name ?? "job";
      }
      const cap = takeN ? Math.max(1, Number(takeN)) : 5000;
      const sk = sortKey === "fit" ? "follower_count" : sortKey;
      const rankActive = (mode === "semantic" && pDeb.trim().length > 0) || lookActive;
      const rankIds = lookActive ? lookIds : semIds;
      let srcRows: Row[];
      if (rankActive) {
        const { data, error } = await withFilters(supabase.from("tt_creators_x").select(COLS)).limit(500);
        if (error) throw error;
        let rs = (data ?? []) as Row[];
        if (sortKey === "fit") {
          const rank = new Map(rankIds.map((id, i) => [id, i]));
          rs = rs.slice().sort((a, b) => (rank.get(a.sec_uid) ?? 1e9) - (rank.get(b.sec_uid) ?? 1e9));
        } else {
          rs = rs.slice().sort((a, b) => {
            const av = Number((a as Record<string, unknown>)[sk] ?? 0), bv = Number((b as Record<string, unknown>)[sk] ?? 0);
            return sortDir === "asc" ? av - bv : bv - av;
          });
        }
        srcRows = rs.slice(0, cap);
      } else {
        const { data, error } = await withFilters(supabase.from("tt_creators_x").select(COLS))
          .order(sk, { ascending: sortDir === "asc", nullsFirst: false }).limit(cap);
        if (error) throw error;
        srcRows = (data ?? []) as Row[];
      }
      if (!srcRows.length) throw new Error("Nothing to add.");
      const jrows = srcRows.map(r => ({ job_id: jobId, sec_uid: r.sec_uid, handle: r.handle, state: "sourced" }));
      let inserted = 0;
      for (let i = 0; i < jrows.length; i += 200) {
        const { data: ins, error: e2 } = await supabase.from("job_creators").upsert(jrows.slice(i, i + 200), { onConflict: "job_id,sec_uid", ignoreDuplicates: true }).select("sec_uid");
        if (e2) throw e2; inserted += ins?.length ?? 0;
      }
      setNotice(`Added ${inserted} to “${jobName}”.`);
      setNewJobTitle(""); loadJobOpts();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setSending(false);
  }


  return (
    <div className="wp">
      <div className="eyebrow">Creator database</div>
      <h1>Who are you looking for?</h1>
      <div className="sub" />

      <div className="seg">
        <button className={mode === "semantic" ? "on" : ""} onClick={() => setMode("semantic")}>
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.6 4.4L18 8l-4.4 1.6L12 14l-1.6-4.4L6 8l4.4-1.6L12 2z"/></svg>Semantic
        </button>
        <button className={mode === "factual" ? "on" : ""} onClick={() => setMode("factual")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M7 12h10M10 18h4"/></svg>Filters
        </button>
      </div>

      {mode === "semantic" ? (
        <div className="prompt">
          <textarea rows={1} placeholder="Describe your ideal creator — e.g. “German food creator from Frankfurt who talks on camera”" value={prompt} onChange={e => setPrompt(e.target.value)} />
          <div className="prompt-foot">
            <span className="badge-ai"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.6 4.4L18 8l-4.4 1.6L12 14l-1.6-4.4L6 8l4.4-1.6L12 2z"/></svg>Keyword over AI summary</span>
            <span className="grow" />
            <button className="send" onClick={() => void load()} title="Search"><svg viewBox="0 0 24 24"><path d="M9 10 4 15l5 5"/><path d="M4 15h11a5 5 0 0 0 5-5V4"/></svg></button>
          </div>
        </div>
      ) : (
        <div className="fcard">
          <div className="fgrid">
            <div className="field"><label>Market</label><select value={market} onChange={e => setMarket(e.target.value)}><option value="">All markets</option><option value="dach">DACH 🇩🇪</option><option value="uk">UK 🇬🇧</option><option value="us">US 🇺🇸</option></select></div>
            <div className="field"><label>Platform</label><select value={platform} onChange={e => setPlatform(e.target.value)}><option value="">Any</option><option value="tiktok">TikTok</option><option value="instagram">Instagram</option></select></div>
            <div className="field"><label>Topic</label><select value={category} onChange={e => setCategory(e.target.value)}><option value="">All topics</option>{TOPICS.map(t => <option key={t} value={t}>{t}</option>)}</select></div>
            <div className="field"><label>Content format</label><select value={format} onChange={e => setFormat(e.target.value)}><option value="">All formats</option>{FORMATS.map(f => <option key={f} value={f}>{f}</option>)}</select></div>
            <div className="field"><label>Followers</label><div className="range"><input className="inp num" placeholder="from" value={follMin} onChange={e => setFollMin(e.target.value)} /><span>–</span><input className="inp num" placeholder="to" value={follMax} onChange={e => setFollMax(e.target.value)} /></div></div>
            <div className="field"><label>Engagement rate %</label><div className="range"><input className="inp num" placeholder="2" value={erMin} onChange={e => setErMin(e.target.value)} /><span>–</span><input className="inp num" placeholder="14" value={erMax} onChange={e => setErMax(e.target.value)} /></div></div>
          </div>
          <button className="advtoggle" onClick={() => setAdv(v => !v)} style={adv ? { color: "var(--wp-accink)" } : undefined}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ transform: adv ? "rotate(180deg)" : "none" }}><path d="m6 9 6 6 6-6"/></svg>Advanced filters
          </button>
          {adv && (
            <div className="fgrid" style={{ marginTop: 15, paddingTop: 16, borderTop: "1px solid var(--wp-line2)" }}>
              <div className="fsec">Lookalike</div>
              <div className="field" style={{ gridColumn: "1/-1" }}>
                <label>Similar to these creators <span style={{ color: "var(--wp-muted)", textTransform: "none", letterSpacing: 0 }}>(paste handles or profile URLs — ranks by similarity, combines with every filter)</span></label>
                <textarea className="inp" rows={2} placeholder={"@thatsonyi, @alicelich   or   https://www.tiktok.com/@…"} value={lookalike} onChange={e => setLookalike(e.target.value)} style={{ resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }} />
                {lookActive && <div style={{ fontSize: 12, color: "var(--wp-accink)", marginTop: 4, fontWeight: 600 }}>{lookLoading ? "Finding lookalikes…" : `${lookHandles.length} sample${lookHandles.length > 1 ? "s" : ""} · ${lookIds.length} similar creators`}</div>}
              </div>
              <div className="fsec">Audience &amp; content</div>
              <div className="field"><label>Persona</label><select value={persona} onChange={e => setPersona(e.target.value)}><option value="">All personas</option><option value="solo">Solo</option><option value="couple">Couple</option><option value="family">Family</option><option value="group">Group</option></select></div>
              <div className="field"><label>Audience language</label><select value={lang} onChange={e => setLang(e.target.value)}><option value="">All</option><option value="de">German</option><option value="en">English</option><option value="mixed">Mixed</option></select></div>
              <div className="field check"><input type="checkbox" checked={speak} onChange={e => setSpeak(e.target.checked)} id="wpspeak" /><label htmlFor="wpspeak">Speaks on camera</label></div>
              <div className="fsec">Reach</div>
              <div className="field"><label>Avg views (min)</label><input className="inp num" placeholder="e.g. 50000" value={viewsMin} onChange={e => setViewsMin(e.target.value)} /></div>
              <div className="field"><label>Total posts</label><div className="range"><input className="inp num" placeholder="from" value={vcMin} onChange={e => setVcMin(e.target.value)} /><span>–</span><input className="inp num" placeholder="to" value={vcMax} onChange={e => setVcMax(e.target.value)} /></div></div>
              <div className="field"><label>Posts / week (min)</label><input className="inp num" placeholder="e.g. 1" value={postMin} onChange={e => setPostMin(e.target.value)} /></div>
              <div className="fsec">Audience quality</div>
              <div className="field check"><input type="checkbox" checked={onmarket} onChange={e => setOnmarket(e.target.checked)} id="wpom" /><label htmlFor="wpom">On-market audience</label></div>
              <div className="field check"><input type="checkbox" checked={engaged} onChange={e => setEngaged(e.target.checked)} id="wpeng" /><label htmlFor="wpeng">Real engagement</label></div>
              <div className="field check"><input type="checkbox" checked={responsive} onChange={e => setResponsive(e.target.checked)} id="wpresp" /><label htmlFor="wpresp">Responsive creator</label></div>
              <div className="fsec">Contact &amp; business</div>
              <div className="field"><label>Last contacted</label><select value={contact} onChange={e => setContact(e.target.value)}><option value="">Any</option><option value="never">Never contacted</option><option value="30">30+ days ago</option><option value="60">60+ days ago</option><option value="90">90+ days ago</option></select></div>
              <div className="field"><label>Found via</label><select value={src} onChange={e => setSrc(e.target.value)}><option value="">Any source</option><option value="brand">Brand</option><option value="hashtag">Hashtag</option><option value="sound">Sound</option><option value="creator">Creator</option></select></div>
              {src && <div className="field"><label>{src === "brand" ? "Which brand" : src === "hashtag" ? "Which hashtag" : src === "sound" ? "Which sound" : "Which creator"}</label><select value={srcVal} onChange={e => setSrcVal(e.target.value)}><option value="">{srcOpts.length ? `All ${src}s (${srcOpts.length})` : "Loading…"}</option>{srcOpts.map(o => <option key={o.v} value={o.v}>{o.v} · {o.n}</option>)}</select></div>}
              <div className="field"><label>Min paid collabs</label><input className="inp num" placeholder="e.g. 2" value={adMin} onChange={e => setAdMin(e.target.value)} /></div>
              <div className="field"><label>Email type</label><select value={etype} onChange={e => setEtype(e.target.value)}><option value="">Any</option><option value="management">Management</option><option value="freemail">Freemail</option><option value="business_email">Business</option></select></div>
              <div className="field"><label>Deliverability</label><select value={emailDiff} onChange={e => setEmailDiff(e.target.value)}><option value="">Any provider</option><option value="very_easy">Very easy only</option><option value="easy">≤ Easy</option><option value="easy_medium">≤ Easy–medium</option><option value="medium">≤ Medium</option><option value="hard">≤ Hard (no Microsoft / t-online)</option><option value="very_hard">Exclude t-online</option></select></div>
              <div className="field check" style={{ gridColumn: "1/-1" }}><input type="checkbox" checked={exclWp} onChange={e => setExclWp(e.target.checked)} id="wpexcl" /><label htmlFor="wpexcl">Exclude existing WePush users</label></div>
            </div>
          )}
        </div>
      )}

      {error && <div className="error" style={{ marginTop: 12 }}>{error}</div>}
      {notice && <div className="success" style={{ marginTop: 12 }}>{notice}</div>}

      <div className="listhead">
        <b>{total.toLocaleString("en-GB")}</b><span>creators</span>
        <span className="grow" />
        <label className="takebox">Take top<input className="takeinp num" placeholder="all" value={takeN} onChange={e => setTakeN(e.target.value)} /></label>
        <select className="listsel" value={jobSel} onChange={e => setJobSel(e.target.value)}>
          <option value="__new">＋ New job…</option>
          {jobOpts.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        {jobSel === "__new" && <input className="listsel" style={{ maxWidth: 150 }} placeholder="Job title…" value={newJobTitle} onChange={e => setNewJobTitle(e.target.value)} />}
        <button className="sbtn2" onClick={send} disabled={sending || total === 0}>
          <svg viewBox="0 0 24 24"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>{sending ? "Adding…" : "Add to job"}
        </button>
        <select className="sortsel" value={sortKey} onChange={e => setSortKey(e.target.value)}>
          <option value="fit">Best match</option>
          <option value="follower_count">Followers</option>
          <option value="engagement_median">Engagement</option>
          <option value="avg_views">Avg views</option>
          <option value="original_sound_ratio">Speaks</option>
          <option value="sponsored_count">Ad experience</option>
        </select>
        <button className="dirbtn" onClick={() => setSortDir(d => d === "desc" ? "asc" : "desc")} title="Sort direction">{sortDir === "desc" ? "↓" : "↑"}</button>
      </div>

      <div className="rows">
        {loading || semLoading || lookLoading ? <div className="empty">{lookLoading ? "Finding lookalikes…" : semLoading ? "AI is ranking creators…" : "Loading…"}</div>
          : rows.length === 0 ? <div className="empty">{mode === "semantic" && !pDeb.trim() ? "Describe who you're looking for above." : "No creators for this search."}</div>
          : rows.map(r => (
            <div key={r.sec_uid} className={"crow" + (r.is_songpush_user ? " wepush" : "")} onClick={() => setPanel(r)}>
              <Mono r={r} />
              <div className="idcol">
                <div className="nm">{r.display_name || r.handle}<span className="pf" title={r.platform === "instagram" ? "Instagram" : "TikTok"}><PlatIcon p={r.platform} /></span></div>
                <div className="hd">@{r.handle}</div>
                <div className="tags">
                  {r.category && <span className="pill cat">{r.category}</span>}
                  {(r.content_format || []).slice(0, 2).map(f => <span key={f} className="pill">{f}</span>)}
                  {r.persona && <span className="pill ghost">{PERSONA[r.persona] || r.persona}</span>}
                  {(r.original_sound_ratio ?? 0) >= 0.5 && <span className="pill ghost">🎤 speaks</span>}
                </div>
              </div>
              <div className="metrics">
                <div className="metric"><div className="v num">{fmt(r.follower_count)}</div><div className="k">Followers</div></div>
                <div className="metric"><div className={"v num " + erClass(r.engagement_median)}>{r.engagement_median ?? "—"}%</div><div className="k">ER</div></div>
                <div className="metric"><div className="v num">{fmt(r.avg_views)}</div><div className="k">Avg views</div></div>
                {r.email && <span className="mail-dot" title={r.email_difficulty && DIFF[r.email_difficulty] ? `Email · ${DIFF[r.email_difficulty].label} to reach` : "Email available"} style={r.email_difficulty && DIFF[r.email_difficulty] ? { background: DIFF[r.email_difficulty].color } : undefined} />}
                <a className="iconbtn" href={r.is_songpush_user && r.songpush_admin_url ? r.songpush_admin_url : profileUrl(r)} target="_blank" rel="noreferrer" title="Open profile" onClick={e => e.stopPropagation()}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M7 17 17 7M9 7h8v8"/></svg></a>
              </div>
            </div>
          ))}
      </div>

      {total > PAGE && (
        <div className="pager">
          <button disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>‹ Prev</button>
          <span className="num">{page * PAGE + 1}–{Math.min((page + 1) * PAGE, total)} of {total.toLocaleString("en-GB")}</span>
          <button disabled={(page + 1) * PAGE >= total} onClick={() => setPage(p => p + 1)}>Next ›</button>
        </div>
      )}

      <div className={"wp-scrim" + (panel ? " show" : "")} onClick={() => setPanel(null)} />
      <div className={"wp-panel" + (panel ? " show" : "")}>
        {panel && <Detail r={panel} onClose={() => setPanel(null)} />}
      </div>
    </div>
  );
}

