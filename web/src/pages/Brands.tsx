import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";

// Brands the scraper discovers. A brand is simply harvested (has creators) or not.
// We show how its reposted creators split across markets (DACH / UK / other) — that's
// what tells you whether a brand is worth re-harvesting. Harvest queues a scrape job.

type Brand = {
  id: number;
  handle: string;
  discovered_via: string | null;
  creators_found: number;
  creators_dach: number;
  creators_uk: number;
  creators_email: number;
  creators_enriched: number;
  last_seen: string | null;
};

type SortKey = "creators_dach" | "creators_uk" | "creators_found" | "creators_enriched";

export default function Brands() {
  const [rows, setRows] = useState<Brand[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("creators_dach");
  const [newHandle, setNewHandle] = useState("");
  const [busy, setBusy] = useState<number | "add" | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? ""));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: err } = await supabase
      .from("brand_overview")
      .select("id,handle,discovered_via,creators_found,creators_dach,creators_uk,creators_email,creators_enriched,last_seen")
      .order("creators_dach", { ascending: false, nullsFirst: false })
      .limit(1000);
    if (err) setError(err.message);
    else setRows((data ?? []) as Brand[]);
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    let r = rows;
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      r = r.filter((b) => b.handle.toLowerCase().includes(q));
    }
    return [...r].sort((a, b) => (b[sortKey] ?? 0) - (a[sortKey] ?? 0));
  }, [rows, query, sortKey]);

  async function harvest(handle: string, id?: number) {
    setBusy(id ?? "add");
    setError(null);
    setNotice(null);
    const { error: jerr } = await supabase.from("scrape_jobs").insert({
      source_type: "brand",
      source_value: handle,
      requested_by: email || "tool",
      options: { pages: 8, enrich: true, dach_only: false, budget_usd: 2 },
    });
    if (jerr) setError(`Could not queue job: ${jerr.message}`);
    else setNotice(`Harvest queued for ${handle} — the worker will run it, results appear here.`);
    setBusy(null);
  }

  async function addBrand() {
    const h = newHandle.trim().replace(/^@/, "");
    if (!h) return;
    setBusy("add");
    setError(null);
    // register (so it shows even before harvest) + queue the harvest
    await supabase.from("brands").insert({ handle: `@${h}`, status: "candidate", discovered_via: "manual" });
    await harvest(`@${h}`);
    setNewHandle("");
    void load();
  }

  return (
    <div>
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Brands</h2>
        <span className="pill">{rows.length}</span>
        <div className="grow" />
        <input
          placeholder="Add a brand handle…"
          value={newHandle}
          onChange={(e) => setNewHandle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addBrand()}
          style={{ minWidth: 180 }}
        />
        <button className="primary" onClick={addBrand} disabled={busy === "add" || !newHandle.trim()}>+ Harvest</button>
      </div>

      <p className="muted">
        Brands the scraper found. A brand is harvested or not. The market split shows how its
        reposted creators divide across DACH / UK — that's the signal for whether to re-harvest.
      </p>

      <div className="toolbar">
        <input placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
          <option value="creators_dach">Sort: DACH creators</option>
          <option value="creators_uk">Sort: UK creators</option>
          <option value="creators_found">Sort: Found</option>
          <option value="creators_enriched">Sort: Enriched</option>
        </select>
      </div>

      {notice && <div className="notice">{notice}</div>}
      {error && <div className="error">{error}</div>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Brand</th>
              <th></th>
              <th style={{ textAlign: "center" }}>Creators</th>
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
              <tr><td colSpan={9} className="center-loading">No brands for this filter.</td></tr>
            ) : (
              visible.map((b) => (
                <tr key={b.id}>
                  <td>
                    <a href={`https://www.tiktok.com/${b.handle}`} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>{b.handle}</a>
                  </td>
                  <td>
                    <span className={`pill ${b.creators_found > 0 ? "pill-good" : "pill-neutral"}`}>
                      {b.creators_found > 0 ? "harvested" : "new"}
                    </span>
                  </td>
                  <td style={{ textAlign: "center" }} className="num">{b.creators_found || "—"}</td>
                  <td style={{ textAlign: "center" }} className="num">{b.creators_dach || "—"}</td>
                  <td style={{ textAlign: "center" }} className="num">{b.creators_uk || "—"}</td>
                  <td style={{ textAlign: "center" }} className="num">
                    {b.creators_found - b.creators_dach - b.creators_uk || "—"}
                  </td>
                  <td style={{ textAlign: "center" }} className="num">{b.creators_enriched || "—"}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{b.last_seen ? new Date(b.last_seen).toLocaleDateString("en-GB") : "—"}</td>
                  <td style={{ textAlign: "right" }}>
                    <button onClick={() => harvest(b.handle, b.id)} disabled={busy === b.id}>
                      {b.creators_found > 0 ? "Re-harvest" : "Harvest"}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
