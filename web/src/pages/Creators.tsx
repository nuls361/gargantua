import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

// Search — the one creator database, redesigned (scoped under .wp). Semantic (keyword over the
// AI profile_summary until embeddings land) ⇄ Filters. Take top N → send to a list (deduped).

type Row = {
  sec_uid: string; handle: string; display_name: string | null; bio: string | null;
  follower_count: number | null; engagement_median: number | null; avg_views: number | null; avg_views_pinned: number | null;
  posting_per_week: number | null; video_count: number | null; sponsored_count: number | null; avatar_url: string | null;
  category: string | null; category_secondary: string | null; content_format: string[] | null;
  persona: string | null; audience_lang: string | null; original_sound_ratio: number | null;
  comment_substance_ratio: number | null; comment_lang_match: number | null; creator_reply_rate: number | null;
  top_hashtags: string[] | null; profile_summary: string | null;
  email: string | null; email_type: string | null; market: string | null;
  source_type: string | null; source_value: string | null; source_brand: string | null;
  is_songpush_user: boolean | null; songpush_admin_url: string | null; platform: string | null;
};
type WList = { id: string; name: string };

const COLS =
  "sec_uid,handle,display_name,bio,follower_count,engagement_median,avg_views,avg_views_pinned,posting_per_week,video_count,sponsored_count,avatar_url,category,category_secondary,content_format,persona,audience_lang,original_sound_ratio,comment_substance_ratio,comment_lang_match,creator_reply_rate,top_hashtags,profile_summary,email,email_type,market,source_type,source_value,source_brand,is_songpush_user,songpush_admin_url,platform";
const PAGE = 25;
const TOPICS = ["beauty","wellness","fitness","fashion","food","travel","gaming","tech","finance","music","comedy","parenting","home & interior","sustainability","relationship","dance","pets","cars","education","art","lifestyle"];
const FORMATS = ["grwm","tutorial","vlog","day-in-life","storytime","talking-head","pov","skit","haul","review","recipe","transformation","dance","lip-sync","get-ready","unboxing","asmr"];
const CAT_HUE: Record<string, number> = { beauty:330,wellness:160,fitness:14,fashion:280,food:26,travel:200,gaming:250,tech:210,finance:150,music:190,comedy:45,parenting:340,"home & interior":175,sustainability:135,relationship:350,dance:300,pets:32,cars:220,education:230,art:265,lifestyle:255 };
const LANG: Record<string, string> = { de:"German", en:"English", mixed:"Mixed", un:"unclear" };
const PERSONA: Record<string, string> = { solo:"Solo", couple:"Couple", family:"Family", group:"Group" };

const fmt = (n: number | null) => n == null ? "—" : n >= 1e6 ? `${(n/1e6).toFixed(n>=1e7?0:1).replace(/\.0$/,"")}m` : n >= 1e3 ? `${(n/1e3).toFixed(n>=1e5?0:1).replace(/\.0$/,"")}k` : `${n}`;
const pct = (x: number | null) => x == null ? "—" : `${Math.round(x*100)}%`;
const catColor = (c: string | null) => `hsl(${(c && CAT_HUE[c]) ?? 255} 62% 52%)`;
const initials = (r: Row) => ((r.display_name || r.handle).replace(/[^\p{L}\p{N} ]/gu, "").trim().split(/\s+/).map(w=>w[0]).slice(0,2).join("").toUpperCase() || r.handle[0].toUpperCase());
const erClass = (e: number | null) => e == null ? "" : e < 2 ? "er-bad" : e > 14 ? "er-warn" : "er-good";

