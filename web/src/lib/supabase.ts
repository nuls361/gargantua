import { createClient } from "@supabase/supabase-js";

// The anon key is PUBLIC by design — it ships in the client bundle and is safe to expose;
// Row Level Security is what protects the data. So we hardcode the lbug project's URL +
// anon key as a fallback, meaning the app works even if the host's build-time env vars are
// missing (which is exactly what white-screened the Vercel deploy). Env vars still win when
// present, so a different project/key can be swapped in without a code change.
const url = import.meta.env.VITE_SUPABASE_URL || "https://lbugisvvafrhdoyyabtq.supabase.co";
const anonKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxidWdpc3Z2YWZyaGRveXlhYnRxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0MDc0NjgsImV4cCI6MjA5ODk4MzQ2OH0.gGNnZFGmNa8T075-nF2r7JjAQ-KHpPkAyj8hYr_QTsI";

export const supabase = createClient(url, anonKey);
