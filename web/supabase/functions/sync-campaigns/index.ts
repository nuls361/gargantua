// Edge Function: sync-campaigns
// -----------------------------------------------------------------------------
// Auth-gated. Pulls every campaign from Instantly (v2, cursor-paginated) and
// upserts it into the `campaigns` table keyed on instantly_campaign_id, so the
// tool's campaign list always mirrors Instantly. The Instantly key stays in the
// INSTANTLY_API_KEY secret and never reaches the browser.
// -----------------------------------------------------------------------------

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

const INSTANTLY_CAMPAIGNS_URL = "https://api.instantly.ai/api/v2/campaigns";

interface InstantlyCampaign {
  id: string;
  name: string;
  status: number;
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

  // --- Require a valid Supabase user session ---
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

  // --- Fetch all Instantly campaigns (cursor pagination) ---
  const all: InstantlyCampaign[] = [];
  let startingAfter: string | undefined;
  try {
    for (let page = 0; page < 100; page++) {
      const url = new URL(INSTANTLY_CAMPAIGNS_URL);
      url.searchParams.set("limit", "100");
      if (startingAfter) url.searchParams.set("starting_after", startingAfter);

      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${INSTANTLY_API_KEY}` },
      });
      if (!resp.ok) {
        return json(
          { error: `Instantly returned ${resp.status}`, detail: await resp.text() },
          502
        );
      }
      const body = await resp.json();
      const items = (body.items ?? []) as InstantlyCampaign[];
      all.push(...items);
      startingAfter = body.next_starting_after;
      if (!startingAfter || items.length === 0) break;
    }
  } catch (e) {
    return json(
      { error: `Request to Instantly failed: ${e instanceof Error ? e.message : String(e)}` },
      502
    );
  }

  // --- Upsert into campaigns (service role) ---
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const now = new Date().toISOString();
  const rows = all.map((c) => ({
    name: c.name,
    instantly_campaign_id: c.id,
    instantly_status: c.status,
    synced_at: now,
  }));

  let upserted = 0;
  if (rows.length > 0) {
    const { data, error } = await db
      .from("campaigns")
      .upsert(rows, { onConflict: "instantly_campaign_id" })
      .select("id");
    if (error) {
      return json({ error: `Upsert failed: ${error.message}` }, 500);
    }
    upserted = data?.length ?? 0;
  }

  return json({ ok: true, fetched: all.length, upserted, synced_at: now });
});
