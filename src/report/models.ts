/**
 * Report models: the assembled referee report.
 *
 * Port of Python `open_referee/report/models.py`, narrowed to Stage 1
 * (no block anchors / categories on comments; markdown overall text).
 */

/** One grounded criticism. severity: 0.0 (polish) .. 1.0 (result-invalidating). */
export interface ReviewComment {
  id?: string;
  /** short imperative problem statement (Python ReviewComment.title) */
  title?: string;
  section: string;
  /** exact manuscript span the comment attaches to */
  quote: string;
  comment: string;
  severity: number;
  /** verbatim anchor sentence (Stage-4 claim/defense provenance) */
  paragraphAnchor?: string;
  /** resolved manuscript block id (Python `_resolve_anchor`, Stage 6) */
  blockId?: string;
  /** anchor resolution confidence: 1.0 exact | 0.7 multi-hit | 0.6 quote | Jaccard */
  anchorConfidence?: number;
  /** claim id from the inventory, when the comment came from a claim worker */
  claimId?: string;
  /** artifact id, when the comment came from artifact verification */
  artifactId?: string;
  /** math|consistency|evidence|references|clarity|novelty|statistical|other */
  category?: string;
  /**
   * How the comment was produced: 'deterministic' for code-verified findings
   * (doi-resolution; 7b adds the full checkers). Python models carry the
   * same optional field.
   */
  provenance?: string;
}

/** One language-mechanics fix from the copyedit stage (Python CopyeditItem). */
export interface CopyeditItem {
  /** verbatim manuscript span (verified to appear in the document) */
  quote: string;
  /** the corrected or reworked phrase */
  suggestion: string;
  /** typo | grammar | phrasing | terminology */
  kind: string;
  /** section title of the resolved block, when one exists */
  section?: string | null;
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
  /** Language-mechanics annex (copyedit stage); optional, additive. */
  copyeditItems?: CopyeditItem[];
  usage: UsageSummary;
  /** true when the pipeline stopped early (failed stage / budget cap) */
  partial: boolean;
  generatedAt: string;
}

/** Comments sorted by severity, highest first. */
export function sortedComments(report: ReviewReport): ReviewComment[] {
  return [...report.comments].sort((a, b) => b.severity - a.severity);
}
