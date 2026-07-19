import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { toCsv } from "../lib/csv";
import CreatorTable from "../components/CreatorTable";
import Pager from "../components/Pager";
import type { Creator } from "../lib/types";

// Recycle = leads we contacted, that didn't reply/bounce/unsubscribe, gone cold for a
// while — ready to re-approach. Three dynamic segments by idle time (days since last
// contact). All derived live from the contact-state fields.

const SEGMENTS = [30, 60, 90];
const PAGE = 50;
const CREATOR_SELECT =
  "id, handle, tiktok_username, platform, email, region_label, label, sample_creator, status, filter_reason, enriched_at, enriched_payload, campaign_id, date_added, added_to_instantly_at, first_contacted_at, last_contacted_at, contact_count, last_outcome, next_eligible_at, do_not_contact";

const cutoff = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

// eligible-to-recycle: contacted, no reply/bounce/unsubscribe, not DNC, idle >= days.
function eligible<T>(qb: T, days: number): T {
  return (qb as any)
    .gt("contact_count", 0)
    .eq("do_not_contact", false)
    .or("last_outcome.is.null,last_outcome.eq.sent")
    .lte("last_contacted_at", cutoff(days)) as T;
}

export default function RecycleList() {
  const [days, setDays] = useState(() => {
    const d = Number(new URLSearchParams(window.location.search).get("days"));
    return SEGMENTS.includes(d) ? d : 60;
  });
  const [rows, setRows] = useState<Creator[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState<Record<number, number>>({});

  useEffect(() => {
    SEGMENTS.forEach(async (d) => {
      const { count } = await eligible(
        supabase.from("creators").select("id", { count: "exact", head: true }), d);
      setCounts((c) => ({ ...c, [d]: count ?? 0 }));
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, count } = await eligible(
      supabase.from("creators").select(CREATOR_SELECT, { count: "exact" }), days)
      .order("last_contacted_at", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    setRows((data ?? []) as unknown as Creator[]);
    setTotal(count ?? 0);
    setLoading(false);
  }, [days, page]);

  useEffect(() => { setPage(0); }, [days]);
  useEffect(() => { void load(); }, [load]);

  async function exportCsv() {
    const { data } = await eligible(
      supabase.from("creators").select("handle, tiktok_username, email"), days)
      .order("last_contacted_at", { ascending: true }).limit(5000);
    const csv = toCsv(
      ((data ?? []) as { handle: string | null; tiktok_username: string | null; email: string | null }[])
        .map((r) => ({ username: r.handle || r.tiktok_username || "", email: r.email ?? "" }))
    );
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `recycle-${days}d-${total}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="ws-head">
        <Link to="/lists" className="ws-back">← Lists</Link>
        <h2>♻️ Recycle</h2>
      </div>

      <p className="muted">
        Leads we've already contacted that <strong>haven't replied/bounced</strong>
        and have gone cold for a while — ready for a fresh approach. Three segments by
        idle time. (The 60-day cooldown still applies when sending.)
      </p>

      <div className="toolbar">
        <div className="segmented">
          {SEGMENTS.map((d) => (
            <button key={d} className={`seg ${days === d ? "active" : ""}`} onClick={() => setDays(d)}>
              {d}+ days {counts[d] != null ? `(${counts[d].toLocaleString("en-GB")})` : ""}
            </button>
          ))}
        </div>
        <div className="grow" />
        <button onClick={exportCsv} disabled={total === 0}>Export CSV</button>
      </div>

      <CreatorTable creators={rows} loading={loading} searchable={false}
        emptyText="No creators to recycle in this window." />
      <Pager page={page} pageSize={PAGE} total={total} onPage={setPage} />
    </div>
  );
}
