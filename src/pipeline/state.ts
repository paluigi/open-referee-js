/**
 * Run state: resumable stage machine for a review run.
 *
 * Port of Python `open_referee/pipeline/state.py`, narrowed to the TS
 * pipeline (triage -> claims -> survey -> scout -> verify -> challenge ->
 * bibliography -> meta -> validate -> assemble). Pure TypeScript, no I/O:
 * persistence lives in `src/runs/store.ts`.
 */

export type Stage =
  | 'triage'
  | 'claims'
  | 'survey'
  | 'scout'
  | 'verify'
  | 'challenge'
  | 'bibliography'
  | 'meta'
  | 'validate'
  | 'assemble';

export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/** A single stage transition, append-only in RunState.events. */
export interface StageEvent {
  stage: Stage;
  status: StageStatus;
  /** ISO 8601 timestamp. */
  at: string;
  detail?: string;
}

/** Persisted per-stage artifacts: a resume re-enters at the first stage
 * whose artifact is missing. Keys are JSON-safe (Python `state.artifacts`). */
export type StageArtifacts = {
  triage?: Record<string, unknown>;
  claims?: Record<string, unknown>[];
  survey?: unknown;
  /** verify-stage output (per-claim workers + lenses), pre-challenger. */
  candidates?: unknown[];
  challenge?: unknown[];
  bibliography?: unknown;
  /** meta output: overall_feedback + recommendation (Python draft_review). */
  draftReview?: { overall: string; recommendation?: string };
};

export interface RunState {
  runId: string;
  documentTitle: string;
  /** stage -> latest status; missing stages are implicitly pending. */
  stages: Partial<Record<Stage, StageStatus>>;
  /** Full event log, persisted so finished runs can replay them. */
  events: StageEvent[];
  /** Final ReviewReport (assembled by the orchestrator), when reached. */
  report?: unknown;
  /** Per-stage artifacts for resume (see StageArtifacts). */
  artifacts?: StageArtifacts;
  /** Raw manuscript document snapshot (resume needs the doc to re-run). */
  docData?: unknown;
  /** True when any stage failed or was skipped: the report is incomplete. */
  partial: boolean;
  /** ISO 8601 timestamps. */
  startedAt: string;
  updatedAt: string;
}

/**
 * Canonical stage order (Python: ingest -> triage -> claims -> survey ->
 * scout -> verify -> challenge -> bibliography -> meta -> validate ->
 * assemble). Old persisted runs with the previous 6-, 8- or 9-stage shapes
 * stay readable: `stages` is Partial.
 */
export const STAGES: readonly Stage[] = [
  'triage',
  'claims',
  'survey',
  'scout',
  'verify',
  'challenge',
  'bibliography',
  'meta',
  'validate',
  'assemble',
];

function nowIso(): string {
  return new Date().toISOString();
}

export function createRunState(runId: string, documentTitle: string): RunState {
  const at = nowIso();
  return {
    runId,
    documentTitle,
    stages: {},
    events: [],
    partial: false,
    startedAt: at,
    updatedAt: at,
  };
}

/**
 * Transition a stage to a new status: records the status, appends a
 * StageEvent to the log, and bumps updatedAt. Returns the appended event.
 */
export function setStage(
  state: RunState,
  stage: Stage,
  status: StageStatus,
  detail?: string,
): StageEvent {
  state.stages[stage] = status;
  const event: StageEvent =
    detail === undefined
      ? { stage, status, at: nowIso() }
      : { stage, status, at: nowIso(), detail };
  state.events.push(event);
  state.updatedAt = event.at;
  return event;
}

/** Latest status of a stage; pending when the stage never ran. */
export function stageStatus(state: RunState, stage: Stage): StageStatus {
  return state.stages[stage] ?? 'pending';
}

/**
 * Python `_stage_or_resume` resume semantics, narrowed to the TS pipeline:
 * the first stage that is neither done-with-artifact nor terminally
 * skipped, in STAGES order (assemble closes the run). A stage marked
 * 'skipped' stays skipped on resume only when the run drained to a report;
 * when the report is absent the run died mid-drain and every stage re-enters.
 */
export function firstOpenStage(state: RunState): Stage {
  const a = state.artifacts ?? {};
  for (let i = 0; i < STAGES.length; i++) {
    const stage = STAGES[i]!;
    const status = stageStatus(state, stage);
    if (status === 'done') {
      // Done WITHOUT its artifact = dead mid-persist: re-run the stage.
      if (stageHasArtifact(a, stage)) continue;
      return stage;
    }
    if (status === 'skipped' && state.report !== undefined) continue;
    return stage;
  }
  return 'assemble';
}

function stageHasArtifact(a: StageArtifacts, stage: Stage): boolean {
  switch (stage) {
    case 'triage':
      return a.triage !== undefined;
    case 'claims':
      return a.claims !== undefined;
    case 'survey':
      return a.survey !== undefined;
    case 'verify':
      // Candidates are the verify output (Python artifacts['candidates']):
      // a done verify without them would resume into an empty challenge.
      return a.candidates !== undefined;
    case 'challenge':
      return a.challenge !== undefined;
    case 'bibliography':
      return a.bibliography !== undefined;
    case 'meta':
      // Draft review (overall/recommendation) is the meta output
      // (Python artifacts['draft_review']).
      return a.draftReview !== undefined;
    default:
      // scout/validate persist no artifact: done means done.
      return true;
  }
}
