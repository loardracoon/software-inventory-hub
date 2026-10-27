# Phase 2: Sophos Central client and computer sync

From `docs/spec.md`, section "Prompts do cliente" ("Fase 2: cliente do Sophos e sincronismo dos computadores"). Plan first, implement, then verify with build and tests before the next phase.

Phase 2: Sophos Central client and computer sync.

Create supabase/functions/_shared/sophos.ts:
- getToken(): POST https://id.sophos.com/api/v2/oauth2/token, form body grant_type=client_credentials, client_id, client_secret, scope=token. Cache until 60 s before expiry.
- whoami(): GET https://api.central.sophos.com/whoami/v1. Returns id, idType (tenant | partner | organization) and apiHosts.dataRegion.
- listTenants(): tenant -> itself; partner -> GET https://api.central.sophos.com/partner/v1/tenants with X-Partner-ID, paginated; organization -> GET https://api.central.sophos.com/organization/v1/tenants with X-Organization-ID.
- listEndpoints(tenant): GET {dataRegion}/endpoint/v1/endpoints with X-Tenant-ID, following pages until the end.
- Retries: on 429 and 5xx, exponential backoff with jitter (1, 2, 4, 8 s, max 5 tries), honour Retry-After. Log each call to collector_logs without tokens.
Secrets: SOPHOS_CLIENT_ID, SOPHOS_CLIENT_SECRET.

Edge Function sync-computers: upserts tenants and computers. When an endpoint is missing from two consecutive syncs, set retired_at. Never delete rows.
Settings > Sophos connection: a card with "Test connection" (returns idType, region and tenant count, never secrets), the last sync time and the tenant list.
