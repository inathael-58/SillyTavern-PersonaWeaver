// Persona Weaver — prompt builders.
// Every piece of user text goes through maskMacros() because generateRaw() substitutes
// {{user}}/{{char}} itself; the model sees [[user]]/[[char]] and index.js restores them.
//
// The persona is sent on every turn, so every block is written to a size budget (core.SIZES).
// The line caps asked for here are also enforced on the output by core.fitLayer().

import { SECTION_KEYS, LABELS, maskMacros, formatStats, sizeSpec, ideaSplit, NAMES_PER_BATCH } from './core.js';

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
        core: `CORE: at most ${s.coreWords} words. Who [[user]] is, what they do, what they want right now. Keep every fact that shapes how [[user]] acts now; compress hard. Leave looks to LOOK.`,
        look: `LOOK: at most ${s.lookWords} words of what others see and notice: build and height, face, hair and eyes, how they dress or a signature item, and one distinctive detail (a scar, a scent, a way of standing). Concrete nouns, fitting the story's world; no generic beauty words. Keep any appearance the author or the opening scene already gave, exactly.`,
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
        return 'Write in natural, vivid Thai, the way a Thai novelist would, not a translation. Word limits are approximate for Thai: keep clauses short. Do NOT put a space directly before or after [[user]], [[char]] or any character name when it touches Thai text: write "ไป[[user]]ที่" and never "ไป [[user]] ที่". Writing in Thai does not make the world Thai: names, places and customs still follow [[char]]\'s setting.';
    }
    if (lang === 'en') return 'Write in natural English.';
    return 'Write in the same language as the author\'s notes.';
}

/**
 * Models read the language of the notes as a clue about who [[user]] is: Thai notes for a
 * Western bot gave a Thai girl with romanized Thai names, temple visits and all.
 */
export const NOT_A_CLUE = 'The author may write notes in their own language (Thai, for example). That language says nothing about [[user]]: [[user]]\'s nationality, ethnicity, culture, names, places, food and customs come from [[char]]\'s world as the card shows it, never from the language the notes are written in. Make [[user]] come from somewhere else only when the notes or the card say so in words.';

