import { LLMError } from './base';

/**
 * Shared retry plumbing for the HTTP provider adapters. The retry semantics
 * are a contract (identical across openai/anthropic/gemini/ollama): retry on
 * 429/5xx/network errors with 500ms·2^n exponential backoff, honoring a
 * `Retry-After` header (seconds or HTTP-date) on 429/5xx; other statuses
 * fail immediately with LLMError(.status).
 */

export const RETRY_BASE_DELAY_MS = 500;

/**
 * Retry-event sink (Python 814c895: logger.warning per retry with model,
 * attempt, error and backoff). The browser build has no logging framework:
 * the hook is collectible — the UI/tests install a sink, silence is the
 * default. Never console.log (the app's own rule).
 */
export interface RetryLogEvent {
  /** provider/model making the call */
  model: string;
  /** 1-based failing attempt number */
  attempt: number;
  /** error type + truncated message */
  error: string;
  /** backoff before the next attempt, ms */
  backoffMs: number;
}

type RetrySink = (e: RetryLogEvent) => void;

let retrySink: RetrySink | undefined;

/** Install (or remove with undefined) the retry-log sink. */
export function setRetryLogger(sink: RetrySink | undefined): void {
  retrySink = sink;
}

/** Internal: emit one retry event (no-op without a sink). */
export function logRetry(event: RetryLogEvent): void {
  try {
    retrySink?.(event);
  } catch {
    // a broken sink must never break the retry loop
  }
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function retryAfterMs(
  res: Response,
  now: () => number = Date.now,
): number | null {
  const v = res.headers.get('Retry-After');
  if (v === null || v.trim() === '') return null;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const date = new Date(v);
  if (!Number.isNaN(date.getTime())) return Math.max(0, date.getTime() - now());
  return null;
}

export interface RetryFetchArgs {
  fetchImpl: typeof fetch;
  url: string;
  init: RequestInit;
  maxRetries: number;
  /** Per-attempt timeout in ms; undefined = no timeout. */
  timeoutMs: number | undefined;
  sleep: (ms: number) => Promise<void>;
  /** Provider/model label for retry-log events (Python spec.provider_name/spec.model). */
  label?: string;
}

/**
 * One retried fetch + terminal-status classification. Returns the first OK
 * Response, or throws LLMError (with .status for non-retryable statuses).
 */
export async function retryFetch(args: RetryFetchArgs): Promise<Response> {
  const { fetchImpl, url, init, maxRetries, timeoutMs, sleep, label } = args;
  let lastError: LLMError | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Per-attempt timeout: a hung endpoint aborts like a network error and
    // is retried like one.
    const controller = new AbortController();
    const timer =
      timeoutMs !== undefined
        ? setTimeout(() => controller.abort(), timeoutMs)
        : undefined;
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      lastError = new LLMError(
        `network error: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (attempt < maxRetries) {
        const backoffMs = RETRY_BASE_DELAY_MS * 2 ** attempt;
        logRetry({
          model: label ?? url,
          attempt: attempt + 1,
          error: `LLMError: ${lastError.message.slice(0, 120)}`,
          backoffMs,
        });
        await sleep(backoffMs);
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
      if (attempt < maxRetries) {
        const raMs = retryAfterMs(res);
        const backoffMs = raMs ?? RETRY_BASE_DELAY_MS * 2 ** attempt;
        logRetry({
          model: label ?? url,
          attempt: attempt + 1,
          error: `LLMError: ${lastError.message.slice(0, 120)}`,
          backoffMs,
        });
        await sleep(backoffMs);
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
    return res;
  }
  throw lastError ?? new LLMError('request failed');
}
