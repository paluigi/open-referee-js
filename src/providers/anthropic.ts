import type { ChatMessage, LLMResponse, ModelSpec } from './base';
import { LLMError } from './base';
import type { RateLimiter } from './rate_limit';

export interface AnthropicProviderOptions {
  apiKey: string;
  rateLimiter?: RateLimiter;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  /** Per-attempt timeout in seconds (AbortController); undefined = no timeout. */
  timeoutS?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface MessagesResponse {
  content?: { text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string;
}

// Single upstream endpoint — the rate limiter is keyed on this constant so
// every Anthropic call shares one delay budget.
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

import { defaultSleep, retryFetch, type RetryFetchArgs } from './retry';

export class AnthropicProvider {
  private readonly apiKey: string;
  private readonly rateLimiter: RateLimiter | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly timeoutMs: number | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor({
    apiKey,
    rateLimiter,
    fetchImpl,
    maxRetries = 3,
    timeoutS,
    sleep,
  }: AnthropicProviderOptions) {
    this.apiKey = apiKey;
    this.rateLimiter = rateLimiter;
    this.fetchImpl = fetchImpl ?? ((...args) => fetch(...args));
    this.maxRetries = Math.max(0, Math.floor(maxRetries));
    this.timeoutMs =
      timeoutS !== undefined && timeoutS > 0 ? timeoutS * 1000 : undefined;
    this.sleep = sleep ?? defaultSleep;
  }

  async complete(messages: ChatMessage[], spec: ModelSpec): Promise<LLMResponse> {
    await this.rateLimiter?.gate('anthropic');
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const turns = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));
    const body: Record<string, unknown> = {
      model: spec.model,
      max_tokens: spec.maxTokens,
      temperature: spec.temperature,
      messages: turns,
    };
    if (system !== '') body.system = system;
    // No JSON mode in Stage 2; the Python adapter's assistant "{" prefill
    // would slot in here when JSON mode lands.

    const init: RequestInit = {
      method: 'POST',
      headers: {
        // Owner decision: 'anthropic-dangerous-direct-browser-access' is
        // required for CORS when calling the Anthropic API directly from a
        // browser (https://docs.anthropic.com/en/api/client-sdks#direct-browser-access).
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    };

    const retryArgs: RetryFetchArgs = {
      fetchImpl: this.fetchImpl,
      url: ANTHROPIC_URL,
      init,
      maxRetries: this.maxRetries,
      timeoutMs: this.timeoutMs,
      sleep: this.sleep,
      label: 'anthropic',
    };

    const res = await retryFetch(retryArgs);

    let parsed: MessagesResponse;
    try {
      parsed = (await res.json()) as MessagesResponse;
    } catch {
      throw new LLMError('malformed response from provider');
    }
    if (!Array.isArray(parsed.content)) {
      throw new LLMError('malformed response: missing content field');
    }
    const text = parsed.content.map((b) => b.text ?? '').join('');
    return {
      content: text,
      usage: {
        promptTokens: parsed.usage?.input_tokens ?? 0,
        completionTokens: parsed.usage?.output_tokens ?? 0,
      },
      model: parsed.model ?? spec.model,
    };
  }

  close(): void {}
}
