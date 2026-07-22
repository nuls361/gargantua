// Edge Function: fetch-doc
// -----------------------------------------------------------------------------
// Server-side fetch of a briefing from a URL (avoids browser CORS). Handles Google
// Docs by rewriting the link to its plain-text export; works when the doc is shared
// "Anyone with the link". Also fetches arbitrary text/published URLs.
//
// Request:  { "url": "https://docs.google.com/document/d/…/edit" }
// Response: { "text": "…" }  or  { "error": "…" }
// -----------------------------------------------------------------------------

import { corsHeaders, json } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { url } = await req.json().catch(() => ({}));
    if (!url || typeof url !== "string") return json({ error: "url required" }, 400);

    let target = url.trim();
    const gdoc = target.match(/docs\.google\.com\/document\/d\/([\w-]+)/);
    if (gdoc) target = `https://docs.google.com/document/d/${gdoc[1]}/export?format=txt`;

    const r = await fetch(target, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
    if (!r.ok) return json({ error: `Fetch failed (${r.status})` }, 502);
    const ct = r.headers.get("content-type") ?? "";
    let text = await r.text();

    // Google returns an HTML login page for private docs instead of the text export.
    if (gdoc && (ct.includes("text/html") || /<html/i.test(text))) {
      return json({ error: "This Google Doc is private. Set sharing to “Anyone with the link (Viewer)” and try again." }, 400);
    }
    // crude HTML → text fallback for non-google pages that returned markup
    if (/<html/i.test(text) && ct.includes("text/html")) {
      text = text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ").replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
    }
    if (!text.trim()) return json({ error: "No text found at that URL." }, 400);
    return json({ text: text.slice(0, 60000) });
  } catch (e) {
    return json({ error: String(e).slice(0, 300) }, 500);
  }
});
