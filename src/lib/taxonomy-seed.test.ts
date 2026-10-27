/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
type Row = { slug: string; level1: string; level2: string };

// Clients match categories by slug: the Hub's taxonomy and the client's cache seed must be the same file.
describe("taxonomy seed", () => {
  const hub = JSON.parse(read("../../docs/taxonomy.json")) as Row[];

  it("is the same taxonomy the Endpoint Inventory client seeds", () => {
    const client = JSON.parse(read("../../../client/docs/taxonomy.json")) as Row[];
    expect(hub.map((r) => r.slug)).toEqual(client.map((r) => r.slug));
  });

  it("is up to date in the migration (run scripts/generate-taxonomy-seed.mjs after changing the taxonomy)", () => {
    const seed = read("../../supabase/migrations/20261027110100_seed_taxonomy.sql");
    const level1 = new Set(hub.map((r) => r.slug.split("/")[0]));
    expect(level1.size).toBe(29);
    expect(hub).toHaveLength(71);
    for (const slug of [...level1, ...hub.map((r) => r.slug)]) expect(seed).toContain(`'${slug}'`);
  });
});
