import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";

// Generic management view for a discovery source type (sound / creator seed / hashtag).
// Shows what we've harvested from each source with its DACH/UK yield, lets you re-harvest,
// and lets you kick off a harvest of a NEW source (which creates a scrape_jobs job the
// Railway worker runs). Brands have their own page (they carry a curation status).

type Row = {
  source_type: string;
  source_value: string;
  creators_found: number;
  creators_dach: number;
  creators_uk: number;
  creators_email: number;
  creators_enriched: number;
  last_seen: string | null;
};

function YieldBar({ n, found }: { n: number; found: number }) {
  const pct = found ? Math.round((n / found) * 100) : 0;
  const tone = pct >= 50 ? "#16794a" : pct >= 20 ? "#8a6100" : "#b83636";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 110 }}>
      <div style={{ flex: 1, height: 6, background: "#eef0f4", borderRadius: 999, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: tone, borderRadius: 999 }} />
      </div>
      <span className="num" style={{ fontSize: 12, color: tone, fontWeight: 600, minWidth: 32, textAlign: "right" }}>{pct}%</span>
    </div>
  );
}

export default function SourceManager({
  title,
  sourceType,
  intro,
  addPlaceholder,
  formatValue = (v) => v,
  harvestOptions,
}: {
  title: string;
  sourceType: "sound" | "creator" | "hashtag";
  intro: string;
  addPlaceholder: string;
  formatValue?: (v: string) => string;
  harvestOptions: Record<string, unknown>;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [query, setQuery] = useState("");
  const [newVal, setNewVal] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? ""));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: err } = await supabase
      .from("source_overview")
      .select("*")
      .eq("source_type", sourceType)
      .order("creators_found", { ascending: false })
      .limit(1000);
    if (err) setError(err.message);
    else setRows((data ?? []) as Row[]);
    setLoading(false);
  }, [sourceType]);
  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? rows.filter((r) => r.source_value.toLowerCase().includes(q)) : rows;
  }, [rows, query]);

  async function harvest(sourceValue: string) {
    setBusy(sourceValue);
    setError(null);
    setNotice(null);
    const { error: jerr } = await supabase.from("scrape_jobs").insert({
      source_type: sourceType,
      source_value: sourceValue,
      requested_by: email || "tool",
      options: harvestOptions,
    });
    if (jerr) setError(`Could not queue job: ${jerr.message}`);
    else setNotice(`Harvest queued for ${formatValue(sourceValue)} — the worker will run it, yield updates here.`);
    setBusy(null);
  }

  async function addNew() {
    const v = newVal.trim();
    if (!v) return;
    await harvest(v);
    setNewVal("");
  }

  return (
    <div>
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>{title}</h2>
        <span className="pill">{rows.length}</span>
        <div className="grow" />
        <input
          placeholder={addPlaceholder}
          value={newVal}
          onChange={(e) => setNewVal(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addNew()}
          style={{ minWidth: 240 }}
        />
        <button className="primary" onClick={addNew} disabled={!newVal.trim() || busy !== null}>+ Harvest</button>
      </div>

      <p className="muted">{intro}</p>

      <div className="toolbar">
        <input placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {notice && <div className="notice">{notice}</div>}
      {error && <div className="error">{error}</div>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th style={{ textAlign: "center" }}>Found</th>
              <th style={{ textAlign: "center" }}>DACH</th>
              <th>DACH yield</th>
              <th style={{ textAlign: "center" }}>UK</th>
              <th>UK yield</th>
              <th style={{ textAlign: "center" }}>Enriched</th>
              <th>Last</th>
              <th style={{ textAlign: "right" }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="center-loading">Loading…</td></tr>
            ) : visible.length === 0 ? (
              <tr><td colSpan={9} className="center-loading">Nothing harvested yet — add one above.</td></tr>
            ) : (
              visible.map((r) => (
                <tr key={r.source_value}>
                  <td style={{ fontWeight: 600 }}>{formatValue(r.source_value)}</td>
                  <td style={{ textAlign: "center" }} className="num">{r.creators_found}</td>
                  <td style={{ textAlign: "center" }} className="num">{r.creators_dach || "—"}</td>
                  <td><YieldBar n={r.creators_dach} found={r.creators_found} /></td>
                  <td style={{ textAlign: "center" }} className="num">{r.creators_uk || "—"}</td>
                  <td><YieldBar n={r.creators_uk} found={r.creators_found} /></td>
                  <td style={{ textAlign: "center" }} className="num">{r.creators_enriched || "—"}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{r.last_seen ? new Date(r.last_seen).toLocaleDateString("en-GB") : "—"}</td>
                  <td style={{ textAlign: "right" }}>
                    <button onClick={() => harvest(r.source_value)} disabled={busy === r.source_value}>Re-harvest</button>
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
