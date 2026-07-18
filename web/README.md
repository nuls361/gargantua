# Email Lead Management (Pre-CRM)

A lean internal tool for managing cold TikTok creator email leads **before** they
go into [Instantly](https://instantly.ai). Import ClickAnalytic CSV exports,
filter out agency/management emails, keep only private freemail addresses,
assign leads to a campaign, and push them to Instantly. Bounces / replies /
unsubscribes flow back via an Instantly webhook.

Deliberately **not** in the main CRM (Attio). Built for 1–2 internal users.

- **Backend:** Supabase (Postgres + Auth + Edge Functions)
- **Frontend:** Vite + React + TypeScript + `supabase-js`
- **UI language:** German

---

## How it works (flow)

1. **Import** – Upload a ClickAnalytic CSV. Columns are detected **by header
   name** (`username`, `email`), not position, so the wider scraper format works
   too. The importer keeps only addresses on a **freemail allowlist** (gmail,
   gmx, icloud, web.de, …) and drops everything else — agency/custom domains —
   plus any domain in the `blocked_domains` table. You get a preview (kept /
   removed with per-domain counts / in-file duplicates), pick **UK** or **DACH**,
   then insert. Inserts are chunked (500) and use `upsert … ignoreDuplicates` on
   `email_normalized`, so re-importing overlapping lists is safe and reports how
   many were new vs. already-present.
2. **Leads** – Filter/search, multi-select, assign to a campaign
   (`status → queued`), **Push zu Instantly** (calls the edge function), export
   selection as CSV, or mark `do_not_contact`.
3. **Kampagnen** – Create campaigns (name + Instantly campaign id) and see lead
   counts.
4. **Webhook** – Instantly posts events back; they are logged and mapped to lead
   status.

### Security model

- The **Instantly API key never reaches the browser.** Only the
  `push-to-instantly` edge function reads it (from the `INSTANTLY_API_KEY`
  secret). Create a dedicated Instantly V2 key scoped to `leads:create`.
- Auth is a Supabase email/password **session** — no credentials in
  `localStorage`.
- All tables have **RLS**; the frontend (anon key) can only act as an
  `authenticated` user. Edge functions use the **service role** key.
- The webhook function is deployed `--no-verify-jwt` and gated by a shared
  `?secret=` matching the `WEBHOOK_SECRET` secret.

---

## Prerequisites

- Node.js 18+ and npm
- [Supabase CLI](https://supabase.com/docs/guides/cli) (`brew install supabase/tap/supabase`)
- A Supabase project
- An Instantly V2 API key (scope: `leads:create`)

> Note: this machine had no Node installed at build time, so the frontend was not
> compiled here. Run `npm install` then `npm run build` once locally to confirm.

---

## 1. Supabase project setup

Create a project at [supabase.com](https://supabase.com), then grab from
**Project Settings → API**:

- Project URL → `https://<ref>.supabase.co`
- `anon` public key
- `service_role` key (server-side only, never in the frontend)

Link the CLI to your project (run from the project root):

```bash
supabase login
supabase link --project-ref <ref>
```

## 2. Run the migration

The schema, RLS policies, indexes, and the seeded `blocked_domains` list live in
`supabase/migrations/0001_init.sql`.

```bash
supabase db push
```

(Or paste the file into the Supabase SQL editor and run it.)

## 3. Create the auth user(s)

There is no self-signup UI. Create your 1–2 users in the dashboard:

**Authentication → Users → Add user** (set email + password, mark as
confirmed). That's the login for the app.

## 4. Set edge function secrets

```bash
supabase secrets set INSTANTLY_API_KEY=<your-instantly-v2-key>
supabase secrets set WEBHOOK_SECRET=<a-long-random-string>
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are injected
into edge functions automatically — you do **not** set those yourself.

Generate a webhook secret, e.g.:

```bash
openssl rand -hex 24
```

## 5. Deploy the edge functions

```bash
# Requires an authenticated Supabase user session; keep JWT verification on.
supabase functions deploy push-to-instantly

# Instantly can't send a Supabase JWT — disable JWT check; it's gated by ?secret= instead.
supabase functions deploy instantly-webhook --no-verify-jwt
```

## 6. Register the webhook in Instantly

In Instantly, add a webhook pointing at:

```
https://<ref>.supabase.co/functions/v1/instantly-webhook?secret=<WEBHOOK_SECRET>
```

Subscribe to reply / bounce / unsubscribe (and any "not interested") events.

> **Event names are not verified.** The function logs every raw payload to
> `webhook_log` first, then best-effort maps known event names to a status. After
> the first real events land, inspect what Instantly actually sends:
>
> ```sql
> select event_type, count(*) from webhook_log group by 1 order by 2 desc;
> ```
>
> If the real names differ from the defaults, extend `EVENT_STATUS_MAP` in
> `supabase/functions/instantly-webhook/index.ts` and redeploy. Unknown events
> are logged and never touch lead data.

---

## Creator Search (ClickAnalytic) — mock until connected

The **Search** screen discovers creators via the ClickAnalytic Influencer
Marketing API, through the auth-gated `clickanalytic-search` edge function (the
API key never reaches the browser).

**It ships in MOCK mode.** While the `CLICKANALYTIC_API_KEY` secret is unset, the
function returns sample-shaped data so the whole UI works (results show a "Mock
data" badge). To go live once you have a ClickAnalytic account:

1. `supabase secrets set CLICKANALYTIC_API_KEY=<key> --project-ref <ref>`
2. Fill the two `TODO(go-live)` blocks in
   `supabase/functions/clickanalytic-search/adapter.ts` — `buildSearchRequest`
   (map filters → their params) and `normalizeResults` (map their response →
   `SearchResult`) — using the OpenAPI reference ClickAnalytic provides on signup.
   **This is the only file that changes.**
3. `supabase functions deploy clickanalytic-search --project-ref <ref>`

The search defaults to TikTok (switchable to Instagram / YouTube) and each result
has a "Show raw API JSON" expander so you always see the raw API feedback.

---

## 7. Local frontend dev

```bash
cp .env.example .env
# edit .env:
#   VITE_SUPABASE_URL=https://<ref>.supabase.co
#   VITE_SUPABASE_ANON_KEY=<anon-key>

npm install
npm run dev
```

Open the printed localhost URL and log in with the user from step 3.

Build for production:

```bash
npm run build      # outputs to dist/
npm run preview    # serve the build locally
```

Deploy `dist/` to any static host (Netlify, Vercel, Cloudflare Pages, an
internal server). Only the two `VITE_` env vars are needed at build time.

---

## Data model (summary)

| Table             | Purpose                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `campaigns`       | Named campaigns mapped to an `instantly_campaign_id`.                   |
| `creators`        | The leads. `email_normalized` (generated, UNIQUE) is the dedupe key.    |
| `blocked_domains` | Agency/management domains to drop on import (pre-seeded).               |
| `webhook_log`     | Raw audit trail of every Instantly webhook POST.                        |

`creators.status`: `new → queued → in_instantly`, plus `replied`, `bounced`,
`do_not_contact` (set by the webhook).

### Import filter rule (frontend, before insert)

Keep an address **only if** its domain is in the freemail allowlist
(`src/lib/filter.ts`) **and not** in `blocked_domains`. Everything else
(agency/custom domains) is dropped. To permanently block a newly-spotted agency
domain, add it to `blocked_domains` — it applies to the next import.

---

## Project layout

```
.
├── index.html
├── package.json
├── vite.config.ts
├── src/
│   ├── main.tsx / App.tsx        # routing + auth session guard
│   ├── lib/
│   │   ├── supabase.ts           # supabase-js client (env-configured)
│   │   ├── csv.ts                # quoted-field CSV parser (BOM/CRLF safe) + CSV export
│   │   ├── filter.ts             # freemail allowlist + preview builder
│   │   └── types.ts
│   └── pages/                    # Login, Import, Leads, Kampagnen
└── supabase/
    ├── migrations/0001_init.sql
    └── functions/
        ├── push-to-instantly/    # auth-gated; calls Instantly v2 /leads/add
        └── instantly-webhook/    # secret-gated; logs + maps events back
```
