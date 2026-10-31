import { describe, expect, it } from 'vitest';
import { LLMError } from '../src/providers/base';
import type { ModelSpec } from '../src/providers/base';
import { AnthropicProvider } from '../src/providers/anthropic';
import { setRetryLogger, type RetryLogEvent } from '../src/providers/retry';
import { RateLimiter } from '../src/providers/rate_limit';

const URL = 'https://api.anthropic.com/v1/messages';

function spec(): ModelSpec {
  return { provider: 'p1', model: 'claude-test', temperature: 0.3, maxTokens: 512 };
}

function jsonResponse(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function mockFetch(
  handler: (call: FetchCall, n: number) => Response | Promise<Response>,
) {
  const calls: FetchCall[] = [];
  const impl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { impl: impl as typeof fetch, calls };
}

function okResponse() {
  return jsonResponse(
    JSON.stringify({
      content: [
        { type: 'text', text: 'hello ' },
        { type: 'text', text: 'world' },
      ],
      usage: { input_tokens: 12, output_tokens: 4 },
      model: 'claude-test-actual',
    }),
  );
}

function provider(impl: typeof fetch, extra = {}) {
  return new AnthropicProvider({ apiKey: 'sk-ant-1', fetchImpl: impl, ...extra });
}

describe('AnthropicProvider', () => {
  it('sends the expected request shape', async () => {
    const { impl, calls } = mockFetch(() => okResponse());
    const p = provider(impl);
    const res = await p.complete(
      [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'system', content: 'also cite' },
        { role: 'user', content: 'more' },
      ],
      spec(),
    );
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe(URL);
    expect(calls[0]?.init.method).toBe('POST');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-1');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: 'claude-test',
      max_tokens: 512,
      temperature: 0.3,
      system: 'be terse\n\nalso cite',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'more' },
      ],
    });
    expect(res).toEqual({
      content: 'hello world',
      usage: { promptTokens: 12, completionTokens: 4 },
      model: 'claude-test-actual',
    });
  });

  it('omits the system field when there are no system messages', async () => {
    const { impl, calls } = mockFetch(() => okResponse());
    const p = provider(impl);
    await p.complete([{ role: 'user', content: 'q' }], spec());
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect('system' in body).toBe(false);
  });

  it('falls back to spec.model when the response has no model field', async () => {
    const { impl } = mockFetch(() =>
      jsonResponse(
        JSON.stringify({
          content: [{ type: 'text', text: 'x' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ),
    );
    const p = provider(impl);
    const res = await p.complete([{ role: 'user', content: 'q' }], spec());
    expect(res.model).toBe('claude-test');
  });

  it('defaults usage fields to 0 when absent', async () => {
    const { impl } = mockFetch(() =>
      jsonResponse(JSON.stringify({ content: [{ type: 'text', text: 'x' }] })),
    );
    const p = provider(impl);
    const res = await p.complete([{ role: 'user', content: 'q' }], spec());
    expect(res.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
  });

  it('retries on 429 honoring Retry-After, then succeeds', async () => {
    const sleeps: number[] = [];
    const { impl, calls } = mockFetch((_, n) =>
      n === 0
        ? jsonResponse('rate limited', 429, { 'Retry-After': '2' })
        : okResponse(),
    );
    const p = provider(impl, {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    const res = await p.complete([{ role: 'user', content: 'q' }], spec());
    expect(res.content).toBe('hello world');
    expect(calls.length).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  it('retries on network error', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const calls: FetchCall[] = [];
    const impl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init: init ?? {} });
      n += 1;
      if (n === 1) throw new TypeError('fetch failed');
      return okResponse();
    }) as typeof fetch;
    const p = provider(impl, {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    const res = await p.complete([{ role: 'user', content: 'q' }], spec());
    expect(res.content).toBe('hello world');
    expect(calls.length).toBe(2);
    expect(sleeps).toEqual([500]);
  });

  it('throws LLMError with status after exhausting retries on persistent 5xx', async () => {
    const sleeps: number[] = [];
    const { impl, calls } = mockFetch(() => jsonResponse('server on fire', 500));
    const p = provider(impl, {
      maxRetries: 2,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    const err = await p.complete([{ role: 'user', content: 'q' }], spec()).then(
      () => {
        throw new Error('expected LLMError');
      },
      (e: LLMError) => e,
    );
    expect(err).toBeInstanceOf(LLMError);
    expect(err.status).toBe(500);
    expect(calls.length).toBe(3); // initial + 2 retries
    expect(sleeps).toEqual([500, 1000]);
  });

  it('throws immediately (no retry) on non-retryable status', async () => {
    const { impl, calls } = mockFetch(() =>
      jsonResponse('{"error": "bad request"}', 400),
    );
    const p = provider(impl);
    await expect(p.complete([{ role: 'user', content: 'q' }], spec())).rejects.toThrow(
      /400.*bad request/s,
    );
    expect(calls.length).toBe(1);
  });

  it('throws LLMError on malformed JSON response', async () => {
    const { impl } = mockFetch(() => jsonResponse('this is not json {', 200));
    const p = provider(impl);
    await expect(p.complete([{ role: 'user', content: 'q' }], spec())).rejects.toThrow(
      LLMError,
    );
  });

  it('throws LLMError when the content field is missing', async () => {
    const { impl } = mockFetch(() => jsonResponse(JSON.stringify({ usage: {} })));
    const p = provider(impl);
    await expect(p.complete([{ role: 'user', content: 'q' }], spec())).rejects.toThrow(
      /missing content/,
    );
  });

  it('throws LLMError (not TypeError) when content is not an array', async () => {
    const { impl } = mockFetch(() =>
      jsonResponse(JSON.stringify({ content: 'oops', usage: {} })),
    );
    const p = provider(impl);
    await expect(p.complete([{ role: 'user', content: 'q' }], spec())).rejects.toThrow(
      LLMError,
    );
  });

  it('calls rateLimiter.gate with the anthropic key before fetch', async () => {
    const order: string[] = [];
    const { impl } = mockFetch(() => {
      order.push('fetch');
      return okResponse();
    });
    const limiter = new RateLimiter(0);
    limiter.gate = async (key: string) => {
      order.push(`gate:${key}`);
    };
    const p = provider(impl, { rateLimiter: limiter });
    await p.complete([{ role: 'user', content: 'q' }], spec());
    expect(order).toEqual(['gate:anthropic', 'fetch']);
  });

  it('close() is a no-op', () => {
    const p = provider(async () => jsonResponse('{}'));
    expect(() => p.close()).not.toThrow();
  });

  it('logs every retry with model, attempt, error and backoff (814c895)', async () => {
    const events: RetryLogEvent[] = [];
    setRetryLogger((e) => events.push({ ...e }));
    try {
      const { impl } = mockFetch((_, n) =>
        n < 2 ? jsonResponse('overloaded', 503) : okResponse(),
      );
      const p = provider(impl, {
        sleep: async () => undefined,
      });
      const res = await p.complete([{ role: 'user', content: 'q' }], spec());
      expect(res.content).toBe('hello world');
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        model: 'anthropic',
        attempt: 1,
        error: 'LLMError: HTTP 503: overloaded',
        backoffMs: 500,
      });
      expect(events[1]).toEqual({
        model: 'anthropic',
        attempt: 2,
        error: 'LLMError: HTTP 503: overloaded',
        backoffMs: 1000,
      });
    } finally {
      setRetryLogger(undefined);
    }
    // sink removed: no further collection, no crash
    setRetryLogger(() => {
      throw new Error('broken sink');
    });
    const { impl } = mockFetch((_, n) =>
      n < 1 ? jsonResponse('boom', 503) : okResponse(),
    );
    const p = provider(impl, { sleep: async () => undefined });
    const res = await p.complete([{ role: 'user', content: 'q' }], spec());
    expect(res.content).toBe('hello world');
    setRetryLogger(undefined);
  });
});
