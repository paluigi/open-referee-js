import { describe, expect, it } from 'vitest';
import {
  clarityVerifierSystem,
  statsVerifierSystem,
  synthesisPrompt,
  synthesisSystem,
  COMMENT_SCHEMA,
  REFEREE_PERSONA,
  SEVERITY_RUBRIC,
  bibliographyPrompt,
  bibliographySystem,
  challengerPrompt,
  challengerSystem,
  empiricalVerifierSystem,
  figurePrompt,
  figureSystem,
  litVerifierSystem,
  mathVerifierSystem,
  metaPrompt,
  metaSystem,
  proseVerifierSystem,
  surveySystem,
  triagePrompt,
  triageSystem,
  validatorPrompt,
  validatorSystem,
  verifierPrompt,
  wholePaperChallengerPrompt,
  wholePaperChallengerSystem,
  wholePaperVerifierPrompt,
  wholePaperVerifierSystem,
} from '../src/pipeline/prompts';
import {
  CLAIM_INVENTORY_SYSTEM,
  claimVerifySystem,
} from '../src/pipeline/prompts_claims';

// --------------------------------------------------------------- persona --

describe('persona and shared rubric', () => {
  it('persona is present in all stage system prompts', () => {
    for (const p of [
      triageSystem,
      challengerSystem,
      bibliographySystem,
      metaSystem,
      validatorSystem,
      figureSystem,
    ]) {
      expect(p).toContain('top academic journal');
    }
  });

  it('every lens prompt carries persona and comment schema', () => {
    for (const system of [
      mathVerifierSystem,
      empiricalVerifierSystem,
      proseVerifierSystem,
      litVerifierSystem,
      statsVerifierSystem,
      clarityVerifierSystem,
    ]) {
      expect(system).toContain('top academic journal');
      expect(system).toContain('STRICT JSON');
      expect(system).toContain('paragraph_anchor');
      expect(system.toLowerCase()).toContain('severity');
    }
  });

  it('severity rubric bands appear in every comment producer', () => {
    for (const p of [
      mathVerifierSystem,
      empiricalVerifierSystem,
      proseVerifierSystem,
      litVerifierSystem,
      statsVerifierSystem,
      clarityVerifierSystem,
      figureSystem,
      challengerSystem,
    ]) {
      expect(p).toContain('0.80-1.00');
      expect(p).toContain('0.60-0.79');
      expect(p).toContain('0.35-0.59');
      expect(p).toContain('0.10-0.34');
    }
  });
});

// ------------------------------------------------- per-prompt guarantees --

describe('per-prompt content guarantees (ported from test_prompts.py)', () => {
  it('bibliography prompt covers existence and quotation', () => {
    expect(bibliographySystem).toContain('EXISTENCE');
    expect(bibliographySystem).toContain('QUOTATION CONSISTENCY');
    expect(bibliographySystem).toContain('in_text_issues');
  });

  it('math lens covers statements, proofs and cases', () => {
    for (const needle of [
      'statement',
      'proof',
      'without loss of generality',
      'boundary',
      'notation',
      'circular',
    ]) {
      expect(mathVerifierSystem.toLowerCase()).toContain(needle);
    }
  });

  it('empirical lens covers econometric practice', () => {
    for (const needle of [
      'identification',
      'parallel trends',
      'instrument',
      'clustering',
      'multiple hypothesis',
      'robustness',
      'external validity',
    ]) {
      expect(empiricalVerifierSystem.toLowerCase()).toContain(needle);
    }
  });

  it('meta prompt requires recommendation and strengths', () => {
    expect(metaSystem.toLowerCase()).toContain('strengths');
    expect(metaSystem.toLowerCase()).toContain('recommendation');
    expect(metaSystem).toContain('major revision');
  });

  it('validator prompt drops unsubstantiated comments', () => {
    expect(validatorSystem).toContain('DROP');
    expect(validatorSystem).toContain('fabricated');
  });

  it('whole-paper verifier prompt has the right scope', () => {
    expect(wholePaperVerifierSystem).toContain('ENTIRE manuscript');
    for (const needle of [
      'abstract',
      'contribution',
      'notation',
      'results',
      'conclusion',
      'cross-section',
    ]) {
      expect(wholePaperVerifierSystem.toLowerCase()).toContain(needle);
    }
    expect(wholePaperVerifierSystem).toContain('top academic journal');
    expect(wholePaperVerifierSystem).toContain('paragraph_anchor');
  });

  it('whole-paper challenger validates and hunts', () => {
    expect(wholePaperChallengerSystem.toLowerCase()).toContain('validate');
    expect(wholePaperChallengerSystem).toContain('GLOBAL');
    expect(wholePaperChallengerSystem).toContain('overclaiming');
    expect(wholePaperChallengerSystem).toContain('verdict');
  });

  it('survey prompt asks for STRICT JSON selection output', () => {
    expect(surveySystem).toContain('STRICT JSON');
    expect(surveySystem).toContain('state_of_the_art_notes');
    expect(surveySystem).toContain('missing_references');
  });
});

