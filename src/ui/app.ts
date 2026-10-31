/**
 * Open Referee browser UI (Stage 2): provider manager, role bindings, vault
 * controls, file ingest, run progress, and the rendered report. Vanilla TS
 * DOM, no framework.
 *
 * API key policy: keys live in memory for the session by DEFAULT; when the
 * optional vault is unlocked they are stored passphrase-encrypted via
 * setSecret (AES-GCM, see src/config/secrets.ts). Keys are NEVER passed to
 * saveSettings (which strips them anyway) and never persisted in plaintext.
 */

import { loadSettings, saveSettings } from '../config/storage';
import type { AppSettings, ProviderType } from '../config/schema';
import type { PricingEntry } from '../providers/usage';
import { BudgetHarness, documentStatsFromDoc } from '../pipeline/budget';
import {
  deleteSecret,
  getSecret,
  lockVault,
  setSecret,
  unlockVault,
  vaultIsUnlocked,
} from '../config/secrets';
import type { Document } from '../ingestion/document';
import { ingestByExtensionAsync } from '../ingestion/readers_md';
import {
  createProvider,
  closeProviders,
  createDecisionProvider,
} from '../providers/factory';
import { RateLimiter } from '../providers/rate_limit';
import type { ChatProvider } from '../providers/base';
import type { DecisionCaller } from '../pipeline/orchestrator';
import type { DecisionQuestion } from '../providers/decisions';
import { DecisionsClient } from '../providers/decisions';
import { runReview } from '../pipeline/orchestrator';
import { loadRun, listRuns } from '../runs/store';
import type { RunState } from '../pipeline/state';
import { STAGES, stageStatus } from '../pipeline/state';
import type { ReviewReport } from '../report/models';
import { reportToMarkdown } from '../report/render';
import { documentFromData, type DocumentData } from '../ingestion/document_data';
import { ProgressController } from './progress';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

/** Session-only keys, used when the vault is locked. Never persisted. */
const sessionKeys = new Map<string, string>();

const PROVIDER_TYPES: ProviderType[] = [
  'openai_compatible',
  'anthropic',
  'gemini',
  'ollama',
  'vllm',
  'decision',
];
const ROLES = ['strong', 'small', 'vision'] as const;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    e.setAttribute(k, v);
  }
  for (const c of children) {
    e.append(c);
  }
  return e;
}

function renderMarkdown(md: string): string {
  return DOMPurify.sanitize(marked.parse(md, { async: false }));
}

// ------------------------------------------------------------- key resolution --

/** Vault-first, session-map fallback. Returns '' when neither has a key. */
async function resolveKey(providerName: string): Promise<string> {
  if (vaultIsUnlocked()) {
    const fromVault = await getSecret(providerName);
    if (fromVault !== undefined) return fromVault;
  }
  return sessionKeys.get(providerName) ?? '';
}

/**
 * 7e review (B6): build the decision-model caller from the bound decision
 * role — Python RolePool wires `pool.decider` from
 * `build_decision_provider(...)` so the DM layer is reachable from the UI.
 * Returns undefined when the role is unbound/incomplete (dormant DM layer).
 */
async function buildDecider(
  settings: AppSettings,
): Promise<DecisionCaller | undefined> {
  const dr = settings.decisionRole;
  if (!dr?.provider || !dr.model) return undefined;
  const cfg = settings.providers[dr.provider];
  if (!cfg || cfg.type !== 'decision' || !cfg.baseUrl) return undefined;
  const apiKey = await resolveKey(dr.provider);
  const rateLimiter = new RateLimiter(settings.minDelayS);
  const client: DecisionsClient = createDecisionProvider({
    baseUrl: cfg.baseUrl,
    apiKey: apiKey || undefined,
    rateLimiter,
    requestTimeoutS: settings.requestTimeoutS,
    maxRetries: settings.maxRetries,
  });
  return async (input, questions: readonly DecisionQuestion[], _callType) => {
    void _callType;
    return client.decide(input, questions);
  };
}

// ----------------------------------------------------------------- settings --

interface SettingsUiHandles {
  root: HTMLElement;
  keyInputs: Map<string, HTMLInputElement>;
  vaultIndicator: HTMLElement;
}

