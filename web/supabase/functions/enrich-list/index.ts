// Edge Function: enrich-list
// -----------------------------------------------------------------------------
// Auth-gated. Enriches every `sourced` member of a list (ClickAnalytic; mocked
// until the key is set), then runs the cleaning logic that used to live in the
// CSV import:
//   - keep only freemail domains, drop blocked/agency domains, drop duplicates
//   - passing leads → status 'enriched' (email + full JSON stored)
//   - failing leads → moved to the static "Filtered" list, status 'filtered'
// -----------------------------------------------------------------------------

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";
import { cleanReason } from "../_shared/freemail.ts";
import {
  buildEnrichRequest,
  mockEnrich,
  normalizeEnrichment,
  type SourcedCreator,
} from "./adapter.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const CLICKANALYTIC_API_KEY = Deno.env.get("CLICKANALYTIC_API_KEY");

  // --- auth ---
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Missing Authorization header" }, 401);
  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userErr } = await authClient.auth.getUser();
  if (userErr || !user) return json({ error: "Not authenticated" }, 401);

  let listId: string | null = null;
  try {
    listId = (await req.json())?.list_id ?? null;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!listId) return json({ error: "list_id is required" }, 400);

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Resolve the Filtered list id.
  const { data: filteredList } = await db
    .from("lists").select("id").eq("kind", "filtered").limit(1).single();
  const filteredId = filteredList?.id;
  if (!filteredId) return json({ error: "Filtered list not found" }, 500);

  // Blocked domains → Set.
  const { data: blocked } = await db.from("blocked_domains").select("domain");
  const blockedSet = new Set(
    (blocked ?? []).map((d) => (d.domain as string).toLowerCase().trim())
  );

  // Sourced members of the list.
  const { data: members, error: memErr } = await db
    .from("creators")
    .select("id, handle, platform, tiktok_username")
    .eq("list_id", listId)
    .eq("status", "sourced");
  if (memErr) return json({ error: `Load failed: ${memErr.message}` }, 500);

  const reasons: Record<string, number> = {};
  let enriched = 0;
  let filtered = 0;

  for (const m of (members ?? []) as SourcedCreator[]) {
    // --- enrich (mock unless the key is set) ---
    let email: string | null;
    let payload: unknown;
    if (!CLICKANALYTIC_API_KEY) {
      ({ email, payload } = mockEnrich(m));
    } else {
      const { url, init } = buildEnrichRequest(m.handle, m.platform, CLICKANALYTIC_API_KEY);
      const resp = await fetch(url, init);
      const body = await resp.json().catch(() => null);
      ({ email, payload } = normalizeEnrichment(body));
    }

    // --- clean ---
    let reason: string | null = cleanReason(email, blockedSet);

    // duplicate check against other creators (email already used)
    if (!reason && email) {
      const norm = email.toLowerCase().trim();
      const { data: dup } = await db
        .from("creators")
        .select("id")
        .eq("email_normalized", norm)
        .neq("id", m.id)
        .limit(1);
      if (dup && dup.length > 0) reason = "duplicate";
    }

    if (reason) {
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      await db.from("creators").update({
        list_id: filteredId,
        status: "filtered",
        filter_reason: reason,
        enriched_payload: payload,
        enriched_at: new Date().toISOString(),
      }).eq("id", m.id);
      filtered++;
      continue;
    }

    // --- pass: set email + enriched. Guard against a race on the unique email. ---
    const { error: upErr } = await db.from("creators").update({
      email,
      enriched_payload: payload,
      enriched_at: new Date().toISOString(),
      status: "enriched",
    }).eq("id", m.id);

    if (upErr) {
      // Most likely the unique email_normalized constraint → treat as duplicate.
      reasons["duplicate"] = (reasons["duplicate"] ?? 0) + 1;
      await db.from("creators").update({
        list_id: filteredId,
        status: "filtered",
        filter_reason: "duplicate",
        enriched_payload: payload,
        enriched_at: new Date().toISOString(),
      }).eq("id", m.id);
      filtered++;
      continue;
    }
    enriched++;
  }

  return json({
    ok: true,
    processed: (members ?? []).length,
    enriched,
    filtered,
    reasons,
  });
});
