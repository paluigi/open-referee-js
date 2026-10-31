import type { ChatMessage, LLMResponse, ModelSpec } from './base';
import { LLMError } from './base';
import type { RateLimiter } from './rate_limit';

export interface GeminiProviderOptions {
  rateLimiter?: RateLimiter;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  /** Per-attempt timeout in seconds (AbortController); undefined = no timeout. */
  timeoutS?: number;
  sleep?: (ms: number) => Promise<void>;
  apiKey: string;
}

interface GenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  modelVersion?: string;
}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

import { defaultSleep, retryFetch, type RetryFetchArgs } from './retry';

export class GeminiProvider {
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
  }: GeminiProviderOptions) {
    this.apiKey = apiKey;
    this.rateLimiter = rateLimiter;
    this.fetchImpl = fetchImpl ?? ((...args) => fetch(...args));
    this.maxRetries = Math.max(0, Math.floor(maxRetries));
    this.timeoutMs =
      timeoutS !== undefined && timeoutS > 0 ? timeoutS * 1000 : undefined;
    this.sleep = sleep ?? defaultSleep;
  }

  async complete(messages: ChatMessage[], spec: ModelSpec): Promise<LLMResponse> {
    await this.rateLimiter?.gate('gemini');
    const systemParts = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content);
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: spec.temperature,
        maxOutputTokens: spec.maxTokens,
      },
    };
    if (systemParts.length > 0) {
      body.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
    }

    const init: RequestInit = {
      method: 'POST',
      headers: {
        // Owner decision: the API key rides in the 'x-goog-api-key' header
        // instead of a ?key= query parameter so keys never appear in URLs
        // (proxy logs, browser history).
        'x-goog-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    };

    const url = `${GEMINI_BASE}/${spec.model}:generateContent`;

    const retryArgs: RetryFetchArgs = {
      fetchImpl: this.fetchImpl,
      url,
      init,
      maxRetries: this.maxRetries,
      timeoutMs: this.timeoutMs,
      sleep: this.sleep,
      label: 'gemini',
    };

    const res = await retryFetch(retryArgs);

    let parsed: GenerateContentResponse;
    try {
      parsed = (await res.json()) as GenerateContentResponse;
    } catch {
      throw new LLMError('malformed response from provider');
    }
    const cand = parsed.candidates?.[0]?.content?.parts;
    if (!Array.isArray(cand)) {
      throw new LLMError(
        'Malformed Gemini response: missing candidates[0].content.parts',
      );
    }
    const text = cand.map((p) => p.text ?? '').join('');
    return {
      content: text,
      usage: {
        promptTokens: parsed.usageMetadata?.promptTokenCount ?? 0,
        completionTokens: parsed.usageMetadata?.candidatesTokenCount ?? 0,
      },
      model: parsed.modelVersion ?? spec.model,
    };
  }

  close(): void {}
}
