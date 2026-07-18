// Edge Function: push-to-instantly
// -----------------------------------------------------------------------------
// Verifies the caller is an authenticated Supabase user, loads the requested
// creators that are in status 'queued', groups them by their campaign's
// instantly_campaign_id, and pushes them to the Instantly v2 API in chunks of
// up to 1000 leads. On success it flips those creators to 'in_instantly'.
//
// The Instantly API key lives only in the INSTANTLY_API_KEY secret and never
// leaves this function.
// -----------------------------------------------------------------------------

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

const INSTANTLY_ADD_LEADS_URL = "https://api.instantly.ai/api/v2/leads/add";
const CHUNK_SIZE = 1000;

interface Creator {
  id: string;
  email: string;
  tiktok_username: string | null;
  campaign_id: string | null;
  campaigns: { instantly_campaign_id: string | null } | null;
}

interface ChunkSummary {
  instantly_campaign_id: string;
  attempted: number;
  updated: number;
  ok: boolean;
  error?: string;
  instantly_response?: unknown;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const INSTANTLY_API_KEY = Deno.env.get("INSTANTLY_API_KEY");

  if (!INSTANTLY_API_KEY) {
    return json({ error: "INSTANTLY_API_KEY secret is not set" }, 500);
  }

  // --- Auth: require a valid Supabase user session ---
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return json({ error: "Missing Authorization header" }, 401);
  }

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error: userErr,
  } = await authClient.auth.getUser();
  if (userErr || !user) {
    return json({ error: "Not authenticated" }, 401);
  }

  // --- Parse input (two modes) ---
  //  A) list block: { list_id, instantly_campaign_id } → push all 'enriched'
  //     members of the list to the chosen campaign (flexible send).
  //  B) legacy:     { creator_ids }                     → push those 'queued'
  //     creators to their own already-assigned campaigns.
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const byCampaign = new Map<string, Creator[]>();
  const skippedNoCampaign: string[] = [];
  // In list mode, all pushed creators are stamped with this campaign row id.
  let targetCampaignRowId: string | null = null;

  if (body?.list_id && body?.instantly_campaign_id) {
    const instId = String(body.instantly_campaign_id);
    const { data: camp } = await db
      .from("campaigns")
      .select("id")
      .eq("instantly_campaign_id", instId)
      .limit(1)
      .single();
    targetCampaignRowId = camp?.id ?? null;

    const { data: creators, error: loadErr } = await db
      .from("creators")
      .select("id, email, tiktok_username, campaign_id, campaigns(instantly_campaign_id)")
      .eq("list_id", body.list_id)
      .eq("status", "enriched");
    if (loadErr) return json({ error: `Load failed: ${loadErr.message}` }, 500);
    const rows = (creators ?? []) as unknown as Creator[];
    if (rows.length === 0) {
      return json({
        summaries: [],
        total_pushed: 0,
        message: "No 'enriched' creators in this list to send.",
      });
    }
    byCampaign.set(instId, rows);
  } else {
    const creatorIds: string[] = Array.isArray(body?.creator_ids)
      ? body.creator_ids
      : [];
    if (creatorIds.length === 0) {
      return json(
        { error: "Provide { list_id, instantly_campaign_id } or { creator_ids }" },
        400
      );
    }
    const { data: creators, error: loadErr } = await db
      .from("creators")
      .select("id, email, tiktok_username, campaign_id, campaigns(instantly_campaign_id)")
      .in("id", creatorIds)
      .eq("status", "queued");
    if (loadErr) return json({ error: `Load failed: ${loadErr.message}` }, 500);
    const rows = (creators ?? []) as unknown as Creator[];
    if (rows.length === 0) {
      return json({
        summaries: [],
        total_pushed: 0,
        message: "No creators in status 'queued' matched the given ids.",
      });
    }
    for (const c of rows) {
      const instCampaign = c.campaigns?.instantly_campaign_id;
      if (!instCampaign) {
        skippedNoCampaign.push(c.email);
        continue;
      }
      const list = byCampaign.get(instCampaign) ?? [];
      list.push(c);
      byCampaign.set(instCampaign, list);
    }
  }

  const summaries: ChunkSummary[] = [];
  let totalPushed = 0;

  for (const [instCampaignId, group] of byCampaign) {
    for (let i = 0; i < group.length; i += CHUNK_SIZE) {
      const chunk = group.slice(i, i + CHUNK_SIZE);
      const leads = chunk.map((c) => ({
        email: c.email,
        custom_variables: { tiktok_username: c.tiktok_username ?? "" },
      }));

      let ok = false;
      let errMsg: string | undefined;
      let instResp: unknown;

      try {
        const resp = await fetch(INSTANTLY_ADD_LEADS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${INSTANTLY_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            campaign_id: instCampaignId,
            skip_if_in_workspace: true,
            leads,
          }),
        });
        instResp = await resp.json().catch(() => null);
        ok = resp.ok;
        if (!ok) {
          errMsg = `Instantly returned ${resp.status}`;
        }
      } catch (e) {
        errMsg = `Request to Instantly failed: ${
          e instanceof Error ? e.message : String(e)
        }`;
      }

      let updated = 0;
      if (ok) {
        const ids = chunk.map((c) => c.id);
        const updatePayload: Record<string, unknown> = {
          status: "in_instantly",
          added_to_instantly_at: new Date().toISOString(),
        };
        if (targetCampaignRowId) updatePayload.campaign_id = targetCampaignRowId;
        const { data: updatedRows, error: updErr } = await db
          .from("creators")
          .update(updatePayload)
          .in("id", ids)
          .select("id");
        if (updErr) {
          errMsg = `Pushed to Instantly but DB update failed: ${updErr.message}`;
          ok = false;
        } else {
          updated = updatedRows?.length ?? 0;
          totalPushed += updated;
          // Record send history so recycling knows which campaigns a creator
          // has received (one row per creator↔campaign; re-sends refresh sent_at).
          const sentAt = updatePayload.added_to_instantly_at as string;
          const sends = chunk
            .map((c) => ({
              creator_id: c.id,
              campaign_id: targetCampaignRowId ?? c.campaign_id,
              sent_at: sentAt,
            }))
            .filter((s) => s.campaign_id);
          if (sends.length > 0) {
            await db
              .from("campaign_sends")
              .upsert(sends, { onConflict: "creator_id,campaign_id" });
          }
        }
      }

      summaries.push({
        instantly_campaign_id: instCampaignId,
        attempted: chunk.length,
        updated,
        ok,
        error: errMsg,
        instantly_response: instResp,
      });
    }
  }

  return json({
    summaries,
    total_pushed: totalPushed,
    skipped_without_campaign: skippedNoCampaign,
  });
});
