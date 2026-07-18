import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";

// Manage the brands the scraper discovers. Each row shows live DACH yield (from
// tt_creators.source_brand) and a Harvest button that queues a scrape_jobs job —
// the Railway worker picks it up, harvests the brand's repost feed, and the yield
// here updates itself. Curate with 👍 gut / 🚫 raus so the good seeds surface.

type Brand = {
  id: number;
  handle: string;
  name: string | null;
  market: string | null;
  status: "candidate" | "queued" | "harvested" | "good" | "rejected";
  discovered_via: string | null;
  notes: string | null;
  creators_found: number;
  creators_dach: number;
  creators_uk: number;
  creators_email: number;
  creators_enriched: number;
  last_seen: string | null;
};

type SortKey = "creators_dach" | "creators_uk" | "creators_found" | "creators_enriched";

const STATUS_PILL: Record<Brand["status"], { cls: string; label: string }> = {
  candidate: { cls: "pill-neutral", label: "Kandidat" },
  queued: { cls: "pill-queued", label: "In Arbeit" },
  harvested: { cls: "pill-in_instantly", label: "Geharvestet" },
  good: { cls: "pill-good", label: "Gut" },
  rejected: { cls: "pill-bad", label: "Raus" },
};

function YieldBar({ n, found }: { n: number; found: number }) {
  const pct = found ? Math.round((n / found) * 100) : 0;
  const tone = pct >= 50 ? "#16794a" : pct >= 20 ? "#8a6100" : "#b83636";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 120 }}>
      <div style={{ flex: 1, height: 6, background: "#eef0f4", borderRadius: 999, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: tone, borderRadius: 999 }} />
      </div>
      <span className="num" style={{ fontSize: 12, color: tone, fontWeight: 600, minWidth: 34, textAlign: "right" }}>
        {pct}%
      </span>
    </div>
  );
}

