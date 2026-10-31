import type { ChatProvider } from './base';
import { LLMError } from './base';
import type { ProviderType } from '../config/schema';
import { AnthropicProvider } from './anthropic';
import { DecisionsClient } from './decisions';
import { FakeProvider } from './fake';
import { GeminiProvider } from './gemini';
import { OllamaProvider, DEFAULT_OLLAMA_BASE_URL } from './ollama';
import { OpenAICompatibleProvider } from './openai';
import type { RateLimiter } from './rate_limit';

export interface CreateProviderOptions {
  providerType: ProviderType;
  baseUrl?: string;
  apiKey?: string;
  rateLimiter?: RateLimiter;
  requestTimeoutS?: number;
  maxRetries?: number;
  /**
   * 7d review (C1): role-config capability flag — does this endpoint host
   * reasoning models? Stamped onto the constructed provider so the
   * orchestrator's two-phase escalation ladder (gated on
   * provider.supportsReasoning) becomes reachable from config. Default
   * false = today's behavior.
   */
  supportsReasoning?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Build a DecisionsClient from a resolved ProviderConfig of type 'decision'
 * (Stage 7e; Python build_decision_provider). The decision role MUST bind to
 * a 'decision'-typed provider with a base URL — the /v1/decisions contract is
 * not served by chat endpoints.
 */
export function createDecisionProvider({
  baseUrl,
  apiKey,
  rateLimiter,
  requestTimeoutS,
  maxRetries,
  fetchImpl,
  sleep,
}: Omit<CreateProviderOptions, 'providerType'>): DecisionsClient {
  if (!baseUrl) {
    throw new LLMError('Decision provider needs a base_url');
  }
  return new DecisionsClient({
    providerName: 'decision',
    model: '',
    baseUrl,
    apiKey,
    rateLimiter,
    fetchImpl,
    timeoutS: requestTimeoutS,
    maxRetries,
    sleep,
  });
}

/**
 * Build a chat provider from a resolved ProviderConfig.
 *
 * The rate limiter is shared across adapters and keyed per adapter
 * (Anthropic/Gemini: endpoint constant; OpenAI-compatible: baseUrl; Ollama:
 * baseUrl), so roles hitting the same endpoint share one delay budget.
 */
export function createProvider({
  providerType,
  baseUrl,
  apiKey,
  rateLimiter,
  requestTimeoutS,
  maxRetries,
  supportsReasoning,
  fetchImpl,
  sleep,
}: CreateProviderOptions): ChatProvider {
  const provider = createProviderInner({
    providerType,
    baseUrl,
    apiKey,
    rateLimiter,
    requestTimeoutS,
    maxRetries,
    fetchImpl,
    sleep,
  });
  // 7d review (C1): stamp the role-config capability flag onto the instance
  // (adapters are plain classes — the flag rides the ReasoningCapable
  // contract; default undefined = single-call path everywhere).
  if (supportsReasoning !== undefined) {
    (provider as { supportsReasoning?: boolean }).supportsReasoning = supportsReasoning;
  }
  return provider;
}

function createProviderInner({
  providerType,
  baseUrl,
  apiKey,
  rateLimiter,
  requestTimeoutS,
  maxRetries,
  fetchImpl,
  sleep,
}: CreateProviderOptions): ChatProvider {
  switch (providerType) {
    case 'openai_compatible':
    case 'vllm': {
      if (!baseUrl) {
        throw new LLMError('Provider needs a base_url');
      }
      return new OpenAICompatibleProvider({
        baseUrl,
        apiKey: apiKey ?? '',
        rateLimiter,
        fetchImpl,
        maxRetries,
        timeoutS: requestTimeoutS,
        sleep,
      });
    }
    case 'anthropic': {
      if (!apiKey) {
        throw new LLMError('Provider has no API key resolved');
      }
      return new AnthropicProvider({
        apiKey,
        rateLimiter,
        fetchImpl,
        maxRetries,
        timeoutS: requestTimeoutS,
        sleep,
      });
    }
    case 'gemini': {
      if (!apiKey) {
        throw new LLMError('Provider has no API key resolved');
      }
      return new GeminiProvider({
        apiKey,
        rateLimiter,
        fetchImpl,
        maxRetries,
        timeoutS: requestTimeoutS,
        sleep,
      });
    }
    case 'ollama':
      return new OllamaProvider({
        baseUrl: baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
        rateLimiter,
        fetchImpl,
        maxRetries,
        timeoutS: requestTimeoutS,
        sleep,
      });
    case 'fake':
      return new FakeProvider();
    case 'decision': {
      // A 'decision' provider cannot fill a chat role: the /v1/decisions API
      // answers typed questions, not free text (Python build_provider raises).
      throw new LLMError(
        "Provider type 'decision' cannot fill chat roles — bind it to the optional decision role instead",
      );
    }
    default: {
      throw new LLMError(`Unknown provider type: ${providerType as string}`);
    }
  }
}

/** Close a name -> provider map; the settings UI loops over this helper. */
export function closeProviders(providers: Record<string, ChatProvider>): void {
  for (const p of Object.values(providers)) {
    p.close();
  }
}
