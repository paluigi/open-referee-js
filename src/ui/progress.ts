/**
 * Progress UI: binds the orchestrator event stream to a <progress> element,
 * a stage label, and a per-stage checklist.
 *
 * Determinate when the event carries unitsTotal; indeterminate otherwise.
 */
import type { Stage, StageEvent } from '../pipeline/state';
import type { StageProgress } from '../pipeline/orchestrator';

const STAGE_LABELS: Record<Stage, string> = {
  triage: 'Triage',
  claims: 'Claim inventory',
  survey: 'Literature survey',
  scout: 'Community scout',
  verify: 'Claim verification',
  challenge: 'Section challenge',
  meta: 'Meta-review',
  validate: 'Validate comments',
  assemble: 'Assemble report',
};

const STAGE_ORDER: Stage[] = [
  'triage',
  'claims',
  'survey',
  'scout',
  'verify',
  'challenge',
  'meta',
  'validate',
  'assemble',
];

export class ProgressController {
  readonly root: HTMLElement;
  private readonly bar: HTMLProgressElement;
  private readonly label: HTMLElement;
  private readonly items: Map<Stage, HTMLElement>;

  constructor(root: HTMLElement) {
    this.root = root;
    this.bar = document.createElement('progress');
    this.bar.max = 1;
    this.bar.value = 0;
    this.label = document.createElement('p');
    this.label.className = 'progress-label';
    const list = document.createElement('ul');
    list.className = 'stage-list';
    this.items = new Map();
    for (const stage of STAGE_ORDER) {
      const li = document.createElement('li');
      li.dataset.stage = stage;
      li.dataset.status = 'pending';
      li.textContent = STAGE_LABELS[stage];
      list.appendChild(li);
      this.items.set(stage, li);
    }
    root.replaceChildren(this.bar, this.label, list);
  }

  /** Feed one orchestrator event (with optional per-section progress). */
  onEvent(e: StageEvent, progress?: StageProgress): void {
    this.setStageStatus(e.stage, e.status);
    if (e.status === 'running') {
      if (progress && progress.unitsTotal > 0) {
        this.bar.classList.remove('indeterminate');
        this.bar.max = progress.unitsTotal;
        this.bar.value = progress.unitsDone;
        this.label.textContent = `${STAGE_LABELS[e.stage]} — ${progress.unitsDone}/${progress.unitsTotal}`;
      } else {
        this.setIndeterminate(`${STAGE_LABELS[e.stage]}…`);
      }
    } else if (e.status === 'done') {
      this.bar.classList.remove('indeterminate');
      this.bar.max = 1;
      this.bar.value = 1;
      this.label.textContent = `${STAGE_LABELS[e.stage]} — done`;
    } else if (e.status === 'failed') {
      this.setIndeterminate(
        `${STAGE_LABELS[e.stage]} — failed${e.detail ? `: ${e.detail}` : ''}`,
      );
    } else if (e.status === 'skipped') {
      this.label.textContent = `${STAGE_LABELS[e.stage]} — skipped`;
    }
  }

  /** Show an activity pulse with no known completion fraction. */
  setIndeterminate(label: string): void {
    this.bar.classList.add('indeterminate');
    // `<progress>` without value/max renders indeterminate in HTML.
    this.bar.removeAttribute('value');
    this.label.textContent = label;
  }

  setStageStatus(stage: Stage, status: StageEvent['status']): void {
    const li = this.items.get(stage);
    if (li) li.dataset.status = status;
  }

  /** Mark everything not yet finished as skipped (e.g. after an early exit). */
  finish(label: string): void {
    this.bar.classList.remove('indeterminate');
    this.bar.max = 1;
    this.bar.value = 1;
    this.label.textContent = label;
  }
}
