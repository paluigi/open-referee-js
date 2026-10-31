import type { ChatMessage, LLMResponse, ModelSpec } from './base';
import { LLMError } from './base';
import { logRetry } from './retry';
import type { RateLimiter } from './rate_limit';

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  rateLimiter?: RateLimiter;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  /** Per-attempt timeout in seconds (AbortController); undefined = no timeout. */
  timeoutS?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface ChatCompletionsResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

const RETRY_BASE_DELAY_MS = 500;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function retryAfterMs(res: Response, now: () => number = Date.now): number | null {
  const v = res.headers.get('Retry-After');
  if (v === null || v.trim() === '') return null;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const date = new Date(v);
  if (!Number.isNaN(date.getTime())) return Math.max(0, date.getTime() - now());
  return null;
}

export class OpenAICompatibleProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly rateLimiter: RateLimiter | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor({
    baseUrl,
    apiKey,
    rateLimiter,
    fetchImpl,
    maxRetries = 3,
    timeoutS,
    sleep,
  }: OpenAICompatibleOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.rateLimiter = rateLimiter;
    this.fetchImpl = fetchImpl ?? ((...args) => fetch(...args));
    this.maxRetries = Math.max(0, Math.floor(maxRetries));
    this.timeoutMs =
      timeoutS !== undefined && timeoutS > 0 ? timeoutS * 1000 : undefined;
    this.sleep = sleep ?? defaultSleep;
  }

  private readonly timeoutMs: number | undefined;

  async complete(messages: ChatMessage[], spec: ModelSpec): Promise<LLMResponse> {
    await this.rateLimiter?.gate(this.baseUrl);
    const body: Record<string, unknown> = {
      model: spec.model,
      messages,
      temperature: spec.temperature,
      max_tokens: spec.callMaxTokens ?? spec.maxTokens,
    };
    if (spec.reasoningEffort) body.reasoning_effort = spec.reasoningEffort;
    const bodyJson = JSON.stringify(body);
    const init: RequestInit = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: bodyJson,
    };

    let lastError: LLMError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Per-attempt timeout: a hung endpoint aborts like a network error and
      // is retried like one.
      const controller = new AbortController();
      const timer =
        this.timeoutMs !== undefined
          ? setTimeout(() => controller.abort(), this.timeoutMs)
          : undefined;
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          ...init,
          signal: controller.signal,
        });
      } catch (err) {
        lastError = new LLMError(
          `network error: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (attempt < this.maxRetries) {
          const backoffMs = RETRY_BASE_DELAY_MS * 2 ** attempt;
          logRetry({
            model: spec.model,
            attempt: attempt + 1,
            error: `LLMError: ${lastError.message.slice(0, 120)}`,
            backoffMs,
          });
          await this.sleep(backoffMs);
          continue;
        }
        throw lastError;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }

      if (res.status === 429 || res.status >= 500) {
        lastError = new LLMError(
          `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
          res.status,
        );
        if (attempt < this.maxRetries) {
          const raMs = retryAfterMs(res);
          const backoffMs = raMs ?? RETRY_BASE_DELAY_MS * 2 ** attempt;
          // 814c895: log every retry with model, attempt, error and backoff.
          logRetry({
            model: `${spec.model}`,
            attempt: attempt + 1,
            error: `LLMError: ${lastError.message.slice(0, 120)}`,
            backoffMs,
          });
          await this.sleep(backoffMs);
          continue;
        }
        throw lastError;
      }

      if (!res.ok) {
        throw new LLMError(
          `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
          res.status,
        );
      }

      let parsed: ChatCompletionsResponse;
      try {
        parsed = (await res.json()) as ChatCompletionsResponse;
      } catch {
        throw new LLMError('malformed JSON response from provider');
      }
      const content = parsed.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new LLMError('malformed response: missing choices[0].message.content');
      }
      return {
        content,
        usage: {
          promptTokens: parsed.usage?.prompt_tokens ?? 0,
          completionTokens: parsed.usage?.completion_tokens ?? 0,
        },
        model: parsed.model ?? spec.model,
      };
    }
    throw lastError ?? new LLMError('request failed');
  }

  close(): void {}
}
