import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import {
  INSTANTLY_STATUS_LABELS,
  type Campaign,
  type Creator,
} from "../lib/types";
import CreatorTable from "../components/CreatorTable";

export default function Campaigns() {
  const { id } = useParams();
  return id ? <CampaignDetail id={id} /> : <CampaignsOverview />;
}

interface CampaignWithCount extends Campaign {
  leadCount: number;
}

function CampaignsOverview() {
  const [campaigns, setCampaigns] = useState<CampaignWithCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: camps, error: cErr } = await supabase
      .from("campaigns")
      .select("*")
      .order("name");
    if (cErr) {
      setError(cErr.message);
      setLoading(false);
      return;
    }
    const withCounts = await Promise.all(
      (camps ?? []).map(async (c) => {
        const { count } = await supabase
          .from("creators")
          .select("id", { count: "exact", head: true })
          .eq("campaign_id", c.id);
        return { ...(c as Campaign), leadCount: count ?? 0 };
      })
    );
    setCampaigns(withCounts);
    setLoading(false);
  }, []);

  const sync = useCallback(
    async (silent = false) => {
      setSyncing(true);
      if (!silent) setNotice(null);
      setError(null);
      const { data, error: fnErr } = await supabase.functions.invoke(
        "sync-campaigns",
        { body: {} }
      );
      setSyncing(false);
      if (fnErr) {
        setError(`Sync failed: ${fnErr.message}`);
        return;
      }
      if (!silent) {
        setNotice(`Synced ${data?.upserted ?? 0} campaigns from Instantly.`);
        setTimeout(() => setNotice(null), 5000);
      }
      await load();
    },
    [load]
  );

  // Auto-sync on first load so the list is always current, then keep it fresh.
  useEffect(() => {
    void (async () => {
      await sync(true);
    })();
  }, [sync]);

  const lastSynced = campaigns
    .map((c) => c.synced_at)
    .filter(Boolean)
    .sort()
    .pop();

  return (
    <div>
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Campaigns</h2>
        <div className="grow" />
        {lastSynced && (
          <span className="muted" style={{ fontSize: 12 }}>
            Last synced: {new Date(lastSynced).toLocaleString("en-GB")}
          </span>
        )}
        <button onClick={() => void sync(false)} disabled={syncing}>
          {syncing ? "Syncing…" : "Sync now"}
        </button>
      </div>

      <p className="muted">
        Campaigns are mirrored from Instantly automatically — this list is
        read-only. Click a campaign to see its recipients.
      </p>

      {error && <div className="error">{error}</div>}
      {notice && <div className="success">{notice}</div>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Instantly status</th>
              <th>Leads</th>
              <th>Instantly Campaign ID</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={4} className="center-loading">
                  Loading…
                </td>
              </tr>
            ) : campaigns.length === 0 ? (
              <tr>
                <td colSpan={4} className="center-loading">
                  No campaigns synced yet. Click “Sync now”.
                </td>
              </tr>
            ) : (
              campaigns.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={`/campaigns/${c.id}`} style={{ fontWeight: 600 }}>
                      {c.name}
                    </Link>
                  </td>
                  <td>
                    {c.instantly_status != null
                      ? INSTANTLY_STATUS_LABELS[c.instantly_status] ??
                        `#${c.instantly_status}`
                      : "—"}
                  </td>
                  <td>{c.leadCount}</td>
                  <td>
                    <code style={{ fontSize: 11 }}>
                      {c.instantly_campaign_id}
                    </code>
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

const PAGE_SIZE = 500;

function CampaignDetail({ id }: { id: string }) {
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [recipients, setRecipients] = useState<Creator[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      const [{ data: c }, { data: r, count }] = await Promise.all([
        supabase.from("campaigns").select("*").eq("id", id).single(),
        supabase
          .from("creators")
          .select(
            "id, handle, tiktok_username, platform, email, region_label, label, sample_creator, status, filter_reason, enriched_at, enriched_payload, campaign_id, date_added, added_to_instantly_at, first_contacted_at, last_contacted_at, contact_count, last_outcome, next_eligible_at, do_not_contact, campaigns(name)",
            { count: "exact" }
          )
          .eq("campaign_id", id)
          .order("date_added", { ascending: false })
          .limit(PAGE_SIZE),
      ]);
      setCampaign((c as Campaign) ?? null);
      setRecipients((r ?? []) as unknown as Creator[]);
      setTotal(count ?? 0);
      setLoading(false);
    })();
  }, [id]);

  if (loading) return <div className="center-loading">Loading…</div>;
  if (!campaign) return <div className="error">Campaign not found.</div>;

  return (
    <div>
      <div className="toolbar">
        <Link to="/campaigns">← Campaigns</Link>
        <h2 style={{ margin: 0 }}>{campaign.name}</h2>
        {campaign.instantly_status != null && (
          <span className="pill pill-new">
            {INSTANTLY_STATUS_LABELS[campaign.instantly_status] ??
              `#${campaign.instantly_status}`}
          </span>
        )}
      </div>

      <div className="muted" style={{ marginBottom: 12 }}>
        {total.toLocaleString("en-GB")} recipient{total === 1 ? "" : "s"} in this
        campaign
        {campaign.instantly_campaign_id && (
          <>
            {" · "}Instantly ID:{" "}
            <code style={{ fontSize: 11 }}>{campaign.instantly_campaign_id}</code>
          </>
        )}
      </div>

      <CreatorTable creators={recipients} emptyText="No recipients yet." />

      {total > PAGE_SIZE && (
        <p className="muted" style={{ fontSize: 12 }}>
          Showing the newest {PAGE_SIZE} of {total.toLocaleString("en-GB")}{" "}
          recipients.
        </p>
      )}
    </div>
  );
}