function settingsPanel(settings: AppSettings, onChange: () => void): SettingsUiHandles {
  const fieldset = el('fieldset', { id: 'settings-panel' });
  fieldset.appendChild(el('legend', {}, 'Settings'));

  const keyInputs = new Map<string, HTMLInputElement>();

  // ---- vault controls ----
  const vaultIndicator = el('span', {
    id: 'vault-state',
    class: 'vault-state',
  });
  const refreshVaultIndicator = (): void => {
    vaultIndicator.textContent = vaultIsUnlocked()
      ? 'vault: unlocked (keys encrypted with your passphrase)'
      : 'vault: locked (keys are session-only)';
  };
  refreshVaultIndicator();

  const vaultError = el('span', { id: 'vault-error', class: 'error' });

  const encryptBtn = el(
    'button',
    { type: 'button', id: 'vault-encrypt' },
    'set passphrase + encrypt keys',
  );
  encryptBtn.addEventListener('click', () => {
    const p1 = window.prompt('Vault passphrase:');
    if (!p1) return;
    const p2 = window.prompt('Repeat passphrase:');
    if (p1 !== p2) {
      vaultError.textContent = 'passphrases do not match';
      return;
    }
    vaultError.textContent = '';
    (async () => {
      await unlockVault(p1);
      // Move session keys into the vault…
      for (const [name, key] of sessionKeys) {
        await setSecret(name, key);
      }
      // …then drop the in-memory copies: after migration, lockVault() must
      // actually lock — resolveKey must not fall back to stale plaintexts.
      sessionKeys.clear();
      for (const input of keyInputs.values()) input.value = '';
      refreshVaultIndicator();
    })().catch((err: unknown) => {
      vaultError.textContent = err instanceof Error ? err.message : String(err);
    });
  });

  const unlockBtn = el('button', { type: 'button', id: 'vault-unlock' }, 'unlock');
  unlockBtn.addEventListener('click', () => {
    const p = window.prompt('Vault passphrase:');
    if (!p) return;
    vaultError.textContent = '';
    unlockVault(p)
      .then(() => refreshVaultIndicator())
      .catch((err: unknown) => {
        vaultError.textContent = err instanceof Error ? err.message : String(err);
      });
  });

  const lockBtn = el('button', { type: 'button', id: 'vault-lock' }, 'lock');
  lockBtn.addEventListener('click', () => {
    lockVault();
    vaultError.textContent = '';
    refreshVaultIndicator();
  });

  const vaultRow = el(
    'div',
    { class: 'row vault-row' },
    vaultIndicator,
    encryptBtn,
    unlockBtn,
    lockBtn,
    vaultError,
  );
  fieldset.appendChild(vaultRow);

  // ---- provider manager ----
  const providerList = el('div', { id: 'provider-list', class: 'provider-list' });

  const addProviderRow = (name: string, cfg: AppSettings['providers'][string]) => {
    const row = el('div', { class: 'row provider-row', 'data-provider': name });

    const nameLabel = el('strong', {}, name);
    row.appendChild(nameLabel);

    const typeSel = el('select', {
      class: 'provider-type',
      'aria-label': `provider type for ${name}`,
    });
    for (const t of PROVIDER_TYPES) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      if (t === cfg.type) opt.selected = true;
      typeSel.appendChild(opt);
    }
    typeSel.addEventListener('change', () => {
      cfg.type = typeSel.value as ProviderType;
      saveSettings(settings);
      onChange();
    });
    row.appendChild(typeSel);

    const baseUrlInput = el('input', {
      type: 'url',
      class: 'provider-base-url',
      placeholder: 'base URL (openai_compatible / vllm / ollama)',
      value: cfg.baseUrl ?? '',
      'aria-label': `base URL for ${name}`,
    });
    baseUrlInput.addEventListener('change', () => {
      const v = baseUrlInput.value.trim();
      if (v) cfg.baseUrl = v;
      else delete cfg.baseUrl;
      saveSettings(settings);
      onChange();
    });
    row.appendChild(baseUrlInput);

    const keyInput = el('input', {
      type: 'password',
      class: 'provider-key',
      placeholder: 'API key (session only, or vault when unlocked)',
      autocomplete: 'off',
      'aria-label': `API key for ${name}`,
    });
    keyInput.value = sessionKeys.get(name) ?? '';
    keyInputs.set(name, keyInput);
    keyInput.addEventListener('input', () => {
      if (keyInput.value) sessionKeys.set(name, keyInput.value);
      else sessionKeys.delete(name);
    });
    keyInput.addEventListener('change', () => {
      if (vaultIsUnlocked() && keyInput.value) {
        setSecret(name, keyInput.value).catch(() => {
          /* vault write failed; key stays session-only */
        });
      }
      // Never persisted: saveSettings strips apiKey and we don't set it.
      saveSettings(settings);
    });
    row.appendChild(keyInput);

    const removeBtn = el(
      'button',
      { type: 'button', class: 'provider-remove' },
      'remove',
    );
    removeBtn.addEventListener('click', () => {
      delete settings.providers[name];
      sessionKeys.delete(name);
      // Also drop the vault secret: leaving it would let re-adding a
      // provider with the same name silently resurrect the old key
      // (resolveKey is vault-first).
      if (vaultIsUnlocked()) {
        deleteSecret(name).catch(() => {
          /* vault write failed; secret stays until removed manually */
        });
      }
      // Clear role bindings pointing at the removed provider — a stale
      // binding would round-trip through localStorage and only fail at
      // run preflight.
      let bindingsChanged = false;
      for (const role of ['strong', 'small', 'vision'] as const) {
        if (settings.roles[role]?.provider === name) {
          settings.roles[role].provider = '';
          settings.roles[role].model = '';
          bindingsChanged = true;
        }
      }
      // Stage 7e: a removed decision-provider binding drops the role entirely
      // (an unbound decision role is the documented dormant state).
      if (settings.decisionRole?.provider === name) {
        settings.decisionRole = undefined;
        bindingsChanged = true;
      }
      saveSettings(settings);
      row.remove();
      rebuildRoleSelects();
      if (bindingsChanged) onChange();
    });
    row.appendChild(removeBtn);

    providerList.appendChild(row);
  };

  for (const [name, cfg] of Object.entries(settings.providers)) {
    addProviderRow(name, cfg);
  }

  const newName = el('input', {
    type: 'text',
    id: 'new-provider-name',
    placeholder: 'new provider name (e.g. anthropic, openai-main)',
    'aria-label': 'new provider name',
  });
  const newType = el('select', {
    id: 'new-provider-type',
    'aria-label': 'new provider type',
  });
  for (const t of PROVIDER_TYPES) {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    newType.appendChild(opt);
  }
  const newBaseUrl = el('input', {
    type: 'url',
    id: 'new-provider-base-url',
    placeholder: 'base URL (optional for anthropic/gemini)',
    'aria-label': 'new provider base URL',
  });
  const addBtn = el('button', { type: 'button', id: 'provider-add' }, 'add provider');
  addBtn.addEventListener('click', () => {
    const name = newName.value.trim();
    if (!name || settings.providers[name]) return;
    const type = newType.value as ProviderType;
    const base = newBaseUrl.value.trim();
    settings.providers[name] = {
      type,
      ...(base ? { baseUrl: base } : {}),
    };
    saveSettings(settings);
    newName.value = '';
    newBaseUrl.value = '';
    addProviderRow(name, settings.providers[name]);
    rebuildRoleSelects();
    onChange();
  });
  const addRow = el(
    'div',
    { class: 'row provider-add-row' },
    newName,
    newType,
    newBaseUrl,
    addBtn,
  );

  fieldset.appendChild(el('h2', {}, 'Providers'));
  fieldset.append(providerList, addRow);

  // ---- search engine keys (Stage 5) ----
  // Session-only like provider keys pre-vault; never persisted (saveSettings
  // strips the block). Consumed by the literature SearchRouter.
  const searchKeysRow = (engine: 'tavily' | 'tinyfish'): HTMLDivElement => {
    const input = el('input', {
      type: 'password',
      class: 'search-key',
      id: `search-key-${engine}`,
      placeholder: `${engine} API key (session only)`,
      autocomplete: 'off',
      'aria-label': `API key for ${engine}`,
    });
    input.value = settings.searchApiKeys?.[engine] ?? '';
    input.addEventListener('change', () => {
      const v = input.value.trim();
      if (v) {
        settings.searchApiKeys = { ...settings.searchApiKeys, [engine]: v };
      } else {
        const rest = { ...settings.searchApiKeys };
        delete rest[engine];
        settings.searchApiKeys = Object.keys(rest).length > 0 ? rest : undefined;
      }
      // saveSettings strips searchApiKeys; this only persists the rest.
      saveSettings(settings);
      onChange();
    });
    return el('div', { class: 'row search-key-row' }, el('label', {}, engine, input));
  };
  fieldset.appendChild(el('h2', {}, 'Search engines'));
  fieldset.append(searchKeysRow('tavily'), searchKeysRow('tinyfish'));

  // ---- role bindings ----
  const roleSelect = (role: (typeof ROLES)[number]): HTMLSelectElement => {
    const sel = el('select', {
      id: `role-provider-${role}`,
      'aria-label': `provider for ${role} role`,
    });
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '— choose provider —';
    sel.appendChild(empty);
    for (const name of Object.keys(settings.providers)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (settings.roles[role].provider === name) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => {
      settings.roles[role].provider = sel.value;
      saveSettings(settings);
      onChange();
    });
    return sel;
  };

  const roleSelects = new Map<(typeof ROLES)[number], HTMLSelectElement>();

  /** Re-render the three role selects so new/removed providers show up. */
  const rebuildRoleSelects = (): void => {
    for (const role of ROLES) {
      const stale = roleSelects.get(role);
      if (!stale) continue;
      const fresh = roleSelect(role);
      stale.replaceWith(fresh);
      roleSelects.set(role, fresh);
    }
  };

  fieldset.appendChild(el('h2', {}, 'Roles'));
  for (const role of ROLES) {
    const model = el('input', {
      type: 'text',
      id: `${role}-model`,
      placeholder: `${role} model name`,
      value: settings.roles[role].model,
      'aria-label': `model for ${role} role`,
    });
    model.addEventListener('change', () => {
      settings.roles[role].model = model.value.trim();
      saveSettings(settings);
      onChange();
    });
    const sel = roleSelect(role);
    roleSelects.set(role, sel);
    fieldset.appendChild(
      el('div', { class: 'row' }, el('label', {}, `${role} role`, sel, model)),
    );
  }

  // ---- decision role (Stage 7e) ----
  // Optional binding to a provider of type 'decision' (/v1/decisions API).
  // Unbound (default) = the DM layer is dormant and every stage uses its
  // labelled-LLM fallback with byte-identical call sequences.
  {
    const dr = settings.decisionRole ?? { provider: '', model: '' };
    const decSel = el('select', {
      id: 'role-provider-decision',
      'aria-label': 'provider for decision role',
    });
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = '— none (decision models disabled) —';
    decSel.appendChild(emptyOpt);
    for (const name of Object.keys(settings.providers)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (dr.provider === name) opt.selected = true;
      decSel.appendChild(opt);
    }
    decSel.addEventListener('change', () => {
      const v = decSel.value;
      if (!v && !settings.decisionRole?.model) {
        delete settings.decisionRole;
      } else {
        settings.decisionRole = {
          ...(settings.decisionRole ?? { model: '' }),
          provider: v,
        };
      }
      saveSettings(settings);
      onChange();
    });
    const decModel = el('input', {
      type: 'text',
      id: 'decision-model',
      placeholder: 'decision model name',
      value: dr.model,
      'aria-label': 'model for decision role',
    });
    decModel.addEventListener('change', () => {
      const v = decModel.value.trim();
      if (!v && !settings.decisionRole?.provider) {
        delete settings.decisionRole;
      } else {
        settings.decisionRole = {
          ...(settings.decisionRole ?? { provider: '' }),
          model: v,
        };
      }
      saveSettings(settings);
      onChange();
    });
    fieldset.appendChild(
      el(
        'div',
        { class: 'row' },
        el('label', {}, 'decision role (optional)', decSel, decModel),
      ),
    );
  }

  // ---- budget tier (Stage 7c) ----
  // fast / standard / deep presets (Python USD figures verbatim) + auto
  // (budget-driven planner). budgetUsd is the hard plan ceiling.
  const TIER_LABELS: Record<string, string> = {
    fast: 'Fast — cheap but substantive (est. ~$1-3)',
    standard: 'Standard — hosted deep-review class (est. ~$3-8)',
    deep: 'Deep — beyond deep-review (est. ~$10-25)',
    auto: 'Auto — budget-driven planner (uses the cap below)',
  };
  const tierSel = el('select', {
    id: 'budget-tier',
    'aria-label': 'budget tier',
  });
  for (const tier of ['fast', 'standard', 'deep', 'auto']) {
    const opt = document.createElement('option');
    opt.value = tier;
    opt.textContent = TIER_LABELS[tier]!;
    if ((settings.budget?.depth ?? 'standard') === tier) opt.selected = true;
    tierSel.appendChild(opt);
  }
  tierSel.addEventListener('change', () => {
    settings.budget = { ...(settings.budget ?? {}), depth: tierSel.value };
    saveSettings(settings);
    onChange();
  });
  const budgetCap = el('input', {
    type: 'number',
    id: 'budget-cap',
    min: '0',
    step: '0.5',
    placeholder: 'hard budget cap (USD)',
    value:
      settings.budget?.budgetUsd !== undefined ? String(settings.budget.budgetUsd) : '',
    'aria-label': 'hard budget cap in USD',
  });
  budgetCap.addEventListener('change', () => {
    const v = Number(budgetCap.value);
    settings.budget = {
      ...(settings.budget ?? {}),
      budgetUsd: Number.isFinite(v) && budgetCap.value !== '' ? v : undefined,
    };
    saveSettings(settings);
    onChange();
  });
  fieldset.appendChild(el('h2', {}, 'Budget'));
  fieldset.appendChild(
    el('div', { class: 'row' }, el('label', {}, 'Tier', tierSel, budgetCap)),
  );

  return { root: fieldset, keyInputs, vaultIndicator };
}

