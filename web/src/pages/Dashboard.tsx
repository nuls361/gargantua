import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import GrowthChart, { type LeadPoint } from "../components/GrowthChart";

// Dashboard — the creator database at a glance, redesigned (scoped under .wp).
// Aggregates come from count(head) queries + the leads_by_day RPC (no GROUP BY needed).

const TOPICS = ["beauty","wellness","fitness","fashion","food","travel","gaming","tech","finance","music","comedy","parenting","home & interior","sustainability","relationship","dance","pets","cars","education","art","lifestyle"];
const CAT_HUE: Record<string, number> = { beauty:330,lifestyle:255,fashion:280,parenting:340,food:26,travel:200,fitness:14,wellness:160,education:230,relationship:350,comedy:45,"home & interior":175,music:190,tech:210,gaming:250,finance:150,sustainability:135,dance:300,pets:32,cars:220,art:265 };
const PERSONAS = ["solo","family","couple","group"];
const PLABEL: Record<string, string> = { solo:"Solo", family:"Family", couple:"Couple", group:"Group" };
const fmt = (n: number) => n >= 1e3 ? `${(n/1e3).toFixed(1).replace(/\.0$/,"")}k` : `${n}`;

async function count(filter?: (q: any) => any): Promise<number> {
  let q = supabase.from("tt_creators").select("sec_uid", { count: "exact", head: true }) as any;
  if (filter) q = filter(q);
  const { count: c } = await q;
  return c ?? 0;
}

export default function Dashboard() {
  const [total, setTotal] = useState<number | null>(null);
  const [dach, setDach] = useState(0);
  const [adexp, setAdexp] = useState(0);
  const [market, setMarket] = useState<{ dach: number; us: number; uk: number; other: number }>({ dach: 0, us: 0, uk: 0, other: 0 });
  const [topics, setTopics] = useState<{ topic: string; n: number }[]>([]);
  const [personas, setPersonas] = useState<{ p: string; n: number }[]>([]);
  const [series, setSeries] = useState<LeadPoint[]>([]);
  const [chartLoading, setChartLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const [t, d, u, us, ad] = await Promise.all([
        count(), count(q => q.eq("market", "dach")), count(q => q.eq("market", "uk")),
        count(q => q.eq("market", "us")), count(q => q.gte("sponsored_count", 2)),
      ]);
      setTotal(t); setDach(d); setAdexp(ad);
      setMarket({ dach: d, uk: u, us, other: Math.max(0, t - d - u - us) });
    })();
    void (async () => {
      const c = await Promise.all(TOPICS.map(async t => ({ topic: t, n: await count(q => q.eq("category", t)) })));
      setTopics(c.filter(x => x.n > 0).sort((a, b) => b.n - a.n));
    })();
    void (async () => {
      const c = await Promise.all(PERSONAS.map(async p => ({ p, n: await count(q => q.eq("persona", p)) })));
      setPersonas(c.filter(x => x.n > 0).sort((a, b) => b.n - a.n));
    })();
    void (async () => {
      const { data } = await supabase.rpc("tt_creators_by_day");
      setSeries(((data ?? []) as { day: string; n: number }[]).map(d => ({ day: d.day, n: Number(d.n) })));
      setChartLoading(false);
    })();
  }, []);

  const MARKET = [
    ["DACH", market.dach, "#12A150"], ["US", market.us, "#5B50E8"], ["UK", market.uk, "#C2680B"], ["Other", market.other, "#B6BAC6"],
  ] as [string, number, string][];
  const mtot = MARKET.reduce((a, m) => a + m[1], 0) || 1;
  let off = 25;
  const topMax = topics[0]?.n || 1;
  const pMax = personas[0]?.n || 1;

  return (
    <div className="wp">
      <div className="eyebrow">Overview</div>
      <h1>Dashboard</h1>
      <div className="sub">The creator database at a glance.</div>

      <div className="stats" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
        {([["Total creators", total == null ? "…" : total.toLocaleString("en-GB"), "var(--wp-acc)"],
          ["DACH 🇩🇪", dach.toLocaleString("en-GB"), "var(--wp-good)"],
          ["Ad-experienced", adexp.toLocaleString("en-GB"), "var(--wp-warn)"]] as [string, string, string][]).map(([k, v, c]) => (
          <div className="stat-card" key={k}><div className="k"><i style={{ background: c }} />{k}</div><div className="v num">{v}</div></div>
        ))}
      </div>

      <div className="grid2">
        <div className="panelc">
          <div className="phead"><div><div className="pt">Database growth</div><div className="pts">Cumulative creators in the pool</div></div></div>
          {chartLoading ? <div className="empty">Loading chart…</div> : <GrowthChart data={series} />}
        </div>
        <div className="panelc">
          <div className="phead"><div><div className="pt">By market</div><div className="pts">Where they post</div></div></div>
          <div className="donut">
            <svg viewBox="0 0 42 42">
              {MARKET.map((m, i) => { const pc = m[1] / mtot * 100; const el = <circle key={i} cx="21" cy="21" r="15.915" fill="none" stroke={m[2]} strokeWidth="5.5" strokeDasharray={`${pc.toFixed(2)} ${(100 - pc).toFixed(2)}`} strokeDashoffset={off.toFixed(2)} />; off -= pc; return el; })}
              <text x="21" y="20.5" textAnchor="middle" fontSize="6" fontWeight="800" fill="var(--wp-ink)">{fmt(mtot)}</text>
              <text x="21" y="26" textAnchor="middle" fontSize="2.6" fill="var(--wp-muted)">creators</text>
            </svg>
            <div className="legend">
              {MARKET.map(m => <div className="li" key={m[0]}><i style={{ background: m[2] }} /><span>{m[0]}</span><b>{m[1].toLocaleString("en-GB")}</b></div>)}
            </div>
          </div>
        </div>
      </div>

      <div className="grid2">
        <div className="panelc">
          <div className="phead"><div><div className="pt">By topic</div><div className="pts">Creators per content niche</div></div></div>
          <div className="bars">
            {topics.map(t => (
              <div className="barr" key={t.topic}><div className="bl">{t.topic}</div><div className="bt"><div className="bf" style={{ width: `${t.n / topMax * 100}%`, background: `hsl(${CAT_HUE[t.topic] ?? 255} 60% 55%)` }} /></div><div className="bv">{t.n.toLocaleString("en-GB")}</div></div>
            ))}
          </div>
        </div>
        <div className="panelc">
          <div className="phead"><div><div className="pt">By persona</div><div className="pts">Who appears in the content</div></div></div>
          <div className="bars">
            {personas.map(p => (
              <div className="barr" key={p.p} style={{ gridTemplateColumns: "70px 1fr auto" }}><div className="bl">{PLABEL[p.p] || p.p}</div><div className="bt"><div className="bf" style={{ width: `${p.n / pMax * 100}%`, background: "var(--wp-acc)" }} /></div><div className="bv">{p.n.toLocaleString("en-GB")}</div></div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
