// Persona Weaver — prompt builders.
// Every piece of user text goes through maskMacros() because generateRaw() substitutes
// {{user}}/{{char}} itself; the model sees [[user]]/[[char]] and index.js restores them.
//
// The persona is sent on every turn, so every block is written to a size budget (core.SIZES).
// The line caps asked for here are also enforced on the output by core.fitLayer().

import { SECTION_KEYS, LABELS, maskMacros, formatStats, sizeSpec } from './core.js';

const PRINCIPLES = `You are a character-writing editor for a roleplay platform. You write persona sheets for the PLAYER's character, called [[user]] in the sheet. Another AI reads the sheet on EVERY turn to roleplay with [[user]] or to write [[user]]'s turns, so every word costs tokens on every turn.

What makes a persona strong:
- People are defined by tensions, not adjectives. "Brave, kind, smart" describes nobody. Contradictions and costs describe someone.
- Voice is shown with exact lines, not described. A model copies examples far better than it follows descriptions.
- Specific beats generic. Cut any sentence that could describe anyone.
- Never contradict what the author wrote. Keep their facts; compress the wording, not the facts.

How to stay small:
- Dense, telegraphic writing is welcome: fragments, semicolons, no filler, no throat-clearing.
- Each fact appears once in the whole sheet. Never restate in one block what another block already says.
- No adjective lists, no "they are a person who", no explaining what a line means.
- No preamble, commentary, markdown, headings or bullet symbols.

Always write [[user]] and [[char]] exactly like that, in double square brackets, never as a name, wherever the sheet refers to those two characters.`;

const MOODS = ['angry', 'affectionate', 'lying or deflecting', 'casual', 'embarrassed'];

function moods(n) {
    return MOODS.slice(0, n).map(m => `(${m})`).join(' ');
}

/** Block instructions for one size. */
export function blockSpecs(size) {
    const s = sizeSpec(size);
    const L = s.lines;
    const w = s.lineWords;
    return {
        core: `CORE: at most ${s.coreWords} words. Who [[user]] is, what they do, what they want right now. Keep every fact that shapes how [[user]] acts now; compress hard.`,
        tension: `TENSION: exactly ${L.tension} one-line contradictions, at most ${w} words each, written as pairs: wants X / needs Y; says A / means B; fears C / hides it by doing D. Specific to this person.`,
        voice: `VOICE: at most ${s.voiceWords} words on how [[user]] talks: rhythm, sentence length, verbal habits, what they never say. Do not repeat what the samples already show.`,
        samples: `SAMPLES: exactly ${L.samples} lines of dialogue in this exact voice, one per line, each starting with its situation in parentheses: ${moods(L.samples)}. At most ${w} words each. Dialogue only, no narration.`,
        asymmetry: `ASYMMETRY: exactly ${L.asymmetry} lines, at most ${w} words each: what [[user]] hides from or knows about [[char]] that [[char]] does not; what [[char]] suspects or gets wrong about [[user]]. Build on the notes and character card; invent only small, plausible details.`,
        rules: `RULES: exactly ${L.rules} short imperative lines, at most ${w} words each, for an AI writing [[user]]'s turns. Only what is specific to this player: turn length, point of view and tense, formatting. One line must say never to act or speak for [[char]] and how to end a turn so [[char]] has something to answer. Skip generic writing advice.`,
    };
}

function budgetLine(size) {
    return `SIZE BUDGET: the whole sheet, all blocks together, must stay under about ${sizeSpec(size).tokens} tokens. When in doubt, cut.`;
}

export function languageRule(lang) {
    if (lang === 'th') {
        return 'Write in natural, vivid Thai, the way a Thai novelist would, not a translation. Word limits are approximate for Thai: keep clauses short. Do NOT put a space directly before or after [[user]], [[char]] or any character name when it touches Thai text: write "ไป[[user]]ที่" and never "ไป [[user]] ที่".';
    }
    if (lang === 'en') return 'Write in natural English.';
    return 'Write in the same language as the author\'s notes.';
}

function systemFor(lang) {
    return `${PRINCIPLES}\n\n${languageRule(lang)}`;
}

function blockFormat(keys) {
    return keys.map(k => `<<${k.toUpperCase()}>>\n(${k} content)\n<</${k.toUpperCase()}>>`).join('\n');
}

function draftText(sections, lang) {
    const labels = LABELS[lang] ?? LABELS.en;
    const lines = [];
    for (const key of SECTION_KEYS) {
        const v = String(sections?.[key] ?? '').trim();
        if (v) lines.push(`[${key.toUpperCase()}] ${labels[key]}:\n${v}`);
    }
    return lines.join('\n\n');
}

