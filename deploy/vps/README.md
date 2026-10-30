# Dictionary Hub on the VPS (next to Mailu)

> This folder is the reference production host, next to an existing Mailu mail server. For a new install on one
> host, use `deploy/compose` (one command; [README › Install](../../README.md#install)).

`https://mail.sophizo.com.br:18443` — Docker Compose project `dictionary-hub` in `/opt/dictionary-hub`, beside the Mailu project in `/mailu`.

| Service | What it is |
| --- | --- |
| `db` | Postgres (`supabase/postgres:17.11.0.006`), volume `dictionary-hub_db-data` |
| `auth`, `rest` | GoTrue and PostgREST; sign-ups off |
| `functions` | `ghcr.io/loardracoon/software-inventory-hub-functions:<HUB_TAG>` |
| `kong` | `ghcr.io/loardracoon/software-inventory-hub-web:<HUB_TAG>` — console + API gateway (same image as K3S; `/env.js` from `PUBLIC_URL`) |
| `tls` | nginx on `HUB_PORT` (18443) with Mailu's Let's Encrypt certificate (`/mailu/certs/letsencrypt`, read-only), reloaded every 12 h to follow renewals; plain HTTP on that port is redirected to HTTPS |
| `smtp-relay` | socat answering as `mail.sophizo.com.br:465` on the Hub network and forwarding to Mailu's `front:465` on `mailu_default` (containers cannot reach the host's public IP); TLS stays end to end |
| `migrate` | profile `tools`: `docker compose run --rm migrate` applies new migrations |

Coexistence with Mailu: only port 18443 is published; Mailu's containers, configuration and ports are untouched. The only change on the Mailu side is the mailbox `hub-noreply@sophizo.com.br` (created with `flask mailu user`), which GoTrue uses to send the magic links and the functions use for admin email (daily digest, reclassification requests, engine pauses). Mailu offers submission on 465 only (its front does not listen on 587).

## Files

- `docker-compose.yml`, `tls.conf`, `update.sh`, `rate-limits.env` from this folder; `mail.htpasswd` empty (no Mailpit here, `/mail/` refuses everyone).
- `.env` (chmod 600, never committed): `PUBLIC_URL`, `HUB_PORT`, `HUB_TAG`, `POSTGRES_PASSWORD`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `CRON_SECRET`, `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`.

## Rate limits and abuse protection

Every variable is explained in [docs/rate-limits.md](../../docs/rate-limits.md). The text below is a short version.

All limits are in one file: **`rate-limits.env`** (in this folder; on the server `/opt/dictionary-hub/rate-limits.env`). Docker Compose loads it into `kong` (the gateway), `auth` and `functions` (`env_file`, optional: without the file the image defaults apply, and Auth has no per-address limits). After a change: `docker compose up -d kong auth functions`. `tls.conf` adds a limit of 100 open connections per address and timeouts against slow clients. Values for a team of up to ~50 users behind one office address:

| Setting | Recommended | What it limits |
| --- | --- | --- |
| `RL_AUTH_STRICT_RATE` / `_BURST` | `10r/m` / `10` | Gateway, per address: `/auth/v1/otp`, `magiclink`, `signup`, `recover`, `resend`, `verify` (sign-in links and code checks) |
| `RL_AUTH_RATE` / `_BURST` | `120r/m` / `60` | Gateway, per address: other Auth calls (session refresh, user) and `/mail/` |
| `RL_REST_RATE` / `_BURST` | `30r/s` / `120` | Gateway, per address: the database API (a screen sends 10 to 30 requests at once) |
| `RL_FUNCTIONS_RATE` / `_BURST` | `10r/s` / `60` | Gateway, per address: Edge Functions (client API, console actions) |
| `RL_CONN_PER_IP` | `60` | Gateway: open connections per address |
| `RL_BODY_AUTH` / `RL_BODY_REST` / `RL_BODY_FUNCTIONS` | `64k` / `2m` / `10m` | Gateway: largest request body (HTTP 413 above) |
| `GOTRUE_RATE_LIMIT_HEADER` | `X-Real-IP` | Auth: the header with the client address. **Without it GoTrue applies none of its per-address limits** (checked in the GoTrue source); the gateway sets it |
| `GOTRUE_RATE_LIMIT_OTP` | `10` | Auth: sign-in and sign-up requests per address per 5 minutes |
| `GOTRUE_RATE_LIMIT_VERIFY` | `15` | Auth: magic link and code checks per address per 5 minutes |
| `GOTRUE_RATE_LIMIT_TOKEN_REFRESH` | `60` | Auth: session refreshes per address per 5 minutes |
| `GOTRUE_RATE_LIMIT_EMAIL_SENT` | `60` | Auth: emails per hour for the whole app (sign-in links, invitations) |
| `RL_INVITES_PER_HOUR` | `20` | Edge Function `manage-users`: invitations and sign-in links per admin per hour (counted in the audit log) |
| `RL_HUB_CLIENT_REQUESTS_PER_MINUTE` | `120` | Client API: calls per client key per minute (HTTP 429 with `Retry-After`; one client sync sends up to ~50) |

How it works:

- **Gateway** (nginx in the web image, `deploy/k3s/nginx.conf.template`): limits per client address with `limit_req` (HTTP 429), open connections, body sizes and timeouts against slow clients. The image has the recommended values as defaults; Docker Compose (rate-limits.env) overrides them. The client address comes from `X-Forwarded-For`, trusted only from private networks (the proxy in front), so a client cannot choose its own address. Calls between services (Edge Functions to PostgREST and Auth, database jobs to Edge Functions) carry no `X-Forwarded-For` and are not limited.
- **Auth** (GoTrue): per-address limits on sign-in, code checks and session refresh, keyed by the `X-Real-IP` header the gateway sets, and one email limit for the whole app.
- **Edge Functions**: the per-admin invitation limit and the per-key limit of the client API.

Raise the gateway rates when many users share one public address (one office behind NAT): every limit is per address. Lower them when the app is open to the internet and has few users.

Check the client address after a change: the gateway access log (`docker compose logs kong`) must show the real public addresses, not one internal address for everyone. On the VPS the tls container adds the address; nothing else is needed. A blocked request gets HTTP 429 and a line `limiting requests` in that log.

Limits that were already in place: Sophos API budget per tenant (10 runs per minute, 1,000 per day, Scans › API budget), Hub sync back-off (5 minutes up to 6 hours), retries of 429 and 5xx with back-off in `_shared/http.ts`, NVD calls paced to its limit (5 per 30 s without a key, 50 with one), Jev and Research daily budgets (Engines & usage).

## Keep the Vault key

The database's Vault (Sophos credential or AI keys, Hub key, job secrets) is encrypted with `pgsodium_root.key`, which
the Postgres image creates at first use in `/etc/postgresql-custom`, **inside the container, outside the data volume**.
A new database container (an image upgrade, a recreated container) creates a new key, and every Vault secret can no
longer be read ("invalid ciphertext"). The one-host install keeps the key in the `db-config` volume; the layouts
below need this once.

1. Save the key of the running database (a secret: keep it with `.env`, never in git):

   ```bash
   cd /opt/dictionary-hub
   docker compose exec -T db sh -c 'cat /etc/postgresql-custom/pgsodium_root.key' > pgsodium_root.key
   chown "$(docker compose exec -T db id -u postgres | tr -d '\r')" pgsodium_root.key && chmod 600 pgsodium_root.key
   ```

2. In `docker-compose.yml`, turn on the commented line under `db` › `volumes`
   (`./pgsodium_root.key:/etc/postgresql-custom/pgsodium_root.key:ro`) and recreate the database:
   `docker compose up -d db`.
3. Check: `docker compose exec -T db psql -U supabase_admin -h localhost -d postgres -tAc "select count(*), count(decrypted_secret) from vault.decrypted_secrets"`
   shows the same number twice.

Step 1 alone already protects you: with the saved key, a lost container can be repaired. Never turn on step 2 before
the file exists (Docker would create a folder with that name and the database would not start).

## Jobs

pg_cron runs `jev-auto` (hourly, :07), `research-tick` (hourly, :37) and `daily-digest` (11:00 UTC). They read the Vault secrets `jev_url` (`http://kong:8000/functions/v1/jev`) and `cron_secret` (`CRON_SECRET`), set on Oct 28, 2026. Jev and Research only act alone in automatic mode (Engines & usage).

## Updating

`/opt/dictionary-hub/update.sh` reads the image tag CI wrote into `deploy/k3s/app/stack.yaml` on `main`; when it differs from `HUB_TAG` it pulls the images, runs the migrations and recreates `functions` and `kong`. `dictionary-hub-update.timer` (installed Oct 28, 2026 from this folder into `/etc/systemd/system`) runs it every 5 minutes; `journalctl -u dictionary-hub-update.service` shows each update. Changes to `docker-compose.yml` or `tls.conf` are copied to the server by hand.

## First install

1. Create `/opt/dictionary-hub` with the files above and `.env`; `docker compose up -d --wait db`.
2. As `supabase_admin`, set the passwords of `authenticator`, `supabase_auth_admin` and `postgres` to `POSTGRES_PASSWORD` and `app.settings.jwt_secret`.
3. `docker compose run --rm migrate`, then `docker compose up -d`.
4. Create the Vault secrets of the jobs (see Jobs) and install the update timer.
