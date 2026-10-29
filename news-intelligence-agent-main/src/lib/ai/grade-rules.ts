/**
 * Two-stage relevance grader (roadmap Phase 3, task #9) — PURE RULES ONLY.
 *
 * Borderline items (relevance in the "gray band") get ONE cheap second AI call
 * asking a single question: "is this REALLY relevant to the audience?". A
 * "no" verdict marks the item `grader_rejected` and the strict send rule drops
 * it — a gray score can never sneak through on importance alone.
 *
 * The actual AI call lives in `src/lib/ai/grader.ts`; this module keeps the
 * rules testable (Node test runner: no runtime imports allowed).
 */

export const GRADE_BORDERLINE_MIN = 55;
export const GRADE_BORDERLINE_MAX = 70;

export type GradeVerdict = "yes" | "no";

/** True when a relevance score sits in the gray band that needs a re-check. */
export function isBorderlineRelevance(score: number | null | undefined, rules?: { graderEnabled?: boolean; graderMin?: number; graderMax?: number }): boolean {
  if (rules?.graderEnabled === false) return false;
  if (typeof score !== "number" || !Number.isFinite(score)) return false;
  return score >= (rules?.graderMin ?? GRADE_BORDERLINE_MIN) && score <= (rules?.graderMax ?? GRADE_BORDERLINE_MAX);
}

/**
 * Parses the grader's free-text reply into a verdict. Looks for standalone
 * decisive tokens (yes/no, بله/خیر) — the first one wins. Returns null when
 * the reply is unparseable (treated as "keep the original scores").
 */
export function parseGradeVerdict(text: string): GradeVerdict | null {
  const clean = (text ?? "").trim().toLowerCase();
  if (!clean) return null;

  const yesMatch = /(^|[^\p{L}])(yes|بله|آری)([^\p{L}]|$)/iu.exec(clean);
  const noMatch = /(^|[^\p{L}])(no|خیر|نه)([^\p{L}]|$)/iu.exec(clean);

  if (yesMatch && noMatch) return yesMatch.index < noMatch.index ? "yes" : "no";
  if (yesMatch) return "yes";
  if (noMatch) return "no";
  return null;
}
