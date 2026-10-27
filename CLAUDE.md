# Dictionary Hub

The single source of truth for software titles (programs, browser and IDE extensions, packages), their descriptions and their two-level categories. Endpoint Inventory clients read it through an API and send suggestions; only hub admins change it. Jev (Lovable AI) proposes categories; an optional research engine (Gemini or Claude) builds sourced dossiers. Nothing about any client's computers, users or Sophos tenants is stored here.

## Read before coding

1. `docs/phases/README.md`: build order and status. Work on one phase at a time.
2. The phase file you are on, e.g. `docs/phases/hub-H3-jev.md`. It is the task.
3. `docs/spec.md`: the design document (Portuguese prose, English prompts). Sections "Duas aplicações", "Hub" and "Motores de IA" matter most. Its "Read this first" box lists the decisions that superseded parts of it.
4. `docs/taxonomy.md` / `docs/taxonomy.csv`: the taxonomy to seed in Phase H1 (29 level 1, 71 level 2, default attention, Sophos Firewall mapping).
5. `design/README.md` and `design/mock/*.dc.html`: the admin console mock (Inbox, Entry, Engines & usage, Taxonomy).
6. `docs/phases/client-07-hub-dictionary.md`: how the client consumes this API.

## Where this repo runs

- Decision (Oct 27, 2026): the Hub is built **locally, like the client** (`../client`), not in Lovable: Vite + React in a container on port 5175 and its own Supabase local stack (project `dictionary-hub`, ports 56320-56329), next to the client's stacks (543xx main, 553xx isolated e2e). It can be moved to Lovable or a Supabase project later; the code is plain Supabase.
- Jev therefore does not use Lovable AI: model calls go through `ai_gateway` to the Claude API (key in `supabase/functions/.env`, never in the repo). Wherever this file or the spec says "Lovable AI", read "the Jev provider behind `ai_gateway`".
- Migrations go in `supabase/migrations/`, Edge Functions in `supabase/functions/`, pgTAP tests in `supabase/tests/database/`.
- Never reset the Hub database once it holds real dictionary work; use a second stack for destructive tests (see `../client/CLAUDE.md`).
- Sign-ups are off (`[auth] enable_signup = false`). Admin accounts come from `npm run admin:add -- <email>`; only users in `hub_admins` get past the access-denied page, and RLS gives anonymous and non-admin users nothing.

## Stack

- Lovable defaults: Vite, React, TypeScript, Tailwind, shadcn/ui; Lovable Cloud (Postgres, Auth, Edge Functions); Lovable AI for Jev; Resend for email.
- Same Sophos DS 2026 tokens and fonts as the client (`design/tokens/`).

## Commands

- `npm install`; `npm run stack:up` (Supabase on 56321-56324 + the web container on http://localhost:5175); `npm run stack:down`.
- `npm run web:up` rebuilds the web container; run it after any dependency change (its node_modules live in a volume).
- `node scripts/generate-taxonomy-seed.mjs` rewrites the taxonomy seed migration from `docs/taxonomy.json` (keep the file identical to `../client/docs/taxonomy.json`).
- `npm run cron:configure` (`-- --off`): writes the Vault secrets pg_cron needs for `jev-auto`, `research-tick` and `daily-digest` (`CRON_SECRET` from `supabase/functions/.env`).
- `npm run admin:add -- <email>`: create a hub admin (local stack by default; `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` for a remote project).
- `npm run dev` (Vite on 5175 without Docker), `npm run build`, `npm test` (Vitest), `npm run lint`, `npm run test:db` (pgTAP), `npm run db:types`, `npm run functions:check`.
- Mailpit (magic links): http://127.0.0.1:56324. Studio: http://127.0.0.1:56323.

## Rules that must not break

- Code, comments and UI copy in English.
- Clients are untrusted. Submissions and reclassification requests are suggestions and are never applied automatically.
- Text from clients and from the web (names, descriptions, reasons, fetched pages) is untrusted: render as plain text, never as HTML, and never let it change the instructions sent to a model.
- Every change to an entry or category creates a revision. Publishing assigns the next global `seq`; nothing reaches clients before it is published.
- Every model call goes through `ai_gateway`: check mode, pause state and budgets first; log every call in `ai_calls` with an estimated cost that is never recomputed; apply the pause rules.
- Entries always point to a level-2 category. Slugs never change.
- Client keys are stored as sha256 hashes, shown once, rate limited (60 calls per minute) and revocable.
- Never return client data to another client: `GET reclassification-requests` only returns the caller's own requests.

## Jev and the auto-publish gate

- Modes: off, manual, automatic. Defaults: automatic, 50 titles per run, a run at most every 6 hours, only titles reported by 2+ clients, 200 titles per day, 3 credits per month, 100 auto-publishes per day, alert at 80%.
- Options sent to Jev: the 71 level-2 categories as "Level 1 / Level 2: description", including Other / Other. Fall back to two steps (level 1, then level 2) if accuracy drops.
- Auto-publish only when all hold: probability >= 0.95; current and proposed category both have attention `info`; no manual revision on the entry; no open request; under the daily cap. Mark `jev_auto`, list it with a one-click Revert.
- "Accept all above 0.85" skips categories with attention `review` or `not_allowed`.
- Pause on: 100% budget; HTTP 402 from Lovable AI; more than 20% failed calls in an hour; acceptance below 70% over the last 50 decided proposals (a reverted auto-publish counts as rejected). Only an admin resumes.
- Research engine: provider claude (default, `claude-opus-5-5`), gemini, openai or grok, chosen in Settings; at most 5 searches and 60 s each, 20 per day, USD 10 per month, one automatic research per entry per 30 days (triggers: client request, sensitive proposal; optional: Jev below 0.85, rule and Jev disagree). Output must match the dossier JSON schema in `docs/spec.md`; drop claims without a URL; it never publishes. Gemini, OpenAI and Grok adapters are not yet verified against the live APIs.
- Provider keys: entered in Settings › AI providers, stored in Vault (`provider_keys` holds the hint only), read only by Edge Functions through `get_provider_key` (service role). `ANTHROPIC_API_KEY` in `supabase/functions/.env` is a fallback for Claude. Without a key an engine answers with the mock; `JEV_PROVIDER=mock` and `RESEARCH_PROVIDER=mock` in that file force the mock even with a key (set locally: mock only for now).
- Both engines share the gateway: `engine_gate` before a call, `record_ai_call` after it (cost includes web searches at `ai_prices.per_search_usd`); a new pause emails every admin. Prices are edited in Engines & usage › Price table (`set_price`: a new row from now on, past calls keep their cost).

## Client API (Edge Functions, `Authorization: Bearer <client key>`)

- `GET dictionary-changes?since=<seq>&limit=1000` → `{ entries, categories, next_seq, has_more }`, published fields only, deprecated entries included.
- `POST titles-submit` → up to 500 titles, metadata only, any other field rejected.
- `POST reclassification-requests` → `{ id: "REQ-0042", status: "open" }`, deduplicated per client and entry, emails every admin.
- `GET reclassification-requests?ids=` → status and admin note, caller's requests only.

Full contract: `docs/phases/hub-H2-client-api.md`. Build through Phase H2 before the client starts its Phase 7.

## How to work here

- Plan mode first on H1, H3 and H5.
- Each phase ends with a passing build, passing tests and a short note in `docs/phases/README.md` (tick the box, list follow-ups).
- Test the gate and pause rules with unit tests; test the API with a fake client key (valid, revoked, rate limited, wrong owner).
