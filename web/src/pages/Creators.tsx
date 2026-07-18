import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import Pager from "../components/Pager";

// Search the owned creator index (tt_creators) with full criteria, then source the
// matching creators straight into a CRM list (creators working set) — deduped against
// the contact history, carrying niche + source. This is the self-sourcing loop.

type Row = {
  sec_uid: string;
  handle: string;
  display_name: string | null;
  follower_count: number | null;
  engagement_median: number | null;
  category: string | null;
  sub_niche: string | null;
  email: string | null;
  email_type: string | null;
  sponsored_count: number | null;
  market: string | null;
  source_type: string | null;
  source_value: string | null;
  source_brand: string | null;
  verified: boolean | null;
  is_songpush_user: boolean | null;
  songpush_admin_url: string | null;
};
type SortKey = "follower_count" | "engagement_median" | "sponsored_count";
type WList = { id: string; name: string };

const COLS =
  "sec_uid,handle,display_name,follower_count,engagement_median,category,sub_niche,email,email_type,sponsored_count,market,source_type,source_value,source_brand,verified,is_songpush_user,songpush_admin_url";
const PAGE = 50;
const NICHES = [
  "skincare", "beauty", "wellness", "fitness", "fashion", "food", "travel", "gaming",
  "tech", "finance", "music", "comedy", "parenting", "home & interior", "sustainability", "lifestyle",
];

