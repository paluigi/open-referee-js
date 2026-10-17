export type ProviderType =
  'openai_compatible' | 'anthropic' | 'gemini' | 'ollama' | 'vllm' | 'fake';

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
}

/** Depth-preset knobs (Python DepthPreset, 'standard' defaults). */
export interface ReviewDepth {
  maxClaims?: number;
  perSectionLenses?: boolean;
  wholePaperPasses?: boolean;
  defenseRound?: boolean;
  maxArtifacts?: number;
  maxParallelCalls?: number;
}

export interface AppSettings {
  version: 1;
  providers: Record<string, ProviderConfig>;
  /** role name -> RoleConfig */
  roles: { strong: RoleConfig; small: RoleConfig; vision: RoleConfig };
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
   * Depth preset (additive; consumers use ?? 'standard' defaults, so old
   * stored settings without this field stay valid — schema v stays 1).
   */
  review?: ReviewDepth;
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
