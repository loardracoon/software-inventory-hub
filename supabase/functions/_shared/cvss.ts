// CVSS v3.0 / v3.1 base score from a vector (FIRST CVSS v3.1 specification, section 7). OSV gives advisories a
// vector but no score; NVD gives both. Runtime-neutral. v4.0 vectors need the specification's lookup tables
// and return null here (the advisory's own severity is kept).

const AV: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const AC: Record<string, number> = { L: 0.77, H: 0.44 };
const PR_UNCHANGED: Record<string, number> = { N: 0.85, L: 0.62, H: 0.27 };
const PR_CHANGED: Record<string, number> = { N: 0.85, L: 0.68, H: 0.5 };
const UI: Record<string, number> = { N: 0.85, R: 0.62 };
const CIA: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };

// The specification's Roundup: the smallest number with one decimal that is equal to or higher than the input,
// computed on integers so that floating point does not round 4.000000001 up to 4.1.
export function roundup(value: number): number {
  const n = Math.round(value * 100000);
  return n % 10000 === 0 ? n / 100000 : (Math.floor(n / 10000) + 1) / 10;
}

export function cvss3BaseScore(vector: string | null | undefined): number | null {
  const m = /^CVSS:3\.[01]\/(.+)$/.exec((vector ?? "").trim());
  if (!m) return null;
  const metrics = new Map(m[1].split("/").map((part) => part.split(":") as [string, string]));
  const s = metrics.get("S");
  const av = AV[metrics.get("AV") ?? ""];
  const ac = AC[metrics.get("AC") ?? ""];
  const pr = (s === "C" ? PR_CHANGED : PR_UNCHANGED)[metrics.get("PR") ?? ""];
  const ui = UI[metrics.get("UI") ?? ""];
  const [c, i, a] = ["C", "I", "A"].map((k) => CIA[metrics.get(k) ?? ""]);
  if ((s !== "U" && s !== "C") || [av, ac, pr, ui, c, i, a].some((x) => x === undefined)) return null;

  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = s === "U" ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15);
  const exploitability = 8.22 * av * ac * pr * ui;
  if (impact <= 0) return 0;
  return roundup(Math.min(s === "U" ? impact + exploitability : 1.08 * (impact + exploitability), 10));
}

// CVSS qualitative rating scale.
export function cvssSeverity(score: number | null): string | null {
  if (score === null) return null;
  if (score === 0) return "NONE";
  if (score < 4) return "LOW";
  if (score < 7) return "MEDIUM";
  if (score < 9) return "HIGH";
  return "CRITICAL";
}
