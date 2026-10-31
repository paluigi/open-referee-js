/**
 * Decisions client unit tests + FakeDecisionProvider parity (Stage 7e).
 * Python reference: providers/decisions.py, tests/test_fit.py stub behavior.
 */

import { describe, expect, it } from 'vitest';
import {
  answer,
  DecisionsClient,
  FakeDecisionProvider,
  type DecisionAnswer,
  type DecisionQuestion,
} from '../src/providers/decisions';
import { LLMError } from '../src/providers/base';

const fetchOk = (body: unknown) =>
  (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )) as typeof fetch;

const fetchStatus = (status: number, text = '') =>
  (() => Promise.resolve(new Response(text, { status }))) as typeof fetch;

const PRED: DecisionQuestion = {
  type: 'predicate',
  name: 'q1',
  instructions: 'Does it hold?',
};

describe('DecisionsClient', () => {
  it('posts model/input/questions and parses typed answers + usage', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const impl = (async (url: string, init?: RequestInit) => {
      captured = { url, init: init ?? {} };
      return new Response(
        JSON.stringify({
          answers: [
            { type: 'predicate', name: 'q1', probability: 0.87, confidence: 0.4 },
            { type: 'choice', name: 'q2', choice: 'b' },
            { type: 'score', name: 'q3', score: 2 },
          ],
          usage: { input_tokens: 123, output_tokens: 4 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const client = new DecisionsClient({
      providerName: 'verceldec',
      model: 'pplx-decider',
      baseUrl: 'http://fake.local/',
      apiKey: 'sk-test',
      fetchImpl: impl,
      maxRetries: 0,
    });
    const q2: DecisionQuestion = {
      type: 'choice',
      name: 'q2',
      instructions: 'pick',
      choices: [{ value: 'a' }, { value: 'b', description: 'the b option' }],
    };
    const q3: DecisionQuestion = {
      type: 'score',
      name: 'q3',
      instructions: 'rate',
      levels: [{ label: 'low' }, { label: 'high', description: 'very high' }],
    };
    const res = await client.decide('the input', [PRED, q2, q3]);
    expect(captured!.url).toBe('http://fake.local/decisions');
    const body = JSON.parse(String(captured!.init.body));
    expect(body.model).toBe('pplx-decider');
    expect(body.input).toBe('the input');
    expect(body.questions[0]).toEqual({
      type: 'predicate',
      name: 'q1',
      instructions: 'Does it hold?',
    });
    // description included only when set (Python _question_payload)
    expect(body.questions[1].choices).toEqual([
      { value: 'a' },
      { value: 'b', description: 'the b option' },
    ]);
    expect(body.questions[2].levels).toEqual([
      { label: 'low' },
      { label: 'high', description: 'very high' },
    ]);
    expect(res.answers).toHaveLength(3);
    expect(answer(res, 'q1')?.probability).toBe(0.87);
    expect(answer(res, 'q2')?.choice).toBe('b');
    expect(answer(res, 'q3')?.score).toBe(2);
    expect(answer(res, 'missing')).toBeUndefined();
    expect(res.usage).toEqual({ promptTokens: 123, completionTokens: 4 });
  });

  it('retries HTTP >= 400 with backoff and raises after retries', async () => {
    const sleeps: number[] = [];
    const client = new DecisionsClient({
      providerName: 'p',
      model: 'm',
      baseUrl: 'http://fake.local',
      fetchImpl: fetchStatus(500, 'boom'),
      maxRetries: 2,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    await expect(client.decide('in', [PRED])).rejects.toThrow(LLMError);
    expect(sleeps).toHaveLength(2);
  });

  it('malformed answers survive the tolerant parse', async () => {
    const client = new DecisionsClient({
      providerName: 'p',
      model: 'm',
      baseUrl: 'http://fake.local',
      fetchImpl: fetchOk({
        answers: [
          'garbage',
          42,
          { type: 'predicate', name: 'q1', probability: 'nope', confidence: 0.5 },
          { type: 'predicate', name: 'q2', probability: 0.5 },
        ],
        usage: {},
      }),
      maxRetries: 0,
    });
    const res = await client.decide('in', [PRED]);
    // every list entry survives; non-dict entries parse to empty shells and
    // dict entries keep whatever parsed (Python keeps all entries too)
    expect(res.answers).toHaveLength(4);
    expect(res.answers[0]!.name).toBeUndefined();
    expect(res.answers[1]!.name).toBeUndefined();
    expect(res.answers[2]!.name).toBe('q1');
    expect(res.answers[2]!.probability).toBeUndefined();
    expect(res.answers[3]!.probability).toBe(0.5);
    expect(res.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
  });
});

describe('FakeDecisionProvider (Python parity)', () => {
  it('queues one answers-list per call and records question names', async () => {
    const fake = new FakeDecisionProvider('decider-fake');
    const a1: DecisionAnswer = {
      type: 'choice',
      name: 'path_choice',
      choice: 'claims-light',
      confidence: 0.9,
      probabilities: [],
    };
    fake.queue([a1]);
    const res = await fake.decide('input text', [
      { type: 'choice', name: 'path_choice', instructions: 'x', choices: [] },
    ]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toEqual({ input: 'input text', questions: ['path_choice'] });
    expect(res.answers[0]!.choice).toBe('claims-light');
    // usage mirrors the Python stub: max(1, len(input)//4) in, 1 out
    expect(res.usage).toEqual({ promptTokens: 2, completionTokens: 1 });
  });

  it('empty queue raises LLMError', async () => {
    const fake = new FakeDecisionProvider();
    await expect(fake.decide('x', [PRED])).rejects.toThrow(LLMError);
  });
});
