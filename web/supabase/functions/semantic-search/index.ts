// Edge Function: semantic-search
// -----------------------------------------------------------------------------
// Embeds a natural-language search prompt with OpenAI text-embedding-3-small and
// returns the creators whose profile_summary embedding is nearest (cosine), via
// the match_creators() RPC. The OpenAI key lives only in the OPENAI_API_KEY
// secret and never reaches the browser.
//
// Request:  { "prompt": "german skincare creators who film unboxings", "match_count": 300 }
// Response: { "ids": ["<sec_uid>", ...], "scores": { "<sec_uid>": 0.42, ... } }
// -----------------------------------------------------------------------------

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

const OPENAI_EMBED_URL = "https://api.openai.com/v1/embeddings";
const MODEL = "text-embedding-3-small";
const MAX_COUNT = 500;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { prompt, match_count } = await req.json().catch(() => ({}));
    const p = typeof prompt === "string" ? prompt.trim() : "";
    if (!p) return json({ ids: [], scores: {} });

    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) return json({ error: "OPENAI_API_KEY not configured" }, 500);

    // 1) embed the prompt
    const er = await fetch(OPENAI_EMBED_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, input: p.slice(0, 8000) }),
    });
    const ed = await er.json();
    if (!ed?.data?.[0]?.embedding) {
      return json({ error: ed?.error?.message ?? "embedding failed" }, 502);
    }
    const embedding: number[] = ed.data[0].embedding;

    // 2) nearest creators via pgvector (service role — bypasses RLS, read-only RPC)
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const count = Math.min(Math.max(Number(match_count) || 300, 1), MAX_COUNT);
    const { data, error } = await supabase.rpc("match_creators", {
      query_embedding: embedding as unknown as string,
      match_count: count,
    });
    if (error) return json({ error: error.message }, 500);

    const rows = (data ?? []) as { sec_uid: string; similarity: number }[];
    const ids = rows.map((r) => r.sec_uid);
    const scores: Record<string, number> = {};
    for (const r of rows) scores[r.sec_uid] = r.similarity;
    return json({ ids, scores });
  } catch (e) {
    return json({ error: String(e).slice(0, 300) }, 500);
  }
});
