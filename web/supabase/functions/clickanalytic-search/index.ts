// Edge Function: clickanalytic-search
// -----------------------------------------------------------------------------
// Auth-gated creator discovery. Reworked off ClickAnalytic onto WePush's OWN
// index (tt_creators). The reader is the caller's authenticated Supabase client
// (RLS: authenticated read), so no vendor key is involved.
//
// MOCK mode kicks in for platforms we hold no owned data for (instagram/youtube)
// or when SEARCH_MOCK=1. All backend knowledge lives in adapter.ts.
// -----------------------------------------------------------------------------

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";
import {
  indexHasPlatform,
  mockSearch,
  searchIndex,
  type SearchFilters,
} from "./adapter.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SEARCH_MOCK = Deno.env.get("SEARCH_MOCK") === "1";

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

  // --- Parse filters ---
  let filters: SearchFilters;
  try {
    filters = (await req.json()) as SearchFilters;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  // --- Mock for platforms we hold no owned data for, or when forced ---
  if (SEARCH_MOCK || !indexHasPlatform(filters)) {
    const results = mockSearch(filters);
    return json({ mock: true, count: results.length, results });
  }

  // --- Real path: query WePush's own index (tt_creators) ---
  try {
    const results = await searchIndex(filters, authClient);
    return json({ mock: false, count: results.length, results });
  } catch (e) {
    return json(
      { error: `Index search failed: ${e instanceof Error ? e.message : String(e)}` },
      502
    );
  }
});
