/**
 * Decision-model provider: typed evaluation questions against gateways
 * implementing the /v1/decisions API (verified on the Vercel AI Gateway).
 *
 * Port of Python `open_referee/providers/decisions.py`. Decision models do
 * not generate free text: they evaluate one shared input against predicate /
 * choice / score questions and return typed answers with probability
 * distributions in a single forward pass. They are NOT ChatProviders and
 * cannot fill chat roles — they fill the optional `decision` role.
 */

import { LLMError, type Usage } from './base';
import { logRetry } from './retry';
import type { RateLimiter } from './rate_limit';

// ------------------------------------------------------------------ models --

export interface DecisionChoice {
  value: string;
  description?: string;
}

export interface DecisionLevel {
  label: string;
  description?: string;
}

/** Probability that the instruction's statement holds for the input. */
export interface PredicateQuestion {
  type: 'predicate';
  name: string;
  instructions: string;
}

/** Pick one option; answer includes the full probability distribution. */
export interface ChoiceQuestion {
  type: 'choice';
  name: string;
  instructions: string;
  choices: DecisionChoice[];
}

/** Position on an ordered rubric; answer includes per-level distribution. */
export interface ScoreQuestion {
  type: 'score';
  name: string;
  instructions: string;
  levels: DecisionLevel[];
}

export type DecisionQuestion = PredicateQuestion | ChoiceQuestion | ScoreQuestion;

export interface DecisionAnswer {
  type: string;
  name?: string;
  /** predicate */
  probability?: number;
  /** choice */
  choice?: string;
  /** score (level index) */
  score?: number;
  confidence?: number;
  probabilities: Record<string, unknown>[];
}

export interface DecisionResult {
  answers: DecisionAnswer[];
  usage: Usage;
}

/** Find the answer for one question by name (Python DecisionResult.answer). */
export function answerByName(
  answers: DecisionAnswer[],
  name: string,
): DecisionAnswer | undefined {
  return answers.find((a) => a.name === name);
}

/** Convenience lookup on a result (Python DecisionResult.answer). */
export function answer(
  result: DecisionResult,
  name: string,
): DecisionAnswer | undefined {
  return answerByName(result.answers, name);
}

/** Python `_question_payload`: choices/levels carry description only when set. */
function questionPayload(q: DecisionQuestion): Record<string, unknown> {
  const d: Record<string, unknown> = {
    type: q.type,
    name: q.name,
    instructions: q.instructions,
  };
  if (q.type === 'choice') {
    d['choices'] = q.choices.map((c) =>
      c.description
        ? { value: c.value, description: c.description }
        : { value: c.value },
    );
  } else if (q.type === 'score') {
    d['levels'] = q.levels.map((lv) =>
      lv.description
        ? { label: lv.label, description: lv.description }
        : { label: lv.label },
    );
  }
  return d;
}

// ------------------------------------------------------------------ client --

