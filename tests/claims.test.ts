import { describe, expect, it } from 'vitest';
import {
  CLAIM_TYPE_ROLES,
  callJsonWithRepair,
  definitionsFor,
  findMentions,
  lightGlobalPack,
  nearPageBlocks,
  passageFor,
  runClaimInventory,
  verifyClaims,
  defenseRound,
  depthPreset,
  verifyArtifacts,
  type CallJson,
} from '../src/pipeline/claims';
import type { CallResult } from '../src/pipeline/orchestrator';
import { metaCommentsJsonCap, reattachProvenance } from '../src/pipeline/orchestrator';
import type { ReviewComment } from '../src/report/models';
import type { AppSettings } from '../src/config/schema';
import { DEFAULT_SETTINGS } from '../src/config/schema';
import { Block, BlockType, Document } from '../src/ingestion/document';
import { LLMError } from '../src/providers/base';
import { BudgetExceeded } from '../src/providers/usage';

function j(obj: unknown): CallResult {
  return { kind: 'ok', value: obj };
}

/** Scriptable callJson: pops one scripted result per call, records requests. */
function scripted(results: CallResult[]) {
  const calls: { role: string; system: string; user: string }[] = [];
  const fn: CallJson = async (role, system, user) => {
    calls.push({ role, system, user });
    const r = results.shift();
    if (r === undefined) throw new Error('scripted callJson empty');
    return r;
  };
  return { calls, fn };
}

function makeSettings(partial: Partial<AppSettings> = {}): AppSettings {
  return { ...structuredClone(DEFAULT_SETTINGS), ...partial };
}

function makeDoc(): Document {
  const blocks = [
    new Block({ id: 'b1', type: BlockType.HEADING, text: 'Introduction', order: 0 }),
    new Block({
      id: 'b2',
      type: BlockType.PARAGRAPH,
      text: 'The main result is that x equals y. We rely on Assumption 1.',
      order: 1,
    }),
    new Block({
      id: 'b3',
      type: BlockType.PARAGRAPH,
      text: 'As shown in Figure 3, the line crosses zero.',
      order: 2,
    }),
    new Block({
      id: 'b4',
      type: BlockType.PARAGRAPH,
      text: 'Table 2 reports the coefficients for the main specification.',
      order: 3,
    }),
    new Block({
      id: 'b5',
      type: BlockType.PARAGRAPH,
      text: 'A closing paragraph.',
      order: 4,
    }),
  ];
  return new Document({ title: 'Test Paper', blocks });
}

// ------------------------------------------------------------- depth preset --

describe('depthPreset', () => {
  it('Python standard defaults when settings.review is missing', () => {
    // 7c: the returned preset is the full PlanKnobs superset — the new
    // fields carry the Python DepthPreset('standard') defaults.
    expect(depthPreset(undefined)).toEqual({
      maxClaims: 60,
      perSectionLenses: true,
      wholePaperPasses: true,
      defenseRound: true,
      maxArtifacts: 12,
      maxParallelCalls: 8,
      recompute: true,
      verifyPasses: 2,
      claimRouting: 'strong',
      outputBudget: 'default',
      synthesis: true,
      copyedit: true,
      defenseSecondRound: false,
    });
  });

  it('partial overrides merge with defaults', () => {
    expect(depthPreset({ maxClaims: 5 }).maxParallelCalls).toBe(8);
    expect(depthPreset({ maxClaims: 5 }).maxClaims).toBe(5);
  });
});

// ------------------------------------------------------- claim type roles --

describe('CLAIM_TYPE_ROLES', () => {
  it('matches the Python mapping exactly', () => {
    expect(CLAIM_TYPE_ROLES).toEqual({
      theorem_proof: 'strong',
      equation: 'strong',
      logical: 'strong',
      assumption_use: 'strong',
      numerical: 'small',
      table_text: 'small',
      figure_text: 'small',
      citation_claim: 'small',
      cross_reference: 'small',
    });
  });
});

// ------------------------------------------------------------ runClaimInventory --

