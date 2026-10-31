import type { ChatMessage, LLMResponse, ModelSpec } from './base';
import { LLMError } from './base';
import type { RateLimiter } from './rate_limit';

export interface OllamaProviderOptions {
  baseUrl?: string;
  rateLimiter?: RateLimiter;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  /** Per-attempt timeout in seconds (AbortController); undefined = no timeout. */
  timeoutS?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface ChatChunk {
  message?: { content?: string };
  model?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';

import { defaultSleep, retryFetch, type RetryFetchArgs } from './retry';

/** Native Ollama /api/chat adapter (local, no auth header). */
export class OllamaProvider {
  private readonly baseUrl: string;
  private readonly rateLimiter: RateLimiter | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly timeoutMs: number | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor({
    baseUrl,
    rateLimiter,
    fetchImpl,
    maxRetries = 3,
    timeoutS,
    sleep,
  }: OllamaProviderOptions) {
    this.baseUrl = (baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');
    this.rateLimiter = rateLimiter;
    this.fetchImpl = fetchImpl ?? ((...args) => fetch(...args));
    this.maxRetries = Math.max(0, Math.floor(maxRetries));
    this.timeoutMs =
      timeoutS !== undefined && timeoutS > 0 ? timeoutS * 1000 : undefined;
    this.sleep = sleep ?? defaultSleep;
  }

  async complete(messages: ChatMessage[], spec: ModelSpec): Promise<LLMResponse> {
    // Different local endpoints are independent — key the limiter on the
    // baseUrl so two Ollama hosts don't share a delay budget.
    await this.rateLimiter?.gate(this.baseUrl);
    const body = JSON.stringify({
      model: spec.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
      options: {
        temperature: spec.temperature,
        num_predict: spec.maxTokens,
      },
    });
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    };

    const retryArgs: RetryFetchArgs = {
      fetchImpl: this.fetchImpl,
      url: `${this.baseUrl}/api/chat`,
      init,
      maxRetries: this.maxRetries,
      timeoutMs: this.timeoutMs,
      sleep: this.sleep,
      label: 'ollama',
    };

    const res = await retryFetch(retryArgs);

    let parsed: ChatChunk;
    try {
      parsed = (await res.json()) as ChatChunk;
    } catch {
      throw new LLMError('malformed response from provider');
    }
    const content = parsed.message?.content;
    if (typeof content !== 'string') {
      throw new LLMError('malformed response: missing message.content');
    }
    return {
      content,
      usage: {
        promptTokens: parsed.prompt_eval_count ?? 0,
        completionTokens: parsed.eval_count ?? 0,
      },
      model: parsed.model ?? spec.model,
    };
  }

  close(): void {}
}
