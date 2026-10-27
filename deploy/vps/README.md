# Dictionary Hub on the VPS (next to Mailu)

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

Coexistence with Mailu: only port 18443 is published; Mailu's containers, configuration and ports are untouched. The only change on the Mailu side is the mailbox `hub-noreply@sophizo.com.br` (created with `flask mailu user`), which GoTrue uses to send the magic links. Mailu offers submission on 465 only (its front does not listen on 587).

## Files

- `docker-compose.yml`, `tls.conf`, `update.sh` from this folder; `mail.htpasswd` empty (no Mailpit here, `/mail/` refuses everyone).
- `.env` (chmod 600, never committed): `PUBLIC_URL`, `HUB_PORT`, `HUB_TAG`, `POSTGRES_PASSWORD`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `CRON_SECRET`, `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`.

## Updating

`/opt/dictionary-hub/update.sh` reads the image tag CI wrote into `deploy/k3s/app/stack.yaml` on `main`; when it differs from `HUB_TAG` it pulls the images, runs the migrations and recreates `functions` and `kong`. Run it by hand after a push, or install `dictionary-hub-update.service` and `.timer` (in this folder) under `/etc/systemd/system` and `systemctl enable --now dictionary-hub-update.timer` to check every 5 minutes. Changes to `docker-compose.yml` or `tls.conf` are copied to the server by hand.

## First install

1. Create `/opt/dictionary-hub` with the files above and `.env`; `docker compose up -d --wait db`.
2. As `supabase_admin`, set the passwords of `authenticator`, `supabase_auth_admin` and `postgres` to `POSTGRES_PASSWORD` and `app.settings.jwt_secret`.
3. `docker compose run --rm migrate`, then `docker compose up -d`.
4. Cron jobs stay off until the Vault secrets `jev_url` (`http://kong:8000/functions/v1/jev`) and `cron_secret` (`CRON_SECRET`) exist.