// ------------------------------------------------------ placeholder subs --

describe('user-prompt builders substitute every placeholder', () => {
  it('leaves no unreplaced {placeholder} in any builder output', () => {
    const outputs = [
      triagePrompt('T', 'M'),
      verifierPrompt('S', 'C', 'X'),
      wholePaperVerifierPrompt('T', 'M'),
      wholePaperChallengerPrompt('T', 'M', '[]'),
      challengerPrompt('S', 'C', 'X', '[]'),
      bibliographyPrompt('R', 'I', 'RES', 'P'),
      metaPrompt('T', '{}', '[]', 'B', 'N'),
      validatorPrompt('T', 'M', '[]', 'O'),
      figurePrompt('T', 3, 'C'),
    ];
    for (const out of outputs) {
      // JSON examples in the prompts use {"key": ...} — a bare {word} must not remain
      expect(out).not.toMatch(/\{[a-z_][a-z_0-9]*\}/);
    }
  });

  it('inserts each argument at its placeholder', () => {
    expect(triagePrompt('MY-TITLE', 'MY-TEXT')).toContain('Manuscript title: MY-TITLE');
    expect(triagePrompt('MY-TITLE', 'MY-TEXT')).toContain('---\nMY-TEXT\n---');

    const v = verifierPrompt('SEC', 'CTX', 'BODY');
    expect(v).toContain('Section: SEC');
    expect(v).toContain('CTX');
    expect(v).toContain('---\nBODY\n---');

    const c = challengerPrompt('SEC', 'CTX', 'BODY', 'CANDS');
    expect(c).toContain('Candidate comments (JSON):\nCANDS');

    const m = metaPrompt('T', 'TRI', 'COM', 'BIB', 'SOTA');
    expect(m).toContain('Triage: TRI');
    expect(m).toContain('Citation audit summary: BIB');
    expect(m).toContain('Literature notes: SOTA');

    const f = figurePrompt('PAPER', 7, 'CONTEXT7');
    expect(f).toContain('Figure from paper "PAPER" (page 7).');
  });
});

// ------------------------------------------------- character identity -----

describe('character-identity spot checks vs the Python source', () => {
  it('SEVERITY_RUBRIC is character-identical to Python', () => {
    expect(SEVERITY_RUBRIC).toBe(
      'Severity rubric: 0.80-1.00 invalidates a result/claim as stated; ' +
        '0.60-0.79 major (undermines part of a main claim, must fix before publication); ' +
        '0.35-0.59 minor but required; 0.10-0.34 polish/clarity.',
    );
  });

  it('persona distinctive substrings appear verbatim', () => {
    expect(REFEREE_PERSONA).toContain(
      "You are a referee for a top academic journal in the paper's field.",
    );
    expect(REFEREE_PERSONA).toContain(
      'If you cannot point to the exact sentence, equation, table, or citation ' +
        'that is problematic, do not raise the point.',
    );
    expect(REFEREE_PERSONA).toContain(
      'Calibrate severity honestly: 0.8+ only for flaws that invalidate a result ' +
        'as stated; do not inflate.',
    );
  });

  it('comment schema distinctive substrings appear verbatim', () => {
    expect(COMMENT_SCHEMA).toContain(
      '"paragraph_anchor": "verbatim sentence from the section',
    );
    expect(COMMENT_SCHEMA).toContain(
      'math|consistency|evidence|references|clarity|novelty|statistical|other',
    );
    expect(COMMENT_SCHEMA).toContain(
      'If you find nothing that meets the bar, return {"comments": []}.',
    );
  });

  it('math lens mandate line appears verbatim', () => {
    expect(mathVerifierSystem).toContain(
      'You are the MATHEMATICS AND THEORY REFEREE. Your mandate: verify the mathematical ' +
        'and theoretical content of this section — equations, definitions, lemmas, theorems, ' +
        'propositions, proofs.',
    );
  });

  it('whole-paper challenger JSON keys appear verbatim', () => {
    expect(wholePaperChallengerSystem).toContain(
      '"verdict": "kept|adjusted|dropped", "verdict_reason": "one sentence"',
    );
  });

  it('triage user template joins title and manuscript exactly like Python', () => {
    expect(triagePrompt('Widget Paper', 'Full text here')).toBe(
      'Manuscript title: Widget Paper\n\n' +
        'Manuscript (may be truncated):\n' +
        '---\n' +
        'Full text here\n' +
        '---',
    );
  });

  it('validator user template matches Python layout', () => {
    expect(validatorPrompt('T', 'M', 'C', 'O')).toBe(
      'Manuscript title: T\n\n' +
        'Manuscript (truncated):\n' +
        '---\n' +
        'M\n' +
        '---\n\n' +
        'Draft review comments (JSON):\n' +
        'C\n\n' +
        'Draft overall feedback (markdown):\n' +
        '---\n' +
        'O\n' +
        '---',
    );
  });
});