// -------------------------------------------------------------------- budget --

/**
 * Projected-cost estimate for the CURRENT settings + doc (Stage 7c): the
 * preset-tier estimate from the cost model — no LLM call, mirroring Python's
 * /api/estimate. Returns null when the doc is absent (nothing ingested yet).
 */
export function projectedCost(
  settings: AppSettings,
  doc: Document | null,
): { preset: string; estimates: Record<string, number> } | null {
  if (!doc) return null;
  const pricing: Record<string, PricingEntry> = {};
  for (const role of ['strong', 'small', 'vision'] as const) {
    const rc = settings.roles[role];
    if (rc?.model && settings.pricing[rc.model])
      pricing[rc.model] = settings.pricing[rc.model]!;
  }
  const specs: Record<string, { provider: string; model: string }> = {};
  for (const role of ['strong', 'small', 'vision'] as const) {
    const rc = settings.roles[role];
    if (rc?.model) specs[role] = { provider: role, model: rc.model };
  }
  const harness = new BudgetHarness(
    {
      calls: [],
      priceFor: (key) => pricing[key] ?? pricing[key.split('/').pop() ?? key],
      totalCost: () => 0,
    },
    specs,
    settings.budget?.budgetUsd ?? settings.maxCostUsd,
    true,
  );
  harness.stats = documentStatsFromDoc(doc);
  return {
    preset: settings.budget?.depth ?? 'standard',
    estimates: harness.preset_estimates(),
  };
}

