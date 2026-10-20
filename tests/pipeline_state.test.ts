import { describe, expect, it } from 'vitest';
import {
  createRunState,
  setStage,
  stageStatus,
  STAGES,
  type RunState,
  type StageEvent,
} from '../src/pipeline/state';

describe('RunState', () => {
  it('creates a fresh pending state with ISO timestamps', () => {
    const s = createRunState('run1', 'Test Paper');
    expect(s.runId).toBe('run1');
    expect(s.documentTitle).toBe('Test Paper');
    expect(s.stages).toEqual({});
    expect(s.events).toEqual([]);
    expect(s.report).toBeUndefined();
    expect(s.partial).toBe(false);
    expect(() => new Date(s.startedAt).toISOString()).not.toThrow();
    expect(s.startedAt).toBe(s.updatedAt);
  });

  it('setStage appends an event, updates stages, bumps updatedAt', () => {
    const s = createRunState('run1', 'P');
    const before = s.updatedAt;
    const ev = setStage(s, 'triage', 'running');
    expect(s.stages['triage']).toBe('running');
    expect(s.events).toHaveLength(1);
    expect(ev).toEqual(s.events[0]);
    expect(new Date(s.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime(),
    );

    setStage(s, 'triage', 'done', 'parsed OK');
    expect(s.events).toHaveLength(2);
    expect(s.events[1]).toEqual({
      stage: 'triage',
      status: 'done',
      at: expect.any(String),
      detail: 'parsed OK',
    });
  });

  it('stageStatus returns pending for unknown stages, latest otherwise', () => {
    const s = createRunState('run1', 'P');
    expect(stageStatus(s, 'survey')).toBe('pending');
    setStage(s, 'survey', 'running');
    setStage(s, 'survey', 'failed');
    expect(stageStatus(s, 'survey')).toBe('failed');
  });

  it('event shape matches StageEvent', () => {
    const s: RunState = createRunState('r', 't');
    const ev: StageEvent = setStage(s, 'assemble', 'skipped', 'budget');
    expect(Object.keys(ev).sort()).toEqual(['at', 'detail', 'stage', 'status']);
  });

  it('STAGES order is triage -> claims -> survey -> scout -> verify -> challenge -> meta -> validate -> assemble', () => {
    expect([...STAGES]).toEqual([
      'triage',
      'claims',
      'survey',
      'scout',
      'verify',
      'challenge',
      'meta',
      'validate',
      'assemble',
    ]);
  });

  it('a stored 6-stage run (pre-Stage-4 shape) loads and renders without crashing', () => {
    // Shape persisted by the Stage-1..3 orchestrator: no 'claims'/'verify'
    // entries. `stages` is Partial, so the old payload stays a valid RunState.
    const legacy = {
      runId: 'legacy1',
      documentTitle: 'Old Paper',
      stages: {
        triage: 'done',
        survey: 'done',
        challenge: 'done',
        meta: 'done',
        validate: 'done',
        assemble: 'done',
      },
      events: [
        { stage: 'triage', status: 'running', at: '2026-01-01T00:00:00.000Z' },
        { stage: 'assemble', status: 'done', at: '2026-01-01T00:01:00.000Z' },
      ],
      report: { paperTitle: 'Old Paper', overall: 'ok', comments: [] },
      partial: false,
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    } as unknown as RunState;

    expect(legacy.stages['claims'] ?? 'pending').toBe('pending');
    expect(legacy.stages['verify'] ?? 'pending').toBe('pending');
    for (const s of STAGES) {
      expect(stageStatus(legacy, s)).toBe(
        s === 'claims' || s === 'verify' || s === 'scout' ? 'pending' : 'done',
      );
    }
    expect(legacy.events).toHaveLength(2);
    expect(legacy.report).toBeDefined();
  });

  it('a stored 8-stage run (Stage-4 shape, no scout) loads with scout pending', () => {
    const stage4 = {
      runId: 'legacy2',
      documentTitle: 'S4 Paper',
      stages: {
        triage: 'done',
        claims: 'done',
        survey: 'done',
        verify: 'done',
        challenge: 'done',
        meta: 'done',
        validate: 'done',
        assemble: 'done',
      },
      events: [],
      partial: false,
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    } as unknown as RunState;
    expect(stageStatus(stage4, 'scout')).toBe('pending');
    for (const s of STAGES.filter((x) => x !== 'scout')) {
      expect(stageStatus(stage4, s)).toBe('done');
    }
  });

  it('new stages participate in the state machine like any other', () => {
    const s = createRunState('r', 'P');
    setStage(s, 'claims', 'running', 'inventory');
    setStage(s, 'claims', 'done', '5 claims');
    setStage(s, 'verify', 'running');
    expect(stageStatus(s, 'claims')).toBe('done');
    expect(stageStatus(s, 'verify')).toBe('running');
    expect(s.events.map((e) => e.stage)).toEqual(['claims', 'claims', 'verify']);
  });
});
