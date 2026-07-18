// Edge Function: instantly-webhook
// -----------------------------------------------------------------------------
// Receives Instantly webhook POSTs. Deploy with --no-verify-jwt (Instantly
// cannot send a Supabase JWT); instead it is protected by a shared secret
// passed as ?secret=... which must match the WEBHOOK_SECRET secret.
//
// It ALWAYS logs the raw payload to webhook_log first (audit trail + a way to
// discover the real event names Instantly sends), then best-effort maps the
// event to a creator status update via email_normalized match.
//
// The exact Instantly event names are NOT verified. After the first real
// events land, inspect them with:
//     select event_type, count(*) from webhook_log group by 1 order by 2 desc;
// and extend EVENT_STATUS_MAP below if the real names differ.
// -----------------------------------------------------------------------------

import { createClient } from "jsr:@supabase/supabase-js@2";

// event name (lowercased) -> creator.status
const EVENT_STATUS_MAP: Record<string, string> = {
  // reply-type
  reply_received: "replied",
  lead_replied: "replied",
  email_reply: "replied",
  // bounce-type
  email_bounced: "bounced",
  bounce: "bounced",
  lead_bounced: "bounced",
  // unsubscribe / not-interested
  lead_unsubscribed: "do_not_contact",
  unsubscribe: "do_not_contact",
  lead_marked_not_interested: "do_not_contact",
  not_interested: "do_not_contact",
};

function pick(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // --- Shared-secret gate ---
  const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET");
  const url = new URL(req.url);
  const providedSecret = url.searchParams.get("secret");
  if (!WEBHOOK_SECRET || providedSecret !== WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // --- Parse payload defensively ---
  let payload: Record<string, unknown> = {};
  try {
    payload = await req.json();
  } catch {
    // Not JSON — still record that something arrived.
    payload = { _unparseable: true };
  }

  const eventType = pick(payload, ["event_type", "event", "type"]);

  // lead email may be nested under a `lead` object
  const lead = (payload.lead ?? {}) as Record<string, unknown>;
  const leadEmail =
    pick(payload, ["lead_email", "email"]) ?? pick(lead, ["email"]);

  // --- ALWAYS log first (audit + event-name discovery) ---
  await db.from("webhook_log").insert({
    event_type: eventType,
    lead_email: leadEmail,
    payload,
  });

  // --- Best-effort status mapping ---
  let action: "updated" | "logged_only" = "logged_only";
  let newStatus: string | null = null;

  if (eventType && leadEmail) {
    newStatus = EVENT_STATUS_MAP[eventType.toLowerCase()] ?? null;
    if (newStatus) {
      const normalized = leadEmail.toLowerCase().trim();
      const { error } = await db
        .from("creators")
        .update({ status: newStatus })
        .eq("email_normalized", normalized);
      if (!error) action = "updated";
    }
  }

  // Always 200 so Instantly does not retry storms; details in the body.
  return new Response(
    JSON.stringify({
      ok: true,
      action,
      event_type: eventType,
      mapped_status: newStatus,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
