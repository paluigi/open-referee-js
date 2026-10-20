/**
 * Run state: resumable stage machine for a review run.
 *
 * Port of Python `open_referee/pipeline/state.py`, narrowed to the TS
 * pipeline (triage -> claims -> survey -> verify -> challenge -> meta ->
 * validate -> assemble; scout/bibliography remain future stages).
 * Pure TypeScript, no I/O: persistence lives in `src/runs/store.ts`.
 */

export type Stage =
  | 'triage'
  | 'claims'
  | 'survey'
  | 'verify'
  | 'challenge'
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

export interface RunState {
  runId: string;
  documentTitle: string;
  /** stage -> latest status; missing stages are implicitly pending. */
  stages: Partial<Record<Stage, StageStatus>>;
  /** Full event log, persisted so finished runs can replay them. */
  events: StageEvent[];
  /** Final ReviewReport (assembled by the orchestrator), when reached. */
  report?: unknown;
  /** True when any stage failed or was skipped: the report is incomplete. */
  partial: boolean;
  /** ISO 8601 timestamps. */
  startedAt: string;
  updatedAt: string;
}

/**
 * Canonical stage order (Python: ingest -> triage -> claims -> survey ->
 * scout -> verify -> challenge -> bibliography -> meta -> validate ->
 * assemble; scout/bibliography deferred). Old persisted runs with the
 * previous 6-stage shape stay readable: `stages` is Partial.
 */
export const STAGES: readonly Stage[] = [
  'triage',
  'claims',
  'survey',
  'verify',
  'challenge',
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
