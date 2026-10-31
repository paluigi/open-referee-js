/**
 * Prompts for the planning committee (strategy reflection, replan
 * consultation, incomplete-review wrap-up).
 *
 * VERBATIM port of Python `open_referee/pipeline/prompts_committee.py`
 * (runtime values character-identical; Python line-continuation backslashes
 * vanish at parse time, `json.dumps(indent=1)` maps to
 * `JSON.stringify(v, null, 1)` — note Python dumps uses ", " item/": "
 * separators with indent, JS stringify with indent uses the same).
 */

// ------------------------------------------------------- strategy reflection --

export const STRATEGY_REFLECT_SYSTEM = `You are the strategy chair of an academic-paper review pipeline with a hard USD budget. You reason about WHAT KIND of review this paper deserves; you do NOT choose the final plan and you never sum costs — the harness has already costed every option.

You receive: document statistics, the triage summary, the importance-ranked top claims, and a frontier of feasible review plans (each with its cost and what it covers: claims verified individually = depth; whole-paper/lens/artifact passes = breadth).

Reply with ONLY a JSON object:
{"draft": "your first-pass reasoning about depth vs breadth for this paper",
 "critique": "challenge your draft: what would a tough referee say about this plan for THIS paper? what is the risk of each emphasis?",
 "evaluation_summary": "2-4 sentences: the balanced recommendation",
 "preferred_path": "frontier name you lean toward"}`;

export const STRATEGY_REFLECT_USER_TEMPLATE =
  `## Document stats

{stats_json}

## Triage summary

{triage}

## Top importance-ranked claims

{top_claims}

## Feasible frontier (costed by the harness; budget $` +
  '{budget:.2f}' +
  `)

{frontier_menu}
`;

export function strategyReflectUser(init: {
  statsJson: string;
  triage: string;
  topClaims: string;
  frontierMenu: string;
  budget: number;
}): string {
  return STRATEGY_REFLECT_USER_TEMPLATE.replace('{stats_json}', init.statsJson)
    .replace('{triage}', init.triage || '(unavailable)')
    .replace('{top_claims}', init.topClaims)
    .replace('{frontier_menu}', init.frontierMenu)
    .replace('{budget:.2f}', init.budget.toFixed(2));
}

// ---------------------------------------------------------- replan consult --

export const REPLAN_CONSULT_SYSTEM = `You are the budget replanner of an academic-paper review. The run is over budget and several pre-costed continuations of the REMAINING work are available. You receive a mechanical snapshot: spend so far, residual budget, which importance-ranked claims are already verified, OBSERVED YIELD (findings per pass so far), and the continuation options with their projected final cost.

Rule of thumb: keep spending where findings are emerging; cut where they are not. Depth = more claims verified; breadth = more passes.

Reply with ONLY a JSON object:
{"continuation": "option name", "rationale": "1-3 sentences"}`;

export const REPLAN_CONSULT_USER_TEMPLATE = `## Mechanical snapshot

{ctx_json}

## Continuation options (projected final cost, what they include)

{paths}
`;

/**
 * Python replan_consult_user: one line per path in the documented shape,
 * ctx capped at 20k chars of pretty-printed JSON.
 */
export function replanConsultUser(
  ctx: Record<string, unknown>,
  paths: {
    name: string;
    projected_final_usd: number;
    claims_remaining: number;
    passes_remaining: string[];
    description: string;
  }[],
): string {
  const lines = paths.map(
    (p) =>
      `- ${p.name}: final ~$${p.projected_final_usd.toFixed(4)}; +${p.claims_remaining} claims; ` +
      `${p.passes_remaining.join(', ') || 'no new passes'} — ${p.description}`,
  );
  return REPLAN_CONSULT_USER_TEMPLATE.replace(
    '{ctx_json}',
    JSON.stringify(ctx, null, 1).slice(0, 20_000),
  ).replace('{paths}', lines.join('\n'));
}

// ------------------------------------------------------------------ wrap-up --

export const WRAPUP_SYSTEM = `You are wrapping up an academic-paper review that ran out of budget before completing all planned stages. Synthesize the best possible review report from what was actually verified — never present unverified areas as checked, and say explicitly which areas were NOT examined.

Reply with ONLY a JSON object:
{"paper_summary": "1-3 sentences",
 "overall_feedback": "markdown: what was verified and found; then a clearly marked 'Not verified' section listing the skipped areas",
 "comments": [{"title", "paragraph_anchor", "quote", "message", "score", "category"}],
 "validator_notes": "what remains unverified and what a continuation should do"}`;

export const WRAPUP_USER_TEMPLATE = `## Manuscript: {title}

{manuscript}

## Review progress when the budget ran out

{progress}

## Findings so far (candidate comments)

{comments}
`;

/** Python wrapup_user inputs, pre-assembled by the orchestrator. */
export function wrapupUser(init: {
  title: string;
  manuscript: string;
  progress: string;
  comments: string;
}): string {
  return WRAPUP_USER_TEMPLATE.replace('{title}', init.title)
    .replace('{manuscript}', init.manuscript)
    .replace('{progress}', init.progress)
    .replace('{comments}', init.comments);
}