function PlatIcon({ p }: { p: string | null }) {
  return p === "instagram"
    ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1.1" fill="currentColor" stroke="none"/></svg>
    : <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.6 5.82A4.28 4.28 0 0 1 15.54 3h-3.2v12.9a2.59 2.59 0 1 1-2.03-2.53v-3.26a5.76 5.76 0 1 0 5.03 5.71V8.9a7.5 7.5 0 0 0 4.3 1.34V7.06a4.28 4.28 0 0 1-2.99-1.24z"/></svg>;
}
const profileUrl = (r: Row) => r.platform === "instagram" ? `https://www.instagram.com/${r.handle}` : `https://www.tiktok.com/@${r.handle}`;

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
  const [onmarket, setOnmarket] = useState(false);
  const [engaged, setEngaged] = useState(false);
  const [responsive, setResponsive] = useState(false);
  const [adMin, setAdMin] = useState("");
  const [etype, setEtype] = useState("");
  const [exclWp, setExclWp] = useState(false);
  const [contact, setContact] = useState("");
  const [sortKey, setSortKey] = useState("follower_count");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // take + send
  const [takeN, setTakeN] = useState("");
  const [listSel, setListSel] = useState("__new");
  const [newName, setNewName] = useState("");
  const [workingLists, setWorkingLists] = useState<WList[]>([]);
  const [sending, setSending] = useState(false);

  const [panel, setPanel] = useState<Row | null>(null);

  useEffect(() => { const t = setTimeout(() => setPDeb(prompt), 300); return () => clearTimeout(t); }, [prompt]);
  const loadLists = useCallback(() => {
    supabase.from("lists").select("id,name").eq("kind", "working").order("name").then(({ data }) => setWorkingLists((data ?? []) as WList[]));
  }, []);
  useEffect(() => { loadLists(); }, [loadLists]);

  const withFilters = useCallback(<T,>(qb: T): T => {
    let q = qb as any;
    if (contact === "never") q = q.is("last_contacted_at", null);
    else if (contact) q = q.lte("last_contacted_at", new Date(Date.now() - Number(contact) * 86400000).toISOString());
    if (mode === "semantic") {
      const p = pDeb.trim();
      if (p) q = q.textSearch("summary_fts", p, { type: "websearch" });
      if (market) q = q.eq("market", market);
      return q as T;
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
    if (onmarket) q = q.gte("comment_lang_match", 0.5);
    if (engaged) q = q.gte("comment_substance_ratio", 0.6);
    if (responsive) q = q.gte("creator_reply_rate", 0.15);
    if (adMin) q = q.gte("sponsored_count", Number(adMin));
    if (etype) q = q.eq("email_type", etype);
    if (exclWp) q = q.or("is_songpush_user.is.null,is_songpush_user.eq.false");
    return q as T;
  }, [mode, pDeb, market, platform, category, format, follMin, follMax, erMin, erMax, viewsMin, persona, lang, speak, vcMin, vcMax, postMin, src, onmarket, engaged, responsive, adMin, etype, exclWp, contact]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const sk = sortKey === "fit" ? "follower_count" : sortKey;
    const q = withFilters(supabase.from("tt_creators_x").select(COLS, { count: "exact" }))
      .order(sk, { ascending: sortDir === "asc", nullsFirst: false })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    const { data, count, error: err } = await q;
    if (err) setError(err.message);
    else { setRows((data ?? []) as Row[]); setTotal(count ?? 0); }
    setLoading(false);
  }, [withFilters, sortKey, sortDir, page]);

  useEffect(() => { setPage(0); }, [withFilters, sortKey, sortDir]);
  useEffect(() => { void load(); }, [load]);

  async function send() {
    setSending(true); setError(null); setNotice(null);
    try {
      let listId = ""; let listName = "";
      if (listSel === "__new") {
        const name = newName.trim(); if (!name) throw new Error("Enter a list name.");
        const { data, error } = await supabase.from("lists").insert({ name, kind: "working" }).select("id,name").single();
        if (error) throw error; listId = data.id; listName = data.name;
      } else {
        listId = listSel; listName = workingLists.find(l => l.id === listSel)?.name ?? "list";
      }
      const cap = takeN ? Math.max(1, Number(takeN)) : 5000;
      const sk = sortKey === "fit" ? "follower_count" : sortKey;
      const { data, error } = await withFilters(supabase.from("tt_creators_x").select(COLS))
        .order(sk, { ascending: sortDir === "asc", nullsFirst: false }).limit(cap);
      if (error) throw error;
      const srcRows = (data ?? []) as Row[];
      if (!srcRows.length) throw new Error("Nothing to send.");
      const now = new Date().toISOString();
      const crows = srcRows.map(r => ({
        handle: r.handle, tiktok_username: r.handle, platform: r.platform || "tiktok", email: r.email || null,
        region_label: r.market === "dach" ? "dach" : r.market === "uk" ? "uk" : null,
        status: r.email ? "enriched" : "sourced", enriched_at: r.email ? now : null,
        category: r.category, source_type: r.source_type, source_value: r.source_value || r.source_brand,
        label: r.source_value || r.source_brand || null, list_id: listId, date_added: now,
      }));
      let inserted = 0;
      for (let i = 0; i < crows.length; i += 200) {
        const { data: ins, error: e2 } = await supabase.from("creators").upsert(crows.slice(i, i + 200), { onConflict: "email_normalized", ignoreDuplicates: true }).select("id");
        if (e2) throw e2; inserted += ins?.length ?? 0;
      }
      setNotice(`Sent ${inserted} to “${listName}”.`);
      setNewName(""); loadLists();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setSending(false);
  }

  const marketFlag = (m: string | null) => m === "dach" ? "🇩🇪 DACH" : m === "uk" ? "🇬🇧 UK" : m === "us" ? "🇺🇸 US" : (m || "—");

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
              <div className="field"><label>Min paid collabs</label><input className="inp num" placeholder="e.g. 2" value={adMin} onChange={e => setAdMin(e.target.value)} /></div>
              <div className="field"><label>Email type</label><select value={etype} onChange={e => setEtype(e.target.value)}><option value="">Any</option><option value="management">Management</option><option value="freemail">Freemail</option><option value="business_email">Business</option></select></div>
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
        <select className="listsel" value={listSel} onChange={e => setListSel(e.target.value)}>
          <option value="__new">＋ New list…</option>
          {workingLists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        {listSel === "__new" && <input className="listsel" style={{ maxWidth: 150 }} placeholder="List name…" value={newName} onChange={e => setNewName(e.target.value)} />}
        <button className="sbtn2" onClick={send} disabled={sending || total === 0}>
          <svg viewBox="0 0 24 24"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>{sending ? "Sending…" : "Send to list"}
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
        {loading ? <div className="empty">Loading…</div>
          : rows.length === 0 ? <div className="empty">No creators for this search.</div>
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
                {r.email && <span className="mail-dot" title="Email available" />}
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
        {panel && <Detail r={panel} onClose={() => setPanel(null)} marketFlag={marketFlag} />}
      </div>
    </div>
  );
}

function bar(label: string, val: string, width: number, color: string, note?: string) {
  return (
    <div className="stat">
      <div className="stat-head"><span className="stat-label">{label}</span><span className="stat-val">{val}</span></div>
      <div className="track"><div className="fill" style={{ width: `${Math.max(2, Math.min(100, width))}%`, background: color }} /></div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

function Detail({ r, onClose, marketFlag }: { r: Row; onClose: () => void; marketFlag: (m: string | null) => string }) {
  const lm = r.comment_lang_match ?? 0, sub = r.comment_substance_ratio ?? 0, rr = r.creator_reply_rate ?? 0;
  const marketLang = r.market === "dach" ? "German" : "English";
  const flag = r.market === "dach" ? "🇩🇪" : r.market === "uk" ? "🇬🇧" : r.market === "us" ? "🇺🇸" : "🌍";
  const langGood = lm >= 0.5, subGood = sub >= 0.6, rrGood = rr >= 0.15;
  const gN = [langGood, subGood, rrGood].filter(Boolean).length;
  const vb = gN >= 3 ? ["Strong", "var(--wp-good)", "var(--wp-goodsoft)"] : gN === 2 ? ["Solid", "var(--wp-good)", "var(--wp-goodsoft)"] : gN === 1 ? ["Mixed", "var(--wp-warn)", "var(--wp-warnsoft)"] : ["Weak", "var(--wp-bad)", "var(--wp-badsoft)"];
  const aqrow = (icon: string, label: string, desc: string, state: string) => (
    <div className="aqrow" key={label}><div className="aqicon">{icon}</div><div className="aqmain"><div className="aqlabel">{label}</div><div className="aqdesc">{desc}</div></div><div className={"aqmark aq-" + state}>{state === "good" ? "✓" : state === "bad" ? "✗" : "~"}</div></div>
  );
  const erCol = (r.engagement_median ?? 0) < 2 ? "var(--wp-muted)" : (r.engagement_median ?? 0) > 14 ? "var(--wp-warn)" : "var(--wp-good)";
  const vmax = Math.max(r.avg_views ?? 0, r.avg_views_pinned ?? 0) || 1;
  const osr = r.original_sound_ratio ?? 0;
  const emClass = r.email_type === "management" ? "em-mgmt" : r.email_type === "business_email" ? "em-biz" : "em-free";
  const emLabel = r.email_type === "management" ? "Management" : r.email_type === "business_email" ? "Business" : r.email_type === "freemail" ? "Freemail" : (r.email_type || "—");
  const adNote = (r.sponsored_count ?? 0) >= 2 ? `${r.sponsored_count} paid collabs → ad-experienced` : (r.sponsored_count === 1 ? "1 paid collab" : "no ads detected");

  return (
    <>
      <div className="p-head">
        <Mono r={r} big />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="nm">{r.display_name || r.handle}<span className="pf" style={{ padding: 3 }}><PlatIcon p={r.platform} /></span></div>
          <div className="hd">@{r.handle}</div>
          <div><span className="loc">{marketFlag(r.market)}</span></div>
        </div>
        <button className="x" onClick={onClose}><svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
      <div className="p-body">
        {r.profile_summary && (
          <div className="summary">
            <div className="lead">{r.profile_summary}</div>
            <div className="src"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.3 3.7L17 7l-3.7 1.3L12 12l-1.3-3.7L7 7l3.7-1.3L12 2z"/></svg>Auto-profile from recent posts · real data only</div>
          </div>
        )}
        <div><div className="sec-t">Bio</div><div className="bio">{r.bio || "—"}</div></div>
        <div>
          <div className="sec-t">Reach &amp; engagement</div>
          {bar("Engagement rate", `${r.engagement_median ?? "—"}%`, ((r.engagement_median ?? 0) / 14) * 100, erCol, (r.engagement_median ?? 0) >= 2 && (r.engagement_median ?? 0) <= 14 ? "in target band 2–14%" : "outside band")}
          <div className="stat twobar">
            <div className="stat-head"><span className="stat-label">Reach — typical vs. peak</span><span className="stat-val">{fmt(r.avg_views)}</span></div>
            <div className="track"><div className="fill" style={{ width: `${Math.max(2, (r.avg_views ?? 0) / vmax * 100)}%`, background: "var(--wp-acc)" }} /></div>
            {r.avg_views_pinned ? (
              <>
                <div className="track" style={{ marginTop: 5 }}><div className="fill" style={{ width: "100%", background: "color-mix(in srgb,var(--wp-acc) 38%,transparent)" }} /></div>
                <div className="minilegend"><span><i style={{ background: "var(--wp-acc)" }} />{fmt(r.avg_views)} typical</span><span><i style={{ background: "color-mix(in srgb,var(--wp-acc) 38%,transparent)" }} />{fmt(r.avg_views_pinned)} pinned</span></div>
              </>
            ) : <div className="stat-note">no pinned post</div>}
          </div>
        </div>
        <div className="kv">
          <div className="cell"><div className="k">Followers</div><div className="v num">{fmt(r.follower_count)}</div></div>
          <div className="cell"><div className="k">Total posts</div><div className="v num">{fmt(r.video_count)}</div></div>
          <div className="cell"><div className="k">Posts / week</div><div className="v num">{r.posting_per_week ?? "—"}</div></div>
          <div className="cell"><div className="k">Persona</div><div className="v sm">{r.persona ? (PERSONA[r.persona] || r.persona) : "—"}</div></div>
        </div>
        <div>
          <div className="sec-t">Content</div>
          <div className="tagrow" style={{ marginBottom: 14 }}>
            {r.category && <span className="pill cat">{r.category}</span>}
            {r.category_secondary && <span className="pill">{r.category_secondary}</span>}
            {(r.content_format || []).map(f => <span key={f} className="pill">{f}</span>)}
          </div>
          {bar('Own original sound — “speaks”', pct(r.original_sound_ratio), osr * 100, osr >= 0.5 ? "var(--wp-good)" : "var(--wp-muted)", osr >= 0.5 ? "mostly own audio → talks / narrates" : "mostly others’ sounds → music / lip-sync")}
        </div>
        <div>
          <div className="aqhead"><div className="sec-t" style={{ margin: 0 }}>Audience quality</div><span className="aqbadge" style={{ background: vb[2], color: vb[1] }}>{vb[0]}</span></div>
          {aqrow(flag, "Right audience", langGood ? `${Math.round(lm * 100)}% of commenters write in ${marketLang}` : `only ${Math.round(lm * 100)}% write in ${marketLang} — likely off-market`, langGood ? "good" : "bad")}
          {aqrow("💬", "Real engagement", subGood ? `${Math.round(sub * 100)}% of comments are genuine sentences (not bot/emoji)` : `just ${Math.round(sub * 100)}% real comments — mostly emoji or one-word`, subGood ? "good" : "warn")}
          {aqrow("↩︎", "Responsive creator", rrGood ? `engages ~${Math.round(rr * 100)}% of comments (likes / replies)` : (rr > 0 ? `rarely engages comments (~${Math.round(rr * 100)}%)` : "doesn't reply to comments"), rrGood ? "good" : "warn")}
        </div>
        {r.audience_lang && <div className="stat-note" style={{ marginTop: -8 }}>Audience language: {LANG[r.audience_lang] || r.audience_lang}</div>}
        {r.top_hashtags && r.top_hashtags.length > 0 && (
          <div><div className="sec-t">Hashtags</div><div className="tagrow">{r.top_hashtags.map(h => <span key={h} className="pill ghost">#{h}</span>)}</div></div>
        )}
        <div>
          <div className="sec-t">Contact &amp; business</div>
          <div className="contact">
            <div className="cr"><div className="ci"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg></div><div className="cx"><div className="k">Email</div><div className="v">{r.email || "—"}</div></div>{r.email_type && <span className={"tag-em " + emClass}>{emLabel}</span>}</div>
            <div className="cr"><div className="ci"><svg viewBox="0 0 24 24"><path d="M20 7h-9M14 17H5M17 3l4 4-4 4M7 21l-4-4 4-4"/></svg></div><div className="cx"><div className="k">Ad experience</div><div className="v">{adNote}</div></div></div>
            {(r.source_value || r.source_brand) && <div className="cr"><div className="ci"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg></div><div className="cx"><div className="k">Found via</div><div className="v">{r.source_value || r.source_brand}</div></div></div>}
          </div>
        </div>
      </div>
      <div className="p-foot">
        <a className="btn primary" href={profileUrl(r)} target="_blank" rel="noreferrer"><svg viewBox="0 0 24 24"><path d="M7 17 17 7M9 7h8v8"/></svg>Open {r.platform === "instagram" ? "Instagram" : "TikTok"} profile</a>
      </div>
    </>
  );
}