function systemFor(lang) {
    return `${PRINCIPLES}\n\n${NOT_A_CLUE}\n\n${languageRule(lang)}`;
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

/** True when the card fixes who [[user]] is and the author keeps that role. */
function roleLocked(charCard) {
    return Boolean(String(charCard?.role ?? '').trim()) && charCard?.roleLocked !== false;
}

function roleBlock(charCard) {
    const role = String(charCard?.role ?? '').trim();
    if (!role) return '';
    if (charCard?.roleLocked === false) {
        return `[[user]]'S DEFAULT ROLE IN THIS CARD (the author allows departing from it; keep only what the premise does not replace):\n${maskMacros(role)}`;
    }
    return `[[user]]'S ROLE, FIXED BY THE CARD (hard canon: the persona lives INSIDE this role and never replaces or contradicts it: same origin, status, condition, teacher, belongings and situation. Build personality, motives, history before the story, habits and private secrets around it. Anything the card says [[user]] does not know stays unknown to [[user]]: never state it, never let the persona know it):\n${maskMacros(role)}`;
}

function charBlock(charCard, premise) {
    if (!charCard?.text && !charCard?.greeting && !charCard?.role) return '';
    const parts = [];
    const rb = roleBlock(charCard);
    if (rb) parts.push(rb);
    if (charCard.text) parts.push(`OTHER CHARACTER ([[char]]) — ${maskMacros(charCard.name)}:\n${maskMacros(charCard.text)}`);
    if (charCard.greeting) {
        const rule = roleLocked(charCard)
            ? 'it shows [[user]] already inside the fixed role; keep its facts'
            : String(premise ?? '').trim()
                ? 'keep its hard facts (place, moment, who is present, what just happened); the PREMISE decides who [[user]] really is in it'
                : 'it often sets who [[user]] is, where they are and why they are with [[char]]; the persona must fit it and must not contradict it';
        parts.push(`OPENING SCENE (the first message of the story; ${rule}):\n${maskMacros(charCard.greeting)}`);
    }
    return parts.join('\n\n');
}

export const GENDERS = ['', 'female', 'male', 'nonbinary'];

/**
 * Gender and pronouns of [[user]]. Thai needs more than she/he: narration pronoun,
 * first-person pronouns and polite particles all follow gender.
 */
export function genderRule(gender, pronouns, lang) {
    const custom = String(pronouns ?? '').trim();
    const lines = [];
    if (gender === 'female') {
        lines.push('[[user]] is FEMALE. Refer to [[user]] as she/her.');
        if (lang !== 'en') lines.push('In Thai: narration calls her เธอ (never เขา or a male word); in her own dialogue she uses a feminine first-person pronoun that fits her background and era (ฉัน, ดิฉัน, ข้า, หนู…) and, when polite, ค่ะ/คะ or a period-fitting equivalent, never ครับ.');
    } else if (gender === 'male') {
        lines.push('[[user]] is MALE. Refer to [[user]] as he/him.');
        if (lang !== 'en') lines.push('In Thai: narration calls him เขา; in his own dialogue he uses a masculine first-person pronoun that fits his background and era (ผม, ข้า, กระผม, ฉัน…) and, when polite, ครับ or a period-fitting equivalent (ขอรับ), never ค่ะ.');
    } else if (gender === 'nonbinary') {
        lines.push('[[user]] is NON-BINARY. Refer to [[user]] as they/them.');
        if (lang !== 'en') lines.push('In Thai: narration uses the name or a neutral เขา; in their own dialogue they use เรา or ฉัน and avoid gendered polite particles (ค่ะ/ครับ) unless the notes say otherwise.');
    }
    if (custom) lines.push(`Use exactly these pronouns for [[user]]: ${maskMacros(custom)}.`);
    return lines.join(' ');
}

function identityBlock(gender, pronouns, lang) {
    const rule = genderRule(gender, pronouns, lang);
    return rule ? `GENDER AND PRONOUNS (fixed, apply everywhere, including dialogue samples):\n${rule}` : '';
}

function premiseBlock(premise, locked = false) {
    const p = String(premise ?? '').trim();
    if (!p) return '';
    if (locked) {
        return `PREMISE (the concept the author chose for [[user]]; it is the FOUNDATION of the persona and every block must express it. It works INSIDE the role the card fixes: where it seems to clash with that role, keep the role and find the reading of the premise that fits it. Over the notes and the current draft, the premise wins):\n${maskMacros(p)}`;
    }
    return `PREMISE (the concept the author chose for [[user]]; it is the FOUNDATION of the persona. Every block must express it, not just mention it. Where the current draft, the notes or the obvious reading of the card disagree with it, the premise wins. From the opening scene keep only its hard facts (place, moment, who is present) and reinterpret [[user]]'s place in it through the premise):\n${maskMacros(p)}`;
}

/** What to tell the model when the author wrote no notes. */
function notesText(notes, charCard, premise) {
    const n = String(notes ?? '').trim();
    if (n) return maskMacros(n);
    if (String(premise ?? '').trim()) return '(none beyond the premise)';
    if (roleLocked(charCard)) {
        return '(none. The card fixes [[user]]\'s role; invent the person inside it: a specific temperament, a want, a private secret the card leaves open, and a way of coping with the situation the card puts [[user]] in.)';
    }
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
export function buildWeavePrompt({ keys = SECTION_KEYS, lang, size, name, notes, sections, charCard, styleNotes, premise, gender, pronouns, nameInfo, withNames = false, worldNames = '', nameSource = 'mix', nameScript = '' }) {
    const draft = draftText(sections, lang === 'auto' ? 'en' : lang);
    const partial = keys.length < SECTION_KEYS.length;
    const specs = blockSpecs(size);
    const hasPremise = Boolean(String(premise ?? '').trim());

    const parts = [`PERSONA NAME: ${maskMacros(name || '(unnamed)')}`];
    const id = identityBlock(gender, pronouns, lang);
    if (id) parts.push(id);
    if (hasPremise) parts.push(premiseBlock(premise, roleLocked(charCard)));
    const nib = nameInfoBlock(nameInfo);
    if (nib) parts.push(nib);
    parts.push(`AUTHOR'S ROUGH NOTES (keep their facts; do not contradict):\n${notesText(notes, charCard, premise)}`);
    if (draft) {
        parts.push(hasPremise
            ? `CURRENT DRAFT (keep what fits the PREMISE and raise its craft; anything that contradicts or ignores the premise is outdated: rewrite it to follow the premise. Do not make it longer):\n${maskMacros(draft)}`
            : `CURRENT DRAFT (where it already covers a block you write, treat it as the author's intent: keep its facts, raise its craft, do not make it longer):\n${maskMacros(draft)}`);
    }
    const cc = charBlock(charCard, premise);
    if (cc) parts.push(cc);
    if (styleNotes) parts.push(`EVIDENCE ABOUT HOW THE PLAYER ACTUALLY WRITES:\n${maskMacros(styleNotes)}`);
    const wb = withNames ? worldBlock(worldNames) : '';
    if (wb) parts.push(wb);
    const outKeys = withNames ? [...keys, 'names'] : keys;

    parts.push(
        `${partial ? 'Write ONLY these blocks, consistent with the rest of the draft and without repeating it.' : 'Write all of these blocks.'}\n\n`
        + `${keys.map(k => specs[k]).join('\n')}\n`
        + `${keys.includes('core') && (gender || String(pronouns ?? '').trim()) ? 'CORE opens with [[user]]\'s gender and pronouns in a few words, so any AI reading the sheet uses them (e.g. "Woman, she/her." or "หญิง (เธอ)").\n' : ''}`
        + `${hasPremise ? 'Check before answering: every block you write must clearly come from the PREMISE.\n' : ''}`
        + `${nib && (keys.includes('core') || keys.length > 1) ? `${NAME_IN_SHEET}\n` : ''}`
        + `${withNames ? `${namesSpec({ source: nameSource, hasWorld: Boolean(wb), script: nameScript, example: charCard?.name })} The NAMES block does not count toward the size budget.\n` : ''}`
        + `\n${budgetLine(size)}\n\n`
        + `Output exactly this format and nothing else:\n${blockFormat(outKeys)}`,
    );

    return { systemPrompt: systemFor(lang), prompt: parts.join('\n\n') };
}

/** How the names should be sourced. */
function nameSourceRule(source, hasWorld) {
    if (!hasWorld || source === 'new') return 'Invent fresh names that suit the setting; do not borrow existing names from the card.';
    if (source === 'world') return 'Build them from the WORLD NAMES list: its houses, clans, places and naming patterns. A new name is fine when it clearly follows those patterns.';
    return 'About half should draw on the WORLD NAMES list (its houses, clans, places, naming patterns); the rest freshly invented in the same style.';
}

/** Instructions for a NAMES block, shared by the weave prompt and the names-only prompt. */
const SCRIPT_NAMES = { latin: 'Latin letters', thai: 'Thai script', cjk: 'the Chinese, Japanese or Korean characters the card uses' };

/** A hard rule on the script of every suggested name, from the bot's own name. */
export function nameScriptRule(script, example = '') {
    const label = SCRIPT_NAMES[script];
    if (!label) return '';
    const ex = String(example ?? '').trim();
    return `NAME SCRIPT AND CULTURE: [[char]]'s world writes names in ${label}${ex ? ` (like "${maskMacros(ex)}")` : ''}. Write EVERY name in ${label}, and take every name from the same culture as [[char]]'s world, even when the author's notes or the output language use another language. A name in another script is wrong; so is a name from another culture spelled in ${label} (a romanized Thai name in a Western setting, for example), unless the notes say [[user]] comes from there.`;
}

export function namesSpec({ source = 'mix', hasWorld = false, count = NAMES_PER_BATCH, script = '', example = '' } = {}) {
    const scriptRule = nameScriptRule(script, example);
    return `NAMES: exactly ${count} name ideas for [[user]], one per line, as "Full name | meaning | gimmick". `
        + 'A name is a status: give a given name plus family name, or whatever naming form this world uses (clan name, title, epithet, a single name with a byname). '
        + 'Every name must MEAN something: its real meaning in its language of origin, or an in-world meaning or wordplay that fits the setting. MEANING (at most 10 words) says what it means; when a family name carries the weight, say what the family name means. '
        + 'GIMMICK (at most 20 words) turns that meaning into something playable for [[user]]: an irony between the name and the person, a habit or superstition, a power or a curse, how people react on hearing it, a nickname, the status it carries (old house, fallen house, commoner, foreigner, an alias hiding the truth). The gimmick must fit the premise. '
        + 'Each name must fit [[user]]\'s gender and the culture of [[char]]\'s world. Make them varied in meaning, status and sound. '
        + 'Never reuse [[char]]\'s own name or the name of a character already in the world; reuse a family or house only as a deliberate story point and say so in the gimmick. If the card fixes [[user]]\'s role, every name fits that role\'s origin and standing. '
        + 'The culture, sound and script of every name come from [[char]]\'s world (as the card and lorebook write names), NEVER from the output language or the language of the author\'s notes: a Western setting gets Western names in Latin letters even when everything else is written in Thai; a Thai setting gets Thai names in Thai script. Only meaning and gimmick are written in the output language. '
        + nameSourceRule(source, hasWorld)
        + (scriptRule ? ` ${scriptRule}` : '');
}

/** The chosen name and its meaning, as part of who [[user]] is. */
function nameInfoBlock(nameInfo) {
    const n = String(nameInfo?.name ?? '').trim();
    const meaning = String(nameInfo?.meaning ?? '').trim();
    const gimmick = String(nameInfo?.gimmick ?? '').trim();
    if (!n || (!meaning && !gimmick)) return '';
    return `THE NAME (part of who [[user]] is): [[user]] is called "${maskMacros(n)}".`
        + `${meaning ? ` It means: ${maskMacros(meaning)}.` : ''}`
        + `${gimmick ? ` Gimmick: ${maskMacros(gimmick)}.` : ''}`;
}

const NAME_IN_SHEET = 'Let THE NAME show in the sheet: CORE names its meaning in a few words, and the gimmick appears in at least one of LOOK, TENSION, VOICE or SAMPLES (a habit, a line of dialogue, an irony). Say it once; never explain it twice.';

function worldBlock(worldNames) {
    const w = String(worldNames ?? '').trim();
    return w ? `WORLD NAMES (titles and keywords from [[char]]'s lorebook, for flavour):\n${maskMacros(w)}` : '';
}

/** Names only: suggestions for the persona's name, without rewriting anything else. */
export function buildNamesPrompt({ lang, notes, sections, charCard, premise, gender, pronouns, worldNames, source = 'mix', avoid = [], nameScript = '' }) {
    const draft = draftText(sections, lang === 'auto' ? 'en' : lang);
    const parts = [];
    const id = identityBlock(gender, pronouns, lang);
    if (id) parts.push(id);
    if (String(premise ?? '').trim()) parts.push(premiseBlock(premise, roleLocked(charCard)));
    if (String(notes ?? '').trim()) parts.push(`AUTHOR'S NOTES:\n${maskMacros(notes)}`);
    if (draft) parts.push(`PERSONA SHEET:\n${maskMacros(draft)}`);
    const cc = charBlock(charCard, premise);
    if (cc) parts.push(cc);
    const wb = worldBlock(worldNames);
    if (wb) parts.push(wb);
    const seen = avoid.map(n => String(n ?? '').trim()).filter(Boolean);
    if (seen.length) parts.push(`ALREADY SUGGESTED (do not repeat these or close variants):\n${seen.map(n => `- ${maskMacros(n)}`).join('\n')}`);
    parts.push(
        `${namesSpec({ source, hasWorld: Boolean(wb), script: nameScript, example: charCard?.name })}\n\n`
        + 'Output exactly this format and nothing else:\n<<NAMES>>\nFull name | meaning | gimmick\n<</NAMES>>',
    );
    return { systemPrompt: systemFor(lang), prompt: parts.join('\n\n') };
}

/** Meaning and gimmick for a name the author typed themselves. */
export function buildNameMeaningPrompt({ lang, name, notes, sections, charCard, premise, gender, pronouns }) {
    const draft = draftText(sections, lang === 'auto' ? 'en' : lang);
    const parts = [`THE NAME: ${maskMacros(name)}`];
    const id = identityBlock(gender, pronouns, lang);
    if (id) parts.push(id);
    if (String(premise ?? '').trim()) parts.push(premiseBlock(premise, roleLocked(charCard)));
    if (String(notes ?? '').trim()) parts.push(`AUTHOR'S NOTES:\n${maskMacros(notes)}`);
    if (draft) parts.push(`PERSONA SHEET:\n${maskMacros(draft)}`);
    const cc = charBlock(charCard, premise);
    if (cc) parts.push(cc);
    parts.push(
        'Give the meaning of THE NAME and a gimmick for [[user]]. MEANING (at most 10 words): its real meaning in its language of origin; if it has none, a plausible meaning inside this setting, or wordplay, and say which. '
        + 'GIMMICK (at most 20 words): how that meaning becomes something playable for [[user]] (an irony, a habit or superstition, a power or curse, how others react, a nickname, the status it carries). It must fit the premise and the persona. '
        + 'Write meaning and gimmick in the output language; keep the name exactly as given.\n\n'
        + 'Output exactly this format and nothing else:\n<<MEANING>>\nName | meaning | gimmick\n<</MEANING>>',
    );
    return { systemPrompt: systemFor(lang), prompt: parts.join('\n\n') };
}

/** Name gimmick: work the chosen name's meaning into a sheet that is already written. */
export function buildNameGimmickPrompt({ lang, size, name, sections, nameInfo, premise, gender, pronouns }) {
    const draft = draftText(sections, lang === 'auto' ? 'en' : lang);
    const specs = blockSpecs(size);
    const parts = [`PERSONA NAME: ${maskMacros(name || nameInfo?.name || '(unnamed)')}`];
    const id = identityBlock(gender, pronouns, lang);
    if (id) parts.push(id);
    if (String(premise ?? '').trim()) parts.push(`PREMISE (stay true to it):\n${maskMacros(premise)}`);
    parts.push(nameInfoBlock(nameInfo));
    parts.push(`CURRENT PERSONA SHEET:\n${maskMacros(draft)}`);
    parts.push(
        'Work THE NAME into the sheet as a gimmick. Rewrite ONLY the blocks it needs, at most three: CORE always (name the meaning in a few words), then the one or two of LOOK, TENSION, VOICE or SAMPLES where the gimmick plays best. Keep every other fact; replace weaker detail instead of adding, so the sheet stays about the same size. Do not output blocks you did not change.\n'
        + `Block formats:\n${['core', 'look', 'tension', 'voice', 'samples'].map(k => specs[k]).join('\n')}\n\n`
        + `${budgetLine(size)}\n\n`
        + 'Output only the changed blocks, in this format:\n<<CORE>>\n(core content)\n<</CORE>>\n<<SAMPLES>>\n(only if changed)\n<</SAMPLES>>',
    );
    return { systemPrompt: systemFor(lang), prompt: parts.filter(Boolean).join('\n\n') };
}

/** Directions for unexpected ideas. The model picks different ones for each wild idea. */
const WILD_ANGLES = [
    '[[user]] is not what the scene assumes (not human, not alone, not from this time, already dead, the one everyone is looking for)',
    'a hidden past connection to [[char]] that [[char]] has forgotten, misremembers or never knew about',
    'a reversal of power or role: [[user]] holds the leverage, the debt, the secret or the authority [[char]] expects to hold',
    'a different genre colliding with this one (comedy, horror, heist, slice of life, political intrigue, cosmic)',
    'a morally grey or outright villainous [[user]] with a sympathetic reason',
    'an absurd but fully playable premise, played completely straight',
    'a tiny, ordinary person who is in this scene for a ridiculous or heartbreaking small reason',
];

/**
 * Wild angles that keep a role the card fixes. "Not human" or "from another time" would
 * break such a card, so surprise comes from who the person is inside the role.
 */
const ROLE_WILD_ANGLES = [
    'a temperament nobody expects in this role (the cheerful one under the curse, the schemer in the lowliest post, the coward who keeps volunteering)',
    'a private obsession, skill or hobby that has nothing to do with the role and keeps getting in the way',
    'a hidden reason for being here that the card leaves open, different from the official one',
    'a secret tie, debt or grudge with someone in this world, from before the story',
    'a strange way of coping with the situation the card imposes: a ritual, a superstition, a running joke played straight',
    'a belief or an old wound that bends how they live this role, for better or worse',
    'a misunderstanding about themselves that everyone else shares, or that only they believe',
];

/**
 * Ideas: persona concepts that fit a bot, for a fresh start with no chat yet.
 * @param {object} p
 * @param {'mix'|'fit'|'wild'} [p.mix] how many grounded vs unexpected ideas
 * @param {string[]} [p.avoid] titles already shown, so a new batch does not repeat them
 */
export function buildIdeasPrompt({ lang, notes, charCard, mix = 'mix', avoid = [], gender, pronouns }) {
    const { fit, wild } = ideaSplit(mix);
    const total = fit + wild;
    const parts = [];
    const id = identityBlock(gender, pronouns, lang);
    if (id) parts.push(`${id}\nEvery idea keeps this gender${roleLocked(charCard) ? '' : ', even when [[user]] is not human'}.`);
    const cc = charBlock(charCard);
    if (cc) parts.push(cc);
    const n = String(notes ?? '').trim();
    if (n) parts.push(`AUTHOR'S NOTES (every idea must respect these):\n${maskMacros(n)}`);
    const seen = avoid.map(t => String(t ?? '').trim()).filter(Boolean);
    if (seen.length) parts.push(`ALREADY SUGGESTED (do not repeat these or close variations of them):\n${seen.map(t => `- ${maskMacros(t)}`).join('\n')}`);

    const asks = [];
    const locked = roleLocked(charCard);
    if (locked) {
        if (fit) asks.push(`${fit} FIT idea${fit > 1 ? 's' : ''}: the role exactly as the card fixes it, each a clearly different PERSON inside it (temperament, what they want, how they cope, how they treat the people around them). Avoid the most obvious take.`);
        if (wild) {
            asks.push(`${wild} WILD idea${wild > 1 ? 's' : ''}: surprising takes the player would never think of, still fully inside the fixed role and playable from the very first reply. Surprise comes from who [[user]] is, never from changing what the card fixes. Each takes a different angle; draw on these, or better:\n${ROLE_WILD_ANGLES.map(a => `  * ${a}`).join('\n')}`);
        }
    } else {
        if (fit) asks.push(`${fit} FIT idea${fit > 1 ? 's' : ''}: grounded in the card and the opening scene, each with a clearly different dynamic with [[char]] (friction, tenderness, mystery, rivalry, dependence, protection…). Avoid the most obvious match.`);
        if (wild) {
            asks.push(`${wild} WILD idea${wild > 1 ? 's' : ''}: surprising, against the grain, ideas the player would never think of, yet still playable from the very first reply without breaking the facts of the opening scene. Each one takes a different angle; draw on these, or better:\n${WILD_ANGLES.map(a => `  * ${a}`).join('\n')}`);
        }
    }

    parts.push(
        `The player is about to start a NEW story with [[char]] and has no persona yet. Propose exactly ${total} persona concepts for [[user]], all different from each other:\n${asks.join('\n')}\n\n`
        + (locked
            ? 'Each idea: a short, vivid title, then 2-3 short lines: who [[user]] is as a person inside the fixed role; what they want and what they hide; the hook it gives the story. Never contradict the role, and never reveal what the card keeps from [[user]]. At most 45 words per idea.\n\n'
            : 'Each idea: a short, vivid title, then 2-3 short lines: who [[user]] is and why they are in this scene; what they want from or hide from [[char]]; the dynamic or the hook it creates. At most 45 words per idea.\n\n')
        + 'Output exactly this format and nothing else, with fit or wild as the second field:\n@@IDEA | fit | Title\n(2-3 lines)\n@@IDEA | wild | Title\n(2-3 lines)',
    );
    return { systemPrompt: systemFor(lang), prompt: parts.join('\n\n'), count: total };
}

/** Condense: rewrite every filled block so the whole sheet fits the size budget. */
export function buildCondensePrompt({ lang, size, name, sections, premise, gender, pronouns, nameInfo }) {
    const keys = SECTION_KEYS.filter(k => String(sections?.[k] ?? '').trim());
    const draft = draftText(sections, lang === 'auto' ? 'en' : lang);
    const specs = blockSpecs(size);
    const prompt = [
        `PERSONA NAME: ${maskMacros(name || '(unnamed)')}`,
        identityBlock(gender, pronouns, lang),
        String(premise ?? '').trim() ? `PREMISE (keep it intact while cutting):\n${maskMacros(premise)}` : '',
        nameInfoBlock(nameInfo) ? `${nameInfoBlock(nameInfo)} Keep the name's meaning and gimmick while cutting.` : '',
        `CURRENT PERSONA SHEET (too long):\n${maskMacros(draft)}`,
        'Rewrite every block below so the sheet becomes much shorter. Keep every fact that changes how [[user]] acts or speaks; merge duplicates across blocks; drop flourish, filler and anything generic. Keep the author\'s strongest exact lines in SAMPLES. Do not add anything new.\n\n'
        + `${keys.map(k => specs[k]).join('\n')}\n\n`
        + `${budgetLine(size)}\n\n`
        + `Output exactly this format and nothing else:\n${blockFormat(keys)}`,
    ].filter(Boolean).join('\n\n');
    return { systemPrompt: systemFor(lang), prompt, keys };
}

/** Mine: derive voice, samples and writing rules from the player's real messages. */
export function buildMinePrompt({ lang, size, name, transcript, stats, sections, gender, pronouns }) {
    const keys = ['voice', 'samples', 'rules'];
    const specs = blockSpecs(size);
    const n = sizeSpec(size).lines.samples;
    const draft = draftText(sections, lang === 'auto' ? 'en' : lang);
    const parts = [
        `PERSONA NAME: ${maskMacros(name || '(unnamed)')}`,
        identityBlock(gender, pronouns, lang),
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
    return { systemPrompt: systemFor(lang), prompt: parts.filter(Boolean).join('\n\n') };
}

/** Evolve: propose a minimal patch after the story has moved on. */
export function buildEvolvePrompt({ lang, size, name, sections, transcript, gender, pronouns }) {
    const draft = draftText(sections, lang === 'auto' ? 'en' : lang);
    const prompt = [
        `PERSONA NAME: ${maskMacros(name || '(unnamed)')}`,
        identityBlock(gender, pronouns, lang),
        `CURRENT PERSONA SHEET:\n${maskMacros(draft)}`,
        `RECENT STORY (oldest first):\n${maskMacros(transcript)}`,
        'Decide what the recent story has genuinely changed about [[user]]: beliefs, wounds, secrets now revealed, relationship with [[char]], new habits, new ways of speaking.\n'
        + 'Output ONLY the blocks that truly need to change, fully rewritten (not diffs), keeping every still-true fact. Do not rewrite a block for style alone. A changed block must not be longer than before: replace what is no longer true instead of adding to it. If nothing has changed, output only the SUMMARY block saying so.\n'
        + 'Block names you may use: CORE, LOOK, TENSION, VOICE, SAMPLES, ASYMMETRY, RULES. LOOK changes only for real reasons (a new scar, a disguise, cut hair). Block formats are the same as in the current sheet.\n'
        + `${budgetLine(size)}\n`
        + 'Finish with a SUMMARY block: one short line per changed block explaining what changed and which moment in the story caused it.\n\n'
        + 'Output format:\n<<TENSION>>\n(only if changed)\n<</TENSION>>\n<<SUMMARY>>\n(one line per change)\n<</SUMMARY>>',
    ].filter(Boolean).join('\n\n');
    return { systemPrompt: systemFor(lang), prompt };
}

/** Lore: move backstory and secrets out of the always-on persona into keyword-triggered entries. */
export function buildLorePrompt({ lang, size, name, notes, sections, charCard, premise, gender, pronouns, nameInfo }) {
    const draft = draftText(sections, lang === 'auto' ? 'en' : lang);
    const words = { lean: '30-70', standard: '40-90', rich: '50-120' }[size] ?? '30-70';
    const hasPremise = Boolean(String(premise ?? '').trim());
    const parts = [`PERSONA NAME: ${maskMacros(name || '(unnamed)')}`];
    const id = identityBlock(gender, pronouns, lang);
    if (id) parts.push(id);
    if (hasPremise) parts.push(premiseBlock(premise, roleLocked(charCard)));
    const nib = nameInfoBlock(nameInfo);
    if (nib) parts.push(`${nib}\nOne entry may tell where the name comes from: who gave it, why, and what it costs [[user]].`);
    parts.push(`AUTHOR'S ROUGH NOTES:\n${notesText(notes, null, premise)}`);
    if (draft) parts.push(`CURRENT PERSONA SHEET (always in the prompt, so do not repeat its content, but every entry must agree with it${hasPremise ? ' and with the PREMISE; if they disagree, the premise wins' : ''}):\n${maskMacros(draft)}`);
    const cc = charBlock(charCard, premise);
    if (cc) parts.push(`${cc}\n(Background only: use it to place [[user]] in [[char]]'s world, never as the subject of an entry.)`);
    parts.push(
        'Create 3-6 lorebook entries that DEEPEN WHO [[user]] IS, holding the material that should NOT sit in the always-on sheet. They surface only when the chat mentions them.\n'
        + (hasPremise
            ? 'Every entry must grow directly out of the PREMISE and the sheet. Cover what that concept implies and the sheet only hints at: its origin and how [[user]] came to be this; its rules, powers, limits and costs; the objects, places, people or bonds tied to it; the secret at its center and what happens if it comes out. An entry that would still make sense for a different persona is wrong; replace it.\n'
            : 'Draw on what the notes and sheet establish: backstory episodes, secrets, relationships with side characters, places, objects, old wounds. An entry that would make sense for any persona is wrong; replace it.\n')
        + `Each entry: a short title; 2-5 trigger keys (words or phrases likely to appear in the chat when this matters, in the chat's language, include name variants); ${words} words of dense content in third person about [[user]]. Build on what the ${hasPremise ? 'premise, ' : ''}notes and sheet establish; add only details that follow from them.\n\n`
        + 'Output exactly this format and nothing else, one header line then the content, for every entry:\n'
        + '@@ENTRY | Title | key one, key two, key three\n(content)',
    );
    return { systemPrompt: systemFor(lang), prompt: parts.join('\n\n') };
}