export default function Brands() {
  const [rows, setRows] = useState<Brand[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState<string>("");

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string>("");
  const [sortKey, setSortKey] = useState<SortKey>("creators_dach");
  const [newHandle, setNewHandle] = useState("");
  const [busy, setBusy] = useState<number | "add" | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? ""));
  }, []);

  async function load() {
    setLoading(true);
    const { data, error: err } = await supabase
      .from("brand_overview")
      .select("*")
      .order("creators_dach", { ascending: false, nullsFirst: false })
      .limit(1000);
    if (err) setError(err.message);
    else setRows((data ?? []) as Brand[]);
    setLoading(false);
  }
  useEffect(() => {
    void load();
  }, []);

  const visible = useMemo(() => {
    let r = rows;
    if (status) r = r.filter((b) => b.status === status);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      r = r.filter((b) => b.handle.toLowerCase().includes(q) || (b.name ?? "").toLowerCase().includes(q));
    }
    return [...r].sort((a, b) => (b[sortKey] ?? 0) - (a[sortKey] ?? 0));
  }, [rows, status, query, sortKey]);

  async function harvest(b: Brand) {
    setBusy(b.id);
    setNotice(null);
    setError(null);
    const { error: jerr } = await supabase.from("scrape_jobs").insert({
      source_type: "brand",
      source_value: b.handle,
      requested_by: email || "tool",
      options: { pages: 8, enrich: true, dach_only: true, budget_usd: 2 },
    });
    if (jerr) {
      setError(`Job anlegen fehlgeschlagen: ${jerr.message}`);
      setBusy(null);
      return;
    }
    await supabase.from("brands").update({ status: "queued" }).eq("id", b.id);
    setNotice(`Harvest-Job für ${b.handle} angelegt — der Worker läuft ihn ab, Yield aktualisiert sich hier.`);
    setBusy(null);
    void load();
  }

  async function setStatusOf(b: Brand, s: Brand["status"]) {
    setBusy(b.id);
    await supabase.from("brands").update({ status: s }).eq("id", b.id);
    setRows((prev) => prev.map((x) => (x.id === b.id ? { ...x, status: s } : x)));
    setBusy(null);
  }

  async function addBrand() {
    const h = newHandle.trim().replace(/^@/, "");
    if (!h) return;
    setBusy("add");
    setError(null);
    const { error: aerr } = await supabase
      .from("brands")
      .insert({ handle: `@${h}`, status: "candidate", discovered_via: "manual" });
    if (aerr) setError(aerr.message.includes("duplicate") ? `@${h} ist schon da.` : aerr.message);
    else {
      setNewHandle("");
      setNotice(`@${h} als Kandidat hinzugefügt — jetzt „Harvest" klicken.`);
      void load();
    }
    setBusy(null);
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const b of rows) c[b.status] = (c[b.status] ?? 0) + 1;
    return c;
  }, [rows]);

  return (
    <div>
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Brands</h2>
        <span className="pill">{rows.length}</span>
        <div className="grow" />
        <input
          placeholder="Brand-Handle hinzufügen…"
          value={newHandle}
          onChange={(e) => setNewHandle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addBrand()}
          style={{ minWidth: 180 }}
        />
        <button className="primary" onClick={addBrand} disabled={busy === "add" || !newHandle.trim()}>
          + Brand
        </button>
      </div>

      <p className="muted">
        Die Brands, die der Scraper findet. <strong>DACH-Yield</strong> = Anteil deutschsprachiger
        Creator im Repost-Feed — der Wert, der zählt. <strong>Harvest</strong> legt einen Job an, den
        der Worker abarbeitet. Kuratiere mit 👍 / 🚫, damit die guten Seeds oben stehen.
      </p>

      <div className="toolbar">
        <input placeholder="Suchen…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Alle Status ({rows.length})</option>
          {(["good", "harvested", "candidate", "queued", "rejected"] as const).map((s) => (
            <option key={s} value={s}>
              {STATUS_PILL[s].label} ({counts[s] ?? 0})
            </option>
          ))}
        </select>
        <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
          <option value="creators_dach">Sortieren: DACH-Creator</option>
          <option value="creators_uk">Sortieren: UK-Creator</option>
          <option value="creators_found">Sortieren: Gefunden</option>
          <option value="creators_enriched">Sortieren: Enriched</option>
        </select>
      </div>

      {notice && <div className="notice">{notice}</div>}
      {error && <div className="error">{error}</div>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Brand</th>
              <th>Status</th>
              <th style={{ textAlign: "center" }}>Gefunden</th>
              <th style={{ textAlign: "center" }}>DACH</th>
              <th>DACH-Yield</th>
              <th style={{ textAlign: "center" }}>UK</th>
              <th>UK-Yield</th>
              <th style={{ textAlign: "center" }}>Enriched</th>
              <th>Zuletzt</th>
              <th style={{ textAlign: "right" }}>Aktion</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={10} className="center-loading">Loading…</td></tr>
            ) : visible.length === 0 ? (
              <tr><td colSpan={10} className="center-loading">Keine Brands für diesen Filter.</td></tr>
            ) : (
              visible.map((b) => (
                <tr key={b.id}>
                  <td>
                    <a
                      href={`https://www.tiktok.com/${b.handle}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontWeight: 600 }}
                    >
                      {b.handle}
                    </a>
                    {b.discovered_via && b.discovered_via !== "harvest" && (
                      <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>{b.discovered_via}</span>
                    )}
                  </td>
                  <td>
                    <span className={`pill ${STATUS_PILL[b.status].cls}`}>{STATUS_PILL[b.status].label}</span>
                  </td>
                  <td style={{ textAlign: "center" }} className="num">{b.creators_found || "—"}</td>
                  <td style={{ textAlign: "center" }} className="num">{b.creators_dach || "—"}</td>
                  <td>{b.creators_found ? <YieldBar n={b.creators_dach} found={b.creators_found} /> : <span className="muted">—</span>}</td>
                  <td style={{ textAlign: "center" }} className="num">{b.creators_uk || "—"}</td>
                  <td>{b.creators_found ? <YieldBar n={b.creators_uk} found={b.creators_found} /> : <span className="muted">—</span>}</td>
                  <td style={{ textAlign: "center" }} className="num">{b.creators_enriched || "—"}</td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {b.last_seen ? new Date(b.last_seen).toLocaleDateString("de-DE") : "—"}
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button onClick={() => harvest(b)} disabled={busy === b.id} title="Repost-Feed harvesten">
                      Harvest
                    </button>
                    <button
                      onClick={() => setStatusOf(b, b.status === "good" ? "harvested" : "good")}
                      disabled={busy === b.id}
                      title="Als guten Seed markieren"
                      style={{ marginLeft: 6 }}
                    >
                      {b.status === "good" ? "★" : "☆"}
                    </button>
                    <button
                      className="danger"
                      onClick={() => setStatusOf(b, "rejected")}
                      disabled={busy === b.id || b.status === "rejected"}
                      title="Aussortieren"
                      style={{ marginLeft: 6 }}
                    >
                      🚫
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