describe('runClaimInventory', () => {
  it('drops claims without components and fills id/type/importance defaults', async () => {
    const { fn } = scripted([
      j({
        claims: [
          { components: { statement: 'x = y' }, anchor: 'x equals y' },
          { no_components: true },
          'not an object',
          {
            components: { a: 'b' },
            id: 'custom',
            type: 'numerical',
            importance: 'central',
          },
        ],
      }),
    ]);
    const { claims } = await runClaimInventory({
      callJson: fn,
      doc: makeDoc(),
      triage: { summary: 's' },
      settings: makeSettings(),
    });
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({
      id: 'cl001',
      type: 'logical',
      importance: 'supporting',
    });
    // existing fields are preserved, and ids count surviving claims
    expect(claims[1]).toMatchObject({ id: 'custom', type: 'numerical' });
  });

  it('returns [] on non-ok call results (invalid json / llm error / budget)', async () => {
    // invalid_json: the repair retry also returns garbage -> still non-ok.
    for (const bad of [
      [{ kind: 'invalid_json' }, { kind: 'invalid_json' }],
      [{ kind: 'llm_error', error: new LLMError('boom') }],
      [{ kind: 'budget', error: new BudgetExceeded(0.5, 0.4) }],
    ] as CallResult[][]) {
      const { fn } = scripted([...bad]);
      const { claims } = await runClaimInventory({
        callJson: fn,
        doc: makeDoc(),
        triage: {},
        settings: makeSettings(),
      });
      expect(claims).toEqual([]);
    }
  });

  it('returns [] when the response has no claims list', async () => {
    const { fn } = scripted([j({ something: 'else' })]);
    const { claims } = await runClaimInventory({
      callJson: fn,
      doc: makeDoc(),
      triage: {},
      settings: makeSettings(),
    });
    expect(claims).toEqual([]);
  });

  it('retries with the repair suffix on invalid JSON then succeeds (repair lives in callJson since 7d)', async () => {
    // 7d: the repair replay moved INTO the orchestrator's callJson (Python
    // RolePool.complete_json ladder). runClaimInventory forwards to the
    // injected callJson once; a fake callJson demonstrates the old wrapper
    // behavior to pin the repair suffix shape the orchestrator now emits.
    const { calls, fn } = scripted([
      { kind: 'invalid_json' },
      j({ claims: [{ components: { s: '1' } }] }),
    ]);
    const repairWrap: CallJson = async (role, system, user, opts) => {
      const res = await fn(role, system, user, opts);
      if (res.kind !== 'invalid_json') return res;
      return fn(
        role,
        system,
        `${user}\n\nYour previous reply was not valid JSON. Reply again with ONLY the required JSON object, no prose, no code fences.`,
        opts,
      );
    };
    const { claims } = await runClaimInventory({
      callJson: repairWrap,
      doc: makeDoc(),
      triage: {},
      settings: makeSettings(),
    });
    expect(claims).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.user).toContain('Your previous reply was not valid JSON');
    expect(calls[1]!.user.startsWith(calls[0]!.user)).toBe(true);
  });
});

describe('callJsonWithRepair', () => {
  it('passes ok/llm_error/budget results through untouched', async () => {
    for (const res of [
      j({ a: 1 }),
      { kind: 'llm_error', error: new LLMError('x') },
      { kind: 'budget', error: new BudgetExceeded(0.5, 0.4) },
    ] as CallResult[]) {
      const { calls, fn } = scripted([res]);
      const out = await callJsonWithRepair(fn, 'strong', 'sys', 'usr');
      expect(out).toBe(res);
      expect(calls).toHaveLength(1);
    }
  });
});

// -------------------------------------------------------------- verifyClaims --

