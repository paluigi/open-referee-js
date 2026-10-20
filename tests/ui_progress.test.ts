import { beforeEach, describe, expect, it } from 'vitest';
import { ProgressController } from '../src/ui/progress';
import type { StageEvent } from '../src/pipeline/state';

function ev(
  stage: StageEvent['stage'],
  status: StageEvent['status'],
  detail?: string,
): StageEvent {
  return detail === undefined
    ? { stage, status, at: '2026-01-01T00:00:00Z' }
    : { stage, status, at: '2026-01-01T00:00:00Z', detail };
}

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.appendChild(root);
});

describe('ProgressController', () => {
  it('builds bar, label, and a per-stage checklist', () => {
    const c = new ProgressController(root);
    const bar = root.querySelector('progress');
    expect(bar).not.toBeNull();
    expect(root.querySelectorAll('li')).toHaveLength(9);
    expect(
      root.querySelector<HTMLLIElement>('li[data-stage="triage"]')?.dataset.status,
    ).toBe('pending');
    expect(c).toBeDefined();
  });

  it('is determinate when unitsTotal is known', () => {
    const c = new ProgressController(root);
    c.onEvent(ev('challenge', 'running'), { unitsDone: 1, unitsTotal: 3 });
    const bar = root.querySelector('progress')!;
    expect(bar.hasAttribute('value')).toBe(true);
    expect(bar.value).toBe(1);
    expect(bar.max).toBe(3);
    expect(root.querySelector('.progress-label')?.textContent).toContain('1/3');
    expect(
      root.querySelector<HTMLLIElement>('li[data-stage="challenge"]')?.dataset.status,
    ).toBe('running');
  });

  it('is indeterminate when no progress is given', () => {
    const c = new ProgressController(root);
    c.onEvent(ev('triage', 'running'));
    const bar = root.querySelector('progress')!;
    expect(bar.hasAttribute('value')).toBe(false);
    expect(root.querySelector('.progress-label')?.textContent).toContain('Triage');
  });

  it('tracks stage transitions in the checklist', () => {
    const c = new ProgressController(root);
    c.onEvent(ev('triage', 'running'));
    c.onEvent(ev('triage', 'failed', 'bad JSON'));
    const li = root.querySelector<HTMLLIElement>('li[data-stage="triage"]')!;
    expect(li.dataset.status).toBe('failed');
    expect(root.querySelector('.progress-label')?.textContent).toContain('failed');
  });

  it('marks done stages', () => {
    const c = new ProgressController(root);
    c.onEvent(ev('survey', 'done'));
    expect(
      root.querySelector<HTMLLIElement>('li[data-stage="survey"]')?.dataset.status,
    ).toBe('done');
    const bar = root.querySelector('progress')!;
    expect(bar.value).toBe(1);
  });

  it('finish completes the bar', () => {
    const c = new ProgressController(root);
    c.setIndeterminate('working');
    c.finish('report ready');
    const bar = root.querySelector('progress')!;
    expect(bar.value).toBe(1);
    expect(root.querySelector('.progress-label')?.textContent).toBe('report ready');
  });
});
