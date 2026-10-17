import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings } from '../src/config/schema';
import { loadSettings, mergeSettings, saveSettings } from '../src/config/storage';

const STORAGE_KEY = 'openreferee.settings.v1';

describe('DEFAULT_SETTINGS', () => {
  it('matches the documented defaults', () => {
    expect(DEFAULT_SETTINGS.version).toBe(1);
    expect(DEFAULT_SETTINGS.providers).toEqual({});
    expect(DEFAULT_SETTINGS.pricing).toEqual({});
    expect(DEFAULT_SETTINGS.roles).toEqual({
      strong: { provider: '', model: '' },
      small: { provider: '', model: '' },
      vision: { provider: '', model: '' },
    });
    expect(DEFAULT_SETTINGS.requestTimeoutS).toBe(300);
    expect(DEFAULT_SETTINGS.maxRetries).toBe(3);
    expect(DEFAULT_SETTINGS.minDelayS).toBe(0);
    expect(DEFAULT_SETTINGS.maxCostUsd).toBe(5);
    expect(DEFAULT_SETTINGS.searchOrder).toEqual(['tavily', 'tinyfish']);
  });
});

describe('mergeSettings', () => {
  it('returns defaults for an empty object', () => {
    expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips the Stage-4 review depth block', () => {
    const review = {
      maxClaims: 25,
      perSectionLenses: false,
      wholePaperPasses: true,
      defenseRound: false,
      maxArtifacts: 4,
      maxParallelCalls: 3,
    };
    const merged = mergeSettings({ review });
    expect(merged.review).toEqual(review);
    // unknown/wrong-typed fields dropped, known ones kept
    const dirty = mergeSettings({
      review: { defenseRound: 'yes', maxClaims: 12, bogus: 1 },
    });
    expect(dirty.review).toEqual({ maxClaims: 12 });
    // absent review stays absent (defaults apply at use time)
    expect(mergeSettings({}).review).toBeUndefined();
  });

  it('round-trips the Stage-5 searchApiKeys block (session-only)', () => {
    const merged = mergeSettings({
      searchApiKeys: { tavily: 'tv-key', tinyfish: 'tf-key' },
    });
    expect(merged.searchApiKeys).toEqual({ tavily: 'tv-key', tinyfish: 'tf-key' });
    // wrong-typed / empty values dropped
    expect(
      mergeSettings({ searchApiKeys: { tavily: 42, tinyfish: '' } }).searchApiKeys,
    ).toBeUndefined();
    expect(mergeSettings({ searchApiKeys: 'nope' }).searchApiKeys).toBeUndefined();
    expect(mergeSettings({}).searchApiKeys).toBeUndefined();
    // partial keys kept
    expect(mergeSettings({ searchApiKeys: { tinyfish: 'k' } }).searchApiKeys).toEqual({
      tinyfish: 'k',
    });
  });

  it('never persists searchApiKeys either', () => {
    saveSettings(mergeSettings({ searchApiKeys: { tavily: 'SECRET-TAVILY' } }));
    const raw = localStorage.getItem(STORAGE_KEY) ?? '';
    expect(raw).not.toContain('SECRET-TAVILY');
    expect(raw).not.toContain('searchApiKeys');
    expect(loadSettings().searchApiKeys).toBeUndefined();
  });

  it('returns defaults for non-object input', () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(42)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings('nope')).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings([1, 2])).toEqual(DEFAULT_SETTINGS);
  });

  it('fills missing fields with defaults from a partial object', () => {
    const merged = mergeSettings({ maxCostUsd: 10 });
    expect(merged.maxCostUsd).toBe(10);
    expect(merged.requestTimeoutS).toBe(DEFAULT_SETTINGS.requestTimeoutS);
    expect(merged.searchOrder).toEqual(DEFAULT_SETTINGS.searchOrder);
    expect(merged.roles).toEqual(DEFAULT_SETTINGS.roles);
  });

  it('deep-merges nested roles without dropping siblings', () => {
    const merged = mergeSettings({
      roles: { strong: { provider: 'openrouter', model: 'gpt-5', temperature: 0.1 } },
    });
    expect(merged.roles.strong).toEqual({
      provider: 'openrouter',
      model: 'gpt-5',
      temperature: 0.1,
    });
    expect(merged.roles.small).toEqual({ provider: '', model: '' });
    expect(merged.roles.vision).toEqual({ provider: '', model: '' });
  });

  it('preserves providers and pricing maps', () => {
    const merged = mergeSettings({
      providers: { p1: { type: 'anthropic', baseUrl: 'https://x' } },
      pricing: { m1: { input: 1.5, output: 6 } },
    });
    expect(merged.providers.p1).toEqual({ type: 'anthropic', baseUrl: 'https://x' });
    expect(merged.pricing.m1).toEqual({ input: 1.5, output: 6 });
  });

  it('ignores wrong-typed scalars and keeps the default', () => {
    const merged = mergeSettings({ requestTimeoutS: 'fast', maxRetries: null });
    expect(merged.requestTimeoutS).toBe(DEFAULT_SETTINGS.requestTimeoutS);
    expect(merged.maxRetries).toBe(DEFAULT_SETTINGS.maxRetries);
  });

  it('replaces searchOrder only when it is a string array', () => {
    expect(mergeSettings({ searchOrder: ['tinyfish'] }).searchOrder).toEqual([
      'tinyfish',
    ]);
    expect(mergeSettings({ searchOrder: 'tavily' }).searchOrder).toEqual(
      DEFAULT_SETTINGS.searchOrder,
    );
  });
});

describe('storage roundtrip', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('returns defaults when the key is absent', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults on corrupt JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults on non-object JSON', () => {
    localStorage.setItem(STORAGE_KEY, '"just a string"');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    localStorage.setItem(STORAGE_KEY, '17');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('saves and loads a full settings object', () => {
    const settings: AppSettings = mergeSettings({
      maxCostUsd: 2.5,
      providers: { p1: { type: 'ollama', baseUrl: 'http://localhost:11434' } },
    });
    saveSettings(settings);
    expect(loadSettings()).toEqual(settings);
  });

  it('never persists apiKey fields', () => {
    saveSettings(
      mergeSettings({
        providers: {
          p1: {
            type: 'openai_compatible',
            baseUrl: 'https://api.x.com',
            apiKey: 'sk-supersecret',
          },
        },
        roles: { strong: { provider: 'p1', model: 'm' } },
      }),
    );
    const raw = localStorage.getItem(STORAGE_KEY) ?? '';
    expect(raw).not.toContain('sk-supersecret');
    expect(raw).not.toContain('apiKey');
    const loaded = loadSettings();
    expect(loaded.providers.p1?.apiKey).toBeUndefined();
    expect(loaded.providers.p1?.type).toBe('openai_compatible');
    expect(loaded.providers.p1?.baseUrl).toBe('https://api.x.com');
  });
});