interface DecisionsApiResponse {
  answers?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

const RETRY_BASE_DELAY_MS = 1500;

function asInt(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** Tolerant answer parse (Python `DecisionAnswer(**a)` semantics, minus the
 * strict-type errors: malformed entries keep whatever fields parsed). */
function parseAnswer(raw: unknown): DecisionAnswer {
  const o =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const probabilities = Array.isArray(o['probabilities'])
    ? (o['probabilities'] as Record<string, unknown>[]).filter(
        (p): p is Record<string, unknown> =>
          typeof p === 'object' && p !== null && !Array.isArray(p),
      )
    : [];
  const out: DecisionAnswer = { type: String(o['type'] ?? ''), probabilities };
  if (typeof o['name'] === 'string') out.name = o['name'];
  if (typeof o['probability'] === 'number') out.probability = o['probability'];
  if (typeof o['choice'] === 'string') out.choice = o['choice'];
  if (typeof o['score'] === 'number') out.score = o['score'];
  if (typeof o['confidence'] === 'number') out.confidence = o['confidence'];
  return out;
}

export interface DecisionsClientOptions {
  providerName: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  rateLimiter?: RateLimiter;
  fetchImpl?: typeof fetch;
  /** Per-attempt timeout in seconds; undefined = no timeout. */
  timeoutS?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** HTTP client for POST {base_url}/decisions (OpenAI-gateway-style auth). */
export class DecisionsClient {
  readonly providerName: string;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly rateLimiter: RateLimiter | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly timeoutMs: number | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: DecisionsClientOptions) {
    this.providerName = opts.providerName;
    this.model = opts.model;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.rateLimiter = opts.rateLimiter;
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.maxRetries = Math.max(0, Math.floor(opts.maxRetries ?? 4));
    this.timeoutMs =
      opts.timeoutS !== undefined && opts.timeoutS > 0
        ? opts.timeoutS * 1000
        : undefined;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async decide(
    input: string,
    questions: readonly DecisionQuestion[],
  ): Promise<DecisionResult> {
    await this.rateLimiter?.gate(this.baseUrl);
    const payload = {
      model: this.model,
      input,
      questions: questions.map(questionPayload),
    };
    const init: RequestInit = {
      method: 'POST',
      headers: {
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    };

    let lastError: LLMError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer =
        this.timeoutMs !== undefined
          ? setTimeout(() => controller.abort(), this.timeoutMs)
          : undefined;
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/decisions`, {
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
            model: this.model,
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

      if (!res.ok) {
        lastError = new LLMError(
          `${this.providerName}/${this.model} decision call failed: ${res.status} ${(
            await res.text()
          ).slice(0, 300)}`,
          res.status,
        );
        if (attempt < this.maxRetries) {
          const backoffMs = RETRY_BASE_DELAY_MS * 2 ** attempt;
          logRetry({
            model: this.model,
            attempt: attempt + 1,
            error: `LLMError: ${lastError.message.slice(0, 120)}`,
            backoffMs,
          });
          await this.sleep(backoffMs);
          continue;
        }
        throw lastError;
      }

      let parsed: DecisionsApiResponse;
      try {
        parsed = (await res.json()) as DecisionsApiResponse;
      } catch {
        throw new LLMError('malformed JSON response from decision provider');
      }
      const answers = Array.isArray(parsed['answers'])
        ? (parsed['answers'] as unknown[]).map(parseAnswer)
        : [];
      return {
        answers,
        usage: {
          promptTokens: asInt(parsed.usage?.input_tokens),
          completionTokens: asInt(parsed.usage?.output_tokens),
        },
      };
    }
    throw (
      lastError ??
      new LLMError(
        `${this.providerName}/${this.model} decision call failed after retries`,
      )
    );
  }

  close(): void {}
}

/**
 * Scripted decision provider for tests: queue one answers-list per decide()
 * call (Python FakeDecisionProvider). Usage mirrors the Python stub:
 * inputTokens = max(1, len(input) // 4), outputTokens = 1.
 */
export class FakeDecisionProvider {
  readonly providerName = 'fake';
  readonly model: string;
  readonly calls: { input: string; questions: string[] }[] = [];
  private queueContents: DecisionAnswer[][] = [];

  constructor(model = 'fake-decider') {
    this.model = model;
  }

  queue(...answerLists: DecisionAnswer[][]): void {
    this.queueContents.push(...answerLists);
  }

  async decide(
    input: string,
    questions: readonly DecisionQuestion[],
  ): Promise<DecisionResult> {
    this.calls.push({ input, questions: questions.map((q) => q.name) });
    const answers = this.queueContents.shift();
    if (answers === undefined) {
      throw new LLMError('FakeDecisionProvider queue empty');
    }
    return {
      answers,
      usage: {
        promptTokens: Math.max(1, Math.floor(input.length / 4)),
        completionTokens: 1,
      },
    };
  }

  close(): void {}
}
