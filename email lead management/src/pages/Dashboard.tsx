import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import LeadsBarChart, { type LeadPoint } from "../components/LeadsBarChart";

export default function Dashboard() {
  const [uk, setUk] = useState<number | null>(null);
  const [dach, setDach] = useState<number | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [series, setSeries] = useState<LeadPoint[]>([]);
  const [chartLoading, setChartLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const [ukRes, dachRes, totalRes] = await Promise.all([
        supabase
          .from("creators")
          .select("id", { count: "exact", head: true })
          .eq("region_label", "uk"),
        supabase
          .from("creators")
          .select("id", { count: "exact", head: true })
          .eq("region_label", "dach"),
        supabase.from("creators").select("id", { count: "exact", head: true }),
      ]);
      setUk(ukRes.count ?? 0);
      setDach(dachRes.count ?? 0);
      setTotal(totalRes.count ?? 0);
    })();

    void (async () => {
      const { data } = await supabase.rpc("leads_by_day");
      setSeries(
        ((data ?? []) as { day: string; n: number }[]).map((d) => ({
          day: d.day,
          n: Number(d.n),
        }))
      );
      setChartLoading(false);
    })();
  }, []);

  const fmt = (n: number | null) => (n == null ? "…" : n.toLocaleString("en-GB"));

  return (
    <div>
      <h2>Dashboard</h2>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: 16,
          marginTop: 8,
        }}
      >
        <div className="stat" style={{ padding: "24px 22px" }}>
          <div className="lbl" style={{ fontSize: 14 }}>Total Leads</div>
          <div style={{ fontSize: 44, fontWeight: 800, marginTop: 6, letterSpacing: "-0.02em" }}>
            {fmt(total)}
          </div>
        </div>
        <div className="stat" style={{ padding: "24px 22px" }}>
          <div className="lbl" style={{ fontSize: 14 }}>UK Leads</div>
          <div style={{ fontSize: 44, fontWeight: 800, marginTop: 6, letterSpacing: "-0.02em" }}>
            {fmt(uk)}
          </div>
        </div>
        <div className="stat" style={{ padding: "24px 22px" }}>
          <div className="lbl" style={{ fontSize: 14 }}>DACH Leads</div>
          <div style={{ fontSize: 44, fontWeight: 800, marginTop: 6, letterSpacing: "-0.02em" }}>
            {fmt(dach)}
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 20 }}>
        <div className="toolbar" style={{ marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>Leads loaded over time</h3>
          <div className="grow" />
          <span className="muted" style={{ fontSize: 12 }}>
            {fmt(total)} total
          </span>
        </div>
        {chartLoading ? (
          <div className="center-loading">Loading chart…</div>
        ) : (
          <LeadsBarChart data={series} />
        )}
      </div>

      <p className="muted" style={{ marginTop: 14 }}>
        Leads only count toward a region once they have a UK/DACH label. The chart
        shows how many leads were loaded per day (by date added) — the initial
        backfill appears as one bar; future imports add new days.
      </p>
    </div>
  );
}