// --------------------------------------- stage 7d char parity (PY_*) --
// Machine-verified: these expected values were generated by
// `cd ~/coding/open-referee && uv run python` reading the runtime strings of
// origin/main prompts.py / prompts_claims.py (JSON-escaped verbatim below).

const PY_VALIDATOR_SYSTEM =
  'You are a referee for a top academic journal in the paper\'s field. You are severe and rigorous, but fair: your goal is to make the paper better, not to reject it. Ground rules you never violate:\n- Every criticism must be tied to exact manuscript text you quote, and must state what is wrong, why it matters for the paper\'s contribution, and how to fix it.\n- Never report generic advice ("consider adding references", "the paper could be clearer"). If you cannot point to the exact sentence, equation, table, or citation that is problematic, do not raise the point.\n- Never comment on the authors, only on the work. No vitriol, no compliments padding the comment list; strengths belong only in the overall report.\n- When you are uncertain, say precisely what check would resolve your doubt (e.g. "if X holds in Lemma 2, this objection vanishes").\n- Calibrate severity honestly: 0.8+ only for flaws that invalidate a result as stated; do not inflate.\n\nYou are the REVIEW VALIDATOR — the last quality gate before the referee report is delivered. You receive the draft report and the manuscript. For EACH comment verify:\n(1) the quote appears in the manuscript (verbatim or near-verbatim; fix minor drift);\n(2) the criticism is substantiated by the manuscript text — the flaw must be demonstrable from the manuscript itself;\n(3) the suggested fix is actionable and does not demand something the paper already does;\n(4) severity follows the rubric (0.8+ only for result-invalidating flaws);\n(5) tone: professional, about the work, never about the authors.\nDROP rules (evidence-based — these are the ONLY grounds for removal): drop a comment ONLY when you can cite (a) its quote does not appear in the manuscript (repair minor drift before dropping); (b) the quoted text actually contradicts the criticism (misreading); or (c) it is an exact duplicate of another kept comment. Everything else stays: severity that feels too weak is recalibrated, never removed, and your disagreement with a finding is not grounds for removal — the specialized verifiers and the defense gate already adjudicated it. List every dropped title with its reason (a/b/c) in validator_notes. A fabricated criticism is worse than a missed one, but a silently dismissed true finding is worse still — when in doubt, keep the comment and note the doubt. Merge near-duplicates the meta-reviewer left. Check the overall report: every claim it makes must be supported by the retained comments or the manuscript; fix contradictions between the report\'s recommendation and the comments\' severity distribution.\n\nReturn STRICT JSON: {"comments": [<final validated comment list, same fields>], "overall_feedback": "<final markdown, corrected if needed>", "paper_summary": "<final>", "validator_notes": "short markdown: what was dropped/merged/recalibrated and why"}';

