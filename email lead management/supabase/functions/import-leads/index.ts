// Edge Function: import-leads
// -----------------------------------------------------------------------------
// Auth-gated. Imports a parsed CSV into a list. The whole batch carries three
// shared properties, stamped on every lead for later orientation:
//   - label            (e.g. "food", "beauty", "batch-42")
//   - region           ("uk" | "dach")
//   - sample_creator   (a reference creator the list is modelled on)
//
// Per row, behaviour depends on whether an email is present:
//   - email present  → run cleaning (freemail-only + blocklist + dedupe):
//       · pass  → inserted into the target list, status 'enriched' (send-ready)
//       · fail  → inserted into the static Filtered list, status 'filtered'
//     If the email already exists in the DB, the existing lead is UPDATED with
//     the batch properties (label/region/sample_creator) instead of duplicated.
//   - only a handle  → inserted into the target list, status 'sourced'
//     (to be enriched later via ClickAnalytic). Handles already in the DB are
//     skipped as duplicates.
// -----------------------------------------------------------------------------

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";
import { cleanReason } from "../_shared/freemail.ts";

interface RawRow {
  email?: string | null;
  handle?: string | null;
  platform?: string | null;
}

const norm = (s: string) => s.toLowerCase().trim();
const cleanHandle = (h: string) => h.trim().replace(/^@+/, "");

// Merge comma-separated labels, keeping order (existing first) and
// de-duplicating case-insensitively. Used so a re-import accumulates labels
// on an existing creator instead of overwriting them.
function mergeLabels(existing: string | null, incoming: string | null): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const add = (s: string | null) => {
    if (!s) return;
    for (const raw of s.split(",")) {
      const v = raw.trim();
      if (!v) continue;
      const key = v.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      parts.push(v);
    }
  };
  add(existing);
  add(incoming);
  return parts.join(", ");
}

