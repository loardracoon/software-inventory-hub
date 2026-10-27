import { describe, expect, it } from "vitest";
import { parseRequestIds, sha256Hex, validateRequest, validateTitles } from "./validate.ts";

const title = { kind: "program", source: "programs", match_key: "anydesk|anydesk", name: "AnyDesk", vendor: "AnyDesk", description: null };

describe("validateTitles", () => {
  it("accepts up to 500 titles with the six metadata fields", () => {
    const r = validateTitles({ titles: Array.from({ length: 500 }, () => title) });
    expect(r.ok && r.value).toHaveLength(500);
  });

  it("rejects any field that is not title metadata", () => {
    const r = validateTitles({ titles: [{ ...title, hostname: "W1", username: "alice" }] });
    expect(r).toEqual({ ok: false, error: "titles[0]: fields not allowed: hostname, username" });
    expect(validateTitles({ titles: [title], tenant: "Acme" })).toEqual({ ok: false, error: "body: fields not allowed: tenant" });
  });

  it("enforces counts, kinds and lengths", () => {
    expect(validateTitles({ titles: Array.from({ length: 501 }, () => title) }).ok).toBe(false);
    expect(validateTitles({ titles: [] }).ok).toBe(false);
    expect(validateTitles({ titles: [{ ...title, kind: "driver" }] })).toMatchObject({ ok: false, error: expect.stringContaining("kind must be one of") });
    expect(validateTitles({ titles: [{ ...title, description: "x".repeat(1001) }] })).toMatchObject({ ok: false, error: "titles[0]: description is longer than 1000 characters" });
    expect(validateTitles({ titles: [{ ...title, name: "  " }] })).toMatchObject({ ok: false, error: "titles[0]: name is required" });
  });
});

describe("validateRequest", () => {
  const request = { kind: "program", source: "programs", match_key: "anydesk|anydesk", suggested_category_id: null, reason: " Remote tool ", evidence_url: null };

  it("accepts a request, Other as null, and trims the reason", () => {
    expect(validateRequest(request)).toEqual({ ok: true, value: { ...request, reason: "Remote tool" } });
  });

  it("rejects bad categories, empty or long reasons, non-http evidence and extra fields", () => {
    expect(validateRequest({ ...request, suggested_category_id: "remote-access" }).ok).toBe(false);
    expect(validateRequest({ ...request, reason: "" }).ok).toBe(false);
    expect(validateRequest({ ...request, reason: "x".repeat(501) }).ok).toBe(false);
    expect(validateRequest({ ...request, evidence_url: "javascript:alert(1)" }).ok).toBe(false);
    expect(validateRequest({ ...request, hostname: "W1" }).ok).toBe(false);
  });
});

describe("parseRequestIds and sha256Hex", () => {
  it("parses up to 100 REQ ids", () => {
    expect(parseRequestIds("REQ-0042, REQ-0043")).toEqual({ ok: true, value: ["REQ-0042", "REQ-0043"] });
    expect(parseRequestIds("1;drop table").ok).toBe(false);
    expect(parseRequestIds(null).ok).toBe(false);
  });

  it("hashes like Postgres sha256()", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
