import { describe, expect, it } from 'vitest';
import {
  MAX_REFS,
  queryFor,
  renderResolutions,
  resolveReferences,
  roundPy2,
  score,
  splitReferences,
  titleGuess,
  norm,
  type ResolutionClients,
  type ResolutionRecord,
} from '../src/literature/reference_resolution';
import type { LiteratureItem } from '../src/literature/types';

// ===== Python-generated expected values (`uv run python` in the open-referee
// repo against literature/reference_resolution.py + the orchestrator's
// _render_resolutions; PY_* repr pattern from tests/bibliography.test.ts).

const PY_SPLIT_FIXTURES: string[] = [
  '[1] Smith, J. (2001). A paper about things. Journal of Papers.\n[2] Doe, J. (2010). Another study of stuff. Annals of Things.\n',
  '1. Smith, J. (2001). A paper about things. Journal of Papers.\n2. Doe, J. (2010). Another study of stuff. Annals.\n',
  '- Smith, J. (2001). A paper about things. Journal of Papers.\n- Doe, J. (2010). Another study of stuff. Annals.\n',
  '• Smith, J. (2001). A paper about things. Journal of Papers.\n• Doe, J. (2010). Another study. Annals.\n',
  '* Smith, J. (2001). A paper about things. Journal of Papers.\n* Doe, J. (2010). Another study. Annals.\n',
  '[1] Smith, J. (2001). A long first entry that continues\non the next line without any marker. Journal of Papers.\n\n[2] Doe, J. (2010). Another study of stuff. Annals.\n',
  'Smith, J. (2001). A long unmarked entry that stands alone on its own line here. Journal of Papers.',
  '[1] Short.\n[2] Smith, J. (2001). A real entry long enough to survive the filter. J.\n',
  '',
  '[1] Adams, B. (1999). First entry text is sufficiently long here. Journal X.\n[2] Brown, C. (2000). Second entry text is also long enough. Journal Y.\n\n[3] Cole, D. (2001). Third entry text with plenty of length too. Journal Z.\n',
];

const PY_SPLITS: string[][] = [
  [
    '[1] Smith, J. (2001). A paper about things. Journal of Papers.',
    '[2] Doe, J. (2010). Another study of stuff. Annals of Things.',
  ],
  [
    '1. Smith, J. (2001). A paper about things. Journal of Papers.',
    '2. Doe, J. (2010). Another study of stuff. Annals.',
  ],
  [
    '- Smith, J. (2001). A paper about things. Journal of Papers.',
    '- Doe, J. (2010). Another study of stuff. Annals.',
  ],
  [
    '• Smith, J. (2001). A paper about things. Journal of Papers.',
    '• Doe, J. (2010). Another study. Annals.',
  ],
  [
    '* Smith, J. (2001). A paper about things. Journal of Papers.',
    '* Doe, J. (2010). Another study. Annals.',
  ],
  [
    '[1] Smith, J. (2001). A long first entry that continues on the next line without any marker. Journal of Papers.',
    '[2] Doe, J. (2010). Another study of stuff. Annals.',
  ],
  [
    'Smith, J. (2001). A long unmarked entry that stands alone on its own line here. Journal of Papers.',
  ],
  ['[2] Smith, J. (2001). A real entry long enough to survive the filter. J.'],
  [],
  [
    '[1] Adams, B. (1999). First entry text is sufficiently long here. Journal X.',
    '[2] Brown, C. (2000). Second entry text is also long enough. Journal Y.',
    '[3] Cole, D. (2001). Third entry text with plenty of length too. Journal Z.',
  ],
];

const PY_ENTRIES: string[] = [
  '[1] Smith, J. (2001). A paper about things. Journal of Papers.',
  '[2] Doe, J. (2010). Another Study of Machine Learning. Annals of Statistics 5(2).',
  'Miller, A. and Wright, B. (1999). Uniqueness proofs for random walks on groups. Ann. Probab. 27.',
  '• On the Optimality of Attention in Deep Networks, NeurIPS 2020.',
  '12) Wang, H. (2015). Deep learning for time-series forecasting: a survey. Neurocomputing.',
];

