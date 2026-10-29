import { describe, expect, it } from "vitest";
import { cvss3BaseScore, cvssSeverity, roundup } from "./cvss.ts";

describe("CVSS v3 base score", () => {
  // Reference scores as NVD and the FIRST calculator show them.
  it.each([
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 9.8],
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:H", 8.8],
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H", 10],
    ["CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N", 5.5],
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N", 6.1],
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N", 7.5],
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:L/A:N", 4.3],
    ["CVSS:3.0/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H", 8.1],
    ["CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H", 8.8],
    ["CVSS:3.1/AV:P/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N", 1.6],
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N", 0],
  ])("%s → %s", (vector, score) => {
    expect(cvss3BaseScore(vector)).toBe(score);
  });

  it("returns null for v4.0, v2 and broken vectors", () => {
    expect(cvss3BaseScore("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N")).toBeNull();
    expect(cvss3BaseScore("AV:N/AC:L/Au:N/C:P/I:P/A:P")).toBeNull();
    expect(cvss3BaseScore("CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBeNull();
    expect(cvss3BaseScore(null)).toBeNull();
  });

  it("rounds up to one decimal without floating point surprises", () => {
    expect(roundup(4.02)).toBe(4.1);
    expect(roundup(4.0)).toBe(4);
    expect(roundup(4.000000001)).toBe(4);
  });

  it("maps scores to the rating scale", () => {
    expect([0, 3.9, 4, 6.9, 7, 8.9, 9, 10, null].map(cvssSeverity)).toEqual(["NONE", "LOW", "MEDIUM", "MEDIUM", "HIGH", "HIGH", "CRITICAL", "CRITICAL", null]);
  });
});
