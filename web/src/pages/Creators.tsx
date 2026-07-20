import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import Pager from "../components/Pager";

// Search = the one creator database (the harvest base, kept high-quality via the terminal).
// A colleague pulls a precise cut (followers, topic, market …), decides how many to take,
// and drops them straight into a list — deduped against the CRM so nobody is double-contacted.

type Row = {
  sec_uid: string;
  tiktok_id: string | null;
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
  "sec_uid,tiktok_id,handle,display_name,follower_count,engagement_median,category,sub_niche,email,email_type,sponsored_count,market,source_type,source_value,source_brand,verified,is_songpush_user,songpush_admin_url";
const PAGE = 50;
const TOPICS = [
  "beauty", "wellness", "fitness", "fashion", "food", "travel", "gaming",
  "tech", "finance", "music", "comedy", "parenting", "home & interior", "sustainability", "lifestyle",
];

const fmt = (n: number | null) => {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return `${n}`;
};
const topic = (s: string | null) => (s ? s.replace(/\b\w/g, (c) => c.toUpperCase()) : s);

function erCell(er: number | null) {
  if (er == null) return <span className="muted">—</span>;
  const [color, label] =
    er < 2 ? ["#767d90", "UGC / dead"] : er > 14 ? ["#8a6100", "mood?"] : ["#16794a", "influencer"];
  return <span className="num" style={{ color, fontWeight: 600 }} title={label}>{er}%</span>;
}

export default function Search() {
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
  const [takeN, setTakeN] = useState("");            // "how many of the cut to add" (blank = all)
  const [listMode, setListMode] = useState<"new" | "existing">("new");
  const [newListName, setNewListName] = useState("");
  const [existingListId, setExistingListId] = useState("");
  const [workingLists, setWorkingLists] = useState<WList[]>([]);
  const [sourcing, setSourcing] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQDeb(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  const loadLists = useCallback(() => {
    supabase.from("lists").select("id,name").eq("kind", "working").order("name")
      .then(({ data }) => setWorkingLists((data ?? []) as WList[]));
  }, []);
  useEffect(() => { loadLists(); }, [loadLists]);

  const withFilters = useCallback(<T,>(qb: T): T => {
    let q = qb as any;
    const qq = qDeb.trim().replace(/^@/, "").replace(/[,()%*]/g, "");
    // In a PostgREST .or() the ilike wildcard is * (not %). Match handle, name, email, TikTok ID.
    if (qq) q = q.or(`handle.ilike.*${qq}*,display_name.ilike.*${qq}*,email.ilike.*${qq}*,tiktok_id.ilike.*${qq}*`);
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
        if (!name) throw new Error("List name is required.");
        const { data, error } = await supabase.from("lists").insert({ name, kind: "working" }).select("id,name").single();
        if (error) throw error;
        listId = data.id; listName = data.name;
      } else if (!listId) throw new Error("Choose a list.");

      const cap = takeN ? Math.max(1, Number(takeN)) : 5000;
      let src: Row[];
      if (scope === "selected") {
        src = rows.filter((r) => selected.has(r.sec_uid)).slice(0, cap);
      } else {
        const { data, error } = await withFilters(supabase.from("tt_creators").select(COLS))
          .order(sortKey, { ascending: sortDir === "asc", nullsFirst: false }).limit(cap);
        if (error) throw error;
        src = (data ?? []) as Row[];
      }
      if (src.length === 0) throw new Error("Nothing to save.");

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
      const skipped = src.length - inserted;   // handle-in-CRM + duplicate-email, combined
      setNotice(`${inserted} creators saved to “${listName}”${skipped > 0 ? ` · ${skipped} skipped (already in CRM or duplicate email)` : ""}. Open “Lists” to send to Instantly.`);
      setSelected(new Set());
      setShowSource(false);
      loadLists();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setSourcing(false);
  }

  const selCount = selected.size;
  const wouldTake = scope === "selected" ? selCount : total;
  const sourceCount = takeN ? Math.min(wouldTake, Math.max(1, Number(takeN))) : wouldTake;

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>Search</h2>
        <span className="pill">{total.toLocaleString("en-GB")}</span>
        <span className="muted" style={{ fontSize: 13 }}>creators in the database</span>
        <div className="grow" />
        <div className="search-field">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
          </svg>
          <input placeholder="Handle, name, email or TikTok ID…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && <button className="search-clear" onClick={() => setQuery("")} aria-label="Clear">×</button>}
        </div>
      </div>

      <div className="toolbar">
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All topics</option>
          {TOPICS.map((c) => <option key={c} value={c}>{topic(c)}</option>)}
        </select>
        <select value={market} onChange={(e) => setMarket(e.target.value)}>
          <option value="">All markets</option>
          <option value="dach">DACH</option>
          <option value="uk">UK</option>
          <option value="other">Other</option>
        </select>
        <select value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
          <option value="">All sources</option>
          <option value="brand">Brand</option>
          <option value="hashtag">Hashtag</option>
          <option value="sound">Sound</option>
          <option value="creator">Creator</option>
        </select>
        <select value={songpush} onChange={(e) => setSongpush(e.target.value)} title="Attio/WePush match">
          <option value="">WePush any</option>
          <option value="exclude">Exclude WePush users</option>
          <option value="only">Only WePush users</option>
        </select>
        <select value={emailType} onChange={(e) => setEmailType(e.target.value)}>
          <option value="">Email any</option>
          <option value="has">Has email</option>
          <option value="freemail">Freemail</option>
          <option value="management">Management</option>
        </select>
        <input type="number" placeholder="Followers min" value={follMin} onChange={(e) => setFollMin(e.target.value)} style={{ width: 110 }} />
        <input type="number" placeholder="max" value={follMax} onChange={(e) => setFollMax(e.target.value)} style={{ width: 90 }} />
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          <input type="checkbox" checked={bandOnly} onChange={(e) => setBandOnly(e.target.checked)} />
          ER 2–14 %
        </label>
      </div>

      {/* sourcing bar */}
      <div className="toolbar" style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px" }}>
        <span className="muted" style={{ fontSize: 13 }}>
          {total.toLocaleString("en-GB")} results{selCount > 0 ? ` · ${selCount} selected` : ""}
        </span>
        <div className="grow" />
        {selCount > 0 && <button onClick={() => setSelected(new Set())}>Clear selection</button>}
        <button className="primary" onClick={() => { setScope(selCount > 0 ? "selected" : "all"); setShowSource((v) => !v); }} disabled={total === 0}>
          Save to list ▾
        </button>
      </div>

      {showSource && (
        <div className="panel" style={{ padding: 14 }}>
          <div className="toolbar" style={{ margin: 0, marginBottom: 10 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: 0 }}>
              <input type="radio" checked={scope === "all"} onChange={() => setScope("all")} /> All {total.toLocaleString("en-GB")} results
            </label>
            {selCount > 0 && (
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: 0 }}>
                <input type="radio" checked={scope === "selected"} onChange={() => setScope("selected")} /> {selCount} selected
              </label>
            )}
            <span className="muted" style={{ fontSize: 13, marginLeft: 8 }}>· take top</span>
            <input type="number" placeholder="all" value={takeN} onChange={(e) => setTakeN(e.target.value)}
              style={{ width: 80 }} title={`Blank = all. Takes the top N by ${sortKey === "follower_count" ? "followers" : sortKey}.`} />
          </div>
          <div className="toolbar" style={{ margin: 0 }}>
            <select value={listMode} onChange={(e) => setListMode(e.target.value as "new" | "existing")}>
              <option value="new">New list</option>
              <option value="existing">Existing list</option>
            </select>
            {listMode === "new" ? (
              <input placeholder="List name…" value={newListName} onChange={(e) => setNewListName(e.target.value)} style={{ minWidth: 200 }} />
            ) : (
              <select value={existingListId} onChange={(e) => setExistingListId(e.target.value)} style={{ minWidth: 200 }}>
                <option value="">Choose a list…</option>
                {workingLists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            )}
            <button className="primary" onClick={doSource} disabled={sourcing}>
              {sourcing ? "Saving…" : `▶ Save ${sourceCount.toLocaleString("en-GB")}`}
            </button>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>
            Duplicates (already in the CRM / already contacted) are skipped automatically. Creators with an email
            land as “enriched”, those without as “raw”.
          </p>
        </div>
      )}

      {error && <div className="error">{error}</div>}
      {notice && <div className="success">{notice}</div>}

      <div className="table-wrap table-fit">
        <table>
          <thead>
            <tr>
              <th style={{ width: 28 }}><input type="checkbox" checked={allOnPage} onChange={toggleAll} aria-label="Select page" /></th>
              <th>Creator</th>
              <th style={{ cursor: "pointer" }} onClick={() => sortBy("follower_count")}>Followers{arrow("follower_count")}</th>
              <th style={{ cursor: "pointer" }} onClick={() => sortBy("engagement_median")}>ER{arrow("engagement_median")}</th>
              <th>Topic</th>
              <th>Market</th>
              <th>Email</th>
              <th style={{ cursor: "pointer" }} onClick={() => sortBy("sponsored_count")}>Ads{arrow("sponsored_count")}</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="center-loading">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={9} className="center-loading">No creators for this filter.</td></tr>
            ) : (
              rows.map((r) => (
                <tr key={r.sec_uid} className={r.is_songpush_user ? "row-wepush" : undefined}>
                  <td><input type="checkbox" checked={selected.has(r.sec_uid)} onChange={() => toggle(r.sec_uid)} /></td>
                  <td>
                    <a href={r.is_songpush_user && r.songpush_admin_url ? r.songpush_admin_url : `https://www.tiktok.com/@${r.handle}`}
                      target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}
                      title={r.is_songpush_user ? "Already a WePush user — opens Attio" : undefined}>@{r.handle}</a>
                    {r.display_name && <div className="muted" style={{ fontSize: 12 }}>{r.display_name}</div>}
                  </td>
                  <td className="num">{fmt(r.follower_count)}</td>
                  <td>{erCell(r.engagement_median)}</td>
                  <td>{topic(r.category) || <span className="muted">—</span>}</td>
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