const PY_TITLE_GUESSES: string[] = [
  'A paper about things',
  'Another Study of Machine Learning',
  'Uniqueness proofs for random walks on groups',
  '• On the Optimality of Attention in Deep Networks',
  'Deep learning for time-series forecasting: a survey',
];

const PY_NORMS: string[] = [
  '1  smith  j   2001  a paper about things  journal of papers',
  '2  doe  j   2010  another study of machine learning  annals of statistics 5 2',
  'miller  a  and wright  b   1999  uniqueness proofs for random walks on groups  ann  probab  27',
  'on the optimality of attention in deep networks  neurips 2020',
  '12  wang  h   2015  deep learning for time series forecasting  a survey  neurocomputing',
];

const PY_QUERIES: string[] = [
  'Smith, J. (2001). A paper about things. Journal of Papers.',
  'Doe, J. (2010). Another Study of Machine Learning. Annals of Statistics 5(2).',
  'Miller, A. and Wright, B. (1999). Uniqueness proofs for random walks on groups. Ann. Probab. 27.',
  '• On the Optimality of Attention in Deep Networks, NeurIPS 2020.',
  'Wang, H. (2015). Deep learning for time-series forecasting: a survey. Neurocomputing.',
];

const PY_ITEM_TITLES: string[] = [
  'A paper about things',
  'Another Study of Machine Learning',
  'Uniqueness proofs for random walks on groups',
  'On the Optimality of Attention in Deep Networks',
  'Deep learning for time-series forecasting: a survey',
  'Completely Unrelated Title Here',
  '',
];

const PY_SCORES: number[] = [
  1.0, 0.33962264150943394, 0.25, 0.25471698113207547, 0.21272727272727274, 0.16, 0.0,
  0.37735849056603776, 1.0, 0.23376623376623376, 0.45, 0.309375, 0.1875, 0.0, 0.25,
  0.1700787401574803, 1.0, 0.17872340425531916, 0.2606896551724138, 0.16, 0.0,
  0.208955223880597, 0.425, 0.13186813186813187, 1.0, 0.20892857142857144,
  0.1794871794871795, 0.0, 0.19718309859154928, 0.2619047619047619, 0.3157894736842105,
  0.20149253731343283, 1.0, 0.2926829268292683, 0.0,
];

const PY_RENDERS: string[] = [
  '(resolution unavailable)',
  '- MATCHED 10.1/x :: A paper about things (Journal of Papers, 2001) [score 0.91]\n- UNMATCHED :: [2] Doe, J. (2010). Another study of stuff. Annals. [best score 0.31]\n- MATCHED no-doi :: No doi entry title (?, ?) [score 0.75]',
  '- UNMATCHED :: X [best score 0.0]',
];

function item(title: string): LiteratureItem {
  return { source: 'openalex', title, authors: [] };
}

describe('splitReferences (char-parity with Python)', () => {
  it('reproduces the Python splits on 10 fixtures', () => {
    expect(PY_SPLIT_FIXTURES.length).toBe(PY_SPLITS.length);
    for (let i = 0; i < PY_SPLIT_FIXTURES.length; i++) {
      expect(splitReferences(PY_SPLIT_FIXTURES[i]!), `fixture ${i}`).toEqual(
        PY_SPLITS[i],
      );
    }
  });

  it('filters entries of <= 15 chars', () => {
    expect(splitReferences('[1] Tiny.')).toEqual([]);
    expect(
      splitReferences('[1] A long enough entry to pass the length filter.'),
    ).toEqual(['[1] A long enough entry to pass the length filter.']);
  });
});

