import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";

// The brand-vetted DACH creator cohort, sourced from brands' TikTok repost feeds.
// This is the outreach list: every row is a real, contactable creator with an email.
// The ER column is the mood-vs-influencer signal (2-14% = bookable; <2 = dead/UGC;
// >14 = often a faceless "mood" account). source_brand = which brand amplified them.

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
  source_brand: string | null;
  market: string | null;
};

type SortKey = "follower_count" | "engagement_median" | "sponsored_count";

const fmt = (n: number | null) =>
  n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, "")}k` : `${n}`;

// ER band -> profile read (encodes the mood/UGC/influencer learning)
function erCell(er: number | null) {
  if (er == null) return <span className="muted">—</span>;
  const [cls, label] =
    er < 2 ? ["pill-neutral", "UGC / tot"] : er > 14 ? ["pill-warn", "mood?"] : ["pill-good", "influencer"];
  return (
    <span className={`pill num ${cls}`} title={label}>
      {er}%
    </span>
  );
}

export default function Creators() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [brand, setBrand] = useState("");
  const [category, setCategory] = useState("");
  const [emailType, setEmailType] = useState("");
  const [bandOnly, setBandOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("follower_count");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: err } = await supabase
        .from("tt_creators")
        .select("sec_uid,handle,display_name,follower_count,engagement_median,category,sub_niche,email,email_type,sponsored_count,source_brand,market")
        .eq("source_channel", "repost")
        .eq("market", "dach")
        .order("follower_count", { ascending: false })
        .limit(2000);
      if (err) setError(err.message);
      else setRows((data ?? []) as Row[]);
      setLoading(false);
    })();
  }, []);

  const brands = useMemo(
    () => [...new Set(rows.map((r) => r.source_brand).filter(Boolean))].sort() as string[],
    [rows]
  );
  const categories = useMemo(
    () => [...new Set(rows.map((r) => r.category).filter(Boolean))].sort() as string[],
    [rows]
  );

  const visible = useMemo(() => {
    let r = rows;
    if (brand) r = r.filter((x) => x.source_brand === brand);
    if (category) r = r.filter((x) => x.category === category);
    if (emailType) r = r.filter((x) => x.email_type === emailType);
    if (bandOnly)
      r = r.filter((x) => x.engagement_median != null && x.engagement_median >= 2 && x.engagement_median <= 14);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      r = r.filter(
        (x) =>
          x.handle.toLowerCase().includes(q) ||
          (x.display_name ?? "").toLowerCase().includes(q) ||
          (x.email ?? "").toLowerCase().includes(q)
      );
    }
    return [...r].sort((a, b) => {
      const d = ((a[sortKey] as number) ?? 0) - ((b[sortKey] as number) ?? 0);
      return sortDir === "asc" ? d : -d;
    });
  }, [rows, brand, category, emailType, bandOnly, query, sortKey, sortDir]);

  function sortBy(k: SortKey) {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir("desc");
    }
  }
  const arrow = (k: SortKey) => (k === sortKey ? (sortDir === "desc" ? " ↓" : " ↑") : "");

  const mgmt = visible.filter((r) => r.email_type === "management").length;

  return (
    <div>
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Creators</h2>
        <span className="pill">{visible.length}</span>
        <div className="grow" />
        <input placeholder="Handle / Name / Email…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select value={brand} onChange={(e) => setBrand(e.target.value)}>
          <option value="">Alle Brands</option>
          {brands.map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">Alle Niches</option>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select value={emailType} onChange={(e) => setEmailType(e.target.value)}>
          <option value="">Alle Emails</option>
          <option value="management">Management</option>
          <option value="freemail">Freemail</option>
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <input type="checkbox" checked={bandOnly} onChange={(e) => setBandOnly(e.target.checked)} />
          nur ER 2–14 %
        </label>
      </div>

      <p className="muted">
        Brand-vetted DACH-Creator aus Repost-Feeds — alle mit Kontakt-Email, buchbar. <strong>ER</strong> =
        Mood-vs-Influencer-Signal (grün 2–14 % = echt, amber &gt;14 % = evtl. Mood, gelb &lt;2 % = UGC/tot).
        {mgmt > 0 && <> · {mgmt} Management-vertreten.</>}
      </p>

      {error && <div className="error">{error}</div>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Creator</th>
              <th style={{ cursor: "pointer" }} onClick={() => sortBy("follower_count")}>Follower{arrow("follower_count")}</th>
              <th style={{ cursor: "pointer" }} onClick={() => sortBy("engagement_median")}>ER{arrow("engagement_median")}</th>
              <th>Niche</th>
              <th>Email</th>
              <th style={{ cursor: "pointer" }} onClick={() => sortBy("sponsored_count")}>Ads{arrow("sponsored_count")}</th>
              <th>Brand</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="center-loading">Loading…</td></tr>
            ) : visible.length === 0 ? (
              <tr><td colSpan={7} className="center-loading">Keine Creator für diesen Filter.</td></tr>
            ) : (
              visible.map((r) => (
                <tr key={r.sec_uid}>
                  <td>
                    <a href={`https://www.tiktok.com/@${r.handle}`} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>
                      @{r.handle}
                    </a>
                    {r.display_name && <div className="muted" style={{ fontSize: 12 }}>{r.display_name}</div>}
                  </td>
                  <td className="num">{fmt(r.follower_count)}</td>
                  <td>{erCell(r.engagement_median)}</td>
                  <td>
                    {r.category || <span className="muted">—</span>}
                    {r.sub_niche && <div className="muted" style={{ fontSize: 12 }}>{r.sub_niche}</div>}
                  </td>
                  <td style={{ fontSize: 13 }}>
                    {r.email ? (
                      <>
                        <a href={`mailto:${r.email}`}>{r.email}</a>
                        {r.email_type === "management" && <span className="pill pill-enriched" style={{ marginLeft: 6 }}>mgmt</span>}
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="num">{r.sponsored_count || 0}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{r.source_brand}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
