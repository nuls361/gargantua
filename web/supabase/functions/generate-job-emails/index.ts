// Edge Function: generate-job-emails
// -----------------------------------------------------------------------------
// For a job's matched creators, generates a personalized cold-outreach email
// ({subject, icebreaker, pitch}) grounded in the creator's profile + the job's
// brief + the WePush view-goal earning model. Stored on job_creators. The OpenAI
// key lives only in the OPENAI_API_KEY secret (already set for embeddings).
//
// Request:  { "job_id": "<uuid>", "sec_uids": ["…"], "limit": 20 }
// Response: { "emails": [{ sec_uid, handle, subject, icebreaker, pitch }] }
// -----------------------------------------------------------------------------

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";
const MAX = 25;

interface Job {
  subject: string | null; briefing: string | null; deliverable: string | null;
  earning_min: number | null; earning_max: number | null; view_goal: number | null;
}
interface Creator {
  sec_uid: string; handle: string; display_name: string | null; category: string | null;
  market: string | null; follower_count: number | null; audience_lang: string | null;
  content_format: string[] | null; profile_summary: string | null;
}

function sys(job: Job): string {
  const pay = job.earning_min != null || job.earning_max != null
    ? `€${job.earning_min ?? 0}–${job.earning_max ?? "?"} per campaign` : "a paid reward";
  return `You write short, warm, genuinely personalized cold-outreach emails on behalf of WePush.

WePush is a platform where creators join brand campaigns and get PAID by hitting a view goal — paid out via PayPal, no follower minimum, instant approval. "We reward creativity, not followers."

You are reaching out to ONE creator to offer them a specific paid campaign:
- Brand/subject: ${job.subject ?? "a brand"}
- What to make: ${job.deliverable ?? job.briefing ?? "a short native video in their own style"}
- Earning: ${pay} (WePush view-goal model)

RULES:
- Write in the creator's language: German if their audience language is German/DACH, else English.
- The icebreaker MUST reference something GENUINE and specific from THIS creator's profile — only use what you're given, NEVER invent facts, numbers, or brand names.
- Warm and human, like a real person who watched their content. Not corporate, not hypey, no emoji spam (one is fine).
- Exactly ONE clear call-to-action (reply / interested?).
- Keep it tight: subject ≤ 55 chars; icebreaker 1 sentence; pitch 2–3 short sentences that name the campaign, the earning, and the CTA.
- Return ONLY JSON: {"subject": "...", "icebreaker": "...", "pitch": "..."}`;
}

function usr(c: Creator): string {
  return `Creator: @${c.handle}${c.display_name ? ` (${c.display_name})` : ""}
Niche: ${c.category ?? "—"} | Market: ${c.market ?? "—"} | Audience language: ${c.audience_lang ?? "—"} | Followers: ${c.follower_count ?? "—"}
Content formats: ${(c.content_format ?? []).join(", ") || "—"}
Profile: ${c.profile_summary ?? "—"}

Write the personalized email as JSON.`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { job_id, sec_uids, limit } = await req.json().catch(() => ({}));
    if (!job_id) return json({ error: "job_id required" }, 400);
    const key = Deno.env.get("OPENAI_API_KEY");
    if (!key) return json({ error: "OPENAI_API_KEY not configured" }, 500);

    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: job, error: je } = await sb.from("jobs").select("subject,briefing,deliverable,earning_min,earning_max,view_goal").eq("id", job_id).single();
    if (je || !job) return json({ error: je?.message ?? "job not found" }, 404);

    const cap = Math.min(Number(limit) || 20, MAX);
    let ids: string[] = Array.isArray(sec_uids) ? sec_uids.slice(0, cap) : [];
    if (!ids.length) {
      const { data: jc } = await sb.from("job_creators").select("sec_uid").eq("job_id", job_id).limit(cap);
      ids = ((jc ?? []) as { sec_uid: string }[]).map((r) => r.sec_uid);
    }
    if (!ids.length) return json({ emails: [] });

    const { data: creators } = await sb.from("tt_creators")
      .select("sec_uid,handle,display_name,category,market,follower_count,audience_lang,content_format,profile_summary")
      .in("sec_uid", ids);

    const system = sys(job as Job);
    const gen = async (c: Creator) => {
      const r = await fetch(OPENAI_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL, temperature: 0.7, response_format: { type: "json_object" },
          messages: [{ role: "system", content: system }, { role: "user", content: usr(c) }],
        }),
      });
      const d = await r.json();
      const txt = d?.choices?.[0]?.message?.content;
      if (!txt) return null;
      let p: { subject?: string; icebreaker?: string; pitch?: string };
      try { p = JSON.parse(txt); } catch { return null; }
      return { sec_uid: c.sec_uid, handle: c.handle, subject: p.subject ?? "", icebreaker: p.icebreaker ?? "", pitch: p.pitch ?? "" };
    };

    const emails = (await Promise.all(((creators ?? []) as Creator[]).map(gen))).filter(Boolean) as Array<{ sec_uid: string; handle: string; subject: string; icebreaker: string; pitch: string }>;

    // persist onto job_creators (upsert so it works whether or not matches were saved first)
    if (emails.length) {
      const now = new Date().toISOString();
      await sb.from("job_creators").upsert(
        emails.map((e) => ({ job_id, sec_uid: e.sec_uid, handle: e.handle, ai_subject: e.subject, ai_icebreaker: e.icebreaker, ai_pitch: e.pitch, generated_at: now })),
        { onConflict: "job_id,sec_uid" },
      );
    }
    return json({ emails });
  } catch (e) {
    return json({ error: String(e).slice(0, 300) }, 500);
  }
});