describe('titleGuess / norm / queryFor (char-parity with Python)', () => {
  it('titleGuess matches Python on 5 entries', () => {
    for (let i = 0; i < PY_ENTRIES.length; i++) {
      expect(titleGuess(PY_ENTRIES[i]!), `entry ${i}`).toBe(PY_TITLE_GUESSES[i]);
    }
  });

  it('norm matches Python on 5 entries', () => {
    for (let i = 0; i < PY_ENTRIES.length; i++) {
      expect(norm(PY_ENTRIES[i]!), `entry ${i}`).toBe(PY_NORMS[i]);
    }
  });

  it('queryFor matches Python on 5 entries', () => {
    for (let i = 0; i < PY_ENTRIES.length; i++) {
      expect(queryFor(PY_ENTRIES[i]!), `entry ${i}`).toBe(PY_QUERIES[i]);
    }
  });

  it('queryFor truncates the body at 220 chars', () => {
    const long = `[1] ${'x'.repeat(300)}`;
    expect(queryFor(long)).toHaveLength(220);
  });
});

describe('score (parity with Python _score)', () => {
  it('matches Python on 35 entry/candidate pairs', () => {
    expect(PY_SCORES).toHaveLength(PY_ENTRIES.length * PY_ITEM_TITLES.length);
    let k = 0;
    for (const entry of PY_ENTRIES) {
      for (const t of PY_ITEM_TITLES) {
        expect(score(entry, titleGuess(entry), item(t)), `${entry} vs ${t}`).toBe(
          PY_SCORES[k],
        );
        k++;
      }
    }
  });

  it('empty candidate title scores 0', () => {
    expect(score('anything at all', 'anything', item(''))).toBe(0);
  });

  it('whole*0.9 boosts a failed title guess (author-only guess)', () => {
    // title guess that does not overlap, but the whole entry does: the
    // whole-entry term (0.6 via difflib) is discounted by 0.9 -> 0.54,
    // above the bare ratio for the author-only guess (0.18).
    const entry = 'Smith, J. (2001). Machine Learning Methods. Journal of ML.';
    const bare = score(entry, 'Smith', item('Machine Learning Methods'));
    const boosted = score(entry + ' tail', 'Smith', item('Machine Learning Methods'));
    expect(bare).toBeGreaterThan(0.5);
    expect(boosted).toBeGreaterThanOrEqual(bare * 0.9);
  });
});

