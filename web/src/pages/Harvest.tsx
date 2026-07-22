import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";

// Harvest — every discovery source (brands, hashtags, sounds, creators) in one list, redesigned.
// Adding a source queues a scrape_jobs row the worker runs (2 levels deep). Click a source to
// see the creators it surfaced (via discovered_from). Scoped under .wp.

type SourceType = "brand" | "hashtag" | "sound" | "creator";
type Row = { source_type: SourceType; source_value: string; creators_found: number; creators_dach: number; creators_uk: number; creators_enriched: number; last_seen: string | null; avatar_url?: string | null };
type SourceCreator = { sec_uid: string; handle: string; display_name: string | null; follower_count: number | null; engagement_median: number | null; market: string | null; email: string | null; category: string | null; platform: string | null; avatar_url: string | null };

const CAT_HUE: Record<string, number> = { beauty:330,wellness:160,fitness:14,fashion:280,food:26,travel:200,gaming:250,tech:210,finance:150,music:190,comedy:45,parenting:340,"home & interior":175,sustainability:135,relationship:350,dance:300,pets:32,cars:220,education:230,art:265,lifestyle:255 };
const TYPE: Record<SourceType, { c: string; label: string; ic: JSX.Element }> = {
  hashtag: { c: "#2E6BE6", label: "Hashtag", ic: <svg viewBox="0 0 24 24"><path d="M10 3 8 21M16 3l-2 18M4 9h16M3 15h16"/></svg> },
  sound: { c: "#8B5CF6", label: "Sound", ic: <svg viewBox="0 0 24 24"><path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg> },
  brand: { c: "#12A150", label: "Brand", ic: <svg viewBox="0 0 24 24"><path d="M6 2 3 6v14a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V6l-3-4zM3 6h18M16 10a4 4 0 0 1-8 0"/></svg> },
  creator: { c: "#D97706", label: "Creator", ic: <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg> },
};
const fmt = (n: number | null) => n == null ? "—" : n >= 1e3 ? `${(n/1e3).toFixed(1).replace(/\.0$/,"")}k` : `${n}`;
const ago = (iso: string | null) => { if (!iso) return "—"; const d = (Date.now() - new Date(iso).getTime()) / 86400000; return d < 1 ? "today" : d < 2 ? "yesterday" : d < 30 ? `${Math.round(d)} days ago` : `${Math.round(d/30)} mo ago`; };
const catColor = (c: string | null) => `hsl(${(c && CAT_HUE[c]) ?? 255} 60% 52%)`;
const initials = (c: SourceCreator) => ((c.display_name || c.handle).replace(/[^\p{L}\p{N} ]/gu, "").trim().split(/\s+/).map(w=>w[0]).slice(0,2).join("").toUpperCase() || c.handle[0].toUpperCase());
const displayValue = (t: SourceType, v: string) => t === "hashtag" ? (v.startsWith("#") ? v : `#${v}`) : (t === "brand" || t === "creator") ? (v.startsWith("@") ? v : `@${v}`) : v;
const normalizeValue = (t: SourceType, raw: string) => {
  let v = raw.trim();
  // Pasted a full profile URL? Pull the handle out of it (tiktok.com/@x, instagram.com/x).
  const m = v.match(/(?:tiktok\.com\/@|instagram\.com\/)([\w.]+)/i);
  if (m) v = m[1];
  if (t === "hashtag") return v.replace(/^[#@]/, "");
  if (t === "brand" || t === "creator") return `@${v.replace(/^@+/, "")}`;
  return v;
};
const optionsFor = (t: SourceType) => { const base = { enrich: true, dach_only: false, budget_usd: 2, max_depth: 2 }; return t === "sound" ? { ...base, pages: 10 } : t === "creator" ? { ...base, pages: 3 } : { ...base, pages: 8 }; };
const PAGE = 25;

export default function Harvest() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<"" | SourceType>("");
  const [sortKey, setSortKey] = useState<"creators_found" | "creators_dach" | "creators_enriched">("creators_found");
  const [newType, setNewType] = useState<SourceType>("hashtag");
  const [newVal, setNewVal] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [viewSrc, setViewSrc] = useState<Row | null>(null);
  const [viewRows, setViewRows] = useState<SourceCreator[]>([]);
  const [viewLoading, setViewLoading] = useState(false);

  useEffect(() => { supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? "")); }, []);

  useEffect(() => {
    if (!viewSrc) return;
    setViewLoading(true); setViewRows([]);
    supabase.from("tt_creators")
      .select("sec_uid,handle,display_name,follower_count,engagement_median,market,email,category,platform,avatar_url")
      .eq("discovered_from", viewSrc.source_value)
      .order("follower_count", { ascending: false }).limit(50)
      .then(({ data }) => { setViewRows((data ?? []) as SourceCreator[]); setViewLoading(false); });
  }, [viewSrc]);

  const load = useCallback(async () => {
    setLoading(true);
    const [srcRes, brandRes] = await Promise.all([
      supabase.from("source_overview").select("source_type,source_value,creators_found,creators_dach,creators_uk,creators_enriched,last_seen").limit(2000),
      supabase.from("brand_overview").select("handle,creators_found,creators_dach,creators_uk,creators_enriched,last_seen,avatar_url").or("creators_found.gt.0,market.in.(dach,uk)").limit(2000),
    ]);
    if (srcRes.error) setError(srcRes.error.message);
    const src = (srcRes.data ?? []) as Row[];
    const brands: Row[] = ((brandRes.data ?? []) as Array<Record<string, unknown>>).map((b) => ({
      source_type: "brand", source_value: String(b.handle ?? ""), creators_found: Number(b.creators_found ?? 0),
      creators_dach: Number(b.creators_dach ?? 0), creators_uk: Number(b.creators_uk ?? 0), creators_enriched: Number(b.creators_enriched ?? 0), last_seen: (b.last_seen as string | null) ?? null,
      avatar_url: (b.avatar_url as string | null) ?? null,
    }));
    setRows([...src, ...brands]); setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    let r = rows;
    if (typeFilter) r = r.filter(x => x.source_type === typeFilter);
    if (query.trim()) { const q = query.trim().toLowerCase(); r = r.filter(x => x.source_value.toLowerCase().includes(q)); }
    return [...r].sort((a, b) => (b[sortKey] ?? 0) - (a[sortKey] ?? 0));
  }, [rows, typeFilter, query, sortKey]);
  useEffect(() => { setPage(0); }, [typeFilter, query, sortKey]);
  const paged = useMemo(() => visible.slice(page * PAGE, page * PAGE + PAGE), [visible, page]);

  const stats = useMemo(() => ({
    sources: rows.length,
    found: rows.reduce((a, s) => a + (s.creators_found || 0), 0),
    enriched: rows.reduce((a, s) => a + (s.creators_enriched || 0), 0),
  }), [rows]);

  async function harvest(type: SourceType, value: string) {
    setBusy(`${type}:${value}`); setError(null); setNotice(null);
    const { error: jerr } = await supabase.from("scrape_jobs").insert({ source_type: type, source_value: value, requested_by: email || "tool", options: optionsFor(type) });
    if (jerr) setError(`Could not queue job: ${jerr.message}`);
    else setNotice(`Harvest queued for ${displayValue(type, value)} (2 levels deep).`);
    setBusy(null);
  }
  async function addNew() {
    const v = normalizeValue(newType, newVal); if (!v) return;
    if (newType === "brand") await supabase.from("brands").insert({ handle: v, status: "candidate", discovered_via: "manual" });
    await harvest(newType, v); setNewVal("");
  }

  return (
    <div className="wp">
      <div className="eyebrow">Database</div>
      <h1>Harvest</h1>
      <div className="sub">Feed the creator database — queue a source, the worker fills it.</div>

      <div className="addcard">
        <select value={newType} onChange={e => setNewType(e.target.value as SourceType)}>
          <option value="hashtag">Hashtag</option><option value="sound">Sound</option><option value="brand">Brand</option><option value="creator">Creator</option>
        </select>
        <input className="inp" placeholder="#hashtag · @brand · sound URL · @creator" value={newVal} onChange={e => setNewVal(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void addNew(); }} />
        <button className="go" onClick={() => void addNew()} disabled={!!busy}><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>{busy ? "Queuing…" : "Queue harvest"}</button>
      </div>
      <div className="hint"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>Runs 2 levels deep · only creators that pass the hard gate are kept (DACH/UK/US · 1k–250k · ER 2–14% · email).</div>

      {error && <div className="error" style={{ marginTop: 12 }}>{error}</div>}
      {notice && <div className="success" style={{ marginTop: 12 }}>{notice}</div>}

      <div className="stats" style={{ gridTemplateColumns: "repeat(3,1fr)", marginTop: 22 }}>
        {[["Sources", stats.sources.toLocaleString("en-GB")], ["Creators surfaced", fmt(stats.found)], ["Enriched", fmt(stats.enriched)]].map(([k, v]) => (
          <div className="stat-card" key={k}><div className="k">{k}</div><div className="v num">{v}</div></div>
        ))}
      </div>

      <div className="toolbar2">
        {(["", "hashtag", "sound", "brand", "creator"] as const).map(t => (
          <span key={t || "all"} className={"chip" + (typeFilter === t ? " on" : "")} onClick={() => setTypeFilter(t)}>{t ? TYPE[t].label + "s" : "All"}</span>
        ))}
        <span className="grow" />
        <input className="search" placeholder="Search source…" value={query} onChange={e => setQuery(e.target.value)} />
        <select className="sortsel" value={sortKey} onChange={e => setSortKey(e.target.value as typeof sortKey)}>
          <option value="creators_found">Creators found</option><option value="creators_dach">DACH found</option><option value="creators_enriched">Enriched</option>
        </select>
      </div>

      <div className="listhead"><b>{visible.length.toLocaleString("en-GB")}</b><span>sources</span></div>
      <div className="rows">
        {loading ? <div className="empty">Loading…</div> : paged.length === 0 ? <div className="empty">No sources match.</div> : paged.map(s => {
          const t = TYPE[s.source_type] || TYPE.hashtag;
          const dPct = s.creators_found ? Math.round(s.creators_dach / s.creators_found * 100) : 0;
          const uPct = s.creators_found ? Math.round(s.creators_uk / s.creators_found * 100) : 0;
          const oPct = Math.max(0, 100 - dPct - uPct);
          return (
            <div className="crow" key={`${s.source_type}:${s.source_value}`} onClick={() => setViewSrc(s)}>
              <div className="stype" style={{ background: t.c }}>{s.avatar_url ? <img src={s.avatar_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "inherit" }} onError={(e) => { e.currentTarget.style.display = "none"; }} /> : t.ic}</div>
              <div className="idcol">
                <div className="nm">{displayValue(s.source_type, s.source_value)}</div>
                <div className="hd">{t.label} · last harvested {ago(s.last_seen)}</div>
                <div className="yield">
                  <div className="track"><i style={{ width: `${dPct}%`, background: "var(--wp-good)" }} /><i style={{ width: `${uPct}%`, background: "var(--wp-acc)" }} /><i style={{ width: `${oPct}%`, background: "var(--wp-track)" }} /></div>
                  <span className="lbl">{dPct}% DACH</span>
                </div>
              </div>
              <div className="metrics">
                <div className="metric"><div className="v num">{s.creators_found}</div><div className="k">Found</div></div>
                <div className="metric"><div className="v num" style={{ color: "var(--wp-good)" }}>{s.creators_dach}</div><div className="k">DACH</div></div>
                <div className="metric"><div className="v num">{s.creators_enriched}</div><div className="k">Enriched</div></div>
                <button className="reharv" onClick={e => { e.stopPropagation(); void harvest(s.source_type, s.source_value); }} disabled={busy === `${s.source_type}:${s.source_value}`}>
                  <svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/></svg>Re-harvest
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {visible.length > PAGE && (
        <div className="pager">
          <button disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>‹ Prev</button>
          <span className="num">{page * PAGE + 1}–{Math.min((page + 1) * PAGE, visible.length)} of {visible.length.toLocaleString("en-GB")}</span>
          <button disabled={(page + 1) * PAGE >= visible.length} onClick={() => setPage(p => p + 1)}>Next ›</button>
        </div>
      )}

      <div className={"wp-scrim" + (viewSrc ? " show" : "")} onClick={() => setViewSrc(null)} />
      <div className={"wp-panel" + (viewSrc ? " show" : "")}>
        {viewSrc && (() => {
          const t = TYPE[viewSrc.source_type] || TYPE.hashtag;
          return (
            <>
              <div className="p-head">
                <div className="stype" style={{ background: t.c, width: 46, height: 46 }}>{viewSrc.avatar_url ? <img src={viewSrc.avatar_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "inherit" }} onError={(e) => { e.currentTarget.style.display = "none"; }} /> : t.ic}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="nm">{displayValue(viewSrc.source_type, viewSrc.source_value)}</div>
                  <div className="hd">{t.label} · {viewSrc.creators_found} found · {viewSrc.creators_dach} DACH · {viewSrc.creators_enriched} enriched</div>
                </div>
                <button className="x" onClick={() => setViewSrc(null)}><svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
              </div>
              <div className="p-body">
                {viewLoading ? <div className="empty">Loading…</div> : viewRows.length === 0 ? <div className="empty" style={{ padding: 36 }}>No stored creators for this source.</div> : viewRows.map(c => (
                  <div className="pcrow" key={c.sec_uid}>
                    <div className="cmono" style={{ background: catColor(c.category) }}>{initials(c)}{c.avatar_url && <img src={c.avatar_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={(e) => { e.currentTarget.style.display = "none"; }} />}</div>
                    <div style={{ minWidth: 0 }}><div className="cn">{c.display_name || c.handle}</div><div className="ch">@{c.handle}{c.category ? ` · ${c.category}` : ""}</div></div>
                    <div className="cm"><b>{fmt(c.follower_count)}</b> foll<br />{c.engagement_median ?? "—"}% ER</div>
                    <a className="op" href={c.platform === "instagram" ? `https://www.instagram.com/${c.handle}` : `https://www.tiktok.com/@${c.handle}`} target="_blank" rel="noreferrer"><svg viewBox="0 0 24 24"><path d="M7 17 17 7M9 7h8v8"/></svg></a>
                  </div>
                ))}
              </div>
            </>
          );
        })()}
      </div>
    </div>
  );
}