// Run an `.in()` lookup in batches to stay under URL length limits.
async function chunkedIn<T>(
  keys: string[],
  fn: (batch: string[]) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < keys.length; i += 200) {
    out.push(...(await fn(keys.slice(i, i + 200))));
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // --- auth ---
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Missing Authorization header" }, 401);
  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userErr } = await authClient.auth.getUser();
  if (userErr || !user) return json({ error: "Not authenticated" }, 401);

  // --- body ---
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const rawRows: RawRow[] = Array.isArray(body?.rows) ? (body.rows as RawRow[]) : [];
  if (rawRows.length === 0) return json({ error: "No rows to import" }, 400);

  const label = (body?.label ?? "").toString().trim() || null;
  const region = body?.region === "uk" || body?.region === "dach" ? body.region : null;
  const sampleCreator = (body?.sample_creator ?? "").toString().trim() || null;
  const fileName = (body?.file_name ?? "").toString().trim() || null;

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // --- resolve target list (new name → find-or-create, else existing id) ---
  let targetListId: string | null = null;
  const newName = (body?.new_list_name ?? "").toString().trim();
  if (newName) {
    const { data: existing } = await db
      .from("lists").select("id").eq("name", newName).maybeSingle();
    if (existing) {
      targetListId = existing.id as string;
    } else {
      const { data: created, error: cErr } = await db
        .from("lists").insert({ name: newName, kind: "working" }).select("id").single();
      if (cErr) return json({ error: `Could not create list: ${cErr.message}` }, 500);
      targetListId = created.id as string;
    }
  } else if (body?.list_id) {
    targetListId = body.list_id as string;
  }
  if (!targetListId) return json({ error: "Provide new_list_name or list_id" }, 400);

  const { data: filteredList } = await db
    .from("lists").select("id").eq("kind", "filtered").limit(1).single();
  const filteredId = filteredList?.id as string | undefined;
  if (!filteredId) return json({ error: "Filtered list not found" }, 500);

  const { data: blocked } = await db.from("blocked_domains").select("domain");
  const blockedSet = new Set((blocked ?? []).map((d) => norm(d.domain as string)));

  // --- normalize rows + in-file dedupe ---
  const seenEmail = new Set<string>();
  const seenHandle = new Set<string>();
  let dupInFile = 0;
  const items: {
    email: string | null;
    emailNorm: string | null;
    handle: string | null;
    platform: string;
  }[] = [];
  for (const r of rawRows) {
    const email = (r.email ?? "").toString().trim() || null;
    const emailNorm = email ? norm(email) : null;
    const handle = (r.handle ?? "").toString().trim();
    const cleanedHandle = handle ? cleanHandle(handle) : null;
    const platform = ((r.platform ?? "").toString().trim().toLowerCase()) || "tiktok";
    if (!email && !cleanedHandle) continue; // nothing usable
    if (emailNorm) {
      if (seenEmail.has(emailNorm)) { dupInFile++; continue; }
      seenEmail.add(emailNorm);
    } else if (cleanedHandle) {
      const hk = cleanedHandle.toLowerCase();
      if (seenHandle.has(hk)) { dupInFile++; continue; }
      seenHandle.add(hk);
    }
    items.push({ email, emailNorm, handle: cleanedHandle, platform });
  }

  // --- bulk lookups for existing rows ---
  const emailNorms = items.map((i) => i.emailNorm).filter(Boolean) as string[];
  const handleKeys = items.filter((i) => !i.emailNorm && i.handle).map((i) => i.handle!) as string[];

  const emailToId = new Map<string, string>();
  const idToLabel = new Map<string, string | null>();
  if (emailNorms.length) {
    const found = await chunkedIn(emailNorms, async (batch) => {
      const { data } = await db.from("creators")
        .select("id, email_normalized, label").in("email_normalized", batch);
      return (data ?? []) as { id: string; email_normalized: string; label: string | null }[];
    });
    for (const f of found) {
      emailToId.set(f.email_normalized, f.id);
      idToLabel.set(f.id, f.label ?? null);
    }
  }

  const handleToId = new Map<string, string>();
  if (handleKeys.length) {
    const found = await chunkedIn(handleKeys, async (batch) => {
      const { data } = await db.from("creators").select("id, handle").in("handle", batch);
      return (data ?? []) as { id: string; handle: string }[];
    });
    for (const f of found) if (f.handle) handleToId.set(f.handle, f.id);
  }

  // --- categorize ---
  const toInsert: Record<string, unknown>[] = [];
  const updateIds = new Set<string>();
  const reasons: Record<string, number> = {};
  let enriched = 0, sourced = 0, filtered = 0, updated = 0;
  let duplicates = dupInFile;

  for (const it of items) {
    if (it.emailNorm) {
      const existingId = emailToId.get(it.emailNorm);
      if (existingId) { updateIds.add(existingId); updated++; continue; }
      const reason = cleanReason(it.email, blockedSet);
      if (reason) {
        reasons[reason] = (reasons[reason] ?? 0) + 1;
        toInsert.push({
          email: it.email, handle: it.handle, platform: it.platform,
          list_id: filteredId, region_label: region, label, sample_creator: sampleCreator,
          status: "filtered", filter_reason: reason,
        });
        filtered++;
      } else {
        toInsert.push({
          email: it.email, handle: it.handle, platform: it.platform,
          list_id: targetListId, region_label: region, label, sample_creator: sampleCreator,
          status: "enriched", enriched_at: new Date().toISOString(),
        });
        enriched++;
      }
    } else if (it.handle) {
      if (handleToId.get(it.handle)) { duplicates++; continue; }
      toInsert.push({
        handle: it.handle, platform: it.platform,
        list_id: targetListId, region_label: region, label, sample_creator: sampleCreator,
        status: "sourced",
      });
      sourced++;
    }
  }

  // --- execute inserts (chunked) ---
  const errors: string[] = [];
  for (let i = 0; i < toInsert.length; i += 500) {
    const chunk = toInsert.slice(i, i + 500);
    const { error } = await db.from("creators").insert(chunk);
    if (error) errors.push(`Insert chunk ${Math.floor(i / 500) + 1}: ${error.message}`);
  }

  // --- enrich existing rows with the batch props ---
  // region + sample_creator: overwrite-if-provided. label: ADDITIVE — the new
  // label is merged into whatever the creator already has (deduped), so a
  // re-import accumulates labels rather than replacing them.
  const baseUpdate: Record<string, unknown> = {};
  if (region) baseUpdate.region_label = region;
  if (sampleCreator) baseUpdate.sample_creator = sampleCreator;

  async function updateIn(ids: string[], patch: Record<string, unknown>) {
    if (!ids.length || Object.keys(patch).length === 0) return;
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await db.from("creators").update(patch).in("id", ids.slice(i, i + 200));
      if (error) errors.push(`Update: ${error.message}`);
    }
  }

  if (updateIds.size) {
    const ids = [...updateIds];
    if (label) {
      // Group existing creators by their resulting merged label so creators
      // that end up with the same label share one update call.
      const byMerged = new Map<string, string[]>();
      for (const id of ids) {
        const merged = mergeLabels(idToLabel.get(id) ?? null, label);
        const arr = byMerged.get(merged) ?? [];
        arr.push(id);
        byMerged.set(merged, arr);
      }
      for (const [mergedLabel, gids] of byMerged) {
        await updateIn(gids, { ...baseUpdate, label: mergedLabel });
      }
    } else {
      // No new label → only region/sample overwrite (if provided).
      await updateIn(ids, baseUpdate);
    }
  }

  // --- record upload history (best-effort) ---
  await db.from("imports").insert({
    file_name: fileName,
    region_label: region,
    label,
    sample_creator: sampleCreator,
    list_id: targetListId,
    total_rows: rawRows.length,
    kept: enriched + sourced,
    inserted: enriched + sourced,
    updated,
    skipped_duplicates: duplicates,
    removed_breakdown: { ...reasons, duplicate_in_file: dupInFile },
    uploaded_by: user.email ?? null,
  });

  return json({
    ok: true,
    list_id: targetListId,
    total_rows: rawRows.length,
    inserted: enriched + sourced,
    enriched,
    sourced,
    filtered,
    updated,
    duplicates,
    reasons,
    errors,
  });
});
