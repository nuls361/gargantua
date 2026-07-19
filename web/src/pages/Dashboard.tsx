import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import GrowthChart, { type LeadPoint } from "../components/GrowthChart";

const TOPICS = [
  "beauty", "wellness", "fitness", "fashion", "food", "travel", "gaming",
  "tech", "finance", "music", "comedy", "parenting", "home & interior", "sustainability", "lifestyle",
];
const cap = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const TOPIC_COLORS = ["#4f46e5", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"];

export default function Dashboard() {
  const [uk, setUk] = useState<number | null>(null);
  const [dach, setDach] = useState<number | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [series, setSeries] = useState<LeadPoint[]>([]);
  const [chartLoading, setChartLoading] = useState(true);
  const [topics, setTopics] = useState<{ topic: string; n: number }[]>([]);
  const [topicsLoading, setTopicsLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const [ukRes, dachRes, totalRes] = await Promise.all([
        supabase.from("creators").select("id", { count: "exact", head: true }).eq("region_label", "uk"),
        supabase.from("creators").select("id", { count: "exact", head: true }).eq("region_label", "dach"),
        supabase.from("creators").select("id", { count: "exact", head: true }),
      ]);
      setUk(ukRes.count ?? 0);
      setDach(dachRes.count ?? 0);
      setTotal(totalRes.count ?? 0);
    })();

    void (async () => {
      const { data } = await supabase.rpc("leads_by_day");
      setSeries(((data ?? []) as { day: string; n: number }[]).map((d) => ({ day: d.day, n: Number(d.n) })));
      setChartLoading(false);
    })();

    void (async () => {
      const counts = await Promise.all(
        TOPICS.map(async (t) => {
          const { count } = await supabase
            .from("creators").select("id", { count: "exact", head: true }).eq("category", t);
          return { topic: t, n: count ?? 0 };
        })
      );
      setTopics(counts.filter((c) => c.n > 0).sort((a, b) => b.n - a.n));
      setTopicsLoading(false);
    })();
  }, []);

  const fmt = (n: number | null) => (n == null ? "…" : n.toLocaleString("en-GB"));
  const topicMax = Math.max(1, ...topics.map((t) => t.n));

  return (
    <div>
      <h2>Dashboard</h2>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, marginTop: 8 }}>
        <div className="stat" style={{ padding: "24px 22px" }}>
          <div className="lbl" style={{ fontSize: 14 }}>Total Leads</div>
          <div style={{ fontSize: 44, fontWeight: 800, marginTop: 6, letterSpacing: "-0.02em" }}>{fmt(total)}</div>
        </div>
        <div className="stat" style={{ padding: "24px 22px" }}>
          <div className="lbl" style={{ fontSize: 14 }}>DACH Leads</div>
          <div style={{ fontSize: 44, fontWeight: 800, marginTop: 6, letterSpacing: "-0.02em" }}>{fmt(dach)}</div>
        </div>
        <div className="stat" style={{ padding: "24px 22px" }}>
          <div className="lbl" style={{ fontSize: 14 }}>UK Leads</div>
          <div style={{ fontSize: 44, fontWeight: 800, marginTop: 6, letterSpacing: "-0.02em" }}>{fmt(uk)}</div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 20 }}>
        <div className="toolbar" style={{ marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>Lead growth</h3>
          <div className="grow" />
          <span className="muted" style={{ fontSize: 12 }}>{fmt(total)} total · cumulative</span>
        </div>
        {chartLoading ? <div className="center-loading">Loading chart…</div> : <GrowthChart data={series} />}
      </div>

      <div className="panel" style={{ marginTop: 20 }}>
        <div className="toolbar" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Creators by topic</h3>
          <div className="grow" />
          <span className="muted" style={{ fontSize: 12 }}>{topics.length} topics</span>
        </div>
        {topicsLoading ? (
          <div className="center-loading">Loading…</div>
        ) : topics.length === 0 ? (
          <p className="muted">No topics categorised yet.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {topics.map((t, i) => (
              <div key={t.topic} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ width: 120, fontSize: 13, textAlign: "right", flex: "none" }}>{cap(t.topic)}</div>
                <div style={{ flex: 1, background: "var(--border)", borderRadius: 6, height: 22, overflow: "hidden" }}>
                  <div style={{
                    width: `${(t.n / topicMax) * 100}%`, height: "100%",
                    background: TOPIC_COLORS[i % TOPIC_COLORS.length], borderRadius: 6,
                    minWidth: 2, transition: "width .3s",
                  }} />
                </div>
                <div className="num" style={{ width: 64, fontSize: 13, fontWeight: 600 }}>{t.n.toLocaleString("en-GB")}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="muted" style={{ marginTop: 14 }}>
        Leads count toward a region once they carry a UK/DACH label. The growth curve is the
        running total of leads by date added; the topic split is the categorised creator base.
      </p>
    </div>
  );
}
