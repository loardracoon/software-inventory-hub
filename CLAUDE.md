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
- Users and access (same model as the client): roles in `hub_members` (`hub_role`: admin changes everything; operator curates: edits and publishes entries, decides proposals and requests, runs Jev and Research, reads Engines & usage; viewer reads and searches). `is_hub_admin()` = role admin, `can_curate()` = admin or operator, `is_hub_member()` = any role; `clients`, `audit_log` and `provider_keys` stay admin-only (members read client names through `client_names`). Sign-ups are on, gated by `access_rules` (an exact email with any role, or an email domain as viewer or operator, never admin): trigger `before_auth_user_created` refuses an Auth sign-up without a rule (except the first account of an empty Hub, which becomes admin) and `on_auth_user_created` adds the member with the rule's role. Settings › Users and access (admins) lists users, changes roles, invites by email through the Edge Function `manage-users` (email rule + one-click invitation or magic link) and manages domains; every change is audited. The console hides actions a role cannot take (`useHubRole()`), and the database refuses them anyway.

## Stack

- Lovable defaults: Vite, React, TypeScript, Tailwind, shadcn/ui; Lovable Cloud (Postgres, Auth, Edge Functions); Lovable AI for Jev; Resend for email.
- Same Sophos DS 2026 tokens and fonts as the client (`design/tokens/`).

## Commands