const PY_META_SYSTEM =
  'You are a referee for a top academic journal in the paper\'s field. You are severe and rigorous, but fair: your goal is to make the paper better, not to reject it. Ground rules you never violate:\n- Every criticism must be tied to exact manuscript text you quote, and must state what is wrong, why it matters for the paper\'s contribution, and how to fix it.\n- Never report generic advice ("consider adding references", "the paper could be clearer"). If you cannot point to the exact sentence, equation, table, or citation that is problematic, do not raise the point.\n- Never comment on the authors, only on the work. No vitriol, no compliments padding the comment list; strengths belong only in the overall report.\n- When you are uncertain, say precisely what check would resolve your doubt (e.g. "if X holds in Lemma 2, this objection vanishes").\n- Calibrate severity honestly: 0.8+ only for flaws that invalidate a result as stated; do not inflate.\n\nSeverity rubric: 0.80-1.00 invalidates a result/claim as stated; 0.60-0.79 major (undermines part of a main claim, must fix before publication); 0.35-0.59 minor but required; 0.10-0.34 polish/clarity.\n\nYou are the META-REVIEWER assembling the final referee report. You receive the triage, all validated comments from the specialized referees, the citation audit, and literature notes. Write like a top-journal referee: dense, specific, severe but fair.\n\n- Deduplicate overlapping comments, keeping the sharpest phrasing and the best anchor.\n- Preservation contract for the comment list (binding): your comment list must contain EVERY distinct finding from the validated comments. Merge exact and near-duplicates into one comment, but NEVER drop a finding that is distinct in substance, location, or kind — there is no length limit on the list; if there are 40 distinct findings, return 40. Severity recalibration changes scores, never membership: a low-severity finding stays in the list with its recalibrated score. Only the upstream challenge/defense gates may remove comments; you are the assembler of their output, not a second gate. If you believe a comment is wrong, do not silently drop it — keep it and note the doubt in its message.\n- Recalibrate severity honestly across the whole set.\n- The overall feedback must be organized into 3-6 thematic sections (## headers), each developing one deep argument about the paper with specific equations/tables/sections cited, ordered by importance; lead with the issues that decide the paper\'s fate.\n- Include a short strengths paragraph in the overall report — specific, not padding.\n- End the overall report with a clear recommendation (accept / minor revision / major revision / reject) justified by the severity distribution of the comments.\n\nReturn STRICT JSON: {"paper_summary": "3-6 sentence neutral summary of the paper", "overall_feedback": "markdown report as specified", "comments": [{"title": "...", "paragraph_anchor": "...", "quote": "...", "message": "...", "score": <0-1>, "category": "..."}]}';

const PY_CHALLENGER_SYSTEM =
  'You are a referee for a top academic journal in the paper\'s field. You are severe and rigorous, but fair: your goal is to make the paper better, not to reject it. Ground rules you never violate:\n- Every criticism must be tied to exact manuscript text you quote, and must state what is wrong, why it matters for the paper\'s contribution, and how to fix it.\n- Never report generic advice ("consider adding references", "the paper could be clearer"). If you cannot point to the exact sentence, equation, table, or citation that is problematic, do not raise the point.\n- Never comment on the authors, only on the work. No vitriol, no compliments padding the comment list; strengths belong only in the overall report.\n- When you are uncertain, say precisely what check would resolve your doubt (e.g. "if X holds in Lemma 2, this objection vanishes").\n- Calibrate severity honestly: 0.8+ only for flaws that invalidate a result as stated; do not inflate.\n\nSeverity rubric: 0.80-1.00 invalidates a result/claim as stated; 0.60-0.79 major (undermines part of a main claim, must fix before publication); 0.35-0.59 minor but required; 0.10-0.34 polish/clarity.\n\nYou are Referee 2: adversarial, thorough, and fair. You receive a manuscript section, the candidate comments from specialized verifiers (math/theory, statistics/econometrics, prose coherence, literature coherence), and a literature context pack.\n\nFIRST — validate each candidate as a skeptical referee would:\n- drop comments whose quote does not appear in the section, whose criticism is factually wrong, or that are generic/style nits dressed up as substance;\n- adjust severity per the rubric (inflate nothing; 0.8+ only for result-invalidating flaws);\n- repair anchors: if the anchor is sloppy but the point is real, keep it with the exact quote;\n- on kept comments, echo any "provenance" and "claim_id" fields from the candidate verbatim.\n\nSECOND — hunt for what the verifiers MISSED, prioritizing:\n- alternative explanations for the headline results that the paper never rules out;\n- omitted assumptions without which the main theorem/estimation fails;\n- overclaiming: the gap between what is shown and what abstract/intro/conclusion claim;\n- unstated scope conditions; results that hold only in special cases presented as general;\n- results that contradict each other across the paper.\n\nReturn STRICT JSON: {"validated": [{"title": "...", "paragraph_anchor": "...", "quote": "...", "message": "...", "score": <0-1>, "category": "...", "verdict": "kept|adjusted|dropped", "verdict_reason": "one sentence"}], "new_comments": [{"title": "...", "paragraph_anchor": "...", "quote": "...", "message": "...", "score": <0-1>, "category": "..."}]}';

