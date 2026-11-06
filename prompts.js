// Persona Weaver — prompt builders.
// Every piece of user text goes through maskMacros() because generateRaw() substitutes
// {{user}}/{{char}} itself; the model sees [[user]]/[[char]] and index.js restores them.

import { SECTION_KEYS, LABELS, maskMacros, formatStats } from './core.js';

const PRINCIPLES = `You are a character-writing editor for a roleplay platform. You write persona sheets for the PLAYER's character, called [[user]] in the sheet. Another AI reads the sheet to roleplay with [[user]] or to write [[user]]'s turns. [[char]] is the other main character in the story.

What makes a persona strong:
- People are defined by tensions, not adjectives. "Brave, kind, smart" describes nobody. Contradictions and costs describe someone.
- Voice is shown with exact lines, not described. A model copies examples far better than it follows descriptions.
- Specific beats generic. Cut any sentence that could describe anyone.
- Never contradict or throw away what the author already wrote. Expand and sharpen it.
- Be compact. No filler, no preamble, no commentary, no markdown headings.

Always write [[user]] and [[char]] exactly like that, in double square brackets, never as a name, wherever the sheet refers to those two characters.`;

const BLOCK_SPECS = {
    core: 'CORE: 2-4 sentences. Who [[user]] is, what they do, what they want right now. Keep every fact the author supplied.',
    tension: 'TENSION: 2-4 one-line contradictions written as pairs. Examples of the shapes: wants X / needs Y; says A / means B; fears C / hides it by doing D. Make them specific to this person.',
    voice: 'VOICE: 2-4 sentences on how [[user]] talks and writes: rhythm, sentence length, vocabulary, verbal habits, what they never say.',
    samples: 'SAMPLES: exactly 5 short lines of dialogue in this exact voice, one per line, each starting with the situation in parentheses: (angry) (affectionate) (lying or deflecting) (embarrassed) (casual). Dialogue only, no narration.',
    asymmetry: 'ASYMMETRY: 3-5 short lines. What [[user]] knows about [[char]] that [[char]] has not noticed; what [[char]] knows or suspects about [[user]]; what [[user]] is hiding; what each gets wrong about the other. Build on the notes and character card; invent only small, plausible details.',
    rules: 'RULES: 4-6 short imperative lines for an AI writing [[user]]\'s turns: length per turn, point of view and tense, dialogue/action formatting, what must never be decided for [[char]], and how to end a turn so [[char]] has something to answer.',
};