/** Spend-so-far line for the progress panel (7c). */
export function spendSoFarLine(runState: RunState): string {
  const calls = runState.ledgerCalls ?? [];
  const spent = calls.reduce((s, c) => s + c.costUsd, 0);
  const plan = runState.plan as
    { budget_usd?: number; target_usd?: number } | undefined;
  const cap = plan?.budget_usd;
  const parts = [`Spent so far: $${spent.toFixed(4)}`];
  if (cap !== undefined) parts.push(`of $${cap.toFixed(2)} cap`);
  if (plan?.target_usd !== undefined)
    parts.push(`(plan target $${plan.target_usd.toFixed(2)})`);
  return parts.join(' ');
}

/**
 * BudgetExceeded top-up affordance (7c): a "Top up & resume" control bound
 * to an incomplete run. Raises the cap in settings and re-enters the
 * pipeline via the existing resume machinery — the button just resumes.
 */
export function topUpControl(io: {
  runState: RunState;
  settings: AppSettings;
  onResume: (raisedCapUsd: number) => void;
}): HTMLElement {
  const wrap = el('div', { id: 'budget-topup', class: 'budget-topup' });
  wrap.appendChild(
    el(
      'p',
      { class: 'budget-topup-note' },
      'The budget cap stopped this run before the report completed. Completed stages are kept — raise the cap and resume from where it stopped.',
    ),
  );
  const input = el('input', {
    type: 'number',
    min: '0',
    step: '1',
    id: 'topup-amount',
    'aria-label': 'new budget cap in USD',
    placeholder: 'new cap (USD)',
  });
  const btn = el('button', { type: 'button', id: 'topup-resume' }, 'Top up & resume');
  btn.addEventListener('click', () => {
    const v = Number(input.value);
    if (!Number.isFinite(v) || v <= 0) {
      input.setAttribute('aria-invalid', 'true');
      return;
    }
    // Persist the raised cap (the run resumes under the new ceiling), then
    // hand off to the resume flow.
    io.settings.budget = { ...(io.settings.budget ?? {}), budgetUsd: v };
    if (v > io.settings.maxCostUsd) io.settings.maxCostUsd = v;
    saveSettings(io.settings);
    io.onResume(v);
  });
  wrap.append(input, btn);
  return wrap;
}