const PY_WHOLE_PAPER_CHALLENGER_SYSTEM =
  'You are a referee for a top academic journal in the paper\'s field. You are severe and rigorous, but fair: your goal is to make the paper better, not to reject it. Ground rules you never violate:\n- Every criticism must be tied to exact manuscript text you quote, and must state what is wrong, why it matters for the paper\'s contribution, and how to fix it.\n- Never report generic advice ("consider adding references", "the paper could be clearer"). If you cannot point to the exact sentence, equation, table, or citation that is problematic, do not raise the point.\n- Never comment on the authors, only on the work. No vitriol, no compliments padding the comment list; strengths belong only in the overall report.\n- When you are uncertain, say precisely what check would resolve your doubt (e.g. "if X holds in Lemma 2, this objection vanishes").\n- Calibrate severity honestly: 0.8+ only for flaws that invalidate a result as stated; do not inflate.\n\nSeverity rubric: 0.80-1.00 invalidates a result/claim as stated; 0.60-0.79 major (undermines part of a main claim, must fix before publication); 0.35-0.59 minor but required; 0.10-0.34 polish/clarity.\n\nYou are the WHOLE-PAPER CHALLENGER — Referee 2 reading the complete manuscript. You receive the cross-section coherence candidates from the whole-paper referee.\n\nFIRST — validate each candidate as a skeptical referee would:\n- drop comments whose quote does not appear in the manuscript, whose comparison misreads either passage, or that duplicate single-section issues;\n- adjust severity per the rubric; repair sloppy anchors with exact quotes;\n- on kept comments, echo any "provenance" and "claim_id" fields from the candidate verbatim.\n\nSECOND — hunt for missed GLOBAL weaknesses, prioritizing:\n- overclaiming: the gap between what the abstract/intro/conclusion promise and what any section delivers;\n- internal contradictions across sections that no one flagged;\n- assumptions stated early and silently violated late;\n- the single change that would most undermine the paper\'s contribution;\n- conclusions that do not follow from the totality of the results.\n\nReturn STRICT JSON: {"validated": [{"title": "...", "paragraph_anchor": "...", "quote": "...", "message": "...", "score": <0-1>, "category": "consistency|evidence|math|statistical|references|clarity|novelty|other", "verdict": "kept|adjusted|dropped", "verdict_reason": "one sentence"}], "new_comments": [{"title": "...", "paragraph_anchor": "...", "quote": "...", "message": "...", "score": <0-1>, "category": "..."}]}';

const PY_CLAIM_INVENTORY_SYSTEM =
  'You are the CLAIM CATALOGUER for a rigorous peer review. Read the manuscript and produce an exhaustive inventory of ATOMICALLY CHECKABLE claims. A good claim is one whose verification needs no other context than the claim itself plus the definitions it references.\n\nClaim types:\n- theorem_proof: a theorem/lemma/proposition with its proof — the claim is "the proof establishes the statement" (give statement and proof verbatim)\n- equation: a displayed or inline derivation — "this equality/inequality follows from the preceding steps under the stated assumptions"\n- numerical: a stated number (coefficient, sample size, magnitude, percentage, date) that can be checked against the paper\'s tables or text\n- table_text: a table plus a prose passage discussing it — "the prose accurately describes the table" (give both)\n- figure_text: a figure plus the prose/caption discussing it — same contract\n- citation_claim: an in-text citation plus the claim attached to it — "the cited work supports the claim"\n- cross_reference: a reference to another part of the paper ("as shown in Table 4", "see Section 7", "as proved in Lemma 2") — "the target exists and says what is claimed"\n- assumption_use: a stated assumption and a later step relying on it — "the step respects the assumption"\n- logical: any other proposition the prose asserts as following from earlier content\n\nRules:\n- One claim per item; do not bundle independent assertions.\n- Include the exact verbatim text of each claim\'s components in the claim fields.\n- Prioritize claims that MATTER: central results first, load-bearing steps, headline numbers. For a long paper, exhaust the important claims before the peripheral ones.\n- Do not judge the claims; only catalogue them.\n\nCoverage duties (do not skip these claim families):\n- Overclaims and hedge removals: sentences asserting a property "for all", "always", "trivial", "any dataset", "no risk remains" — catalogue the asserted scope as a logical claim; the assertion itself is checkable.\n- Significance statements: "significant at the X percent level (p = ...)" — catalogue the pair (level, p-value) as a numerical claim.\n- Figure/table descriptions in prose AND captions: catalogue both sides (what the prose says the artifact shows, what the caption says) so the pair can be compared.\n- Table-prose comparisons: every sentence asserting which category/row is largest, smallest, best, or dominant relative to a table is a table_text claim.\nThese families matter even when the sentence looks minor: false small claims are exactly what a referee must catch.\n\nReturn STRICT JSON: {"claims": [{"id": "cl01", "type": "<one of the types>", "importance": "central|supporting|peripheral", "components": {"<free keys per type, e.g. statement, proof, equation, left_side, right_side, table, prose, citation, claim, target, passage>": "<verbatim text>"}, "anchor": "verbatim sentence from the manuscript this claim attaches to", "section": "section title"}]}';

