// Validation of what clients send (they are untrusted). Runtime-neutral (Deno and Node) so Vitest can
// test it. Any field outside the contract is rejected, so nothing but title metadata can arrive.

export const KINDS = ["program", "extension", "ide_extension", "package"] as const;
export const MAX_TITLES = 500;
export const TITLE_FIELDS = ["kind", "source", "match_key", "name", "vendor", "description"] as const;
const REQUEST_FIELDS = ["kind", "source", "match_key", "suggested_category_id", "reason", "evidence_url"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Title = { kind: string; source: string; match_key: string; name: string; vendor: string | null; description: string | null };
export type RequestInput = {
  kind: string;
  source: string;
  match_key: string;
  suggested_category_id: string | null;
  reason: string;
  evidence_url: string | null;
};
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function text(v: unknown, field: string, max: number, required: boolean): string | null {
  if (v === undefined || v === null || v === "") {
    if (required) throw new Error(`${field} is required`);
    return null;
  }
  if (typeof v !== "string") throw new Error(`${field} must be a string`);
  if (v.length > max) throw new Error(`${field} is longer than ${max} characters`);
  if (required && !v.trim()) throw new Error(`${field} is required`);
  return v;
}

function onlyFields(o: Record<string, unknown>, allowed: readonly string[], where: string) {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`${where}: fields not allowed: ${extra.join(", ")}`);
}

function kind(v: unknown): string {
  if (!KINDS.includes(v as (typeof KINDS)[number])) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
  return v as string;
}

export function validateTitles(body: unknown): Result<Title[]> {
  try {
    if (!isObject(body)) throw new Error("Body must be a JSON object");
    onlyFields(body, ["titles"], "body");
    const titles = body.titles;
    if (!Array.isArray(titles) || titles.length === 0 || titles.length > MAX_TITLES) throw new Error(`titles must be an array of 1 to ${MAX_TITLES}`);
    return {
      ok: true,
      value: titles.map((t, i) => {
        if (!isObject(t)) throw new Error(`titles[${i}] must be an object`);
        onlyFields(t, TITLE_FIELDS, `titles[${i}]`);
        try {
          return {
            kind: kind(t.kind),
            source: text(t.source, "source", 60, true)!,
            match_key: text(t.match_key, "match_key", 500, true)!,
            name: text(t.name, "name", 300, true)!,
            vendor: text(t.vendor, "vendor", 300, false),
            description: text(t.description, "description", 1000, false),
          };
        } catch (e) {
          throw new Error(`titles[${i}]: ${(e as Error).message}`);
        }
      }),
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function validateRequest(body: unknown): Result<RequestInput> {
  try {
    if (!isObject(body)) throw new Error("Body must be a JSON object");
    onlyFields(body, REQUEST_FIELDS, "body");
    const suggested = body.suggested_category_id ?? null;
    if (suggested !== null && (typeof suggested !== "string" || !UUID.test(suggested))) throw new Error("suggested_category_id must be a category id or null");
    const reason = text(body.reason, "reason", 500, true)!.trim();
    const evidence = text(body.evidence_url, "evidence_url", 500, false);
    if (evidence !== null && !/^https?:\/\/\S+$/i.test(evidence.trim())) throw new Error("evidence_url must be an http(s) link");
    return {
      ok: true,
      value: {
        kind: kind(body.kind),
        source: text(body.source, "source", 60, true)!,
        match_key: text(body.match_key, "match_key", 500, true)!,
        suggested_category_id: suggested as string | null,
        reason,
        evidence_url: evidence?.trim() ?? null,
      },
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ?ids=REQ-0042,REQ-0043 → at most 100 well-formed ids.
export function parseRequestIds(param: string | null): Result<string[]> {
  const ids = (param ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0 || ids.length > 100) return { ok: false, error: "ids must list 1 to 100 request ids" };
  if (ids.some((id) => !/^REQ-\d{4,}$/.test(id))) return { ok: false, error: "ids must look like REQ-0042" };
  return { ok: true, value: ids };
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