function charBlock(charCard) {
    if (!charCard?.text && !charCard?.greeting) return '';
    const parts = [];
    if (charCard.text) parts.push(`OTHER CHARACTER ([[char]]) — ${maskMacros(charCard.name)}:\n${maskMacros(charCard.text)}`);
    if (charCard.greeting) {
        parts.push(`OPENING SCENE (the first message of the story; it often sets who [[user]] is, where they are and why they are with [[char]]; the persona must fit it and must not contradict it):\n${maskMacros(charCard.greeting)}`);
    }
    return parts.join('\n\n');
}

/** What to tell the model when the author wrote no notes. */
function notesText(notes, charCard) {
    const n = String(notes ?? '').trim();
    if (n) return maskMacros(n);
    if (charCard?.text || charCard?.greeting) {
        return '(none. Invent [[user]] to fit [[char]] and the opening scene: someone with a reason to be there, a want that rubs against [[char]], and a secret worth discovering. Prefer the specific and slightly unexpected over the obvious match.)';
    }
    return '(none)';
}

/**
 * Weave: write (or rewrite) some or all sections.
 * @param {object} p
 * @param {string[]} [p.keys] sections to write, default all
 * @param {string} p.lang 'th' | 'en' | 'auto'
 * @param {string} [p.size] 'lean' | 'standard' | 'rich'
 * @param {string} p.name persona name
 * @param {string} p.notes the author's rough notes
 * @param {object} [p.sections] current draft sections (treated as author intent)
 * @param {{name:string,text:string}} [p.charCard]
 * @param {string} [p.styleNotes] extra evidence, e.g. style statistics
 */
export function buildWeavePrompt({ keys = SECTION_KEYS, lang, size, name, notes, sections, charCard, styleNotes }) {
    const draft = draftText(sections, lang === 'auto' ? 'en' : lang);
    const partial = keys.length < SECTION_KEYS.length;
    const specs = blockSpecs(size);

    const parts = [
        `PERSONA NAME: ${maskMacros(name || '(unnamed)')}`,
        `AUTHOR'S ROUGH NOTES (keep their facts; do not contradict):\n${notesText(notes, charCard)}`,
    ];
    if (draft) parts.push(`CURRENT DRAFT (where it already covers a block you write, treat it as the author's intent: keep its facts, raise its craft, do not make it longer):\n${maskMacros(draft)}`);
    const cc = charBlock(charCard);
    if (cc) parts.push(cc);
    if (styleNotes) parts.push(`EVIDENCE ABOUT HOW THE PLAYER ACTUALLY WRITES:\n${maskMacros(styleNotes)}`);

    parts.push(
        `${partial ? 'Write ONLY these blocks, consistent with the rest of the draft and without repeating it.' : 'Write all of these blocks.'}\n\n`
        + `${keys.map(k => specs[k]).join('\n')}\n\n`
        + `${budgetLine(size)}\n\n`
        + `Output exactly this format and nothing else:\n${blockFormat(keys)}`,
    );

    return { systemPrompt: systemFor(lang), prompt: parts.join('\n\n') };
}

/** Ideas: a few short persona concepts that fit a bot, for a fresh start with no chat yet. */
export function buildIdeasPrompt({ lang, notes, charCard }) {
    const parts = [];
    const cc = charBlock(charCard);
    if (cc) parts.push(cc);
    const n = String(notes ?? '').trim();
    if (n) parts.push(`AUTHOR'S NOTES (every idea must respect these):\n${maskMacros(n)}`);
    parts.push(
        'The player is about to start a NEW story with [[char]] and has no persona yet. Propose exactly 3 persona concepts for [[user]] that fit [[char]] and the opening scene, each creating a clearly different dynamic with [[char]] (for example friction, tenderness, mystery, rivalry). Avoid the most obvious match.\n'
        + 'Each idea: a short title, then 2-3 short lines: who [[user]] is and why they are in this scene; what they want from or hide from [[char]]; the dynamic it creates. At most 60 words per idea.\n\n'
        + 'Output exactly this format and nothing else:\n@@IDEA | Title\n(2-3 lines)',
    );
    return { systemPrompt: systemFor(lang), prompt: parts.join('\n\n') };
}

/** Condense: rewrite every filled block so the whole sheet fits the size budget. */
export function buildCondensePrompt({ lang, size, name, sections }) {
    const keys = SECTION_KEYS.filter(k => String(sections?.[k] ?? '').trim());
    const draft = draftText(sections, lang === 'auto' ? 'en' : lang);
    const specs = blockSpecs(size);
    const prompt = [
        `PERSONA NAME: ${maskMacros(name || '(unnamed)')}`,
        `CURRENT PERSONA SHEET (too long):\n${maskMacros(draft)}`,
        'Rewrite every block below so the sheet becomes much shorter. Keep every fact that changes how [[user]] acts or speaks; merge duplicates across blocks; drop flourish, filler and anything generic. Keep the author\'s strongest exact lines in SAMPLES. Do not add anything new.\n\n'
        + `${keys.map(k => specs[k]).join('\n')}\n\n`
        + `${budgetLine(size)}\n\n`
        + `Output exactly this format and nothing else:\n${blockFormat(keys)}`,
    ].join('\n\n');
    return { systemPrompt: systemFor(lang), prompt, keys };
}