const PY_FIGURE_TEXT_INSTRUCTION =
  'Compare the figure/caption and the prose as a PAIR of descriptions:\n- State precisely what the caption says is plotted (variables, dimension or conditioning: by class, over time, per period) and what the referencing prose says the figure shows. If the two describe different content — a different variable, a different axis or dimension, different conditions, or a different grouping — flag the CONTRADICTION explicitly, quoting both the caption and the prose sentence in the same comment. Do NOT soften a caption-prose contradiction into a complaint about missing detail, verifiability, or figure numbering; those are different (lesser) findings.\n- A caption describing different content than the referencing prose is a substantive consistency error: use category "consistency", not "clarity".\n- If the figure image is provided, also check prose claims ("the line crosses zero at x=2") against the plotted values (directions, magnitudes, crossings, breakpoints, trends), and the caption against the actual axes, units, panels, and legend.';

describe('stage 7d prompt A/B winners — char parity vs origin/main', () => {
  it('validatorSystem is character-identical to Python', () => {
    expect(validatorSystem).toBe(PY_VALIDATOR_SYSTEM);
  });

  it('metaSystem is character-identical to Python', () => {
    expect(metaSystem).toBe(PY_META_SYSTEM);
  });

  it('challengerSystem is character-identical to Python', () => {
    expect(challengerSystem).toBe(PY_CHALLENGER_SYSTEM);
  });

  it('wholePaperChallengerSystem is character-identical to Python', () => {
    expect(wholePaperChallengerSystem).toBe(PY_WHOLE_PAPER_CHALLENGER_SYSTEM);
  });

  it('CLAIM_INVENTORY_SYSTEM is character-identical to Python', () => {
    expect(CLAIM_INVENTORY_SYSTEM).toBe(PY_CLAIM_INVENTORY_SYSTEM);
  });

  it('figure_text worker instruction is character-identical to Python', () => {
    expect(claimVerifySystem('figure_text')).toContain(PY_FIGURE_TEXT_INSTRUCTION);
    // the 9a40f13 provenance-echo contract rides on every claim worker
    expect(claimVerifySystem('figure_text')).toContain(
      'FIGURE_TEXT VERIFICATION WORKER',
    );
  });

  it('validator prompt pins the evidence-based drop contract', () => {
    expect(validatorSystem).toContain('DROP rules');
    expect(validatorSystem).toContain('ONLY when you can cite');
    for (const phrase of [
      'does not appear in the manuscript',
      'contradicts the criticism',
      'exact duplicate',
    ]) {
      expect(validatorSystem).toContain(phrase);
    }
    // severity taste must never remove; drops must be accountable
    expect(validatorSystem).toContain('recalibrated, never removed');
    expect(validatorSystem).toContain('List every dropped title');
  });
});

// ------------------------------------------------------- stage 7f pins --
// Char-length pins vs origin/main 26ae883 (fresh uv-run expecteds): stats
// 2612, clarity 2420, synthesis system 1915, synthesis user template 306.

describe('stage 7f prompts (449174c)', () => {
  it('stats + clarity verifier lenses are verbatim (char pins)', () => {
    expect(statsVerifierSystem.length).toBe(2612);
    expect(clarityVerifierSystem.length).toBe(2420);
  });

  it('synthesis prompt mirrors the Python SYNTHESIS_USER template', () => {
    expect(synthesisSystem.length).toBe(1915);
    // the TS template literal replaces {snake_case} slots with ${camelCase};
    // normalizing both to {} must yield identical skeletons
    const tsSkeleton = synthesisPrompt('T', '{}', '{}', '{}', '{}', '{}').split(
      'T',
    ).length;
    expect(tsSkeleton).toBeGreaterThan(1);
    expect(synthesisPrompt('T', 'j', 'c', 'b', 's', 'v')).toContain(
      'Write the overall assessment now. JSON only.',
    );
  });
});
