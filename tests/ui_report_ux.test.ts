import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { manuscriptView, reportView } from '../src/ui/app';
import { Block, Document } from '../src/ingestion/document';
import type { ReviewReport } from '../src/report/models';
import type { RunState } from '../src/pipeline/state';

// The print stylesheet must exist and hide the app chrome while keeping the
// report + manuscript printable (Stage 6 print smoke).
const CSS = readFileSync('src/ui/style.css', 'utf8');

function makeRunState(): RunState {
  return {
    runId: 'r1',
    documentTitle: 'Test Paper',
    stages: { assemble: 'done' },
    events: [],
    partial: false,
    startedAt: '2026-10-17T00:00:00.000Z',
    updatedAt: '2026-10-17T00:00:00.000Z',
  };
}

function makeReport(withBlock: boolean): ReviewReport {
  return {
    paperTitle: 'Test Paper',
    overall: '## Weaknesses\n\nOverstated.',
    comments: [
      {
        id: 'c000',
        section: 'Methods',
        quote: '999 replications',
        comment: 'Count contradicts Table 1.',
        severity: 0.55,
        paragraphAnchor: 'bootstrap with 999 replications',
        ...(withBlock ? { blockId: 'b2', anchorConfidence: 1.0 } : {}),
      },
    ],
    usage: {
      byRole: {},
      estimatedCostUsd: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
    },
    partial: false,
    generatedAt: '2026-10-17T00:00:00.000Z',
  };
}

function makePane(): HTMLElement {
  const doc = new Document({
    title: 'Test Paper',
    blocks: [
      new Block({ id: 'b1', text: 'Intro text.' }),
      new Block({ id: 'b2', text: 'bootstrap with 999 replications' }),
    ],
  });
  const pane = manuscriptView(doc);
  document.body.appendChild(pane);
  return pane;
}

describe('print stylesheet (Stage 6)', () => {
  it('hides app chrome in @media print', () => {
    const m = CSS.match(/@media print \{[\s\S]*\n\}/);
    expect(m).not.toBeNull();
    const block = m![0];
    for (const sel of [
      '#settings-panel',
      '#progress-root',
      '#resume-section',
      '#run-btn',
      '#download-md',
      '.anchor-link',
    ]) {
      expect(block).toContain(sel);
    }
    expect(block).toContain('display: none');
  });

  it('prints the manuscript pane inline and breaks pages before sections', () => {
    const m = CSS.match(/@media print \{[\s\S]*\n\}/)!;
    expect(m[0]).toContain('#manuscript-pane');
    expect(m[0]).toContain('page-break-before: always');
    expect(m[0]).toContain('page-break-inside: avoid');
  });
});

describe('report anchor links (Stage 6)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('renders an anchor button only for comments with a blockId; click highlights the block', () => {
    const pane = makePane();
    document.body.appendChild(reportView(makeReport(true), makeRunState(), pane));
    const btn = document.querySelector<HTMLButtonElement>(
      '.anchor-link[data-block-id="b2"]',
    );
    expect(btn).not.toBeNull();
    btn!.click();
    const block = document.getElementById('block-b2')!;
    expect(block.classList.contains('block-highlight')).toBe(true);
    // a "back to comment" link appears near the block
    expect(block.querySelector('.anchor-back')).not.toBeNull();
  });

  it('no anchor button without a resolved block', () => {
    document.body.appendChild(reportView(makeReport(false), makeRunState()));
    expect(document.querySelector('.anchor-link')).toBeNull();
  });

  it('manuscriptView gives every block an id-anchored element', () => {
    document.body.innerHTML = '';
    const pane = makePane();
    expect(pane.querySelector('#block-b1')).not.toBeNull();
    expect(pane.querySelector('#block-b2')).not.toBeNull();
  });
});