// -------------------------------------------------------------------- report --

/** Highlight a manuscript block (scroll + flash) and return the undo. */
function scrollToBlock(blockId: string): void {
  const target = document.getElementById(`block-${blockId}`);
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('block-highlight');
  window.setTimeout(() => target.classList.remove('block-highlight'), 1600);
}

/** Rendered report view (exported for the Stage-6 UI tests). */
export function reportView(
  report: ReviewReport,
  runState: RunState,
  _manuscriptPane?: HTMLElement | null,
): HTMLElement {
  const wrap = el('section', { id: 'report-view' });
  const overall = el('div', { class: 'report-overall' });
  overall.innerHTML = renderMarkdown(report.overall);
  wrap.appendChild(overall);

  if (report.comments.length > 0) {
    const list = el('ol', { class: 'comment-list' });
    const sorted = [...report.comments].sort((a, b) => b.severity - a.severity);
    for (const c of sorted) {
      const li = el(
        'li',
        {},
        el('strong', {}, ` [${c.severity.toFixed(2)}] `),
        c.section ? el('em', {}, `${c.section} — `) : document.createTextNode(''),
        c.quote ? el('blockquote', {}, c.quote) : document.createTextNode(''),
        el('p', {}, c.comment),
      );
      // Stage 6: anchor link to the referenced manuscript block (and back).
      if (c.blockId) {
        const back = `comment-${c.id ?? ''}`;
        const anchorBtn = el(
          'button',
          {
            type: 'button',
            class: 'anchor-link',
            'data-block-id': c.blockId,
            'data-back-target': back,
          },
          'show in manuscript →',
        );
        anchorBtn.addEventListener('click', () => {
          // scrollToBlock already scrolls + flash-highlights the block.
          scrollToBlock(c.blockId!);
          const blockEl = document.getElementById(`block-${c.blockId}`);
          const backLink = document.getElementById(back);
          // "back": a small floating link near the block returns to the comment
          if (blockEl && backLink) {
            const returnBtn = el(
              'button',
              { type: 'button', class: 'anchor-back' },
              '← back to comment',
            );
            returnBtn.addEventListener('click', () => {
              backLink.scrollIntoView({ behavior: 'smooth', block: 'center' });
              returnBtn.remove();
            });
            blockEl.appendChild(returnBtn);
          }
        });
        li.appendChild(anchorBtn);
      }
      li.id = `comment-${c.id ?? ''}`;
      list.appendChild(li);
    }
    wrap.appendChild(el('h2', {}, `Detailed comments (${report.comments.length})`));
    wrap.appendChild(list);
  }

  const meta = el(
    'p',
    { class: 'report-meta' },
    `Usage: ${report.usage.totalPromptTokens.toLocaleString('en-US')} in / ` +
      `${report.usage.totalCompletionTokens.toLocaleString('en-US')} out · ` +
      `estimated $${report.usage.estimatedCostUsd.toFixed(4)}` +
      (report.partial ? ' · PARTIAL RUN' : ''),
  );
  wrap.appendChild(meta);

  const download = el('button', { type: 'button', id: 'download-md' }, 'Download .md');
  download.addEventListener('click', () => {
    const md = reportToMarkdown(report);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `review-${runState.runId}.md` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
  wrap.appendChild(download);
  return wrap;
}

// --------------------------------------------------------------- manuscript --

/** Render the ingested document as anchorable blocks (Stage 6, exported for tests). */
export function manuscriptView(doc: Document): HTMLElement {
  const pane = el('section', { id: 'manuscript-pane' });
  pane.appendChild(el('h2', {}, doc.title));
  for (const b of doc.blocks) {
    const p = el(b.type === 'heading' ? 'h3' : 'p', { id: `block-${b.id}` }, b.text);
    pane.appendChild(p);
  }
  return pane;
}

// ---------------------------------------------------------------- runs list --

/** In-progress runs with a Resume button (Stage 6 resume UX). */
function createResumeSection(io: {
  settings: AppSettings;
  progressRoot: HTMLElement;
  output: HTMLElement;
  errorBox: HTMLElement;
  buildProviders: () => Promise<Record<string, ChatProvider>>;
  setActiveProviders: (p: Record<string, ChatProvider> | null) => void;
}): Promise<HTMLElement | null> {
  return (async () => {
    let runs: RunState[];
    try {
      runs = await listRuns();
    } catch {
      return null; // IndexedDB unavailable: no resume UI
    }
    const resumable = runs.filter(
      (r) => r.report === undefined && r.docData !== undefined,
    );
    if (resumable.length === 0) return null;
    const section = el('div', { id: 'resume-section', class: 'resume-section' });
    section.appendChild(el('h2', {}, 'In-progress runs'));
    for (const r of resumable.slice(0, 5)) {
      const doneCount = STAGES.filter((s) => stageStatus(r, s) === 'done').length;
      const btn = el(
        'button',
        { type: 'button', class: 'resume-btn', 'data-run-id': r.runId },
        `Resume “${r.documentTitle}” (${doneCount}/${STAGES.length} stages)`,
      );
      btn.addEventListener('click', () => {
        void (async () => {
          // Re-read the persisted state (fresh copy) and re-enter the pipeline.
          const state = await loadRun(r.runId);
          if (!state) return;
          let providers: Record<string, ChatProvider> | null = null;
          try {
            providers = await io.buildProviders();
            io.setActiveProviders(providers);
            const progress = new ProgressController(io.progressRoot);
            // 7e review (B6): the resume path gets the decision caller too.
            const decider = await buildDecider(io.settings);
            const gen = runReview({
              doc: null as unknown as Document,
              settings: io.settings,
              providers: providers as { strong: ChatProvider; small: ChatProvider },
              decider,
              searchApiKeys: io.settings.searchApiKeys,
              resume: { state, settings: io.settings, decider },
              onEvent: (e, p) => progress.onEvent(e, p),
            });
            let final: RunState | undefined;
            for (;;) {
              const next = await gen.next();
              if (next.done) {
                final = next.value;
                break;
              }
            }
            progress.finish(
              final?.partial
                ? 'Resumed run finished (partial report)'
                : 'Resumed run finished — report ready',
            );
            if (
              final &&
              final.report !== undefined &&
              typeof final.report === 'object'
            ) {
              const merged = el('div', {});
              if (final.docData) {
                merged.appendChild(
                  manuscriptView(documentFromData(final.docData as DocumentData)),
                );
              }
              merged.appendChild(
                reportView(
                  final.report as ReviewReport,
                  final,
                  merged.firstChild as HTMLElement | null,
                ),
              );
              io.output.replaceChildren(merged);
            }
          } catch (err) {
            io.errorBox.textContent = `Resume failed: ${err instanceof Error ? err.message : String(err)}`;
            io.errorBox.hidden = false;
          } finally {
            if (providers) closeProviders(providers);
            io.setActiveProviders(null);
          }
        })();
      });
      section.appendChild(el('div', { class: 'row resume-row' }, btn));
    }
    return section;
  })();
}

export function mountApp(root: HTMLElement): void {
  const settings = loadSettings();

  const heading = el('h1', {}, 'Open Referee');
  const runBtn = el(
    'button',
    { type: 'button', id: 'run-btn', disabled: '' },
    'Run review',
  );
  const fileInput = el('input', {
    type: 'file',
    id: 'file-input',
    accept: '.pdf,.docx,.md,.markdown,.txt',
  });
  const fileName = el('span', { id: 'file-name' }, 'no file selected');
  const progressRoot = el('div', { id: 'progress-root' });
  const output = el('div', { id: 'output' });
  const errorBox = el('p', { id: 'error-box', class: 'error', hidden: '' });

  let doc: Document | null = null;

  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    fileName.textContent = f.name;
    const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase();
    const stem = f.name.replace(/\.(pdf|docx|md|markdown|txt)$/i, '');
    (async () => {
      // ArrayBuffer path: heavy readers (pdf/docx) need bytes, not text.
      const buf = await f.arrayBuffer();
      return ingestByExtensionAsync(
        ext,
        () => f.text(),
        () => buf,
        stem,
      );
    })()
      .then((parsed) => {
        doc = parsed;
        errorBox.hidden = true;
        runBtn.removeAttribute('disabled');
      })
      .catch((err: unknown) => {
        errorBox.textContent = `Failed to read file: ${err instanceof Error ? err.message : String(err)}`;
        errorBox.hidden = false;
      });
  });

  runBtn.addEventListener('click', () => {
    if (!doc) return;

    // Preflight: role bound, provider exists, base URL when required, model set.
    const roles = ['strong', 'small'] as const;
    for (const role of roles) {
      const name = settings.roles[role].provider;
      if (!name) {
        errorBox.textContent = `Bind the ${role} role to a provider in settings first.`;
        errorBox.hidden = false;
        return;
      }
      const cfg = settings.providers[name];
      if (!cfg) {
        errorBox.textContent = `Role ${role} points at unknown provider "${name}".`;
        errorBox.hidden = false;
        return;
      }
      if (!cfg.baseUrl && (cfg.type === 'openai_compatible' || cfg.type === 'vllm')) {
        errorBox.textContent = `Set the base URL for provider "${name}" first.`;
        errorBox.hidden = false;
        return;
      }
      if (!settings.roles[role].model) {
        errorBox.textContent = `Set the ${role} model name in settings first.`;
        errorBox.hidden = false;
        return;
      }
    }
    // Preflight passed: capture the resolved configs for buildProviders.
    const resolved = new Map<string, AppSettings['providers'][string]>();
    for (const role of roles) {
      const cfg: AppSettings['providers'][string] | undefined =
        settings.providers[settings.roles[role].provider];
      if (!cfg) {
        // Unreachable after the preflight loop above; keeps types honest.
        throw new Error(`Role ${role} points at unknown provider.`);
      }
      resolved.set(settings.roles[role].provider, cfg);
    }
    errorBox.hidden = true;
    output.replaceChildren();
    runBtn.setAttribute('disabled', '');

    const rateLimiter = new RateLimiter(settings.minDelayS);
    const buildProviders = async (): Promise<Record<string, ChatProvider>> => {
      const providers: Record<string, ChatProvider> = {};
      const seen = new Map<string, ChatProvider>();
      for (const role of roles) {
        const name = settings.roles[role].provider;
        const cfg = resolved.get(name);
        if (!cfg) {
          throw new Error(`Role ${role} points at unknown provider "${name}".`);
        }
        let provider = seen.get(name);
        if (!provider) {
          const apiKey = await resolveKey(name);
          // 7d review (C1): the role's capability flag rides the binding —
          // a shared provider keeps the flag of the role that built it.
          const supportsReasoning = settings.roles[role].supportsReasoning;
          provider = createProvider({
            providerType: cfg.type,
            baseUrl: cfg.baseUrl,
            apiKey: apiKey || undefined,
            rateLimiter,
            requestTimeoutS: settings.requestTimeoutS,
            maxRetries: settings.maxRetries,
            supportsReasoning,
          });
          seen.set(name, provider);
        }
        providers[role] = provider;
      }
      return providers;
    };

    let activeProviders: Record<string, ChatProvider> | null = null;
    (async () => {
      const progress = new ProgressController(progressRoot);
      // Projected cost before the first call (7c spec: estimate display —
      // same cost model as Python's /api/estimate, zero LLM calls).
      const est = projectedCost(settings, doc);
      if (est) {
        const tierEst = est.estimates[est.preset];
        if (tierEst !== undefined) {
          progress.setSpend(`Projected (${est.preset}): $${tierEst.toFixed(2)}`);
        }
      }
      const providers = await buildProviders();
      activeProviders = providers;
      // 7e review (B6): construct the decision provider from the bound role.
      const decider = await buildDecider(settings);
      const gen = runReview({
        doc: doc,
        settings,
        providers: providers as { strong: ChatProvider; small: ChatProvider },
        decider,
        searchApiKeys: settings.searchApiKeys,
        onEvent: (e, p) => progress.onEvent(e, p),
      });
      let state: RunState | undefined;
      for (;;) {
        const next = await gen.next();
        if (next.done) {
          state = next.value;
          break;
        }
        // Spend-so-far in the progress panel (7c): append to each label tick.
        if (state === undefined) {
          // The pipeline persists ledger records as it goes; surface them.
          const runs = await listRuns().catch(() => []);
          const live = runs.find((r) => r.report === undefined && r.ledgerCalls);
          if (live) progress.setSpend(spendSoFarLine(live));
        }
      }
      if (state) progress.setSpend(spendSoFarLine(state));
      progress.finish(
        state?.partial
          ? 'Run finished (partial report)'
          : 'Run finished — report ready',
      );
      let report: ReviewReport | undefined;
      if (state && state.report !== undefined && typeof state.report === 'object') {
        report = state.report as ReviewReport;
      }
      if (report && state) {
        const merged = el('div', {});
        if (doc) merged.appendChild(manuscriptView(doc));
        merged.appendChild(
          reportView(report, state, merged.firstChild as HTMLElement | null),
        );
        // BudgetExceeded -> top-up affordance (7c): a partial run whose
        // assembled report stopped on the cap gets a resume control.
        if (report.partial) {
          const budgetDrained = (state.events ?? []).some(
            (e) => e.detail !== undefined && e.detail.includes('budget cap reached'),
          );
          if (budgetDrained) {
            merged.appendChild(
              topUpControl({
                runState: state,
                settings,
                onResume: () => {
                  // Reload the persisted state and re-enter the pipeline
                  // through the REAL resume path (doc:null + resume:{state}
                  // — runBtn.click() would start a fresh run).
                  void (async () => {
                    const saved = await loadRun(state!.runId);
                    if (!saved) return;
                    output.replaceChildren();
                    const progress = new ProgressController(progressRoot);
                    const providers = await buildProviders();
                    activeProviders = providers;
                    const topUpDecider = await buildDecider(settings);
                    const gen = runReview({
                      doc: null as unknown as Document,
                      settings,
                      providers: providers as {
                        strong: ChatProvider;
                        small: ChatProvider;
                      },
                      decider: topUpDecider,
                      searchApiKeys: settings.searchApiKeys,
                      resume: { state: saved, settings, decider: topUpDecider },
                      onEvent: (e, p) => progress.onEvent(e, p),
                    });
                    let final: RunState | undefined;
                    for (;;) {
                      const next = await gen.next();
                      if (next.done) {
                        final = next.value;
                        break;
                      }
                    }
                    progress.finish(
                      final?.partial
                        ? 'Resumed run finished (partial report)'
                        : 'Resumed run finished — report ready',
                    );
                    if (
                      final &&
                      final.report !== undefined &&
                      typeof final.report === 'object'
                    ) {
                      const merged = el('div', {});
                      if (final.docData) {
                        merged.appendChild(
                          manuscriptView(
                            documentFromData(final.docData as DocumentData),
                          ),
                        );
                      }
                      merged.appendChild(
                        reportView(
                          final.report as ReviewReport,
                          final,
                          merged.firstChild as HTMLElement | null,
                        ),
                      );
                      output.replaceChildren(merged);
                    }
                  })().catch((err: unknown) => {
                    errorBox.textContent = `Resume failed: ${err instanceof Error ? err.message : String(err)}`;
                    errorBox.hidden = false;
                  });
                },
              }),
            );
          }
        }
        output.replaceChildren(merged);
      }
    })()
      .catch((err: unknown) => {
        errorBox.textContent = `Run failed: ${err instanceof Error ? err.message : String(err)}`;
        errorBox.hidden = false;
      })
      .finally(() => {
        if (activeProviders) closeProviders(activeProviders);
        activeProviders = null;
        runBtn.removeAttribute('disabled');
      });
  });

  const ui = settingsPanel(settings, () => {
    /* settings persisted on change; nothing else to refresh */
  });

  const unloadHandler = (): void => {
    lockVault();
  };
  window.addEventListener('beforeunload', unloadHandler);
  window.addEventListener('unload', unloadHandler);

  // Stage 6: in-progress runs list with Resume (async; null when none/IDB down)
  void createResumeSection({
    settings,
    progressRoot,
    output,
    errorBox,
    buildProviders: async () => {
      // Resume preflight mirrors the run-button preflight.
      const roles = ['strong', 'small'] as const;
      for (const role of roles) {
        const name = settings.roles[role].provider;
        if (!name)
          throw new Error(`Bind the ${role} role to a provider in settings first.`);
        if (!settings.roles[role].model) {
          throw new Error(`Set the ${role} model name in settings first.`);
        }
      }
      const rateLimiter = new RateLimiter(settings.minDelayS);
      const providers: Record<string, ChatProvider> = {};
      const seen = new Map<string, ChatProvider>();
      for (const role of roles) {
        const name = settings.roles[role].provider;
        const cfg = settings.providers[name];
        if (!cfg) throw new Error(`Role ${role} points at unknown provider "${name}".`);
        let provider = seen.get(name);
        if (!provider) {
          const apiKey = await resolveKey(name);
          // 7d review (C1): the role's capability flag rides the binding.
          const supportsReasoning = settings.roles[role].supportsReasoning;
          provider = createProvider({
            providerType: cfg.type,
            baseUrl: cfg.baseUrl,
            apiKey: apiKey || undefined,
            rateLimiter,
            requestTimeoutS: settings.requestTimeoutS,
            maxRetries: settings.maxRetries,
            supportsReasoning,
          });
          seen.set(name, provider);
        }
        providers[role] = provider;
      }
      return providers;
    },
    setActiveProviders: () => {
      // The resume path closes its providers in its own finally block; the
      // shared active-run bookkeeping lives inside the resume closure.
    },
  }).then((section) => {
    if (section) root.insertBefore(section, progressRoot);
  });

  root.replaceChildren(
    heading,
    ui.root,
    el('div', { class: 'row' }, fileInput, fileName),
    runBtn,
    progressRoot,
    errorBox,
    output,
  );
}
