// Persona Weaver — pure helpers.
// No SillyTavern imports here, so everything in this file can be tested in plain Node.

export const SECTION_KEYS = ['core', 'look', 'tension', 'voice', 'samples', 'asymmetry', 'rules'];

export const LABELS = {
    en: {
        core: 'Core',
        look: 'Appearance',
        tension: 'Inner conflict',
        voice: 'Voice',
        samples: 'Voice samples',
        asymmetry: 'What each knows',
        rules: 'Writing rules',
    },
    th: {
        core: 'แก่นตัวตน',
        look: 'รูปลักษณ์',
        tension: 'ความขัดแย้งภายใน',
        voice: 'น้ำเสียง',
        samples: 'ตัวอย่างคำพูด',
        asymmetry: 'สิ่งที่แต่ละฝ่ายรู้',
        rules: 'กฎการเขียนเทิร์น',
    },
};

const THAI_RANGE = '\\u0E00-\\u0E7F';

// ---------------------------------------------------------------------------
// Persona size. The persona sits in every prompt, so every token in it is paid on every
// turn. Each size sets a total budget and how many lines the list-shaped layers may have;
// the caps are enforced on the model's output too, not only asked for.
// ---------------------------------------------------------------------------

export const SIZES = {
    lean: { tokens: 280, lookWords: 30, coreWords: 40, voiceWords: 25, lineWords: 14, lines: { tension: 2, samples: 3, asymmetry: 2, rules: 3 } },
    standard: { tokens: 440, lookWords: 45, coreWords: 60, voiceWords: 40, lineWords: 18, lines: { tension: 3, samples: 4, asymmetry: 3, rules: 4 } },
    rich: { tokens: 700, lookWords: 60, coreWords: 90, voiceWords: 60, lineWords: 22, lines: { tension: 4, samples: 5, asymmetry: 4, rules: 5 } },
};

export function sizeKey(size) {
    return Object.hasOwn(SIZES, size) ? size : 'lean';
}

export function sizeSpec(size) {
    return SIZES[sizeKey(size)];
}

/** Keep at most `max` non-empty lines. Used on model output for the list-shaped layers. */
export function capLines(text, max) {
    const lines = String(text ?? '').split('\n').map(l => l.trimEnd()).filter(l => l.trim());
    return (max > 0 ? lines.slice(0, max) : lines).join('\n');
}

/** Apply the size's line caps to one layer of model output. */
export function fitLayer(key, text, size) {
    const max = sizeSpec(size).lines[key];
    return max ? capLines(text, max) : String(text ?? '').trim();
}

/** True when version string a is newer than b (1.10.0 > 1.9.3). */
export function newerVersion(a, b) {
    const pa = String(a ?? '').split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b ?? '').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    }
    return false;
}

export function emptySections() {
    return Object.fromEntries(SECTION_KEYS.map(k => [k, '']));
}

export function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Resolve 'auto' to 'th' or 'en' from a sample of the user's own text. */
export function resolveLang(lang, sample = '') {
    if (lang === 'th' || lang === 'en') return lang;
    const text = String(sample ?? '');
    const thai = (text.match(/[฀-๿]/g) || []).length;
    const letters = (text.match(/[A-Za-z฀-๿]/g) || []).length;
    return letters > 0 && thai / letters > 0.3 ? 'th' : 'en';
}

// ---------------------------------------------------------------------------
// Macro masking. generateRaw() runs substituteParams() over every message, so a
// literal {{user}} would be swapped for the real name before the model sees it.
// We hide the two macros behind plain-ASCII placeholders and restore them after.
// ---------------------------------------------------------------------------

export function maskMacros(text) {
    return String(text ?? '')
        .replace(/\{\{\s*user\s*\}\}/gi, '[[user]]')
        .replace(/\{\{\s*char\s*\}\}/gi, '[[char]]')
        .replace(/\{\{/g, '{​{')
        .replace(/\}\}/g, '}​}');
}

export function unmaskMacros(text) {
    return String(text ?? '')
        .replace(/\[\[\s*user\s*\]\]/gi, '{{user}}')
        .replace(/\[\[\s*char\s*\]\]/gi, '{{char}}')
        .replace(/\{​\{/g, '{{')
        .replace(/\}​\}/g, '}}')
        .replace(/​/g, '');
}

