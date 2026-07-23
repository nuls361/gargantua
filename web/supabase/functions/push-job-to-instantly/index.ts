// Edge Function: push-job-to-instantly
// -----------------------------------------------------------------------------
// Exports a job's leads to Instantly, ROUTED BY the recipient's email provider:
//   google    -> job.campaign_google   (send from Google inboxes)
//   microsoft -> job.campaign_outlook   (send from Outlook inboxes)
//   else      -> job.campaign_custom    (Custom SMTP: icloud/gmx/yahoo/other)
//   tonline / no-email / no-campaign    -> skipped
// The generated email fields (subject/icebreaker/pitch) ride along as Instantly
// custom_variables so the campaign template can reference {{icebreaker}} etc.
// INSTANTLY_API_KEY lives only in the vault secret.
// -----------------------------------------------------------------------------

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

const ADD_LEADS_URL = "https://api.instantly.ai/api/v2/leads/add";
const CHUNK = 1000;

interface JC { sec_uid: string; handle: string | null; ai_subject: string | null; ai_icebreaker: string | null; ai_pitch: string | null; }
interface Cr { sec_uid: string; email: string | null; email_provider: string | null; display_name: string | null; }

function campaignFor(provider: string | null, job: Record<string, string | null>): string | null {
  if (provider === "tonline") return null;
  if (provider === "google") return job.campaign_google;
  if (provider === "microsoft") return job.campaign_outlook;
  return job.campaign_custom; // icloud, gmx_webde, yahoo_aol, other
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const INSTANTLY = Deno.env.get("INSTANTLY_API_KEY");
  if (!INSTANTLY) return json({ error: "INSTANTLY_API_KEY not set" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Missing Authorization" }, 401);
  const auth = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return json({ error: "Not authenticated" }, 401);

  const { job_id, resend } = await req.json().catch(() => ({}));
  if (!job_id) return json({ error: "job_id required" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: job } = await db.from("jobs").select("campaign_google,campaign_outlook,campaign_custom").eq("id", job_id).single();
  if (!job) return json({ error: "job not found" }, 404);

  const { data: jcData } = await db.from("job_creators").select("sec_uid,handle,ai_subject,ai_icebreaker,ai_pitch").eq("job_id", job_id);
  const jcs = (jcData ?? []) as JC[];
  if (!jcs.length) return json({ error: "No leads in this job." }, 400);

  const { data: crData } = await db.from("tt_creators").select("sec_uid,email,email_provider,display_name").in("sec_uid", jcs.map(j => j.sec_uid));
  const crBy = new Map((crData ?? []).map((c: Cr) => [c.sec_uid, c]));

  const byCampaign = new Map<string, { sec_uid: string; lead: Record<string, unknown> }[]>();
  const skipped = { no_email: 0, tonline: 0, no_campaign: 0 };

  for (const jc of jcs) {
    const cr = crBy.get(jc.sec_uid);
    if (!cr?.email) { skipped.no_email++; continue; }
    if (cr.email_provider === "tonline") { skipped.tonline++; continue; }
    const camp = campaignFor(cr.email_provider, job as Record<string, string | null>);
    if (!camp) { skipped.no_campaign++; continue; }
    const lead = {
      email: cr.email,
      first_name: (cr.display_name ?? jc.handle ?? "").split(/\s+/)[0] || "",
      custom_variables: {
        tiktok_username: jc.handle ?? "",
        subject_line: jc.ai_subject ?? "",
        icebreaker: jc.ai_icebreaker ?? "",
        pitch: jc.ai_pitch ?? "",
      },
    };
    const arr = byCampaign.get(camp) ?? [];
    arr.push({ sec_uid: jc.sec_uid, lead });
    byCampaign.set(camp, arr);
  }

  const summaries: Array<{ campaign_id: string; attempted: number; ok: boolean; error?: string }> = [];
  let pushed = 0;
  const now = new Date().toISOString();

  for (const [campaignId, group] of byCampaign) {
    for (let i = 0; i < group.length; i += CHUNK) {
      const chunk = group.slice(i, i + CHUNK);
      let ok = false, errMsg: string | undefined;
      try {
        const resp = await fetch(ADD_LEADS_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${INSTANTLY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ campaign_id: campaignId, skip_if_in_workspace: resend ? false : true, leads: chunk.map(c => c.lead) }),
        });
        ok = resp.ok;
        if (!ok) errMsg = `Instantly ${resp.status}: ${(await resp.text()).slice(0, 200)}`;
      } catch (e) { errMsg = String(e).slice(0, 200); }

      if (ok) {
        const ids = chunk.map(c => c.sec_uid);
        for (let k = 0; k < ids.length; k += 100) {
          await db.from("job_creators").update({ state: "in_instantly" }).eq("job_id", job_id).in("sec_uid", ids.slice(k, k + 100));
        }
        pushed += chunk.length;
      }
      summaries.push({ campaign_id: campaignId, attempted: chunk.length, ok, error: errMsg });
    }
  }
  return json({ pushed, skipped, summaries, sent_at: now });
});
