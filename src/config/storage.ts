import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type ReviewDepth,
  type RoleConfig,
} from './schema';

const STORAGE_KEY = 'openreferee.settings.v1';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function mergeProviderConfig(
  raw: unknown,
): Record<string, AppSettings['providers'][string]> {
  if (!isRecord(raw)) return {};
  const out: Record<string, AppSettings['providers'][string]> = {};
  const validTypes: readonly string[] = [
    'openai_compatible',
    'anthropic',
    'gemini',
    'ollama',
    'vllm',
    'fake',
  ];
  for (const [name, cfg] of Object.entries(raw)) {
    if (!isRecord(cfg) || typeof cfg['type'] !== 'string') continue;
    if (!validTypes.includes(cfg['type'])) continue;
    out[name] = {
      type: cfg['type'] as AppSettings['providers'][string]['type'],
      ...(typeof cfg['baseUrl'] === 'string' ? { baseUrl: cfg['baseUrl'] } : {}),
      ...(typeof cfg['apiKey'] === 'string' ? { apiKey: cfg['apiKey'] } : {}),
    };
  }
  return out;
}

function mergePricing(raw: unknown): AppSettings['pricing'] {
  if (!isRecord(raw)) return {};
  const out: AppSettings['pricing'] = {};
  for (const [model, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) continue;
    const input = entry['input'];
    const output = entry['output'];
    if (typeof input !== 'number' || typeof output !== 'number') continue;
    out[model] = { input, output };
  }
  return out;
}

function mergeRole(raw: unknown, fallback: RoleConfig): RoleConfig {
  if (!isRecord(raw)) return { ...fallback };
  const merged: RoleConfig = { ...fallback };
  if (typeof raw['provider'] === 'string') merged.provider = raw['provider'];
  if (typeof raw['model'] === 'string') merged.model = raw['model'];
  if (typeof raw['temperature'] === 'number') merged.temperature = raw['temperature'];
  if (typeof raw['maxTokens'] === 'number') merged.maxTokens = raw['maxTokens'];
  return merged;
}

/**
 * Pure deep-merge of a raw parsed value over DEFAULT_SETTINGS: missing or
 * wrong-typed fields fall back to defaults; unknown keys are dropped.
 */
export function mergeSettings(raw: unknown): AppSettings {
  if (!isRecord(raw)) return structuredClone(DEFAULT_SETTINGS);
  const d = DEFAULT_SETTINGS;
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;

  const rolesRaw = isRecord(raw['roles']) ? raw['roles'] : {};
  return {
    version: 1,
    providers: mergeProviderConfig(raw['providers']),
    roles: {
      strong: mergeRole(rolesRaw['strong'], d.roles.strong),
      small: mergeRole(rolesRaw['small'], d.roles.small),
      vision: mergeRole(rolesRaw['vision'], d.roles.vision),
    },
    pricing: mergePricing(raw['pricing']),
    requestTimeoutS: num(raw['requestTimeoutS'], d.requestTimeoutS),
    maxRetries: num(raw['maxRetries'], d.maxRetries),
    minDelayS: num(raw['minDelayS'], d.minDelayS),
    maxCostUsd: num(raw['maxCostUsd'], d.maxCostUsd),
    searchOrder:
      Array.isArray(raw['searchOrder']) &&
      raw['searchOrder'].every((s) => typeof s === 'string')
        ? (raw['searchOrder'] as string[])
        : [...d.searchOrder],
    review: mergeReview(raw['review']),
  };
}

/** Depth knobs: round-trip only known, type-correct fields (Stage 4). */
function mergeReview(raw: unknown): ReviewDepth | undefined {
  if (!isRecord(raw)) return undefined;
  const out: ReviewDepth = {};
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const bool = (v: unknown): boolean | undefined =>
    typeof v === 'boolean' ? v : undefined;
  out.maxClaims = num(raw['maxClaims']);
  out.maxArtifacts = num(raw['maxArtifacts']);
  out.maxParallelCalls = num(raw['maxParallelCalls']);
  out.perSectionLenses = bool(raw['perSectionLenses']);
  out.wholePaperPasses = bool(raw['wholePaperPasses']);
  out.defenseRound = bool(raw['defenseRound']);
  return out;
}

/** API keys never reach localStorage — they live in the Stage 2 vault. */
function stripApiKeys(settings: AppSettings): AppSettings {
  const providers: AppSettings['providers'] = {};
  for (const [name, cfg] of Object.entries(settings.providers)) {
    providers[name] = { type: cfg.type, baseUrl: cfg.baseUrl };
  }
  return { ...settings, providers };
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stripApiKeys(settings)));
}

export function loadSettings(): AppSettings {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return structuredClone(DEFAULT_SETTINGS);
  try {
    return mergeSettings(JSON.parse(raw));
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}
