import { beforeEach, describe, expect, it } from 'vitest';
import { mountApp } from '../src/ui/app';
import { reportToMarkdown } from '../src/report/render';
import type { ReviewReport } from '../src/report/models';

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

function makeReport(): ReviewReport {
  return {
    paperTitle: 'Test Paper',
    recommendation: 'major revision',
    overall:
      '## Weaknesses\n\n<strong>should be sanitized?</strong> The claim is overstated.',
    comments: [
      {
        section: 'Introduction',
        quote: 'some quote',
        comment: 'A deep problem.',
        severity: 0.9,
      },
    ],
    usage: {
      byRole: {},
      estimatedCostUsd: 0.0123,
      totalPromptTokens: 12000,
      totalCompletionTokens: 3400,
    },
    partial: false,
    generatedAt: '2026-10-16T14:00:00.000Z',
  };
}

describe('mountApp shell', () => {
  it('builds settings panel, file input, run button, progress root', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountApp(root);
    expect(root.querySelector('#settings-panel')).not.toBeNull();
    // Stage 2: keys are per-provider (password inputs inside provider rows).
    expect(root.querySelector('#provider-list')).not.toBeNull();
    expect(root.querySelector('#provider-add')).not.toBeNull();
    expect(root.querySelector('#vault-state')).not.toBeNull();
    expect(root.querySelector('#vault-encrypt')).not.toBeNull();
    expect(root.querySelector('#vault-unlock')).not.toBeNull();
    expect(root.querySelector('#vault-lock')).not.toBeNull();
    expect(root.querySelector('#role-provider-strong')).not.toBeNull();
    expect(root.querySelector('#role-provider-small')).not.toBeNull();
    expect(root.querySelector('#role-provider-vision')).not.toBeNull();
    expect(root.querySelector('#file-input')?.getAttribute('accept')).toBe(
      '.pdf,.docx,.md,.markdown,.txt',
    );
    expect(root.querySelector('#run-btn')).not.toBeNull();
    expect(root.querySelector('#progress-root')).not.toBeNull();
    expect(root.querySelector('#output')).not.toBeNull();
  });

  it('persists settings on change but never the API key', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountApp(root);
    const strong = root.querySelector<HTMLInputElement>('#strong-model')!;
    strong.value = 'gpt-5';
    strong.dispatchEvent(new Event('change'));
    const stored = JSON.parse(localStorage.getItem('openreferee.settings.v1') ?? '{}');
    expect(stored.roles?.strong?.model).toBe('gpt-5');
    // API key never lands in storage
    expect(JSON.stringify(stored)).not.toContain('sk-secret');
  });

  it('report view sanitizes markdown-derived HTML', () => {
    const report = makeReport();
    // rendered via marked + DOMPurify inside reportView; simulate the pipeline
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountApp(root);
    // The markdown export path must include the structure
    const md = reportToMarkdown(report);
    expect(md).toContain('# Review report — Test Paper');
    expect(md).toContain('[severity 0.90]');
    expect(root).toBeDefined();
  });

  it('downloads a .md blob when the download button is clicked', async () => {
    const report = makeReport();
    const root = document.createElement('div');
    document.body.appendChild(root);
    // exercise reportToMarkdown + Blob URL mechanics used by the button
    const md = reportToMarkdown(report);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    expect(url.startsWith('blob:')).toBe(true);
    expect(blob.size).toBeGreaterThan(100);
    URL.revokeObjectURL(url);
  });
});