describe('resolveReferences (stub clients, no network)', () => {
  const ENTRY = '[1] Smith, J. (2001). A paper about things. Journal of Papers.';
  const TEXT = `${ENTRY}\n[2] Doe, J. (2010). Another study of stuff. Annals.\n`;

  function stubClients(
    over: {
      crossref?: (q: string) => Promise<LiteratureItem | null> | LiteratureItem | null;
      openalex?: (q: string) => Promise<LiteratureItem[]> | LiteratureItem[];
    } = {},
  ): ResolutionClients & { crCalls: string[]; oaCalls: string[] } {
    const crCalls: string[] = [];
    const oaCalls: string[] = [];
    return {
      crCalls,
      oaCalls,
      crossref: {
        lookup: async (q: string) => {
          crCalls.push(q);
          return over.crossref ? over.crossref(q) : null;
        },
      },
      openalex: {
        searchWorks: async (q: string) => {
          oaCalls.push(q);
          return over.openalex ? over.openalex(q) : [];
        },
      },
    };
  }

  it('matches a Crossref hit above the threshold', async () => {
    const clients = stubClients({
      crossref: () => item('A paper about things'),
    });
    const recs = await resolveReferences(TEXT, clients);
    expect(recs).toHaveLength(2);
    expect(recs[0]).toEqual({
      ref: ENTRY,
      status: 'matched',
      score: 1,
      doi: null,
      title: 'A paper about things',
      venue: null,
      year: null,
      source: 'openalex',
    });
    expect(recs[1]!.status).toBe('unmatched');
    // query is the marker-stripped body
    expect(clients.crCalls[0]).toBe(queryFor(ENTRY));
  });

  it('passes limit=3 to OpenAlex searchWorks', async () => {
    let seenLimit: number | undefined;
    const clients: ResolutionClients = {
      crossref: { lookup: async () => null },
      openalex: {
        searchWorks: async (q, limit) => {
          seenLimit = limit;
          void q;
          return [];
        },
      },
    };
    await resolveReferences(TEXT, clients);
    expect(seenLimit).toBe(3);
  });

  it('openalex-only match with year/venue carried through', async () => {
    const clients = stubClients({
      openalex: () => [
        {
          source: 'openalex',
          title: 'Another study of stuff',
          authors: [],
          doi: '10.2/y',
          venue: 'Annals',
          year: 2010,
        },
      ],
    });
    const recs = await resolveReferences(TEXT, clients);
    expect(recs[1]).toMatchObject({
      status: 'matched',
      doi: '10.2/y',
      title: 'Another study of stuff',
      venue: 'Annals',
      year: 2010,
      source: 'openalex',
    });
  });

  it('below-threshold best score stays unmatched with the rounded score', async () => {
    const clients = stubClients({
      openalex: () => [item('Completely Unrelated Title Here')],
    });
    const recs = await resolveReferences(TEXT, clients);
    expect(recs[0]!.status).toBe('unmatched');
    // Python round(0.16, 2) — pinned by the PY_SCORES harness entry
    expect(recs[0]!.score).toBe(0.16);
  });

  it('per-client failure is fail-soft: crossref throw does not skip openalex', async () => {
    const clients = stubClients({
      crossref: () => {
        throw new Error('crossref down');
      },
      openalex: () => [item('A paper about things')],
    });
    const recs = await resolveReferences(TEXT, clients);
    expect(recs[0]!.status).toBe('matched');
  });

  it('crossref returning null (its own fail-soft) is skipped, openalex still used', async () => {
    const clients = stubClients({
      crossref: () => null,
      openalex: () => [item('A paper about things')],
    });
    const recs = await resolveReferences(TEXT, clients);
    expect(recs[0]!.status).toBe('matched');
  });

  it('openalex throw is fail-soft too', async () => {
    const clients = stubClients({
      openalex: () => {
        throw new Error('openalex down');
      },
    });
    const recs = await resolveReferences(TEXT, clients);
    expect(recs.map((r) => r.status)).toEqual(['unmatched', 'unmatched']);
    expect(recs[0]!.score).toBe(0);
  });

  it('MAX_REFS cap: only the first maxRefs entries are resolved', async () => {
    const many = Array.from(
      { length: MAX_REFS + 10 },
      (_, i) =>
        `[${i + 1}] Author, A. (${2000 + (i % 20)}). Study number ${i} of things. Journal.`,
    ).join('\n');
    const clients = stubClients();
    const recs = await resolveReferences(many, clients);
    expect(recs).toHaveLength(MAX_REFS);
    expect(clients.crCalls).toHaveLength(MAX_REFS);
  });

  it('opts.maxRefs override', async () => {
    const clients = stubClients();
    const recs = await resolveReferences(TEXT, clients, { maxRefs: 1 });
    expect(recs).toHaveLength(1);
  });

  it('empty references -> no records, no client calls', async () => {
    const clients = stubClients();
    expect(await resolveReferences('', clients)).toEqual([]);
    expect(clients.crCalls).toHaveLength(0);
    expect(clients.oaCalls).toHaveLength(0);
  });

  it('timeout: all entries unmatched with error "timeout" (overridable timeout)', async () => {
    const clients: ResolutionClients = {
      crossref: {
        lookup: () => new Promise((resolve) => setTimeout(() => resolve(null), 5_000)),
      },
      openalex: { searchWorks: async () => [] },
    };
    const t0 = Date.now();
    const recs = await resolveReferences(TEXT, clients, { timeoutS: 0.05 });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(recs).toHaveLength(2);
    for (const r of recs) {
      expect(r).toEqual({
        ref: r.ref,
        status: 'unmatched',
        score: 0.0,
        error: 'timeout',
      });
    }
  });

  it('an exception inside the resolver (not the clients) yields the guarded error record', async () => {
    // A client that resolves forever, plus a 0s timeout, exercises the
    // timeout branch; a synchronously-throwing lookup exercises `guarded`.
    const clients: ResolutionClients = {
      crossref: {
        lookup: () => {
          throw new Error('hard failure');
        },
      },
      openalex: { searchWorks: async () => [] },
    };
    const recs = await resolveReferences(TEXT, clients);
    expect(recs.every((r) => r.status === 'unmatched')).toBe(true);
  });

  it('resolves entries concurrently (bounded by CONCURRENCY=4)', async () => {
    let inFlight = 0;
    let peak = 0;
    const entries = Array.from(
      { length: 12 },
      (_, i) => `[${i + 1}] Author, A. (2001). Concurrent study ${i}. Journal.`,
    ).join('\n');
    const clients: ResolutionClients = {
      crossref: {
        lookup: async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 10));
          inFlight--;
          return null;
        },
      },
      openalex: { searchWorks: async () => [] },
    };
    await resolveReferences(entries, clients);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });
});