- `npm install`; `npm run stack:up` (Supabase on 56321-56324 + the web container on http://localhost:5175); `npm run stack:down`.
- `npm run web:up` rebuilds the web container; run it after any dependency change (its node_modules live in a volume).
- `node scripts/generate-taxonomy-seed.mjs` rewrites the taxonomy seed migration from `docs/taxonomy.json` (keep the file identical to `../client/docs/taxonomy.json`).
- `npm run cron:configure` (`-- --off`): writes the Vault secrets pg_cron needs for `jev-auto`, `research-tick` and `daily-digest` (`CRON_SECRET` from `supabase/functions/.env`).
- Admin email (`_shared/admin-email.ts`): SMTP when `SMTP_HOST` is set (`_shared/smtp.ts`; port 465 = implicit TLS with login, other ports plain and only without login — the local Mailpit is `supabase_inbucket_dictionary-hub:1025`), otherwise Resend (`RESEND_API_KEY`, `HUB_EMAIL_FROM`), otherwise skipped. The main Hub is the VPS (`deploy/vps/`), which sends through Mailu.
- `npm run admin:add -- <email>`: first admin or access recovery: admin email rule, account and admin membership (local stack by default; `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` for a remote project).
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

## Products (phase H6)

- Entries that differ only by version, architecture or vendor spelling belong to one product (`products`, `entries.product_id`). The key is computed in SQL: `product_name()` ("7-Zip 23.01 (x64)" → "7-Zip", "WindowsAppRuntime.1.8" → "WindowsAppRuntime"; years, "Java 8 Update 401" and "python3.12" stay), `vendor_key()` (lower case, no punctuation or legal suffix), `product_key_for()` = kind | vendor key (after `vendor_aliases`) | lower product name. The client uses the same functions and test vectors; change both together.
- Classification belongs to the product: `publish_entry` copies every publish to the other spellings (same category, attention, method and confidence, so older clients accept it; the revision says "Same product as …"; `hub.propagating` stops the loop), and `submit_titles` publishes a new spelling of a published product at once. Jev classifies one spelling per product.
- Spellings published with different categories before grouping show in Inbox › Grouping review (`v_product_conflicts`, `resolve_product_conflict`). Operators move or split a spelling on the entry page (`set_entry_product`; the entry is then locked). Admins add vendor spellings the rules miss (`set_vendor_alias`, regroups at once).
- `dictionary-changes` adds `product_id` and `product_key` to each entry (additive).

## Known vulnerabilities (phase H7)

- Sources (all free, public data): NVD CVE API 2.0 by CPE (`virtualMatchString=cpe:2.3:a:vendor:product`, incremental by last-modified date, 120-day window) and the NVD CPE dictionary (`keywordSearch`) for programs; OSV.dev `/v1/query` for npm and PyPI packages (deb, rpm, Chocolatey and Homebrew are not covered yet); CISA KEV (daily); FIRST EPSS (daily, 100 CVEs per call). The optional NVD API key is in Vault (`provider_keys` provider `nvd`, Settings › Data sources): without it NVD calls are spaced 6.5 s, with it 0.7 s.
- `product_cpes`: an exact CPE (product name equal, vendor equal to the vendor key or to the product) is confirmed automatically; other candidates wait in Inbox › CPE matches (`decide_cpe`, `add_cpe`; operators and admins). A rejected CPE takes its CVEs away.
- `vulnerabilities` (CVE id, or the OSV id without a CVE; NVD's CVSS wins over OSV) and `vulnerability_ranges` per product and CPE (start/end with inclusive flags, or an exact version). Only CVEs with a range for the product are stored. Every change of a (product, CVE) pair is a `vulnerability_events` row; EPSS moves of less than 0.05 are not.
- Edge Function `vuln-sync` (`_shared/vuln-sources.ts` parsers, `_shared/vuln-sync.ts` runner): pg_cron `vuln-sync` at :17 (`invoke_vuln_sync`, the Jev cron secrets), or the Refresh button on the entry page (one product, full read). Order: CVEs of due CPEs, CPE search, OSV, KEV, EPSS; stops before 140 s; logged in `vuln_sync_runs`.
- Client API `GET vulnerability-changes?since=<seq>` (client key): per (product, CVE) pair the product key, severity, KEV, EPSS and ranges, or `removed`. Clients compare their own installed versions; nothing about computers reaches the Hub.

## Jev and the auto-publish gate

- Modes: off, manual, automatic. Defaults: automatic, 50 titles per run, a run at most every 6 hours, only titles reported by 2+ clients, 200 titles per day, 3 credits per month, 100 auto-publishes per day, alert at 80%.
- Jev provider and model: Settings › Jev, stored in `engine_settings` (`set_engine_config` accepts claude or openai for Jev). Claude: Messages API, `claude-haiku-5-5` by default, cached system prompt. OpenAI: Responses API over REST, `gpt-5-mini` by default (a reasoning model: `reasoning.effort` low, room for reasoning tokens in `max_output_tokens`), strict JSON schema, automatic prompt caching; `input_tokens` include the cached ones, so the adapter subtracts them before pricing; `insufficient_quota` (429) counts as billing (402), any other 429 is a normal error. Both live in `_shared/jev-classifier.ts`.
- Options sent to Jev: the 71 level-2 categories as "Level 1 / Level 2: description", including Other / Other. Fall back to two steps (level 1, then level 2) if accuracy drops.
- Auto-publish only when all hold: probability >= 0.95; current and proposed category both have attention `info`; no manual revision on the entry; no open request; under the daily cap. Mark `jev_auto`, list it with a one-click Revert.
- "Accept all above 0.85" skips categories with attention `review` or `not_allowed`.
- Pause on: 100% budget; HTTP 402 from Lovable AI; more than 20% failed calls in an hour; acceptance below 70% over the last 50 decided proposals (a reverted auto-publish counts as rejected). Only an admin resumes.
- Research engine: provider claude (default, `claude-opus-5-5`), gemini, openai or grok, chosen in Settings; at most 5 searches and 60 s each, 20 per day, USD 10 per month, one automatic research per entry per 30 days (triggers: client request, sensitive proposal; optional: Jev below 0.85, rule and Jev disagree). Output must match the dossier JSON schema in `docs/spec.md`; drop claims without a URL; it never publishes. The Gemini adapter is verified against the live API (`gemini-3.8-flash`; only HTTP 402 counts as billing, 429 is a normal error); OpenAI and Grok are not yet verified.
- Provider keys: entered in Settings › AI providers, stored in Vault (`provider_keys` holds the hint only), read only by Edge Functions through `get_provider_key` (service role). `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in `supabase/functions/.env` are fallbacks for Claude / OpenAI. Without a key an engine answers with the mock; `JEV_PROVIDER=mock` and `RESEARCH_PROVIDER=mock` in that file force the mock even with a key (set locally: mock only for now).
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