export function languageRule(lang) {
    if (lang === 'th') {
        return 'Write in natural, vivid Thai, the way a Thai novelist would, not a translation. Do NOT put a space directly before or after [[user]], [[char]] or any character name when it touches Thai text: write "ไป[[user]]ที่" and never "ไป [[user]] ที่".';
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
    if (!charCard?.text) return '';
    return `\nOTHER CHARACTER ([[char]]) — ${maskMacros(charCard.name)}:\n${maskMacros(charCard.text)}\n`;
}

/**
 * Weave: write (or rewrite) some or all sections.
 * @param {object} p
 * @param {string[]} [p.keys] sections to write, default all
 * @param {string} p.lang 'th' | 'en' | 'auto'
 * @param {string} p.name persona name
 * @param {string} p.notes the author's rough notes
 * @param {object} [p.sections] current draft sections (treated as author intent)
 * @param {{name:string,text:string}} [p.charCard]
 * @param {string} [p.styleNotes] extra evidence, e.g. style statistics
 */
export function buildWeavePrompt({ keys = SECTION_KEYS, lang, name, notes, sections, charCard, styleNotes }) {
    const draft = draftText(sections, lang === 'auto' ? 'en' : lang);
    const partial = keys.length < SECTION_KEYS.length;

    const parts = [
        `PERSONA NAME: ${maskMacros(name || '(unnamed)')}`,
        `AUTHOR'S ROUGH NOTES (keep every fact; do not contradict):\n${maskMacros(notes || '(none)')}`,
    ];
    if (draft) parts.push(`CURRENT DRAFT (where it already covers a block you write, treat it as the author's intent: keep its facts, raise its craft):\n${maskMacros(draft)}`);
    const cc = charBlock(charCard);
    if (cc) parts.push(cc.trim());
    if (styleNotes) parts.push(`EVIDENCE ABOUT HOW THE PLAYER ACTUALLY WRITES:\n${maskMacros(styleNotes)}`);

    parts.push(
        `${partial ? 'Write ONLY these blocks and keep them consistent with the rest of the draft.' : 'Write all of these blocks.'}\n\n`
        + `${keys.map(k => BLOCK_SPECS[k]).join('\n')}\n\n`
        + `Output exactly this format and nothing else:\n${blockFormat(keys)}`,
    );

    return { systemPrompt: systemFor(lang), prompt: parts.join('\n\n') };
}

/** Mine: derive voice, samples and writing rules from the player's real messages. */
export function buildMinePrompt({ lang, name, transcript, stats, sections }) {
    const keys = ['voice', 'samples', 'rules'];
    const draft = draftText(sections, lang === 'auto' ? 'en' : lang);
    const parts = [
        `PERSONA NAME: ${maskMacros(name || '(unnamed)')}`,
        `STATISTICS (computed from the player's messages, treat as fact):\n${formatStats(stats)}`,
        `THE PLAYER'S OWN MESSAGES, oldest first:\n${maskMacros(transcript)}`,
    ];
    if (draft) parts.push(`CURRENT PERSONA DRAFT (stay consistent with it):\n${maskMacros(draft)}`);
    parts.push(
        'Study how this player really writes, then produce:\n'
        + `${BLOCK_SPECS.voice}\n`
        + 'SAMPLES: exactly 5 lines in the situations (angry) (affectionate) (lying or deflecting) (embarrassed) (casual). Quote or lightly condense REAL lines from the messages whenever a fitting one exists; only invent a line when none fits, and match how this player really writes. Dialogue only.\n'
        + 'RULES: 4-6 short imperative lines for an AI writing this player\'s turns. Ground them in the statistics (turn length, question habit, action markup, dialogue style) and in what the player does and never does.\n\n'
        + `Output exactly this format and nothing else:\n${blockFormat(keys)}`,
    );
    return { systemPrompt: systemFor(lang), prompt: parts.join('\n\n') };
}

/** Evolve: propose a minimal patch after the story has moved on. */
export function buildEvolvePrompt({ lang, name, sections, transcript }) {
    const draft = draftText(sections, lang === 'auto' ? 'en' : lang);
    const prompt = [
        `PERSONA NAME: ${maskMacros(name || '(unnamed)')}`,
        `CURRENT PERSONA SHEET:\n${maskMacros(draft)}`,
        `RECENT STORY (oldest first):\n${maskMacros(transcript)}`,
        'Decide what the recent story has genuinely changed about [[user]]: beliefs, wounds, secrets now revealed, relationship with [[char]], new habits, new ways of speaking.\n'
        + 'Output ONLY the blocks that truly need to change, fully rewritten (not diffs), keeping every still-true fact. Do not rewrite a block for style alone. If nothing has changed, output only the SUMMARY block saying so.\n'
        + 'Block names you may use: CORE, TENSION, VOICE, SAMPLES, ASYMMETRY, RULES. Block formats are the same as in the current sheet.\n'
        + 'Finish with a SUMMARY block: one short line per changed block explaining what changed and which moment in the story caused it.\n\n'
        + 'Output format:\n<<TENSION>>\n(only if changed)\n<</TENSION>>\n<<SUMMARY>>\n(one line per change)\n<</SUMMARY>>',
    ].join('\n\n');
    return { systemPrompt: systemFor(lang), prompt };
}

/** Lore: move backstory and secrets out of the always-on persona into keyword-triggered entries. */
export function buildLorePrompt({ lang, name, notes, sections, charCard }) {
    const draft = draftText(sections, lang === 'auto' ? 'en' : lang);
    const parts = [
        `PERSONA NAME: ${maskMacros(name || '(unnamed)')}`,
        `AUTHOR'S ROUGH NOTES:\n${maskMacros(notes || '(none)')}`,
    ];
    if (draft) parts.push(`CURRENT PERSONA SHEET (always in the prompt, so do not repeat its content):\n${maskMacros(draft)}`);
    const cc = charBlock(charCard);
    if (cc) parts.push(cc.trim());
    parts.push(
        'Create 3-6 lorebook entries for material about [[user]] that should NOT sit in the always-on sheet: backstory episodes, secrets, relationships with side characters, places, objects, old wounds. They surface only when the chat mentions them.\n'
        + 'Each entry: a short title; 2-5 trigger keys (words or phrases likely to appear in the chat when this matters, in the chat\'s language, include name variants); 40-120 words of content in third person about [[user]]. Use only what the notes and sheet support, plus small plausible detail.\n\n'
        + 'Output exactly this format and nothing else, one header line then the content, for every entry:\n'
        + '@@ENTRY | Title | key one, key two, key three\n(content)',
    );
    return { systemPrompt: systemFor(lang), prompt: parts.join('\n\n') };
}