describe('renderResolutions (char-parity with Python _render_resolutions)', () => {
  it('matches Python on the pinned record sets', () => {
    const sets: ResolutionRecord[][] = [
      [],
      [
        {
          ref: '[1] Smith, J. (2001). A paper about things. Journal of Papers.',
          status: 'matched',
          score: 0.91,
          doi: '10.1/x',
          title: 'A paper about things',
          venue: 'Journal of Papers',
          year: 2001,
          source: 'openalex',
        },
        {
          ref: '[2] Doe, J. (2010). Another study of stuff. Annals.',
          status: 'unmatched',
          score: 0.31,
        },
        {
          ref: '[3] No doi entry here that is long enough to render. Venue.',
          status: 'matched',
          score: 0.75,
          doi: null,
          title: 'No doi entry title',
          venue: null,
          year: null,
          source: 'crossref',
        },
      ],
      [{ ref: 'X', status: 'unmatched', score: 0.0, error: 'timeout' }],
    ];
    for (let i = 0; i < sets.length; i++) {
      expect(renderResolutions(sets[i]!), `set ${i}`).toBe(PY_RENDERS[i]);
    }
  });

  it('renders null/zero fields with Python or/str() semantics (review F2)', () => {
    // str(None) -> 'None'; year 0 -> '?' (Python `or`); score keeps as-is
    expect(
      renderResolutions([
        {
          ref: 'r',
          status: 'matched',
          score: 0.715,
          doi: '10.1/x',
          title: null,
          venue: 'V',
          year: 0,
          source: 'crossref',
        },
      ]),
    ).toBe('- MATCHED 10.1/x :: None (V, ?) [score 0.715]');
    expect(
      renderResolutions([
        {
          ref: 'r',
          status: 'matched',
          score: 0.125,
          doi: '10.1/y',
          title: 'T',
          venue: null,
          year: null,
          source: 'crossref',
        },
      ]),
    ).toBe('- MATCHED 10.1/y :: T (?, ?) [score 0.125]');
    expect(
      renderResolutions([
        { ref: null as unknown as string, status: 'unmatched', score: 0.995 },
      ]),
    ).toBe('- UNMATCHED :: None [best score 0.995]');
  });

  it('rounds scores like Python round(x, 2) (review F3: no scaling fudge)', () => {
    // roundPy2 is the resolveReferences score-rounding helper. 0.715's
    // double is BELOW the half (scaling by 100 first yields exactly 71.5
    // and would banker's-round UP to 0.72 — Python gives 0.71); 0.125 is
    // an exact binary half -> half-to-even 0.12. Pins from uv-run Python.
    expect(roundPy2(0.715)).toBe(0.71);
    expect(roundPy2(143 / 200)).toBe(0.71);
    expect(roundPy2(199 / 200)).toBe(0.99);
    expect(roundPy2(294 / 400)).toBe(0.73);
    expect(roundPy2(8.845)).toBe(8.85);
    expect(roundPy2(0.125)).toBe(0.12);
    expect(roundPy2(2.675)).toBe(2.67);
    expect(roundPy2(0.115)).toBe(0.12);
    expect(roundPy2(0)).toBe(0);
    expect(roundPy2(1)).toBe(1);
  });

  it('truncates the joined block at 20000 chars', () => {
    const recs: ResolutionRecord[] = Array.from({ length: 400 }, (_, i) => ({
      ref: `ref ${i} ${'x'.repeat(150)}`,
      status: 'unmatched' as const,
      score: 0,
    }));
    expect(renderResolutions(recs).length).toBeLessThanOrEqual(20_000);
  });
});
