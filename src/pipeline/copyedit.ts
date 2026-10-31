/**
 * Copyedit annex stage (Stage 7a): language-mechanics fixes, post-validate,
 * never blocks the report.
 *
 * Port of Python orchestrator `_copyedit` + prompts COPYEDIT_*: one SMALL
 * `callJsonWithRepair` call (call_type 'copyedit'), fail-soft -> [] on any
 * LLM/parse failure (Python catches LLMError). Quotes are verified against
 * the document with the deterministic anchor resolver — items whose quotes
 * cannot be located are dropped (hallucination guard); no severity/defense/
 * validation gating applies (nothing here is a finding).
 *
 * 7c: the Python gates (`plan_knobs().copyedit` + `budget_allows('copyedit')`)
 * are wired in the orchestrator — closed in 7c (was: always-on pre-7c).
 */

import type { Document } from '../ingestion/document';
import type { CopyeditItem } from '../report/models';
import { BudgetExceeded } from '../providers/usage';
import { callJsonWithRepair, type CallJson } from './claims';
import { copyeditPrompt, copyeditSystem } from './prompts';
import { resolveAnchor, sectionOfBlock } from '../report/anchor';

/** Python's kind whitelist, lowercased. */
const KINDS = new Set(['typo', 'grammar', 'phrasing', 'terminology']);
/** Python cap: at most 40 items survive sanitation. */
export const COPYEDIT_MAX_ITEMS = 40;

/**
 * Sanitize raw LLM items (Python `_copyedit` tail, verbatim): dicts only,
 * non-empty quote+suggestion, whitelisted lowercased kind, quote resolvable
 * in the document (resolveAnchor(doc, quote, quote) — null -> drop), 300-char
 * truncation, section from the resolved block, cap 40.
 */
export function sanitizeCopyeditItems(raw: unknown, doc: Document): CopyeditItem[] {
  const items = Array.isArray(raw) ? raw : [];
  const out: CopyeditItem[] = [];
  for (const it of items) {
    if (typeof it !== 'object' || it === null) continue;
    const o = it as Record<string, unknown>;
    const quote = String(o['quote'] ?? '').trim();
    const suggestion = String(o['suggestion'] ?? '').trim();
    const kind = String(o['kind'] ?? 'phrasing')
      .trim()
      .toLowerCase();
    if (!quote || !suggestion || !KINDS.has(kind)) continue;
    const { blockId } = resolveAnchor(doc, quote, quote);
    if (blockId === null) continue; // quote not in the document — paraphrased
    out.push({
      quote: quote.slice(0, 300),
      suggestion: suggestion.slice(0, 300),
      kind,
      section: sectionOfBlock(doc, blockId) ?? null,
    });
    if (out.length >= COPYEDIT_MAX_ITEMS) break;
  }
  return out;
}

/**
 * COPYEDIT stage: one SMALL-role language-mechanics pass over the full
 * manuscript. Fail-soft ([]) on LLM/parse failure; only a budget cap is
 * surfaced to the caller.
 */
export async function runCopyEditStage(init: {
  callJson: CallJson;
  doc: Document;
  manuscript: string;
}): Promise<{ items: CopyeditItem[]; budget?: BudgetExceeded }> {
  const { callJson, doc, manuscript } = init;
  const user = copyeditPrompt(doc.title, manuscript);
  const res = await callJsonWithRepair(
    callJson,
    'small',
    copyeditSystem,
    user,
    'copyedit',
  );
  if (res.kind === 'budget') return { items: [], budget: res.error };
  // Python catches LLMError (which the JSON-repair retry also raises) and
  // continues with no items — the annex never blocks the report.
  if (res.kind !== 'ok') return { items: [] };
  const o =
    typeof res.value === 'object' && res.value !== null
      ? (res.value as Record<string, unknown>)
      : {};
  return { items: sanitizeCopyeditItems(o['items'], doc) };
}