// ---------------------------------------------------------------------------
// Thai spacing: models copy the spacing they see around names, so a space in
// "ไป {{user}} ที่" gets repeated forever. Remove spaces that sit between a Thai
// character and a name/macro. Spaces next to English text are left alone.
// ---------------------------------------------------------------------------

export function fixThaiNameSpacing(text, names = []) {
    const tokens = ['{{user}}', '{{char}}', ...names]
        .map(n => String(n ?? '').trim())
        .filter(Boolean);
    const unique = [...new Set(tokens)].sort((a, b) => b.length - a.length);
    if (!unique.length) return String(text ?? '');

    const alt = unique.map(escapeRegExp).join('|');
    const before = new RegExp(`([${THAI_RANGE}])[ \\t]+(${alt})`, 'g');
    const after = new RegExp(`(${alt})[ \\t]+([${THAI_RANGE}])`, 'g');

    let out = String(text ?? '');
    // Run until stable so chains like "ก {{user}} ข {{char}} ค" settle in one call.
    for (let i = 0; i < 4; i++) {
        const next = out.replace(before, '$1$2').replace(after, '$1$2');
        if (next === out) break;
        out = next;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Parsing model output
// ---------------------------------------------------------------------------

function stripFences(text) {
    return String(text ?? '').replace(/^[ \t]*```[a-zA-Z]*[ \t]*$/gm, '');
}

function cleanBlock(text) {
    return String(text ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/^\s*\n+/, '')
        .replace(/\n+\s*$/, '')
        .trim();
}

/**
 * Parse `<<KEY>> ... <</KEY>>` blocks. Closing tags are optional; a block ends at
 * the next marker of any kind. Unknown keys and any chatter outside blocks are ignored.
 */
export function parseTagged(raw, keys = SECTION_KEYS) {
    const text = stripFences(raw);
    const wanted = new Map(keys.map(k => [k.toUpperCase(), k]));
    const re = /<<\s*(\/?)\s*([A-Za-z_]+)\s*>>/g;
    const marks = [];
    let m;
    while ((m = re.exec(text))) {
        marks.push({ close: m[1] === '/', name: m[2].toUpperCase(), start: m.index, end: re.lastIndex });
    }
    const out = {};
    for (let i = 0; i < marks.length; i++) {
        const mark = marks[i];
        if (mark.close) continue;
        const key = wanted.get(mark.name);
        if (!key) continue;
        const next = marks[i + 1];
        const body = cleanBlock(text.slice(mark.end, next ? next.start : text.length));
        if (body) out[key] = body;
    }
    return out;
}

export function splitKeys(raw) {
    const seen = new Set();
    const keys = [];
    for (const part of String(raw ?? '').split(/[,،、]/)) {
        const k = part.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
        const id = k.toLowerCase();
        if (k && !seen.has(id)) {
            seen.add(id);
            keys.push(k);
        }
    }
    return keys.slice(0, 8);
}

/** Parse `@@ENTRY | Title | key1, key2` followed by content lines. */
export function parseLore(raw) {
    const text = stripFences(raw).replace(/\r\n/g, '\n');
    const entries = [];
    let current = null;
    for (const line of text.split('\n')) {
        const m = line.match(/^\s*@@ENTRY\s*\|\s*([^|]*?)\s*\|\s*(.*?)\s*$/i);
        if (m) {
            if (current) entries.push(current);
            current = { title: m[1], keys: splitKeys(m[2]), content: [] };
            continue;
        }
        if (current) current.content.push(line);
    }
    if (current) entries.push(current);
    return entries
        .map(e => ({ title: e.title || 'Entry', keys: e.keys, content: e.content.join('\n').trim() }))
        .filter(e => e.content && e.keys.length);
}

export const IDEA_KINDS = ['fit', 'wild'];
export const IDEA_MIXES = ['mix', 'fit', 'wild'];
export const IDEAS_PER_BATCH = 6;
const MAX_IDEAS = 24;

/**
 * Parse `@@IDEA | kind | Title` (kind is fit or wild) followed by a few lines of pitch.
 * `@@IDEA | Title` without a kind is read as kind 'fit'.
 */
export function parseIdeas(raw) {
    const text = stripFences(raw).replace(/\r\n/g, '\n');
    const ideas = [];
    let current = null;
    for (const line of text.split('\n')) {
        const m = line.match(/^\s*@@IDEA\s*\|?\s*(.*?)\s*$/i);
        if (m) {
            if (current) ideas.push(current);
            const fields = m[1].split('|').map(f => f.trim()).filter(Boolean);
            let kind = 'fit';
            const tag = (fields[0] ?? '').toLowerCase().replace(/[^a-z]/g, '');
            if (fields.length > 1 && IDEA_KINDS.includes(tag)) {
                kind = tag;
                fields.shift();
            }
            current = { kind, title: fields.join(' | '), lines: [] };
            continue;
        }
        if (current) current.lines.push(line);
    }
    if (current) ideas.push(current);
    return ideas
        .map(i => ({ kind: i.kind, title: i.title || 'Idea', text: i.lines.join('\n').trim() }))
        .filter(i => i.text)
        .slice(0, MAX_IDEAS);
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export const NAME_SOURCES = ['mix', 'world', 'new'];
// ---------------------------------------------------------------------------
// Naming script. Models follow the language of the author's notes when they name
// someone, so Thai notes for a Western bot gave Thai names. The script the bot's
// world writes names in is worked out here, told to the model, and checked after.
// ---------------------------------------------------------------------------

const SCRIPTS = {
    thai: /[\u0E00-\u0E7F]/g,
    latin: /[A-Za-z\u00C0-\u024F]/g,
    cjk: /[\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/g,
};

/** The script most of the letters in a text are written in: 'thai' | 'latin' | 'cjk' | ''. */
export function scriptOf(text) {
    // Macros such as {{user}} and [[char]] are Latin letters in every card; they say nothing.
    const s = String(text ?? '').replace(/\{\{[^}]*\}\}|\[\[[^\]]*\]\]/g, ' ');
    let best = '';
    let most = 0;
    for (const [name, re] of Object.entries(SCRIPTS)) {
        const n = (s.match(re) || []).length;
        if (n > most) { best = name; most = n; }
    }
    return best;
}

/**
 * The script names are written in inside the bot's world. The bot's own name decides;
 * without one, its lorebook's titles, then its card.
 */
export function namingScript({ charName = '', worldNames = '', cardText = '' } = {}) {
    for (const sample of [charName, worldNames, cardText]) {
        const s = scriptOf(sample);
        if (s) return s;
    }
    return '';
}

/**
 * Keep only the world names written in the world's own script. A lorebook whose titles were
 * written in the author's language (Thai titles for a Western bot) would otherwise pull every
 * suggestion toward the author's culture.
 */
export function worldNamesInScript(worldNames, script) {
    const list = String(worldNames ?? '').split(/\s*,\s*/).filter(Boolean);
    if (!script) return list.join(', ');
    return list.filter(n => {
        const s = scriptOf(n);
        return !s || s === script;
    }).join(', ');
}

/** Drop suggested names written in another script than the world's. */
export function keepNamesInScript(names, script) {
    if (!script) return names;
    return names.filter(n => {
        const s = scriptOf(n?.name);
        return !s || s === script;
    });
}

export const NAMES_PER_BATCH = 8;
const MAX_NAMES = 24;

/**
 * Read name suggestions, one per line: `Full name | meaning | gimmick`.
 * Two fields (`Full name | gimmick`) and an em dash or " - " separator are accepted too,
 * as are list bullets, numbering and bold.
 */
export function parseNameLines(text) {
    const out = [];
    const seen = new Set();
    const clean = v => String(v ?? '').trim().replace(/^\*\*|\*\*$/g, '').replace(/^["“'‘]+|["”'’]+$/g, '').trim();
    for (const raw of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
        const line = raw.trim().replace(/^(?:[-•*]|\d+[.)])\s*/, '').replace(/^\*\*(.+?)\*\*/, '$1');
        if (!line || /^<<|^@@/.test(line)) continue;
        let name;
        let meaning = '';
        let hook = '';
        if (line.includes('|')) {
            const parts = line.split('|').map(clean);
            name = parts[0];
            if (parts.length >= 3) {
                meaning = parts[1];
                hook = parts.slice(2).filter(Boolean).join(' | ');
            } else {
                hook = parts[1] ?? '';
            }
        } else {
            const m = line.match(/^(.+?)\s*(?:—|–|\s-\s)\s*(.*)$/);
            name = clean(m ? m[1] : line);
            hook = clean(m ? m[2] : '');
        }
        if (!name || name.length > 60) continue;
        const id = name.toLowerCase();
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ name, meaning, hook });
    }
    return out.slice(0, MAX_NAMES);
}

export function mergeNames(existing, batch) {
    const seen = new Set((existing ?? []).map(n => String(n.name).trim().toLowerCase()));
    const out = [...(existing ?? [])];
    for (const n of batch ?? []) {
        const id = String(n.name).trim().toLowerCase();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(n);
    }
    return out.slice(-MAX_NAMES);
}

/**
 * A short list of the names a lorebook knows (entry titles and first keys), for flavour:
 * houses, clans, places, naming patterns. Entry contents are not sent.
 */
export function worldNameList(entries, maxChars = 900) {
    const seen = new Set();
    const names = [];
    const add = (v) => {
        const n = String(v ?? '').replace(/\s+/g, ' ').trim();
        if (!n || n.length > 40 || /^\d+$/.test(n)) return;
        const id = n.toLowerCase();
        if (seen.has(id)) return;
        seen.add(id);
        names.push(n);
    };
    // Works for ST world files (key, comment, disable) and for a card's embedded
    // character_book (keys, comment/name, enabled).
    const list = Array.isArray(entries) ? entries : Object.values(entries ?? {});
    for (const e of list) {
        if (!e || e.disable || e.enabled === false) continue;
        // GM-only and rule entries are not names; their titles may even spoil a secret.
        if (/\b(secret|gm[- ]?only|spoiler|always on|forms of address|rules?|system|mechanics?|instructions?)\b/i.test(String(e.comment || e.name || ''))) continue;
        // Bracketed parts of a title often hold a true identity or a note; leave them out.
        add(String(e.comment || e.name || '').replace(/^\s*(?:npc|place|item|world|lore)\s*[·:|-]\s*/i, '').replace(/\s*[([（【][^)\]）】]*[)\]）】]/g, ''));
        const keys = Array.isArray(e.key) ? e.key : Array.isArray(e.keys) ? e.keys : [];
        if (keys.length) add(keys[0]);
    }
    let out = '';
    for (const n of names) {
        const next = out ? `${out}, ${n}` : n;
        if (next.length > maxChars) break;
        out = next;
    }
    return out;
}

// ---------------------------------------------------------------------------
// The user's role as the card fixes it
// ---------------------------------------------------------------------------

const ROLE_HEADING = /^\s*#{1,6}\s*.*\b(premise|protagonist|player|user|your role|you are|role|setup|set-up|backstory|background|scenario|story)\b|^\s*#{1,6}\s*.*(บทบาท|ผู้เล่น|ตัวเอก|ปูเรื่อง|เนื้อเรื่อง|ฉากหลัง)/i;
const ROLE_LINE = /^\s*(?:[-*•]\s*)?(?:unknown to \{\{user\}\},\s*)?\{\{user\}\}(?:'s)?\s+(?:is|was|are|were|has|had|wears|carries|calls|lives|works|serves|belongs|became|becomes|starts|begins|arrives|must)\b|^\s*(?:[-*•]\s*)?\{\{user\}\}\s*(?:เป็น|คือ|ถูก|มี|อาศัย|ทำงาน)|^\s*(?:[-*•]\s*)?you (?:are|play)\b/i;
const WRITING_RULE = /\b(?:never|don'?t|do not|avoid|must not|only)\b[^.\n]*\b(?:write|speak|act|decide|narrat|control|impersonat|describe)|\b(?:write|speak|act|decide|control)\s+(?:for|as)\s+\{\{user\}\}|\{\{user\}\}'s\s+(?:dialogue|thoughts|actions|decisions|turns?|lines)\b/i;

/**
 * Pull out what a card fixes about {{user}}: sections whose heading reads like the premise or
 * the player's role, plus lines elsewhere that say what {{user}} is ("{{user}} is…", "you are…").
 * Writing rules about {{user}} ("never write {{user}}'s dialogue") are skipped. The scenario is
 * included first because it usually states the set-up.
 * @param {{description?:string, personality?:string, scenario?:string}} card
 */
export function extractUserRole(card, maxChars = 1800) {
    const chunks = [];
    const seen = new Set();
    const push = (text) => {
        const t = String(text ?? '').replace(/\n{3,}/g, '\n\n').trim();
        if (!t) return;
        const id = t.toLowerCase();
        if (seen.has(id)) return;
        seen.add(id);
        chunks.push(t);
    };

    const scenario = String(card?.scenario ?? '').trim();
    if (/\{\{user\}\}|\byou\b/i.test(scenario)) push(scenario);

    for (const field of [card?.description, card?.personality]) {
        const lines = String(field ?? '').replace(/\r\n/g, '\n').split('\n');
        let inRole = false;
        let section = [];
        const flush = () => { if (section.length) push(section.join('\n')); section = []; };
        for (const line of lines) {
            if (/^\s*#{1,6}\s/.test(line)) {
                flush();
                inRole = ROLE_HEADING.test(line);
                continue;
            }
            if (inRole) {
                if (!WRITING_RULE.test(line)) section.push(line);
                continue;
            }
            for (const sentence of line.split(/(?<=[.!?。])\s+/)) {
                if (ROLE_LINE.test(sentence) && !WRITING_RULE.test(sentence)) push(sentence.replace(/^\s*[-*•]\s*/, ''));
            }
        }
        flush();
    }

    let out = '';
    for (const c of chunks) {
        const next = out ? `${out}\n\n${c}` : c;
        if (next.length > maxChars) {
            if (!out) out = c.slice(0, maxChars);
            break;
        }
        out = next;
    }
    return out;
}

/** Add a new batch to the ideas already shown, skipping repeated titles, keeping the list bounded. */
export function mergeIdeas(existing, batch) {
    const seen = new Set((existing ?? []).map(i => String(i.title).trim().toLowerCase()));
    const out = [...(existing ?? [])];
    for (const idea of batch ?? []) {
        const id = String(idea.title).trim().toLowerCase();
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(idea);
    }
    return out.slice(-MAX_IDEAS);
}

/** How many fitting and wild ideas a batch should hold for a mix setting. */
export function ideaSplit(mix, total = IDEAS_PER_BATCH) {
    if (mix === 'fit') return { fit: total, wild: 0 };
    if (mix === 'wild') return { fit: 0, wild: total };
    const wild = Math.ceil(total / 2);
    return { fit: total - wild, wild };
}

// ---------------------------------------------------------------------------
// Persona text <-> sections
// ---------------------------------------------------------------------------

function normalizeSamples(text) {
    return String(text ?? '')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => `- ${l.replace(/^[-•*]\s*/, '')}`)
        .join('\n');
}

export function assemblePersona(sections, lang = 'en') {
    const labels = LABELS[lang] ?? LABELS.en;
    const blocks = [];
    for (const key of SECTION_KEYS) {
        const value = String(sections?.[key] ?? '').trim();
        if (!value) continue;
        blocks.push(key === 'samples'
            ? `${labels[key]}:\n${normalizeSamples(value)}`
            : `${labels[key]}: ${value}`);
    }
    return blocks.join('\n\n');
}

/** Inverse of assemblePersona. Text with no recognised labels becomes `core`. */
export function parsePersona(text) {
    const result = emptySections();
    const src = String(text ?? '').replace(/\r\n/g, '\n');

    const labelMap = new Map();
    for (const lang of Object.keys(LABELS)) {
        for (const key of SECTION_KEYS) labelMap.set(LABELS[lang][key].toLowerCase(), key);
    }

    const lineRe = /^\s*([^\n:：]{1,40}?)\s*[:：]\s*(.*)$/;
    const preamble = [];
    let current = null;
    let matched = false;

    for (const line of src.split('\n')) {
        const m = line.match(lineRe);
        const key = m ? labelMap.get(m[1].trim().toLowerCase()) : undefined;
        if (key) {
            current = key;
            matched = true;
            result[key] = result[key] ? `${result[key]}\n${m[2]}` : m[2];
            continue;
        }
        if (current) result[current] += `\n${line}`;
        else preamble.push(line);
    }

    if (!matched) {
        result.core = src.trim();
        return result;
    }
    const lead = preamble.join('\n').trim();
    if (lead) result.core = result.core ? `${lead}\n${result.core}` : lead;
    for (const key of SECTION_KEYS) result[key] = result[key].trim();
    return result;
}

/** Non-empty patch values replace the base; everything else is kept. */
export function applyPatch(base, patch) {
    const merged = { ...emptySections(), ...(base ?? {}) };
    for (const key of SECTION_KEYS) {
        const v = String(patch?.[key] ?? '').trim();
        if (v) merged[key] = v;
    }
    return merged;
}

export function changedKeys(before, after) {
    return SECTION_KEYS.filter(k => String(before?.[k] ?? '').trim() !== String(after?.[k] ?? '').trim());
}

export function estimateTokens(text) {
    const s = String(text ?? '');
    const thai = (s.match(/[฀-๿]/g) || []).length;
    return Math.ceil(thai / 1.6 + (s.length - thai) / 4);
}

// ---------------------------------------------------------------------------
// Chat -> transcript / style statistics
// ---------------------------------------------------------------------------

function compact(text, maxChars) {
    let s = String(text ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (s.length > maxChars) s = `${s.slice(0, maxChars)}…`;
    return s;
}

function visibleMessages(chat) {
    return (Array.isArray(chat) ? chat : [])
        .filter(m => m && !m.is_system && typeof m.mes === 'string' && m.mes.trim());
}

export function buildTranscript(chat, {
    maxMessages = 40,
    maxChars = 12000,
    perMessageChars = 1500,
    onlyUser = false,
    userName = 'User',
    charName = 'Character',
} = {}) {
    const msgs = visibleMessages(chat);
    const picked = (onlyUser ? msgs.filter(m => m.is_user) : msgs).slice(-maxMessages);
    const lines = picked.map(m => `${m.is_user ? userName : (m.name || charName)}: ${compact(m.mes, perMessageChars)}`);

    const kept = [];
    let total = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
        if (total + lines[i].length > maxChars && kept.length) break;
        kept.unshift(lines[i].slice(0, maxChars));
        total += lines[i].length + 1;
    }
    return kept.join('\n');
}

export function styleStats(chat, { maxMessages = 60 } = {}) {
    const mine = visibleMessages(chat).filter(m => m.is_user).slice(-maxMessages).map(m => compact(m.mes, 4000));
    if (!mine.length) return null;

    const lengths = mine.map(s => s.length).sort((a, b) => a - b);
    const pct = (pred) => Math.round((mine.filter(pred).length / mine.length) * 100);
    const median = lengths.length % 2
        ? lengths[(lengths.length - 1) / 2]
        : Math.round((lengths[lengths.length / 2 - 1] + lengths[lengths.length / 2]) / 2);

    return {
        count: mine.length,
        medianChars: median,
        avgChars: Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length),
        shortPct: pct(s => s.length <= 80),
        questionPct: pct(s => /[?？]/.test(s)),
        exclaimPct: pct(s => /[!！]/.test(s)),
        ellipsisPct: pct(s => /(\.{3}|…)/.test(s)),
        quotedSpeechPct: pct(s => /["“”「」『』]/.test(s)),
        actionMarkupPct: pct(s => /\*[^*\n]+\*/.test(s)),
    };
}

export function formatStats(stats) {
    if (!stats) return '';
    return [
        `messages analysed: ${stats.count}`,
        `length (characters): median ${stats.medianChars}, average ${stats.avgChars}`,
        `short messages (80 characters or fewer): ${stats.shortPct}%`,
        `contain a question: ${stats.questionPct}%`,
        `contain "!": ${stats.exclaimPct}%`,
        `contain an ellipsis: ${stats.ellipsisPct}%`,
        `contain quoted speech: ${stats.quotedSpeechPct}%`,
        `contain *action* markup: ${stats.actionMarkupPct}%`,
    ].join('\n');
}

// ---------------------------------------------------------------------------
// Lorebook helpers
// ---------------------------------------------------------------------------

export function loreBookName(personaName) {
    const clean = String(personaName ?? '').replace(/[\\/:*?"<>|]/g, '').trim() || 'Persona';
    return `PW - ${clean}`;
}

export function loreEntryFields(entry, index = 0) {
    return {
        key: [...entry.keys],
        comment: entry.title,
        content: entry.content,
        order: 100 + index,
    };
}
