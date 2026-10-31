export type ProviderType =
  | 'openai_compatible'
  | 'anthropic'
  | 'gemini'
  | 'ollama'
  | 'vllm'
  | 'fake'
  | 'decision';

export interface ProviderConfig {
  type: ProviderType;
  baseUrl?: string;
  apiKey?: string;
}

export interface RoleConfig {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * 7d review (C1): does this role's endpoint host reasoning models whose
   * thinking can exhaust the output budget before any JSON is emitted?
   * Universal merge rule: non-boolean values are dropped. Default false =
   * the single-call path (no two-phase escalation ladder).
   */
  supportsReasoning?: boolean;
}

/** Depth-preset knobs (Python DepthPreset, 'standard' defaults). */
export interface ReviewDepth {
  maxClaims?: number;
  perSectionLenses?: boolean;
  wholePaperPasses?: boolean;
  defenseRound?: boolean;
  maxArtifacts?: number;
  maxParallelCalls?: number;
  /**
   * 7c budget-tier knobs (Python PlanKnobs; user overrides win over the
   * tier preset — Python DepthPreset fields). Absent = tier default.
   */
  recompute?: boolean;
  verifyPasses?: number;
  /** base | strong | all_strong (Python claim_routing) */
  claimRouting?: string;
  /** low | default | high (Python output_budget) */
  outputBudget?: string;
  synthesis?: boolean;
  copyedit?: boolean;
  defenseSecondRound?: boolean;
}

/**
 * Budget tier block (Stage 7c; Python ReviewConfig.depth + budget_usd).
 * `depth` selects the tier preset; 'auto' switches the run to the
 * budget-driven planner. `budgetUsd` is the hard plan ceiling in USD
 * (falls back to the UsageLedger cap `maxCostUsd`).
 */
export interface BudgetSettings {
  /** fast | standard | deep | auto */
  depth?: string;
  /** hard budget ceiling in USD */
  budgetUsd?: number;
}

export interface AppSettings {
  version: 1;
  providers: Record<string, ProviderConfig>;
  /** role name -> RoleConfig */
  roles: { strong: RoleConfig; small: RoleConfig; vision: RoleConfig };
  /**
   * Optional decision-model role (Stage 7e; Python ModelRole.DECISION).
   * Absent = the DM layer is fully dormant and every pipeline stage uses
   * its labelled-LLM fallback with byte-identical call sequences (eaa1a85).
   * Must bind to a provider of type 'decision' (/v1/decisions API).
   */
  decisionRole?: RoleConfig;
  /** USD per 1M tokens */
  pricing: Record<string, { input: number; output: number }>;
  /** Per-attempt request timeout in seconds (AbortController in the adapter). */
  requestTimeoutS: number;
  maxRetries: number;
  /** min delay between LLM calls per provider, in seconds */
  minDelayS: number;
  /** UsageLedger cap */
  maxCostUsd: number;
  /** Search-engine failover order; consumed by the Stage-5 literature router. */
  searchOrder: string[];
  /**
   * Search-engine API keys (Stage 5). Session-only, same treatment as
   * provider apiKey pre-vault: mergeSettings round-trips them, saveSettings
   * strips them before localStorage.
   */
  searchApiKeys?: { tavily?: string; tinyfish?: string };
  /**
   * Depth preset (additive; consumers use ?? 'standard' defaults, so old
   * stored settings without this field stay valid — schema v stays 1).
   */
  review?: ReviewDepth;
  /**
   * Budget tier (Stage 7c, additive — Python review.depth + budget).
   * mergeSettings round-trips it (universal rule); absent = 'standard'.
   */
  budget?: BudgetSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  providers: {},
  roles: {
    strong: { provider: '', model: '' },
    small: { provider: '', model: '' },
    vision: { provider: '', model: '' },
  },
  pricing: {},
  requestTimeoutS: 300,
  maxRetries: 3,
  minDelayS: 0,
  maxCostUsd: 5,
  searchOrder: ['tavily', 'tinyfish'],
};
