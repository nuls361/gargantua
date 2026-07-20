import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";

// One unified view of every discovery source we harvest from — brands, hashtags,
// sounds and creator seeds in a single table (columns mirror the old Brand table).
// Adding a source queues a scrape_jobs row the Railway worker runs. Product harvests
// default to 2 levels deep.

type SourceType = "brand" | "hashtag" | "sound" | "creator";

type Row = {
  source_type: SourceType;
  source_value: string;
  creators_found: number;
  creators_dach: number;
  creators_uk: number;
  creators_enriched: number;
  last_seen: string | null;
};

type SortKey = "creators_found" | "creators_dach" | "creators_uk" | "creators_enriched";

type SourceCreator = {
  sec_uid: string; handle: string; follower_count: number | null;
  engagement_median: number | null; market: string | null; email: string | null; category: string | null;
};

const TYPE_LABEL: Record<SourceType, string> = {
  brand: "Brand", hashtag: "Hashtag", sound: "Sound", creator: "Creator",
};
const TYPE_CLS: Record<SourceType, string> = {
  brand: "pill-new", hashtag: "pill-good", sound: "pill-neutral", creator: "pill-warn",
};

function displayValue(t: SourceType, v: string): string {
  if (t === "hashtag") return v.startsWith("#") ? v : `#${v}`;
  if (t === "brand" || t === "creator") return v.startsWith("@") ? v : `@${v}`;
  return v;
}
function normalizeValue(t: SourceType, raw: string): string {
  const v = raw.trim();
  if (t === "hashtag") return v.replace(/^#/, "");
  if (t === "brand" || t === "creator") return v.startsWith("@") ? v : `@${v.replace(/^@/, "")}`;
  return v;
}
function optionsFor(t: SourceType): Record<string, unknown> {
  const base = { enrich: true, dach_only: false, budget_usd: 2, max_depth: 2 };
  if (t === "brand") return { ...base, pages: 8 };
  if (t === "hashtag") return { ...base, pages: 8 };
  if (t === "sound") return { ...base, pages: 10 };
  return { ...base, pages: 3 };
}

export default function Harvest() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<"" | SourceType>("");
  const [sortKey, setSortKey] = useState<SortKey>("creators_found");
  const [newType, setNewType] = useState<SourceType>("hashtag");
  const [newVal, setNewVal] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [viewSrc, setViewSrc] = useState<Row | null>(null);
  const [viewRows, setViewRows] = useState<SourceCreator[]>([]);
  const [viewLoading, setViewLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? ""));
  }, []);

  // Click a source -> the creators that came in through it.
  useEffect(() => {
    if (!viewSrc) return;
    setViewLoading(true);
    setViewRows([]);
    supabase.from("tt_creators")
      .select("sec_uid,handle,follower_count,engagement_median,market,email,category")
      .eq("source_value", viewSrc.source_value)
      .order("follower_count", { ascending: false }).limit(300)
      .then(({ data }) => { setViewRows((data ?? []) as SourceCreator[]); setViewLoading(false); });
  }, [viewSrc]);

  const load = useCallback(async () => {
    setLoading(true);
    const [srcRes, brandRes] = await Promise.all([
      supabase.from("source_overview")
        .select("source_type,source_value,creators_found,creators_dach,creators_uk,creators_enriched,last_seen")
        .limit(2000),
      supabase.from("brand_overview")
        .select("handle,creators_found,creators_dach,creators_uk,creators_enriched,last_seen")
        // harvested brands (have creators) + everything classified DACH/UK by account
        // language — the out-of-market "other" candidates stay hidden.
        .or("creators_found.gt.0,market.in.(dach,uk)").limit(2000),
    ]);
    if (srcRes.error) setError(srcRes.error.message);
    const src = (srcRes.data ?? []) as Row[];
    const brands: Row[] = ((brandRes.data ?? []) as Array<Record<string, unknown>>).map((b) => ({
      source_type: "brand",
      source_value: String(b.handle ?? ""),
      creators_found: Number(b.creators_found ?? 0),
      creators_dach: Number(b.creators_dach ?? 0),
      creators_uk: Number(b.creators_uk ?? 0),
      creators_enriched: Number(b.creators_enriched ?? 0),
      last_seen: (b.last_seen as string | null) ?? null,
    }));
    setRows([...src, ...brands]);
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    let r = rows;
    if (typeFilter) r = r.filter((x) => x.source_type === typeFilter);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      r = r.filter((x) => x.source_value.toLowerCase().includes(q));
    }
    return [...r].sort((a, b) => (b[sortKey] ?? 0) - (a[sortKey] ?? 0));
  }, [rows, typeFilter, query, sortKey]);

  async function harvest(type: SourceType, value: string) {
    setBusy(`${type}:${value}`);
    setError(null);
    setNotice(null);
    const { error: jerr } = await supabase.from("scrape_jobs").insert({
      source_type: type, source_value: value,
      requested_by: email || "tool", options: optionsFor(type),
    });
    if (jerr) setError(`Could not queue job: ${jerr.message}`);
    else setNotice(`Harvest queued for ${displayValue(type, value)} (2 levels deep) — the worker will run it.`);
    setBusy(null);
  }

  async function addNew() {
    const v = normalizeValue(newType, newVal);
    if (!v) return;
    if (newType === "brand") {
      await supabase.from("brands").insert({ handle: v, status: "candidate", discovered_via: "manual" });
    }
    await harvest(newType, v);
    setNewVal("");
    void load();
  }

  const totalFound = rows.reduce((s, r) => s + (r.creators_found || 0), 0);

  return (
    <div>
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Harvest</h2>
        <span className="pill">{rows.length} sources</span>
        <span className="muted" style={{ fontSize: 13 }}>{totalFound.toLocaleString("en-GB")} creators found</span>
        <div className="grow" />
        <select value={newType} onChange={(e) => setNewType(e.target.value as SourceType)}>
          <option value="hashtag">Hashtag</option>
          <option value="brand">Brand</option>
          <option value="sound">Sound</option>
          <option value="creator">Creator</option>
        </select>
        <input
          placeholder={newType === "hashtag" ? "#hashtag or word" : newType === "sound" ? "sound id / url" : "@handle"}
          value={newVal}
          onChange={(e) => setNewVal(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addNew()}
          style={{ minWidth: 200 }}
        />
        <button className="primary" onClick={addNew} disabled={!newVal.trim() || busy !== null}>+ Harvest</button>
      </div>

      <p className="muted">
        Every source we discover creators from — brands, hashtags, sounds and creator seeds — in one
        place. Adding one queues a harvest for the worker; the DACH / UK split tells you whether it's
        worth re-harvesting. Team harvests run <strong>2 levels deep</strong> by default.
      </p>

      <div className="toolbar">
        <input placeholder="Search sources…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as "" | SourceType)}>
          <option value="">All types</option>
          <option value="brand">Brands</option>
          <option value="hashtag">Hashtags</option>
          <option value="sound">Sounds</option>
          <option value="creator">Creators</option>
        </select>
        <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
          <option value="creators_found">Sort: Found</option>
          <option value="creators_dach">Sort: DACH</option>
          <option value="creators_uk">Sort: UK</option>
          <option value="creators_enriched">Sort: Enriched</option>
        </select>
      </div>

      {notice && <div className="success">{notice}</div>}
      {error && <div className="error">{error}</div>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Type</th>
              <th style={{ textAlign: "center" }}>Found</th>
              <th style={{ textAlign: "center" }}>DACH</th>
              <th style={{ textAlign: "center" }}>UK</th>
              <th style={{ textAlign: "center" }}>Other</th>
              <th style={{ textAlign: "center" }}>Enriched</th>
              <th>Last</th>
              <th style={{ textAlign: "right" }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="center-loading">Loading…</td></tr>
            ) : visible.length === 0 ? (
              <tr><td colSpan={9} className="center-loading">Nothing harvested yet — add a source above.</td></tr>
            ) : (
              visible.map((r) => (
                <tr key={`${r.source_type}:${r.source_value}`}>
                  <td style={{ fontWeight: 600 }}>
                    <button type="button" onClick={() => setViewSrc(r)} title="Creator dieser Quelle anzeigen"
                      style={{ background: "none", border: "none", padding: 0, color: "var(--accent)", cursor: "pointer", font: "inherit", fontWeight: 600 }}>
                      {displayValue(r.source_type, r.source_value)}
                    </button>
                  </td>
                  <td><span className={`pill ${TYPE_CLS[r.source_type]}`}>{TYPE_LABEL[r.source_type]}</span></td>
                  <td style={{ textAlign: "center" }} className="num">{r.creators_found || "—"}</td>
                  <td style={{ textAlign: "center" }} className="num">{r.creators_dach || "—"}</td>
                  <td style={{ textAlign: "center" }} className="num">{r.creators_uk || "—"}</td>
                  <td style={{ textAlign: "center" }} className="num">
                    {r.creators_found - r.creators_dach - r.creators_uk || "—"}
                  </td>
                  <td style={{ textAlign: "center" }} className="num">{r.creators_enriched || "—"}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{r.last_seen ? new Date(r.last_seen).toLocaleDateString("en-GB") : "—"}</td>
                  <td style={{ textAlign: "right" }}>
                    <button onClick={() => harvest(r.source_type, r.source_value)} disabled={busy === `${r.source_type}:${r.source_value}`}>
                      Re-harvest
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {viewSrc && (
        <div onClick={() => setViewSrc(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} className="panel" style={{ width: "min(900px, 94vw)", maxHeight: "84vh", overflow: "auto", padding: 18 }}>
            <div className="toolbar" style={{ margin: 0, marginBottom: 10 }}>
              <h3 style={{ margin: 0 }}>{displayValue(viewSrc.source_type, viewSrc.source_value)}</h3>
              <span className={`pill ${TYPE_CLS[viewSrc.source_type]}`}>{TYPE_LABEL[viewSrc.source_type]}</span>
              <span className="muted" style={{ fontSize: 13 }}>{viewRows.length} Creator</span>
              <div className="grow" />
              <button onClick={() => setViewSrc(null)}>Schließen</button>
            </div>
            {viewLoading ? (
              <div className="center-loading">Lädt…</div>
            ) : viewRows.length === 0 ? (
              <p className="muted">Noch keine Creator von dieser Quelle.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr>
                    <th>Creator</th><th style={{ textAlign: "right" }}>Follower</th>
                    <th style={{ textAlign: "right" }}>ER</th><th>Topic</th><th>Markt</th><th>Email</th>
                  </tr></thead>
                  <tbody>
                    {viewRows.map((c) => (
                      <tr key={c.sec_uid}>
                        <td><a href={`https://www.tiktok.com/@${c.handle}`} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>@{c.handle}</a></td>
                        <td className="num" style={{ textAlign: "right" }}>{c.follower_count?.toLocaleString("en-GB") ?? "—"}</td>
                        <td className="num" style={{ textAlign: "right" }}>{c.engagement_median != null ? `${c.engagement_median}%` : "—"}</td>
                        <td>{c.category ?? "—"}</td>
                        <td className="muted" style={{ textTransform: "uppercase", fontSize: 12 }}>{c.market ?? "—"}</td>
                        <td style={{ fontSize: 13 }}>{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
