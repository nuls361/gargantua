// Edge Function: resolve-creators
// -----------------------------------------------------------------------------
// Makes ANY creator searchable + usable as a lookalike seed. For each handle not
// already embedded in the pool: fetch TikHub profile + one posts page, derive
// light metrics, build a summary + tags + brands via gpt-4o-mini, embed it, and
// upsert into tt_creators (discovered_via='lookalike_seed', NO hard filter — seeds
// are references, not leads). Returns which handles resolved.
//
// Secrets: TIKHUB_API_KEY, OPENAI_API_KEY (vault). Request: { handles: string[] }
// Response: { resolved: [{handle, sec_uid}], already: [...], failed: [...] }
// -----------------------------------------------------------------------------

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

const TIKHUB = "https://api.tikhub.io";
const EP_PROFILE = "/api/v1/tiktok/web/fetch_user_profile";
const EP_POSTS = "/api/v1/tiktok/app/v3/fetch_user_post_videos";
const OPENAI_CHAT = "https://api.openai.com/v1/chat/completions";
const OPENAI_EMBED = "https://api.openai.com/v1/embeddings";
const AD_RE = /(?:\b(?:anzeige|werbung|sponsored|paid partnership|ad)\b|\/ad\b|#ad\b|#werbung\b)/i;

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
const median = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function tik(path: string, params: Record<string, string>, key: string): Promise<unknown> {
  for (let i = 0; i < 4; i++) {
    const url = `${TIKHUB}${path}?${new URLSearchParams(params)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (r.status === 401) throw new Error("TikHub 401");
    if ([400, 429].includes(r.status) || r.status >= 500) { await new Promise(s => setTimeout(s, 1200 * (i + 1))); continue; }
    if (!r.ok) throw new Error(`TikHub ${r.status}`);
    const body = await r.json();
    const code = body?.code;
    if (code !== undefined && ![200, 0, null].includes(code)) { await new Promise(s => setTimeout(s, 1200 * (i + 1))); continue; }
    return body;
  }
  throw new Error(`TikHub ${path} failed`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const TK = Deno.env.get("TIKHUB_API_KEY"), OA = Deno.env.get("OPENAI_API_KEY");
  if (!TK || !OA) return json({ error: "TIKHUB_API_KEY / OPENAI_API_KEY not set" }, 500);

  const { handles } = await req.json().catch(() => ({}));
  const list: string[] = Array.isArray(handles) ? handles.map((h: string) => String(h).replace(/^@+/, "").trim()).filter(Boolean).slice(0, 20) : [];
  if (!list.length) return json({ resolved: [], already: [], failed: [] });

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const resolved: { handle: string; sec_uid: string }[] = [], already: string[] = [], failed: { handle: string; reason: string }[] = [];

  for (const handle of list) {
    try {
      // skip if already embedded
      const { data: ex } = await db.from("tt_creators").select("sec_uid,summary_embedding").ilike("handle", handle).limit(1).maybeSingle();
      if (ex?.summary_embedding) { already.push(handle); continue; }

      const prof = await tik(EP_PROFILE, { uniqueId: handle }, TK);
      const user = (dig(prof, ["userInfo"]) as Record<string, unknown>)?.user ?? dig(prof, ["user"]);
      const stats = (dig(prof, ["userInfo"]) as Record<string, unknown>)?.stats ?? dig(prof, ["stats", "statsV2"]);
      const sec_uid = dig(user, ["secUid", "sec_uid"]) as string;
      if (!sec_uid) { failed.push({ handle, reason: "no profile" }); continue; }
      const follower_count = Number(dig(stats, ["followerCount", "follower_count"]) ?? 0) || null;
      const bio = String(dig(user, ["signature"]) ?? "");
      const nickname = String(dig(user, ["nickname"]) ?? handle);
      const avatar_url = dig(user, ["avatarMedium", "avatarLarger", "avatarThumb"]) as string ?? null;
      const video_count = Number(dig(stats, ["videoCount", "video_count"]) ?? 0) || null;

      const postsRaw = await tik(EP_POSTS, { sec_user_id: sec_uid, count: "30", max_cursor: "0" }, TK);
      const posts = findList(postsRaw, ["aweme_list", "itemList", "item_list", "videos"]) ?? [];
      const ers: number[] = [], views: number[] = [], times: number[] = [], hashtags: string[] = [], sponsoredCaps: string[] = [];
      const langs: Record<string, number> = {};
      for (const p of posts) {
        const st = (dig(p, ["statistics", "stats", "statsV2"]) ?? {}) as Record<string, unknown>;
        const play = Number(dig(st, ["play_count", "playCount"]) ?? 0);
        const eng = Number(dig(st, ["digg_count", "diggCount"]) ?? 0) + Number(dig(st, ["comment_count", "commentCount"]) ?? 0) + Number(dig(st, ["share_count", "shareCount"]) ?? 0);
        if (play > 0) { ers.push((eng / play) * 100); views.push(play); }
        const ct = Number(dig(p, ["create_time", "createTime"]) ?? 0); if (ct) times.push(ct);
        const cap = String(dig(p, ["desc"]) ?? "");
        for (const m of cap.matchAll(/#(\w+)/g)) hashtags.push(m[1]);
        const dl = dig(p, ["desc_language"]) as string; if (dl) langs[dl] = (langs[dl] ?? 0) + 1;
        if (AD_RE.test(cap)) sponsoredCaps.push(cap.slice(0, 300));
      }
      const engagement_median = ers.length ? Math.round((median(ers) as number) * 100) / 100 : null;
      const avg_views = views.length ? Math.round(median(views) as number) : null;
      const sponsored_count = sponsoredCaps.length;
      const last_placement_at = null; // derived below only if we can date it — kept light here
      let posting_per_week: number | null = null;
      if (times.length >= 2) { const wk = (Math.max(...times) - Math.min(...times)) / 604800; posting_per_week = wk > 0 ? Math.round((times.length / wk) * 100) / 100 : null; }
      // market: german post-language or bio → dach; else uk/us fallback stays null unless clear
      const deShare = (langs["de"] ?? 0) / Math.max(posts.length, 1);
      const market = deShare >= 0.3 ? "dach" : null;
      const topHash = [...new Set(hashtags)].slice(0, 12);

      // LLM: summary + tags + brands (brands from sponsored captions — catches hashtag/text brands)
      const sys = `You profile a TikTok creator for a B2B creator database. Return ONLY JSON:
{"summary":"2-3 sentence profile of their content, style and audience (real data only, no fluff)","category":"one of: beauty,wellness,fitness,fashion,food,travel,gaming,tech,finance,music,comedy,parenting,home & interior,sustainability,relationship,dance,pets,cars,education,art,lifestyle","content_format":["up to 3 formats e.g. grwm,vlog,review,haul,tutorial,talking-head"],"persona":"solo|couple|family|group","audience_lang":"de|en|mixed","brands_worked_with":["brand names advertised in the sponsored captions below — real brands only, [] if none clear"]}`;
      const usr = `Handle: @${handle} (${nickname}) · ${follower_count ?? "?"} followers\nBio: ${bio}\nTop hashtags: ${topHash.join(", ")}\nRecent captions: ${posts.slice(0, 12).map(p => String(dig(p, ["desc"]) ?? "").slice(0, 160)).join(" | ")}\nSponsored captions (extract brands from these): ${sponsoredCaps.join(" || ") || "none"}`;
      const cr = await fetch(OPENAI_CHAT, { method: "POST", headers: { Authorization: `Bearer ${OA}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0.3, response_format: { type: "json_object" }, messages: [{ role: "system", content: sys }, { role: "user", content: usr }] }) });
      const doc = JSON.parse((await cr.json())?.choices?.[0]?.message?.content ?? "{}");

      const summary = String(doc.summary ?? bio ?? nickname);
      const er = await fetch(OPENAI_EMBED, { method: "POST", headers: { Authorization: `Bearer ${OA}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "text-embedding-3-small", input: summary.slice(0, 8000) }) });
      const emb = (await er.json())?.data?.[0]?.embedding;
      if (!emb) { failed.push({ handle, reason: "embed failed" }); continue; }

      const row: Record<string, unknown> = {
        sec_uid, handle, display_name: nickname, bio, follower_count, video_count, avatar_url,
        engagement_median, avg_views, sponsored_count, posting_per_week, market,
        category: doc.category ?? null, content_format: Array.isArray(doc.content_format) ? doc.content_format : null,
        persona: doc.persona ?? null, audience_lang: doc.audience_lang ?? null,
        brands_worked_with: Array.isArray(doc.brands_worked_with) && doc.brands_worked_with.length ? doc.brands_worked_with.slice(0, 10) : null,
        last_placement_at, top_hashtags: topHash.length ? topHash : null,
        profile_summary: summary, summary_embedding: JSON.stringify(emb),
        platform: "tiktok", enrichment_status: "enriched", discovered_via: "lookalike_seed",
        source_type: "manual", source_value: "@" + handle,
      };
      const { error: upErr } = await db.from("tt_creators").upsert(row, { onConflict: "sec_uid" });
      if (upErr) { failed.push({ handle, reason: upErr.message.slice(0, 80) }); continue; }
      resolved.push({ handle, sec_uid });
    } catch (e) {
      failed.push({ handle, reason: String(e).slice(0, 80) });
    }
  }
  return json({ resolved, already, failed });
});