/** Mine: derive voice, samples and writing rules from the player's real messages. */
export function buildMinePrompt({ lang, size, name, transcript, stats, sections }) {
    const keys = ['voice', 'samples', 'rules'];
    const specs = blockSpecs(size);
    const n = sizeSpec(size).lines.samples;
    const draft = draftText(sections, lang === 'auto' ? 'en' : lang);
    const parts = [
        `PERSONA NAME: ${maskMacros(name || '(unnamed)')}`,
        `STATISTICS (computed from the player's messages, treat as fact):\n${formatStats(stats)}`,
        `THE PLAYER'S OWN MESSAGES, oldest first:\n${maskMacros(transcript)}`,
    ];
    if (draft) parts.push(`CURRENT PERSONA DRAFT (stay consistent with it, do not repeat it):\n${maskMacros(draft)}`);
    parts.push(
        'Study how this player really writes, then produce:\n'
        + `${specs.voice}\n`
        + `SAMPLES: exactly ${n} lines in the situations ${moods(n)}. Quote or condense REAL lines from the messages whenever a fitting one exists; only invent a line when none fits, and match how this player really writes. Dialogue only, short.\n`
        + `${specs.rules} Ground them in the statistics (turn length, question habit, action markup, dialogue style).\n\n`
        + `${budgetLine(size)}\n\n`
        + `Output exactly this format and nothing else:\n${blockFormat(keys)}`,
    );
    return { systemPrompt: systemFor(lang), prompt: parts.join('\n\n') };
}

/** Evolve: propose a minimal patch after the story has moved on. */
export function buildEvolvePrompt({ lang, size, name, sections, transcript }) {
    const draft = draftText(sections, lang === 'auto' ? 'en' : lang);
    const prompt = [
        `PERSONA NAME: ${maskMacros(name || '(unnamed)')}`,
        `CURRENT PERSONA SHEET:\n${maskMacros(draft)}`,
        `RECENT STORY (oldest first):\n${maskMacros(transcript)}`,
        'Decide what the recent story has genuinely changed about [[user]]: beliefs, wounds, secrets now revealed, relationship with [[char]], new habits, new ways of speaking.\n'
        + 'Output ONLY the blocks that truly need to change, fully rewritten (not diffs), keeping every still-true fact. Do not rewrite a block for style alone. A changed block must not be longer than before: replace what is no longer true instead of adding to it. If nothing has changed, output only the SUMMARY block saying so.\n'
        + 'Block names you may use: CORE, TENSION, VOICE, SAMPLES, ASYMMETRY, RULES. Block formats are the same as in the current sheet.\n'
        + `${budgetLine(size)}\n`
        + 'Finish with a SUMMARY block: one short line per changed block explaining what changed and which moment in the story caused it.\n\n'
        + 'Output format:\n<<TENSION>>\n(only if changed)\n<</TENSION>>\n<<SUMMARY>>\n(one line per change)\n<</SUMMARY>>',
    ].join('\n\n');
    return { systemPrompt: systemFor(lang), prompt };
}

/** Lore: move backstory and secrets out of the always-on persona into keyword-triggered entries. */
export function buildLorePrompt({ lang, size, name, notes, sections, charCard }) {
    const draft = draftText(sections, lang === 'auto' ? 'en' : lang);
    const words = { lean: '30-70', standard: '40-90', rich: '50-120' }[size] ?? '30-70';
    const parts = [
        `PERSONA NAME: ${maskMacros(name || '(unnamed)')}`,
        `AUTHOR'S ROUGH NOTES:\n${maskMacros(notes || '(none)')}`,
    ];
    if (draft) parts.push(`CURRENT PERSONA SHEET (always in the prompt, so do not repeat its content):\n${maskMacros(draft)}`);
    const cc = charBlock(charCard);
    if (cc) parts.push(cc);
    parts.push(
        'Create 3-6 lorebook entries for material about [[user]] that should NOT sit in the always-on sheet: backstory episodes, secrets, relationships with side characters, places, objects, old wounds. They surface only when the chat mentions them.\n'
        + `Each entry: a short title; 2-5 trigger keys (words or phrases likely to appear in the chat when this matters, in the chat's language, include name variants); ${words} words of dense content in third person about [[user]]. Use only what the notes and sheet support, plus small plausible detail.\n\n`
        + 'Output exactly this format and nothing else, one header line then the content, for every entry:\n'
        + '@@ENTRY | Title | key one, key two, key three\n(content)',
    );
    return { systemPrompt: systemFor(lang), prompt: parts.join('\n\n') };
}
