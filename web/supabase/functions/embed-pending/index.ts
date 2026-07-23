// Edge Function: embed-pending  (runs on a schedule via pg_cron)
// -----------------------------------------------------------------------------
// Keeps newly-enriched creators fully searchable without manual backfills. Each run
// grabs a small batch of enriched creators that have NO summary_embedding yet and:
//   - if they already have a profile_summary  -> just embed it (OpenAI, cheap)
//   - else                                    -> fetch posts + build summary/tags via
//                                                gpt-4o-mini, then embed (partial update,
//                                                preserving the crawl's own fields)
// Self-limiting (BATCH per run) so cost stays gradual. Secrets: TIKHUB, OPENAI (vault).
// -----------------------------------------------------------------------------

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

const TIKHUB = "https://api.tikhub.io";
const EP_POSTS = "/api/v1/tiktok/app/v3/fetch_user_post_videos";
const OPENAI_CHAT = "https://api.openai.com/v1/chat/completions";
const OPENAI_EMBED = "https://api.openai.com/v1/embeddings";
const AD_RE = /(?:\b(?:anzeige|werbung|sponsored|paid partnership|ad)\b|\/ad\b|#ad\b|#werbung\b)/i;
const BATCH = 12;
const DAILY_CAP = 3.0;   // USD/day — auto-embed self-limits regardless of cron frequency

function dig(o: unknown, keys: string[]): unknown {
  if (o && typeof o === "object") {
    for (const k of keys) { const v = (o as Record<string, unknown>)[k]; if (v !== undefined && v !== null && v !== "") return v; }
    for (const v of Object.values(o as Record<string, unknown>)) { const r = dig(v, keys); if (r !== undefined && r !== null && r !== "") return r; }
  }
  return null;
}
function findList(o: unknown, keys: string[]): unknown[] | null {
  if (Array.isArray(o)) return o.length && typeof o[0] === "object" ? o : null;
  if (o && typeof o === "object") {
    for (const k of keys) { const v = (o as Record<string, unknown>)[k]; if (Array.isArray(v) && v.length) return v; }
    for (const v of Object.values(o as Record<string, unknown>)) { const r = findList(v, keys); if (r) return r; }
  }
  return null;
}
async function tik(path: string, params: Record<string, string>, key: string): Promise<unknown> {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${TIKHUB}${path}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${key}` } });
    if ([400, 429].includes(r.status) || r.status >= 500) { await new Promise(s => setTimeout(s, 1000 * (i + 1))); continue; }
    if (!r.ok) throw new Error(`TikHub ${r.status}`);
    const body = await r.json();
    if (body?.code !== undefined && ![200, 0, null].includes(body.code)) { await new Promise(s => setTimeout(s, 1000 * (i + 1))); continue; }
    return body;
  }
  throw new Error(`TikHub ${path} failed`);
}
async function embed(text: string, key: string): Promise<number[] | null> {
  const r = await fetch(OPENAI_EMBED, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 8000) }) });
  return (await r.json())?.data?.[0]?.embedding ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const TK = Deno.env.get("TIKHUB_API_KEY"), OA = Deno.env.get("OPENAI_API_KEY");
  if (!TK || !OA) return json({ error: "secrets missing" }, 500);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // daily budget guard — skip if today's auto-embed spend already hit the cap
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const { data: sp } = await db.from("spend_ledger").select("usd").eq("channel", "embed_auto").gte("ts", dayStart.toISOString());
  const spentToday = (sp ?? []).reduce((a, r) => a + Number((r as { usd: number }).usd || 0), 0);
  if (spentToday >= DAILY_CAP) return json({ skipped: "daily cap reached", spent_today: Math.round(spentToday * 100) / 100 });

  const { data: pend } = await db.from("tt_creators")
    .select("sec_uid,handle,display_name,bio,follower_count,profile_summary")
    .eq("enrichment_status", "enriched").eq("platform", "tiktok").is("summary_embedding", null)
    .order("follower_count", { ascending: false, nullsFirst: false }).limit(BATCH);
  const rows = (pend ?? []) as { sec_uid: string; handle: string; display_name: string | null; bio: string | null; follower_count: number | null; profile_summary: string | null }[];
  if (!rows.length) return json({ embedded: 0, built: 0, done: true });

  let embedded = 0, built = 0;
  await Promise.all(rows.map(async (c) => {
    try {
      // Cheap path: summary already there → just embed.
      if (c.profile_summary && c.profile_summary.length > 20) {
        const e = await embed(c.profile_summary, OA);
        if (e) { await db.from("tt_creators").update({ summary_embedding: JSON.stringify(e) }).eq("sec_uid", c.sec_uid); embedded++; }
        return;
      }
      // Build path: fetch posts → summary + doc-spec tags → embed. Partial update only.
      const postsRaw = await tik(EP_POSTS, { sec_user_id: c.sec_uid, count: "30", max_cursor: "0" }, TK);
      const posts = findList(postsRaw, ["aweme_list", "itemList", "item_list", "videos"]) ?? [];
      const caps = posts.map(p => String(dig(p, ["desc"]) ?? "").slice(0, 160));
      const hashtags = [...new Set(caps.flatMap(cp => [...cp.matchAll(/#(\w+)/g)].map(m => m[1])))].slice(0, 12);
      const spon = caps.filter(cp => AD_RE.test(cp)).map(cp => cp.slice(0, 300));
      const sys = `You profile a TikTok creator for a B2B database. Return ONLY JSON: {"summary":"2-3 sentences on their content/style/audience, real data only","content_format":["up to 3 e.g. grwm,vlog,review,haul,tutorial,talking-head"],"persona":"solo|couple|family|group","audience_lang":"de|en|mixed","brands_worked_with":["brands advertised in the sponsored captions, [] if none clear"]}`;
      const usr = `@${c.handle} (${c.display_name ?? ""}) · ${c.follower_count ?? "?"} followers\nBio: ${c.bio ?? ""}\nHashtags: ${hashtags.join(", ")}\nCaptions: ${caps.slice(0, 12).join(" | ")}\nSponsored captions: ${spon.join(" || ") || "none"}`;
      const cr = await fetch(OPENAI_CHAT, { method: "POST", headers: { Authorization: `Bearer ${OA}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0.3, response_format: { type: "json_object" }, messages: [{ role: "system", content: sys }, { role: "user", content: usr }] }) });
      const doc = JSON.parse((await cr.json())?.choices?.[0]?.message?.content ?? "{}");
      const summary = String(doc.summary ?? c.bio ?? c.handle);
      const e = await embed(summary, OA);
      if (!e) return;
      const upd: Record<string, unknown> = { profile_summary: summary, summary_embedding: JSON.stringify(e), top_hashtags: hashtags.length ? hashtags : null };
      if (Array.isArray(doc.content_format)) upd.content_format = doc.content_format;
      if (doc.persona) upd.persona = doc.persona;
      if (doc.audience_lang) upd.audience_lang = doc.audience_lang;
      if (Array.isArray(doc.brands_worked_with) && doc.brands_worked_with.length) upd.brands_worked_with = doc.brands_worked_with.slice(0, 10);
      await db.from("tt_creators").update(upd).eq("sec_uid", c.sec_uid);
      built++;
    } catch (_) { /* skip; next run retries */ }
  }));

  const usd = built * 0.006 + embedded * 0.0002;
  if (usd > 0) await db.from("spend_ledger").insert({ channel: "embed_auto", usd, calls: built * 3 + embedded, ts: new Date().toISOString() });
  return json({ embedded, built, spent_today: Math.round((spentToday + usd) * 100) / 100, remaining_hint: rows.length === BATCH });
});
