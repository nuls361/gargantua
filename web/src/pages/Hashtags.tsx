import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";

// Overview of the hashtags our creator index was discovered through, with a
// quality read per hashtag. The key column is "Email %" — the share of a
// hashtag's creators that carry a contact email. High = real, bookable
// influencers; low = faceless "mood/aesthetic" accounts that don't book
// campaigns. Brand hashtags (#sephora, #douglas…) score highest.

type Row = {
  hashtag: string;
  creators: number;
  pct_email: number;
  avg_er: number;
  avg_followers: number;
  is_brand: boolean;
};

type SortKey = "creators" | "pct_email" | "avg_er" | "avg_followers";

const fmt = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, "")}k` : `${n}`;

function emailBadge(pct: number) {
  // green = influencer-rich, amber = mixed, red = mood-account risk
  const [cls, label] =
    pct >= 70 ? ["pill-good", "influencer"] : pct >= 45 ? ["pill-warn", "mixed"] : ["pill-bad", "mood-risk"];
  return (
    <span className={`pill num ${cls}`} title={`${label} — ${pct}% of creators have a contact email`}>
      {pct}%
    </span>
  );
}

export default function Hashtags() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [brandOnly, setBrandOnly] = useState(false);
  const [minCreators, setMinCreators] = useState(5);
  const [sortKey, setSortKey] = useState<SortKey>("creators");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: err } = await supabase
        .from("tt_hashtags")
        .select("hashtag, creators, pct_email, avg_er, avg_followers, is_brand")
        .order("creators", { ascending: false })
        .limit(2000);
      if (err) setError(err.message);
      else setRows((data ?? []) as Row[]);
      setLoading(false);
    })();
  }, []);

  const visible = useMemo(() => {
    let r = rows.filter((x) => x.creators >= minCreators);
    if (brandOnly) r = r.filter((x) => x.is_brand);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      r = r.filter((x) => x.hashtag.includes(q));
    }
    r = [...r].sort((a, b) => {
      const d = (a[sortKey] as number) - (b[sortKey] as number);
      return sortDir === "asc" ? d : -d;
    });
    return r;
  }, [rows, query, brandOnly, minCreators, sortKey, sortDir]);

  function sortBy(k: SortKey) {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir("desc");
    }
  }
  const arrow = (k: SortKey) => (k === sortKey ? (sortDir === "desc" ? " ↓" : " ↑") : "");

  const brandCount = rows.filter((r) => r.is_brand).length;

  return (
    <div>
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Hashtags</h2>
        <div className="grow" />
        <input
          placeholder="Search hashtags…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={brandOnly}
            onChange={(e) => setBrandOnly(e.target.checked)}
          />
          Brand hashtags only ({brandCount})
        </label>
        <select value={minCreators} onChange={(e) => setMinCreators(Number(e.target.value))}>
          <option value={3}>≥ 3 creators</option>
          <option value={5}>≥ 5 creators</option>
          <option value={10}>≥ 10 creators</option>
          <option value={20}>≥ 20 creators</option>
        </select>
      </div>

      <p className="muted">
        How we find creators. <strong>Email %</strong> = share of creators with a contact email
        = <strong>influencer signal</strong>. High (green) = real, bookable influencers; low
        (red) = faceless mood/aesthetic accounts that don't book campaigns.
        Brand hashtags deliver the highest quality.
      </p>

      {error && <div className="error">{error}</div>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Hashtag</th>
              <th style={{ cursor: "pointer" }} onClick={() => sortBy("creators")}>
                Creators{arrow("creators")}
              </th>
              <th style={{ cursor: "pointer" }} onClick={() => sortBy("pct_email")}>
                Email %{arrow("pct_email")}
              </th>
              <th style={{ cursor: "pointer" }} onClick={() => sortBy("avg_er")}>
                Ø ER{arrow("avg_er")}
              </th>
              <th style={{ cursor: "pointer" }} onClick={() => sortBy("avg_followers")}>
                Ø Followers{arrow("avg_followers")}
              </th>
              <th>Typ</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="center-loading">
                  Loading…
                </td>
              </tr>
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={6} className="center-loading">
                  No hashtags for this filter.
                </td>
              </tr>
            ) : (
              visible.map((r) => (
                <tr key={r.hashtag}>
                  <td style={{ fontWeight: 600 }}>#{r.hashtag}</td>
                  <td className="num">{r.creators}</td>
                  <td>{emailBadge(r.pct_email)}</td>
                  <td className="num">{r.avg_er}%</td>
                  <td className="num">{fmt(r.avg_followers)}</td>
                  <td>{r.is_brand ? <span className="pill pill-enriched">Brand</span> : ""}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
