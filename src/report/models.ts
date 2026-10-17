/**
 * Report models: the assembled referee report.
 *
 * Port of Python `open_referee/report/models.py`, narrowed to Stage 1
 * (no block anchors / categories on comments; markdown overall text).
 */

/** One grounded criticism. severity: 0.0 (polish) .. 1.0 (result-invalidating). */
export interface ReviewComment {
  id?: string;
  section: string;
  /** exact manuscript span the comment attaches to */
  quote: string;
  comment: string;
  severity: number;
  /** verbatim anchor sentence (Stage-4 claim/defense provenance) */
  paragraphAnchor?: string;
  /** claim id from the inventory, when the comment came from a claim worker */
  claimId?: string;
  /** artifact id, when the comment came from artifact verification */
  artifactId?: string;
  /** math|consistency|evidence|references|clarity|novelty|statistical|other */
  category?: string;
}

export interface UsageSummary {
  /** role -> { calls, costUsd, tokens } */
  byRole: Record<
    string,
    {
      calls: number;
      costUsd: number;
      tokens: { promptTokens: number; completionTokens: number };
    }
  >;
  estimatedCostUsd: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
}

export interface ReviewReport {
  paperTitle: string;
  /** accept | minor revision | major revision | reject, when stated */
  recommendation?: string;
  /** meta-review markdown (the report body) */
  overall: string;
  comments: ReviewComment[];
  usage: UsageSummary;
  /** true when the pipeline stopped early (failed stage / budget cap) */
  partial: boolean;
  generatedAt: string;
}

/** Comments sorted by severity, highest first. */
export function sortedComments(report: ReviewReport): ReviewComment[] {
  return [...report.comments].sort((a, b) => b.severity - a.severity);
}