const fmt = (n: number | null) =>
  n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, "")}k` : `${n}`;
const niche = (s: string | null) => (s ? s.replace(/\b\w/g, (c) => c.toUpperCase()) : s);

function erCell(er: number | null) {
  if (er == null) return <span className="muted">—</span>;
  const [color, label] =
    er < 2 ? ["#767d90", "UGC / tot"] : er > 14 ? ["#8a6100", "mood?"] : ["#16794a", "influencer"];
  return <span className="num" style={{ color, fontWeight: 600 }} title={label}>{er}%</span>;
}

export default function Creators() {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // filters
  const [query, setQuery] = useState("");
  const [qDeb, setQDeb] = useState("");
  const [category, setCategory] = useState("");
  const [market, setMarket] = useState("");
  const [emailType, setEmailType] = useState("");
  const [follMin, setFollMin] = useState("");
  const [follMax, setFollMax] = useState("");
  const [bandOnly, setBandOnly] = useState(false);
  const [sourceType, setSourceType] = useState("");
  const [songpush, setSongpush] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("follower_count");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // selection + sourcing
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showSource, setShowSource] = useState(false);
  const [scope, setScope] = useState<"all" | "selected">("all");
  const [listMode, setListMode] = useState<"new" | "existing">("new");
  const [newListName, setNewListName] = useState("");
  const [existingListId, setExistingListId] = useState("");
  const [workingLists, setWorkingLists] = useState<WList[]>([]);
  const [sourcing, setSourcing] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQDeb(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    supabase.from("lists").select("id,name").eq("kind", "working").order("name")
      .then(({ data }) => setWorkingLists((data ?? []) as WList[]));
  }, []);

  const withFilters = useCallback(<T,>(qb: T): T => {
    let q = qb as any;
    const qq = qDeb.trim().replace(/[,()%*]/g, "");
    if (qq) q = q.or(`handle.ilike.%${qq}%,display_name.ilike.%${qq}%,email.ilike.%${qq}%`);
    if (category) q = q.eq("category", category);
    if (market) q = q.eq("market", market);
    if (emailType === "has") q = q.not("email", "is", null);
    else if (emailType) q = q.eq("email_type", emailType);
    if (follMin) q = q.gte("follower_count", Number(follMin));
    if (follMax) q = q.lte("follower_count", Number(follMax));
    if (bandOnly) q = q.gte("engagement_median", 2).lte("engagement_median", 14);
    if (sourceType) q = q.eq("source_type", sourceType);
    if (songpush === "only") q = q.eq("is_songpush_user", true);
    else if (songpush === "exclude") q = q.or("is_songpush_user.is.null,is_songpush_user.eq.false");
    return q as T;
  }, [qDeb, category, market, emailType, follMin, follMax, bandOnly, sourceType, songpush]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const q = withFilters(supabase.from("tt_creators").select(COLS, { count: "exact" }))
      .order(sortKey, { ascending: sortDir === "asc", nullsFirst: false })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    const { data, count, error: err } = await q;
    if (err) setError(err.message);
    else { setRows((data ?? []) as Row[]); setTotal(count ?? 0); }
    setLoading(false);
  }, [withFilters, sortKey, sortDir, page]);

  useEffect(() => { setPage(0); }, [qDeb, category, market, emailType, follMin, follMax, bandOnly, sourceType, songpush]);
  useEffect(() => { void load(); }, [load]);

  function sortBy(k: SortKey) {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir("desc"); }
  }
  const arrow = (k: SortKey) => (k === sortKey ? (sortDir === "desc" ? " ↓" : " ↑") : "");

  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.sec_uid));
  function toggle(id: string) {
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleAll() {
    setSelected((s) => {
      const n = new Set(s);
      if (allOnPage) rows.forEach((r) => n.delete(r.sec_uid));
      else rows.forEach((r) => n.add(r.sec_uid));
      return n;
    });
  }

  async function doSource() {
    setSourcing(true);
    setError(null);
    setNotice(null);
    try {
      let listId = existingListId;
      let listName = workingLists.find((l) => l.id === existingListId)?.name ?? "";
      if (listMode === "new") {
        const name = newListName.trim();
        if (!name) throw new Error("Listenname fehlt.");
        const { data, error } = await supabase.from("lists").insert({ name, kind: "working" }).select("id,name").single();
        if (error) throw error;
        listId = data.id; listName = data.name;
      } else if (!listId) throw new Error("Wähle eine Liste.");

      let src: Row[];
      if (scope === "selected") {
        src = rows.filter((r) => selected.has(r.sec_uid));
      } else {
        const { data, error } = await withFilters(supabase.from("tt_creators").select(COLS))
          .order(sortKey, { ascending: false, nullsFirst: false }).limit(5000);
        if (error) throw error;
        src = (data ?? []) as Row[];
      }
      if (src.length === 0) throw new Error("Nichts zu sourcen.");

      // dedupe against the CRM (by handle) so we never re-add / double-contact
      const handles = [...new Set(src.map((r) => r.handle))];
      const existing = new Set<string>();
      for (let i = 0; i < handles.length; i += 300) {
        const { data } = await supabase.from("creators").select("handle").in("handle", handles.slice(i, i + 300));
        (data ?? []).forEach((c: { handle: string | null }) => c.handle && existing.add(c.handle.toLowerCase()));
      }
      const fresh = src.filter((r) => !existing.has(r.handle.toLowerCase()));
      const now = new Date().toISOString();
      const crows = fresh.map((r) => ({
        handle: r.handle, tiktok_username: r.handle, platform: "tiktok",
        email: r.email || null,
        region_label: r.market === "dach" ? "dach" : r.market === "uk" ? "uk" : null,
        status: r.email ? "enriched" : "sourced",
        enriched_at: r.email ? now : null,
        category: r.category,
        source_type: r.source_type, source_value: r.source_value || r.source_brand,
        label: r.source_value || r.source_brand || null,
        list_id: listId, date_added: now,
      }));

      let inserted = 0;
      for (let i = 0; i < crows.length; i += 200) {
        const { data, error } = await supabase
          .from("creators")
          .upsert(crows.slice(i, i + 200), { onConflict: "email_normalized", ignoreDuplicates: true })
          .select("id");
        if (error) throw error;
        inserted += data?.length ?? 0;
      }
      setNotice(`${inserted} Creator in „${listName}" gesourced${src.length - fresh.length > 0 ? ` · ${src.length - fresh.length} Dubletten übersprungen` : ""}. Öffne „Listen" zum Anreichern & Senden.`);
      setSelected(new Set());
      setShowSource(false);
      supabase.from("lists").select("id,name").eq("kind", "working").order("name")
        .then(({ data }) => setWorkingLists((data ?? []) as WList[]));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setSourcing(false);
  }

  const selCount = selected.size;
  const sourceCount = scope === "selected" ? selCount : total;

  return (
    <div>
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Search</h2>
        <span className="pill">{total.toLocaleString("de-DE")}</span>
        <div className="grow" />
        <input placeholder="Handle / Name / Email…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ minWidth: 200 }} />
      </div>

      <div className="toolbar">
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">Alle Niches</option>
          {NICHES.map((c) => <option key={c} value={c}>{niche(c)}</option>)}
        </select>
        <select value={market} onChange={(e) => setMarket(e.target.value)}>
          <option value="">Alle Märkte</option>
          <option value="dach">DACH</option>
          <option value="uk">UK</option>
          <option value="other">Andere</option>
        </select>
        <select value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
          <option value="">Alle Quellen</option>
          <option value="brand">Brand</option>
          <option value="hashtag">Hashtag</option>
          <option value="sound">Sound</option>
          <option value="creator">Creator</option>
        </select>
        <select value={songpush} onChange={(e) => setSongpush(e.target.value)} title="Attio/Songpush-Abgleich">
          <option value="">Songpush egal</option>
          <option value="exclude">Ohne Songpush-User</option>
          <option value="only">Nur Songpush-User</option>
        </select>
        <select value={emailType} onChange={(e) => setEmailType(e.target.value)}>
          <option value="">Email egal</option>
          <option value="has">Hat Email</option>
          <option value="freemail">Freemail</option>
          <option value="management">Management</option>
        </select>
        <input type="number" placeholder="Follower min" value={follMin} onChange={(e) => setFollMin(e.target.value)} style={{ width: 110 }} />
        <input type="number" placeholder="max" value={follMax} onChange={(e) => setFollMax(e.target.value)} style={{ width: 90 }} />
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          <input type="checkbox" checked={bandOnly} onChange={(e) => setBandOnly(e.target.checked)} />
          ER 2–14 %
        </label>
      </div>

      {/* sourcing bar */}
      <div className="toolbar" style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px" }}>
        <span className="muted" style={{ fontSize: 13 }}>
          {total.toLocaleString("de-DE")} Treffer{selCount > 0 ? ` · ${selCount} ausgewählt` : ""}
        </span>
        <div className="grow" />
        {selCount > 0 && <button onClick={() => setSelected(new Set())}>Auswahl leeren</button>}
        <button className="primary" onClick={() => { setScope(selCount > 0 ? "selected" : "all"); setShowSource((v) => !v); }} disabled={total === 0}>
          In Liste sourcen ▾
        </button>
      </div>

      {showSource && (
        <div className="panel" style={{ padding: 14 }}>
          <div className="toolbar" style={{ margin: 0, marginBottom: 10 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: 0 }}>
              <input type="radio" checked={scope === "all"} onChange={() => setScope("all")} /> Alle {total.toLocaleString("de-DE")} Treffer
            </label>
            {selCount > 0 && (
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: 0 }}>
                <input type="radio" checked={scope === "selected"} onChange={() => setScope("selected")} /> {selCount} ausgewählte
              </label>
            )}
          </div>
          <div className="toolbar" style={{ margin: 0 }}>
            <select value={listMode} onChange={(e) => setListMode(e.target.value as "new" | "existing")}>
              <option value="new">Neue Liste</option>
              <option value="existing">Bestehende Liste</option>
            </select>
            {listMode === "new" ? (
              <input placeholder="Listenname…" value={newListName} onChange={(e) => setNewListName(e.target.value)} style={{ minWidth: 200 }} />
            ) : (
              <select value={existingListId} onChange={(e) => setExistingListId(e.target.value)} style={{ minWidth: 200 }}>
                <option value="">Liste wählen…</option>
                {workingLists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            )}
            <button className="primary" onClick={doSource} disabled={sourcing}>
              {sourcing ? "Source…" : `▶ ${sourceCount.toLocaleString("de-DE")} sourcen`}
            </button>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>
            Dubletten (schon im CRM / bereits kontaktiert) werden automatisch übersprungen. Creator mit Email
            landen als „angereichert", ohne als „roh".
          </p>
        </div>
      )}

      {error && <div className="error">{error}</div>}
      {notice && <div className="success">{notice}</div>}

      <div className="table-wrap table-fit">
        <table>
          <thead>
            <tr>
              <th style={{ width: 28 }}><input type="checkbox" checked={allOnPage} onChange={toggleAll} aria-label="Seite auswählen" /></th>
              <th>Creator</th>
              <th style={{ cursor: "pointer" }} onClick={() => sortBy("follower_count")}>Follower{arrow("follower_count")}</th>
              <th style={{ cursor: "pointer" }} onClick={() => sortBy("engagement_median")}>ER{arrow("engagement_median")}</th>
              <th>Niche</th>
              <th>Markt</th>
              <th>Email</th>
              <th style={{ cursor: "pointer" }} onClick={() => sortBy("sponsored_count")}>Ads{arrow("sponsored_count")}</th>
              <th>Quelle</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="center-loading">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={9} className="center-loading">Keine Creator für diesen Filter.</td></tr>
            ) : (
              rows.map((r) => (
                <tr key={r.sec_uid}>
                  <td><input type="checkbox" checked={selected.has(r.sec_uid)} onChange={() => toggle(r.sec_uid)} /></td>
                  <td>
                    <a href={`https://www.tiktok.com/@${r.handle}`} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>@{r.handle}</a>
                    {r.is_songpush_user && (
                      <a href={r.songpush_admin_url ?? "#"} target="_blank" rel="noreferrer"
                        className="pill pill-good" style={{ fontSize: 9, marginLeft: 6, textTransform: "none" }}
                        title="Ist bereits Songpush-User (Attio)">★ Songpush</a>
                    )}
                    {r.display_name && <div className="muted" style={{ fontSize: 12 }}>{r.display_name}</div>}
                  </td>
                  <td className="num">{fmt(r.follower_count)}</td>
                  <td>{erCell(r.engagement_median)}</td>
                  <td>
                    {niche(r.category) || <span className="muted">—</span>}
                    {r.sub_niche && <div className="muted" style={{ fontSize: 12 }}>{niche(r.sub_niche)}</div>}
                  </td>
                  <td className="muted" style={{ fontSize: 12, textTransform: "uppercase" }}>{r.market || "—"}</td>
                  <td style={{ fontSize: 13 }}>{r.email ? <a href={`mailto:${r.email}`}>{r.email}</a> : <span className="muted">—</span>}</td>
                  <td className="num">{r.sponsored_count || 0}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{r.source_value || r.source_brand || r.source_type || "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pager page={page} pageSize={PAGE} total={total} onPage={setPage} />
    </div>
  );
}
