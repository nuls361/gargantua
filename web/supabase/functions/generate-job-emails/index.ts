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
  return `You write ONE short cold-outreach email on behalf of WePush — it must read like a genuine DM from a real person, not a marketing email.

WePush: creators get PAID to join brand & music-label campaigns; hit the view goal → payout via PayPal, no follower minimum, instant approval. "We reward creativity, not followers."
This email offers ONE creator a specific paid opportunity:
- Subject: ${job.subject ?? "a campaign"}
- What it is: ${job.briefing ?? job.deliverable ?? "a short native video in their own style"}
- Payout: ${pay}

STRICT RULES (deliverability + trust):
- 40–90 words TOTAL across icebreaker + pitch. Plain text. No "Hi {name}" greeting, no signature, no images/HTML, no emoji spam.
- Subject line: 2–4 words, lowercase, DM-style (e.g. "collab idea", "for your next video", "quick q"). NOT marketing, NOT clickbait, never a fake "Re:".
- The icebreaker (first line) = a specific, genuine reference to THIS creator's own content — their niche/format/style from the profile. NEVER invent a video, number, or brand.
- Value from the CREATOR's point of view: paid, relevant, low effort. Concrete & credible (what, rough scope, how little effort). One short social-proof phrase is fine.
- NO links in the body. NO spam words (free, guarantee, $$$, !!!).
- End the pitch with a soft opt-out, e.g. "not for you? just reply and I'll leave you alone."
- Language: German if the creator's audience language is German/DACH, else English.
Return ONLY JSON: {"subject": "<2-4 lowercase words>", "icebreaker": "<first line, on their content>", "pitch": "<value + soft CTA + opt-out>"}`;
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
