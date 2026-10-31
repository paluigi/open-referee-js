import { describe, expect, it } from 'vitest';
import {
  emptyAudit,
  runBibliographyAudit,
  type BibliographyAudit,
} from '../src/pipeline/bibliography';
import { Block, Document } from '../src/ingestion/document';
import { newContextPack } from '../src/literature/types';
import { LLMError } from '../src/providers/base';
import { BudgetExceeded } from '../src/providers/usage';
import type { CallJson } from '../src/pipeline/claims';
import type { CallResult } from '../src/pipeline/orchestrator';
import { bibliographySystem } from '../src/pipeline/prompts';

function makeDoc(): Document {
  return new Document({
    title: 'T',
    blocks: [
      new Block({
        id: 'b1',
        text: 'We build on Smith (2001) and the method of [2].',
      }),
    ],
    referencesText:
      '[1] Smith, J. (2001). A paper. Journal of Papers.\n[2] Doe, J. (2010). Another. Annals.\n',
  });
}

describe('runBibliographyAudit', () => {
  it('no referencesText -> empty audit, no LLM call', async () => {
    const calls: unknown[] = [];
    const callJson: CallJson = async () => {
      calls.push(1);
      return { kind: 'invalid_json' };
    };
    const doc = makeDoc();
    doc.referencesText = undefined;
    const { audit } = await runBibliographyAudit({
      callJson,
      doc,
      pack: newContextPack('T'),
    });
    expect(audit).toEqual(emptyAudit());
    expect(calls).toHaveLength(0);
  });

  it('happy path: slices references/intext, SMALL role, setdefault in_text_issues', async () => {
    const seen: { role: string; system: string; user: string }[] = [];
    const callJson: CallJson = async (role, system, user) => {
      seen.push({ role, system, user });
      return {
        kind: 'ok',
        value: { entries: [{ raw_entry: '[1]', status: 'verified' }] },
      };
    };
    const { audit } = await runBibliographyAudit({
      callJson,
      doc: makeDoc(),
      pack: newContextPack('T'),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.role).toBe('small');
    expect(seen[0]!.system).toBe(bibliographySystem);
    // in_text_issues setdefault: missing key becomes []
    expect(audit).toEqual({
      entries: [{ raw_entry: '[1]', status: 'verified' }],
      in_text_issues: [],
      missing_key_references: [],
    });
    // intext line made it into the user prompt
    expect(seen[0]!.user).toContain('- Smith (2001) ::');
    expect(seen[0]!.user).toContain('[1] Smith, J. (2001).');
  });

  it('fail-soft: LLMError and invalid JSON yield the empty audit', async () => {
    const llmError: CallJson = async () => ({
      kind: 'llm_error',
      error: new LLMError('boom'),
    });
    const badJson: CallJson = async (): Promise<CallResult> => ({
      kind: 'invalid_json',
    });
    for (const callJson of [llmError, badJson]) {
      const { audit } = await runBibliographyAudit({
        callJson,
        doc: makeDoc(),
        pack: newContextPack('T'),
      });
      expect(audit).toEqual(emptyAudit());
    }
  });

  it('budget cap surfaces to the caller', async () => {
    const capErr = new BudgetExceeded(1.2, 1.0);
    const callJson: CallJson = async () => ({ kind: 'budget', error: capErr });
    const { audit, budget } = await runBibliographyAudit({
      callJson,
      doc: makeDoc(),
      pack: newContextPack('T'),
    });
    expect(audit).toEqual(emptyAudit());
    expect(budget).toBe(capErr);
  });

  it('preserves a non-array in_text_issues as [] but keeps arrays as-is', async () => {
    const callJson: CallJson = async () => ({
      kind: 'ok',
      value: {
        entries: [],
        in_text_issues: [{ citation: 'x', verdict: 'overstated' }],
        missing_key_references: [{ title: 'Missing' }],
      },
    });
    const { audit }: { audit: BibliographyAudit } = await runBibliographyAudit({
      callJson,
      doc: makeDoc(),
      pack: newContextPack('T'),
    });
    expect(audit.in_text_issues).toEqual([{ citation: 'x', verdict: 'overstated' }]);
    expect(audit.missing_key_references).toEqual([{ title: 'Missing' }]);
  });
});
