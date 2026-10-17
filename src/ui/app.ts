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
import { createProvider, closeProviders } from '../providers/factory';
import { RateLimiter } from '../providers/rate_limit';
import type { ChatProvider } from '../providers/base';
import { runReview } from '../pipeline/orchestrator';
import type { RunState } from '../pipeline/state';
import type { ReviewReport } from '../report/models';
import { reportToMarkdown } from '../report/render';
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

  return { root: fieldset, keyInputs, vaultIndicator };
}

// -------------------------------------------------------------------- report --

function reportView(report: ReviewReport, runState: RunState): HTMLElement {
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

// --------------------------------------------------------------------- mount --

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
          provider = createProvider({
            providerType: cfg.type,
            baseUrl: cfg.baseUrl,
            apiKey: apiKey || undefined,
            rateLimiter,
            requestTimeoutS: settings.requestTimeoutS,
            maxRetries: settings.maxRetries,
          });
          seen.set(name, provider);
        }
        providers[role] = provider;
      }
      return providers;
    };

    let activeProviders: Record<string, ChatProvider> | null = null;

    (async () => {
      const providers = await buildProviders();
      activeProviders = providers;
      const progress = new ProgressController(progressRoot);
      const gen = runReview({
        doc: doc,
        settings,
        providers: providers as { strong: ChatProvider; small: ChatProvider },
        onEvent: (e, p) => progress.onEvent(e, p),
      });
      let state: RunState | undefined;
      for (;;) {
        const next = await gen.next();
        if (next.done) {
          state = next.value;
          break;
        }
      }
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
        output.replaceChildren(reportView(report, state));
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