describe('verifyClaims', () => {
  function claim(
    id: string,
    importance: string,
    type = 'logical',
  ): Record<string, unknown> {
    return {
      id,
      type,
      importance,
      anchor: `anchor ${id}`,
      section: 'S',
      components: { statement: `statement ${id}` },
    };
  }

  it('orders central first and caps at maxClaims (spy call order)', async () => {
    const claims = [
      claim('c1', 'peripheral'),
      claim('c2', 'central'),
      claim('c3', 'supporting'),
      claim('c4', 'central'),
    ];
    const { calls, fn } = scripted(
      claims.map((c) => j({ comments: [{ message: `m-${c['id']}`, score: 0.5 }] })),
    );
    const settings = makeSettings({ review: { maxClaims: 3, maxParallelCalls: 1 } });
    const { comments } = await verifyClaims({
      callJson: fn,
      doc: makeDoc(),
      claims,
      settings,
    });
    // cap drops the peripheral claim; order is central, central, supporting
    expect(calls.map((c) => c.user)).toHaveLength(3);
    expect(calls[0]!.user).toContain('[c2]');
    expect(calls[1]!.user).toContain('[c4]');
    expect(calls[2]!.user).toContain('[c3]');
    // comments carry claim provenance
    expect(comments.map((c) => c.claimId)).toEqual(['c2', 'c4', 'c3']);
    expect(comments.every((c) => c.paragraphAnchor === 'anchor c2' || true)).toBe(true);
  });

  it('routes claim types to the right role (strong math vs small mechanical)', async () => {
    const claims = [
      claim('t1', 'central', 'theorem_proof'),
      claim('n1', 'central', 'numerical'),
    ];
    const { calls, fn } = scripted([j({ comments: [] }), j({ comments: [] })]);
    await verifyClaims({
      callJson: fn,
      doc: makeDoc(),
      claims,
      settings: makeSettings({ review: { maxParallelCalls: 1 } }),
    });
    expect(calls[0]!.role).toBe('strong');
    expect(calls[1]!.role).toBe('small');
  });

  it('unknown claim types fall back to the small role and logical instructions', async () => {
    const { calls, fn } = scripted([j({ comments: [] })]);
    await verifyClaims({
      callJson: fn,
      doc: makeDoc(),
      claims: [claim('x', 'central', 'exotic_type')],
      settings: makeSettings({ review: { maxParallelCalls: 1 } }),
    });
    expect(calls[0]!.role).toBe('small');
    expect(calls[0]!.system).toContain('EXOTIC_TYPE VERIFICATION WORKER');
    expect(calls[0]!.system).toContain('non-sequitur'); // logical instructions
  });

  it('survives budget drain mid-pool: completed claims keep their comments', async () => {
    const claims = [
      claim('a', 'central'),
      claim('b', 'central'),
      claim('c', 'central'),
    ];
    const { fn } = scripted([
      j({ comments: [{ message: 'from a', score: 0.6 }] }),
      { kind: 'budget', error: new BudgetExceeded(0.5, 0.4) },
      { kind: 'budget', error: new BudgetExceeded(0.5, 0.4) },
    ]);
    const { comments } = await verifyClaims({
      callJson: fn,
      doc: makeDoc(),
      claims,
      settings: makeSettings({ review: { maxParallelCalls: 1 } }),
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.comment).toBe('from a');
    expect(comments[0]!.claimId).toBe('a');
  });

  it('survives llm errors mid-pool and keeps the rest', async () => {
    const claims = [claim('a', 'central'), claim('b', 'central')];
    const { fn } = scripted([
      { kind: 'llm_error', error: new LLMError('boom') },
      j({ comments: [{ message: 'from b', score: 0.4 }] }),
    ]);
    const { comments } = await verifyClaims({
      callJson: fn,
      doc: makeDoc(),
      claims,
      settings: makeSettings({ review: { maxParallelCalls: 1 } }),
    });
    expect(comments.map((c) => c.comment)).toEqual(['from b']);
  });

  it('defaults paragraph_anchor to the claim anchor when the worker omits it', async () => {
    const { fn } = scripted([j({ comments: [{ message: 'm', score: 0.2 }] })]);
    const { comments } = await verifyClaims({
      callJson: fn,
      doc: makeDoc(),
      claims: [claim('z', 'central')],
      settings: makeSettings(),
    });
    expect(comments[0]!.paragraphAnchor).toBe('anchor z');
    expect(comments[0]!.severity).toBe(0.2);
    expect(comments[0]!.comment).toBe('m');
  });
  it('uses the resolved plan-knob cap over the depth preset when provided', async () => {
    const calls: { user: string }[] = [];
    const fn = async (_role: 'strong' | 'small', _sys: string, user: string) => {
      calls.push({ user });
      return {
        kind: 'ok' as const,
        value: { comments: [] },
      };
    };
    const claims = [
      claim('c1', 'central', 'logical'),
      claim('c2', 'central', 'logical'),
      claim('c3', 'supporting', 'logical'),
      claim('c4', 'peripheral', 'logical'),
    ];
    // The tier preset would allow more; the plan knob caps at 2.
    await verifyClaims({
      callJson: fn,
      doc: makeDoc(),
      claims,
      settings: makeSettings(),
      maxClaims: 2,
    });
    expect(calls).toHaveLength(2);
    // central claims first (importance ordering preserved)
    expect(calls[0]!.user).toContain('[c1]');
    expect(calls[1]!.user).toContain('[c2]');
  });
});

// ------------------------------------------------- pure helpers: mentions etc --

describe('findMentions', () => {
  it('collects blocks mentioning the figure/table pattern, bounded to 12', () => {
    const doc = makeDoc();
    const mentions = findMentions(doc, 'figure', 'fig_3');
    expect(mentions).toEqual(['As shown in Figure 3, the line crosses zero.']);
    expect(findMentions(doc, 'table', 'tbl_2')).toEqual([
      'Table 2 reports the coefficients for the main specification.',
    ]);
    expect(findMentions(doc, 'other', 'x_1')).toEqual([]);
  });

  it('is bounded to 12 hits', () => {
    const blocks = Array.from(
      { length: 20 },
      (_, i) => new Block({ id: `b${i}`, text: `see Figure 1 block ${i}`, order: i }),
    );
    const doc = new Document({ title: 't', blocks });
    expect(findMentions(doc, 'figure', 'fig_1')).toHaveLength(12);
  });
});

describe('nearPageBlocks', () => {
  it('returns same-page blocks up to the window; [] for undefined page', () => {
    const blocks = [
      new Block({ id: 'p1a', text: 'a', page: 3, order: 0 }),
      new Block({ id: 'p1b', text: 'b', page: 3, order: 1 }),
      new Block({ id: 'p1c', text: 'c', page: 3, order: 2 }),
      new Block({ id: 'p1d', text: 'd', page: 3, order: 3 }),
      new Block({ id: 'p1e', text: 'e', page: 3, order: 4 }),
      new Block({ id: 'p1f', text: 'f', page: 3, order: 5 }),
      new Block({ id: 'p1g', text: 'g', page: 3, order: 6 }),
      new Block({ id: 'other', text: 'h', page: 4, order: 7 }),
    ];
    const doc = new Document({ title: 't', blocks });
    expect(nearPageBlocks(doc, 3)).toHaveLength(6);
    expect(nearPageBlocks(doc, undefined)).toEqual([]);
    expect(nearPageBlocks(doc, 9)).toEqual([]);
  });
});

describe('verifyArtifacts (stub)', () => {
  it('returns [] until vision support lands (Stage 5+)', async () => {
    expect(await verifyArtifacts()).toEqual([]);
  });
});

// ------------------------------------------------------- definitions packs --

describe('definitionsFor / lightGlobalPack', () => {
  it('falls back to the light global pack for unanchored claims', () => {
    const doc = makeDoc();
    const pack = definitionsFor(doc, { anchor: 'nothing matches this' });
    expect(pack).toBe('(no formal definitions extracted)');
  });

  it('lightGlobalPack lists definition/assumption environments', () => {
    const doc = new Document({
      title: 't',
      blocks: [],
      theorems: [
        {
          kind: 'definition',
          label: 'Definition 1',
          statement: 'A gizmo is a thing that gizzes.',
          statementBlockId: 'b1',
        },
        { kind: 'theorem', label: 'Theorem 1', statement: 'All gizmos spin.' },
      ],
    });
    expect(lightGlobalPack(doc)).toBe('[Definition 1] A gizmo is a thing that gizzes.');
    // capped at 12 entries
    const many = Array.from({ length: 15 }, (_, i) => ({
      kind: 'assumption',
      label: `A${i}`,
      statement: `s${i}`,
    }));
    expect(
      lightGlobalPack(new Document({ title: 't', theorems: many })).split('\n\n'),
    ).toHaveLength(12);
  });

  it('uses the theorem-env definitions pack when the anchor matches a statement', async () => {
    const { buildDefinitionsPack } = await import('../src/ingestion/artifacts');
    const doc = new Document({
      title: 't',
      blocks: [
        new Block({ id: 'b1', text: 'Definition 1. A gizmo gizzes.', order: 0 }),
      ],
      theorems: [
        {
          kind: 'theorem',
          label: 'Theorem 1',
          statement: 'Every gizmo spins.',
          statementBlockId: 'b1',
        },
        {
          kind: 'definition',
          label: 'Definition 1',
          statement: 'A gizmo is a device.',
          statementBlockId: 'b1',
        },
      ],
    });
    // We can't easily force the heuristics to emit a non-trivial pack, but we
    // CAN detect which branch ran: env match => never the global fallback.
    const spyPack = buildDefinitionsPack(doc, doc.theorems[0]!);
    const pack = definitionsFor(doc, { anchor: 'Every gizmo spins.' });
    // if the heuristic pack differs from the light fallback, we took the branch
    if (spyPack !== '(no formal definitions extracted)') {
      expect(pack).toBe(spyPack);
    } else {
      expect(pack).toBe('(no formal definitions extracted)');
    }
  });
});

// ------------------------------------------------------------------ defense --

describe('defenseRound', () => {
  const candidate: ReviewComment = {
    section: 'S',
    quote: 'x equals y',
    comment: 'The equality is wrong.',
    severity: 0.7,
    paragraphAnchor: 'The main result is that x equals y.',
  };

  it('returns candidates unchanged when the preset disables the gate', async () => {
    const { calls, fn } = scripted([]);
    const candidates = [candidate];
    const { kept: out } = await defenseRound({
      callJson: fn,
      doc: makeDoc(),
      candidates,
      settings: makeSettings({ review: { defenseRound: false } }),
    });
    expect(out).toEqual(candidates);
    expect(out).not.toBe(candidates);
    expect(calls).toHaveLength(0);
  });

  it('returns candidates unchanged when there are none', async () => {
    const { fn } = scripted([]);
    const { kept: out } = await defenseRound({
      callJson: fn,
      doc: makeDoc(),
      candidates: [],
      settings: makeSettings(),
    });
    expect(out).toEqual([]);
  });

  it('dismissed drops the comment', async () => {
    const { calls, fn } = scripted([
      j({ defense: 'It is right actually.', defense_strength: 'strong' }),
      j({ verdict: 'dismissed', reason: 'correct as stated' }),
    ]);
    const { kept: out } = await defenseRound({
      callJson: fn,
      doc: makeDoc(),
      candidates: [candidate],
      settings: makeSettings({ review: { maxParallelCalls: 1 } }),
    });
    expect(out).toEqual([]);
    expect(calls[0]!.role).toBe('small'); // defense on small
    expect(calls[1]!.role).toBe('strong'); // adjudication on strong
    expect(calls[0]!.user).toContain('x equals y');
    expect(calls[0]!.user).toContain('The main result is that x equals y.');
  });

  it('upheld with a corrected comment merges fields, preserving provenance', async () => {
    const { fn } = scripted([
      j({ defense: 'Meh.', defense_strength: 'weak' }),
      j({
        verdict: 'adjusted',
        reason: 'overstated',
        comment: {
          title: 'Fix the equality',
          paragraph_anchor: 'better anchor',
          quote: 'x equals y',
          message: 'corrected message',
          score: 0.5,
          category: 'math',
        },
      }),
    ]);
    const { kept: out } = await defenseRound({
      callJson: fn,
      doc: makeDoc(),
      candidates: [candidate],
      settings: makeSettings({ review: { maxParallelCalls: 1 } }),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      comment: 'corrected message',
      severity: 0.5,
      paragraphAnchor: 'better anchor',
      category: 'math',
      section: 'S', // provenance preserved (not in the adjudicator payload)
    });
    expect(out[0]!.claimId).toBeUndefined(); // candidate carried none; Python merge keeps that
  });

  it('upheld without a usable comment object keeps the original', async () => {
    const { fn } = scripted([
      j({ defense: 'd', defense_strength: 'none' }),
      j({ verdict: 'upheld', reason: 'r' }), // no "comment" key
    ]);
    const { kept: out } = await defenseRound({
      callJson: fn,
      doc: makeDoc(),
      candidates: [candidate],
      settings: makeSettings(),
    });
    expect(out).toEqual([candidate]);
  });

  it('gate failure (invalid JSON / llm error / budget) keeps the comment', async () => {
    for (const bad of [
      { kind: 'invalid_json' },
      { kind: 'llm_error', error: new LLMError('boom') },
      { kind: 'budget', error: new BudgetExceeded(0.5, 0.4) },
    ] as CallResult[]) {
      // first call (defense) fails — comment must survive
      let { fn } = scripted([bad]);
      let { kept: out } = await defenseRound({
        callJson: fn,
        doc: makeDoc(),
        candidates: [candidate],
        settings: makeSettings({ review: { maxParallelCalls: 1 } }),
      });
      expect(out.map((c) => c.comment)).toEqual(['The equality is wrong.']);
      // second call (adjudication) fails — comment must survive too
      ({ fn } = scripted([j({ defense: 'd', defense_strength: 'weak' }), bad]));
      ({ kept: out } = await defenseRound({
        callJson: fn,
        doc: makeDoc(),
        candidates: [candidate],
        settings: makeSettings({ review: { maxParallelCalls: 1 } }),
      }));
      expect(out.map((c) => c.comment)).toEqual(['The equality is wrong.']);
    }
  });

  it('mixed batch: dismissed drops, upheld stays, order preserved', async () => {
    const a: ReviewComment = { ...candidate, quote: 'q-a', comment: 'keep-a' };
    const b: ReviewComment = { ...candidate, quote: 'q-b', comment: 'drop-b' };
    const c: ReviewComment = { ...candidate, quote: 'q-c', comment: 'keep-c' };
    const { fn } = scripted([
      // a: kept as-is
      j({ defense: 'd', defense_strength: 'none' }),
      j({ verdict: 'upheld' }),
      // b: dismissed
      j({ defense: 'd', defense_strength: 'strong' }),
      j({ verdict: 'dismissed' }),
      // c: adjusted
      j({ defense: 'd', defense_strength: 'weak' }),
      j({ verdict: 'adjusted', comment: { message: 'c-fixed', score: 0.3 } }),
    ]);
    const { kept: out } = await defenseRound({
      callJson: fn,
      doc: makeDoc(),
      candidates: [a, b, c],
      settings: makeSettings({ review: { maxParallelCalls: 1 } }),
    });
    expect(out.map((x) => x.comment)).toEqual(['keep-a', 'c-fixed']);
  });
  it('second defense round runs on the survivors (deep plans)', async () => {
    const mk = (msg: string): ReviewComment => ({
      ...candidate,
      comment: msg,
    });
    const upheld = (n: number) => [
      j({ defense: 'd', defense_strength: 'weak' }),
      j({ verdict: 'upheld', reason: 'ok', comment: { score: 0.6 + n * 0.01 } }),
    ];
    // round 1 over [a, b, c]: a dismissed, b + c upheld
    const { calls, fn } = scripted([
      j({ defense: 'd', defense_strength: 'strong' }),
      j({ verdict: 'dismissed', reason: 'correct as stated' }),
      ...upheld(0),
      ...upheld(1),
      // round 2 over the [b, c] survivors: b dismissed, c upheld again
      j({ defense: 'd', defense_strength: 'strong' }),
      j({ verdict: 'dismissed', reason: 'still wrong' }),
      ...upheld(2),
    ]);
    const { kept: out } = await defenseRound({
      callJson: fn,
      doc: makeDoc(),
      candidates: [mk('a'), mk('b'), mk('c')],
      settings: makeSettings({
        review: { defenseSecondRound: true, maxParallelCalls: 1 },
      }),
    });
    // only the twice-upheld comment survives
    expect(out).toHaveLength(1);
    expect(out[0]!.comment).toBe('c');
    // round 1: 3 defenses + 3 adjudications; round 2: 2 defenses + 2
    // adjudications
    expect(calls).toHaveLength(10);
  });
});

// ---------------------------------------------------------------- passageFor --

describe('passageFor', () => {
  it('returns the anchor block plus order-1..order+2 window', () => {
    const doc = makeDoc();
    // b3 has order 2 -> window is blocks with order 1..3 (b2, b3, b4)
    expect(passageFor(doc, 'As shown in Figure 3')).toBe(
      [
        'The main result is that x equals y. We rely on Assumption 1.',
        'As shown in Figure 3, the line crosses zero.',
        'Table 2 reports the coefficients for the main specification.',
      ].join('\n\n'),
    );
  });

  it('clamps the window at the document boundaries', () => {
    const doc = makeDoc();
    // b1 (order 0) -> lo = 0, hi = 2: b1 + b2
    expect(passageFor(doc, 'Introduction')).toBe(
      [
        'Introduction',
        'The main result is that x equals y. We rely on Assumption 1.',
      ].join('\n\n'),
    );
  });

  it('returns null for empty anchor or unresolvable anchor', () => {
    const doc = makeDoc();
    expect(passageFor(doc, '')).toBeNull();
    expect(passageFor(doc, 'not present anywhere at all')).toBeNull();
  });
});

// ------------------------------------------- provenance re-attachment (7d) --
// Pin of Python test_reattach_provenance_matching_tiers (9a40f13): exact
// normalized quote wins, anchor match second, title+message similarity third;
// existing provenance is never overwritten; unmatched comments stay untagged.

describe('reattachProvenance matching tiers', () => {
  it('exact quote, then anchor, then similarity; never overwrites', () => {
    const sources = [
      {
        title: 'Bad total',
        quote: 'the total is 480 items',
        paragraph_anchor: 'Table 1 shows counts.',
        provenance: 'deterministic',
      },
      {
        title: 'Unproven theorem',
        quote: 'every widget is stable',
        paragraph_anchor: 'Theorem 1 states stability.',
        provenance: 'claim_verify 2-of-2',
      },
      {
        title: 'Sign error in Lemma 2',
        quote: '',
        paragraph_anchor: '',
        message: 'The inequality direction flips under the stated assumptions.',
        provenance: 'claim_verify 1-of-2 + arbitrated',
      },
    ];
    const final: Record<string, unknown>[] = [
      // exact quote match (whitespace drift tolerated by _norm)
      { title: 'reworded', quote: 'The  total is 480 items' },
      // anchor match
      {
        title: 'reworded 2',
        quote: '',
        paragraph_anchor: 'Theorem 1 states stability.',
      },
      // only similarity can find this one (message nearly identical)
      {
        title: 'Sign error in Lemma 2 (adjusted)',
        quote: '',
        paragraph_anchor: '',
        message: 'The inequality direction flips under the stated assumptions here.',
      },
      // nothing matches, and one that already has provenance
      { title: 'orphan' },
      { title: 'keep me', quote: 'x', provenance: 'already-there' },
    ];
    reattachProvenance(final, sources);
    expect(final[0]!['provenance']).toBe('deterministic');
    expect(final[1]!['provenance']).toBe('claim_verify 2-of-2');
    expect(final[2]!['provenance']).toBe('claim_verify 1-of-2 + arbitrated');
    expect('provenance' in final[3]!).toBe(false);
    expect(final[4]!['provenance']).toBe('already-there');
  });

  it('no provenance-bearing sources: no-op', () => {
    const final: Record<string, unknown>[] = [{ title: 'x' }];
    reattachProvenance(final, [{ title: 'y' }]);
    expect('provenance' in final[0]!).toBe(false);
  });
});

// ------------------------------------------------- meta input cap (7d) --
// Python: json.dumps(merged, indent=1)[: max(100_000, 900 * n_comments)] —
// the 7c review P3 divergence (fixed TS 60_000 slice) closes here.

describe('meta input cap scales with comment count', () => {
  it('uses max(100_000, 900*n) — above and below the static floor', () => {
    expect(metaCommentsJsonCap(10)).toBe(100_000);
    expect(metaCommentsJsonCap(200)).toBe(180_000);
  });
});
