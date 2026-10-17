import { describe, expect, it } from 'vitest';
import { mapPool } from '../src/pipeline/pool';

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('mapPool', () => {
  it('preserves result order regardless of completion order', async () => {
    const items = [30, 5, 20, 1];
    const out = await mapPool(items, 4, async (ms) => {
      await delay(ms);
      return ms * 10;
    });
    expect(out.map((r) => (r.ok ? r.value : -1))).toEqual([300, 50, 200, 10]);
  });

  it('respects the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    await mapPool(items, 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await delay(5);
      inFlight--;
    });
    expect(peak).toBe(3);
  });

  it('never exceeds the limit even when tasks fail', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    const out = await mapPool(items, 2, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await delay(3);
      inFlight--;
      if (i % 2 === 0) throw new Error(`boom ${i}`);
      return i;
    });
    expect(peak).toBe(2);
    // failures are isolated per item; every slot is decided (never rejects)
    expect(out).toHaveLength(items.length);
    expect(
      out.filter((r) => !r.ok).map((r) => (r as { error: Error }).error.message),
    ).toEqual(items.filter((i) => i % 2 === 0).map((i) => `boom ${i}`));
  });

  it('isolates errors: one rejection does not affect other results', async () => {
    const items = ['a', 'b', 'c', 'd'];
    const out = await mapPool(items, 2, async (x) => {
      if (x === 'b') throw new Error('isolated');
      return x.toUpperCase();
    });
    expect(out[0]).toEqual({ ok: true, value: 'A' });
    expect(out[1]!.ok).toBe(false);
    expect((out[1] as { error: Error }).error.message).toBe('isolated');
    expect(out[2]).toEqual({ ok: true, value: 'C' });
    expect(out[3]).toEqual({ ok: true, value: 'D' });
  });

  it('coerces non-Error throws into Errors', async () => {
    const out = await mapPool([1], 1, async () => {
      throw 'plain string';
    });
    expect(out[0]!.ok).toBe(false);
    expect((out[0] as { error: Error }).error).toBeInstanceOf(Error);
    expect((out[0] as { error: Error }).error.message).toBe('plain string');
  });

  it('handles empty input and limit larger than input', async () => {
    expect(await mapPool([], 8, async (x) => x)).toEqual([]);
    const out = await mapPool([1, 2], 100, async (x) => x + 1);
    expect(out.map((r) => (r.ok ? r.value : 0))).toEqual([2, 3]);
  });

  it('clamps non-positive limit to at least one lane', async () => {
    const out = await mapPool([1, 2, 3], 0, async (x) => x * 2);
    expect(out.map((r) => (r.ok ? r.value : 0))).toEqual([2, 4, 6]);
  });

  it('passes the item index to fn', async () => {
    const out = await mapPool(['x', 'y'], 2, async (_item, i) => i);
    expect(out.map((r) => (r.ok ? r.value : -1))).toEqual([0, 1]);
  });
});
