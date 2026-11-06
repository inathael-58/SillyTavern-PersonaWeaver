// Persona Weaver — SillyTavern extension.
// Turns a rough persona into a layered one (inner conflict, voice samples, asymmetric knowledge,
// turn-writing rules), mines your real chat style, evolves the persona after an arc, and can
// move backstory/secrets into a keyword-triggered lorebook.

import {
    characters,
    chat,
    eventSource,
    event_types,
    name1,
    name2,
    saveSettings,
    saveSettingsDebounced,
    this_chid,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { getCurrentLocale } from '../../../i18n.js';
import { power_user } from '../../../power-user.js';
import { getUserAvatars, setPersonaDescription, setUserAvatar, user_avatar } from '../../../personas.js';
import { getContext } from '../../../st-context.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { createWorldInfoEntry, loadWorldInfo, saveWorldInfo, updateWorldInfoList, world_names } from '../../../world-info.js';

import * as api from './api.js';
import * as core from './core.js';
import { SECTION_KEYS } from './core.js';
import { STRINGS, fmt, resolveUiLang } from './i18n.js';
import * as prompts from './prompts.js';

const MODULE = 'persona_weaver';
const VERSION = '0.3.0'; // keep in sync with manifest.json
const BASE_URL = new URL('.', import.meta.url);
/** Every file of the extension, so a hard refresh can replace all of them in the browser cache. */
const FILES = ['index.js', 'api.js', 'core.js', 'prompts.js', 'i18n.js', 'style.css', 'manifest.json'];
const DRAFT_KEY = 'persona_weaver_draft';

const DEFAULTS = Object.freeze({
    uiLang: 'auto',
    lang: 'auto',
    thaiSpacing: true,
    useCharCard: true,
    weaveTokens: 1500,
    otherTokens: 1000,
    messages: 40,
    size: 'lean',
    source: 'main',
    timeoutSec: 120,
});
/** Warn when the persona is this much over its size budget. */
const BUDGET_SLACK = 1.15;
const CHAR_CARD_CHARS = 1200;
const GREETING_CHARS = 900;

function settings() {
    extension_settings[MODULE] = Object.assign({}, DEFAULTS, extension_settings[MODULE]);
    return extension_settings[MODULE];
}

function ui() {
    return STRINGS[resolveUiLang(settings().uiLang, getCurrentLocale())] ?? STRINGS.en;
}

const state = {
    mode: 'weave',
    target: 'new',
    name: '',
    notes: '',
    sections: core.emptySections(),
    loreOn: false,
    lore: [],
    selectAfter: true,
    msgCount: DEFAULTS.messages,
    evolve: null,
    history: [],
    lastRaw: '',
    charSel: null, // '' = no character, '@current' = this chat's character, else a character avatar
    ideas: [],
    busy: false,
    sendingTo: '',
    lastCall: null,
    tokenCount: 0,
    initialised: false,
};

/** Thrown when the user declines a request in the confirm dialog. */
class Cancelled extends Error {}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function slashEscape(value) {
    return String(value ?? '')
        .replace(/\{\{|\}\}/g, '')
        .replace(/[|\r\n]/g, ' ')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .trim();
}

function hasActivePersona() {
    return Boolean(user_avatar) && Boolean(power_user.personas?.[user_avatar]);
}

function personaName() {
    if (state.target === 'active') return name1;
    return state.name.trim() || name1;
}

function charSel() {
    if (state.charSel === null) state.charSel = settings().useCharCard ? '@current' : '';
    return state.charSel;
}

/** The bot the persona is built for: this chat's character, one picked from the list, or none. */
function targetChar() {
    const sel = charSel();
    if (!sel) return undefined;
    if (sel === '@current') return characters?.[this_chid];
    return (characters ?? []).find(c => c?.avatar === sel);
}

function currentCharName() {
    return targetChar()?.name ?? '';
}

/**
 * The opening scene. For this chat's character, the first message actually on screen
 * (it reflects the greeting the player swiped to); otherwise the card's first message.
 */
function greetingFor(c) {
    const cur = characters?.[this_chid];
    if (c && cur && c.avatar === cur.avatar) {
        const first = (Array.isArray(chat) ? chat : []).find(m => m && !m.is_system);
        if (first && !first.is_user && String(first.mes ?? '').trim()) return first.mes;
    }
    return c?.first_mes ?? '';
}

function currentCharCard() {
    const c = targetChar();
    if (!c) return undefined;
    const text = [c.description, c.personality, c.scenario].filter(Boolean).join('\n\n').slice(0, CHAR_CARD_CHARS);
    const greeting = String(greetingFor(c) ?? '').trim().slice(0, GREETING_CHARS);
    return text || greeting ? { name: c.name, text, greeting } : undefined;
}

/** True when the chat has none of the player's own messages yet (a fresh start). */
function isFreshChat() {
    return !core.styleStats(chat);
}

function hasSections(sections = state.sections) {
    return SECTION_KEYS.some(k => String(sections[k] ?? '').trim());
}

function concreteLang() {
    const setting = settings().lang;
    if (setting === 'th' || setting === 'en') return setting;
    const sample = `${state.notes}\n${SECTION_KEYS.map(k => state.sections[k]).join('\n')}`;
    if (!sample.trim()) return resolveUiLang(settings().uiLang, getCurrentLocale());
    return core.resolveLang('auto', sample);
}

function finalText() {
    return core.assemblePersona(state.sections, concreteLang());
}

function tidy(text) {
    let out = core.unmaskMacros(text);
    if (settings().thaiSpacing) out = core.fixThaiNameSpacing(out, [personaName(), currentCharName()]);
    return out;
}

function pushHistory() {
    state.history.push({ sections: { ...state.sections }, lore: state.lore.map(e => ({ ...e })) });
    if (state.history.length > 10) state.history.shift();
}

// ---------------------------------------------------------------------------
// Model calls
// ---------------------------------------------------------------------------

function sizeNow() {
    return core.sizeKey(settings().size);
}

function budgetNow() {
    return core.sizeSpec(sizeNow()).tokens;
}

/**
 * Every request goes through here: the user sees the task, the API, the size of the request
 * and (on demand) the exact text, and must press Send. Nothing is sent otherwise.
 */
async function callModel(p, responseLength, task) {
    const t = ui();
    const src = await confirmRequest({ task, p, maxTokens: responseLength });
    if (!src) throw new Cancelled(t.cancelled);

    const label = api.sourceLabel(src, t.apiMain);
    state.sendingTo = label;
    render();
    const t0 = Date.now();
    try {
        const raw = await api.send(src, p, responseLength, settings().timeoutSec * 1000, {
            timeout: n => fmt(t.errTimeout, { n }),
            empty: t.errEmpty,
            noProfiles: t.errNoProfiles,
        });
        state.lastRaw = raw;
        return raw;
    } finally {
        state.lastCall = { label, ms: Date.now() - t0 };
        state.sendingTo = '';
    }
}

async function askBlocks(p, keys, responseLength, task) {
    const raw = await callModel(p, responseLength, task);
    const parsed = core.parseTagged(raw, keys);
    if (!keys.some(k => parsed[k])) throw new Error(ui().errFormat);
    return parsed;
}

async function run(task) {
    if (state.busy) return;
    state.busy = true;
    state.lastRaw = '';
    render();
    try {
        await task();
    } catch (err) {
        if (err instanceof Cancelled) {
            toastr.info(err.message, ui().title, { timeOut: 2500 });
        } else {
            console.error('[Persona Weaver]', err);
            toastr.error(String(err?.message ?? err), ui().title);
        }
    } finally {
        state.busy = false;
        state.sendingTo = '';
        render();
    }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function loadActive() {
    if (!hasActivePersona()) {
        toastr.warning(ui().noActive, ui().title);
        return;
    }
    const text = String(power_user.persona_description ?? '');
    const parsed = core.parsePersona(text);
    const onlyCore = SECTION_KEYS.every(k => k === 'core' || !parsed[k]);
    pushHistory();
    if (onlyCore) {
        state.notes = text;
        state.sections = core.emptySections();
    } else {
        state.sections = parsed;
    }
}

async function weave(keys) {
    await run(async () => {
        const t = ui();
        const charCard = currentCharCard();
        if (!state.notes.trim() && !hasSections() && !charCard) throw new Error(t.needNotes);
        const size = sizeNow();
        const p = prompts.buildWeavePrompt({
            keys,
            lang: concreteLang(),
            size,
            name: personaName(),
            notes: state.notes,
            sections: state.sections,
            charCard,
        });
        const task = keys.length === 1 ? fmt(t.task_regen, { layer: t['sec_' + keys[0]] }) : t.task_weaveAll;
        const parsed = await askBlocks(p, keys, keys.length === 1 ? settings().otherTokens : settings().weaveTokens, task);
        pushHistory();
        for (const k of keys) if (parsed[k]) state.sections[k] = tidy(core.fitLayer(k, parsed[k], size));
    });
}

async function suggestIdeas() {
    await run(async () => {
        const t = ui();
        const card = currentCharCard();
        if (!card) throw new Error(t.ideasNeedChar);
        const p = prompts.buildIdeasPrompt({ lang: concreteLang(), notes: state.notes, charCard: card });
        const raw = await callModel(p, settings().otherTokens, fmt(t.task_ideas, { name: card.name }));
        const ideas = core.parseIdeas(raw);
        if (!ideas.length) throw new Error(t.errFormat);
        state.ideas = ideas.map(i => ({ title: tidy(i.title), text: tidy(i.text) }));
    });
}

function useIdea(i) {
    const idea = state.ideas[i];
    if (!idea) return;
    const block = `${idea.title}\n${idea.text}`;
    state.notes = state.notes.trim() ? `${state.notes.trim()}\n\n${block}` : block;
    state.ideas = [];
}

async function condense() {
    await run(async () => {
        const t = ui();
        if (!hasSections()) throw new Error(t.nothingToSave);
        const size = sizeNow();
        const n = await countTokens(finalText());
        if (n <= budgetNow()) {
            toastr.info(t.condenseNothing, t.title);
            return;
        }
        const p = prompts.buildCondensePrompt({ lang: concreteLang(), size, name: personaName(), sections: state.sections });
        const task = fmt(t.task_condense, { size: t['sizeShort_' + size] });
        const parsed = await askBlocks(p, p.keys, settings().weaveTokens, task);
        pushHistory();
        for (const k of p.keys) if (parsed[k]) state.sections[k] = tidy(core.fitLayer(k, parsed[k], size));
    });
}

async function generateLore() {
    await run(async () => {
        const t = ui();
        if (!state.notes.trim() && !hasSections()) throw new Error(t.needNotes);
        const p = prompts.buildLorePrompt({
            lang: concreteLang(),
            size: sizeNow(),
            name: personaName(),
            notes: state.notes,
            sections: state.sections,
            charCard: currentCharCard(),
        });
        const raw = await callModel(p, settings().otherTokens, t.task_lore);
        const entries = core.parseLore(raw);
        if (!entries.length) throw new Error(t.errFormat);
        pushHistory();
        state.lore = entries.map(e => ({
            title: tidy(e.title),
            keysText: e.keys.join(', '),
            content: tidy(e.content),
        }));
    });
}

async function mine() {
    await run(async () => {
        const t = ui();
        const stats = core.styleStats(chat, { maxMessages: state.msgCount });
        if (!stats || stats.count < 3) throw new Error(t.mineNoChat);
        const transcript = core.buildTranscript(chat, {
            maxMessages: state.msgCount,
            onlyUser: true,
            userName: name1,
        });
        const size = sizeNow();
        const p = prompts.buildMinePrompt({
            lang: concreteLang(),
            size,
            name: personaName(),
            transcript,
            stats,
            sections: state.sections,
        });
        const keys = ['voice', 'samples', 'rules'];
        const parsed = await askBlocks(p, keys, settings().otherTokens, fmt(t.task_mine, { n: stats.count }));
        pushHistory();
        for (const k of keys) if (parsed[k]) state.sections[k] = tidy(core.fitLayer(k, parsed[k], size));
        state.mode = 'weave';
        toastr.success(fmt(t.mineDone, { n: stats.count }), t.title);
    });
}

async function evolve() {
    await run(async () => {
        const t = ui();
        let base = state.sections;
        if (!hasSections(base)) {
            base = state.target === 'active' && hasActivePersona()
                ? core.parsePersona(power_user.persona_description)
                : core.emptySections();
        }
        if (!hasSections(base)) throw new Error(t.evolveNeedPersona);
        const transcript = core.buildTranscript(chat, {
            maxMessages: state.msgCount,
            userName: name1,
            charName: name2,
        });
        if (!transcript) throw new Error(t.mineNoChat);

        const size = sizeNow();
        const p = prompts.buildEvolvePrompt({ lang: concreteLang(), size, name: personaName(), sections: base, transcript });
        const raw = await callModel(p, settings().otherTokens, t.task_evolve);
        const parsed = core.parseTagged(raw, [...SECTION_KEYS, 'summary']);
        if (!SECTION_KEYS.some(k => parsed[k]) && !parsed.summary) throw new Error(t.errFormat);

        const patch = {};
        for (const k of SECTION_KEYS) if (parsed[k]) patch[k] = tidy(core.fitLayer(k, parsed[k], size));
        const changed = core.changedKeys(base, core.applyPatch(base, patch));
        state.evolve = {
            base,
            patch,
            changed,
            summary: parsed.summary ? tidy(parsed.summary) : '',
            accept: Object.fromEntries(changed.map(k => [k, true])),
        };
    });
}

function applyEvolve() {
    const ev = state.evolve;
    if (!ev) return;
    const accepted = {};
    for (const k of ev.changed) if (ev.accept[k]) accepted[k] = ev.patch[k];
    if (!Object.keys(accepted).length) return;
    const current = hasSections() ? state.sections : ev.base;
    pushHistory();
    state.sections = core.applyPatch(current, accepted);
    state.evolve = null;
    state.mode = 'weave';
}

function undo() {
    const last = state.history.pop();
    if (!last) return;
    state.sections = last.sections;
    state.lore = last.lore;
}

async function writeLorebook(name, entries) {
    const book = core.loreBookName(name);
    const exists = Array.isArray(world_names) && world_names.includes(book);
    const data = (exists ? await loadWorldInfo(book) : null) ?? { entries: {} };
    if (!data.entries) data.entries = {};

    // Re-saving updates entries with the same title instead of duplicating them.
    const titles = new Set(entries.map(e => e.title));
    for (const [uid, entry] of Object.entries(data.entries)) {
        if (titles.has(entry?.comment)) delete data.entries[uid];
    }
    entries.forEach((e, i) => {
        const entry = createWorldInfoEntry(book, data);
        if (!entry) throw new Error('Could not create a lorebook entry.');
        Object.assign(entry, core.loreEntryFields(e, i));
    });
    await saveWorldInfo(book, data, true);
    await updateWorldInfoList();
    return book;
}

function updateActivePersona(text, book) {
    const avatar = user_avatar;
    const descriptors = power_user.persona_descriptions;
    const d = descriptors[avatar] ?? (descriptors[avatar] = { description: '', position: 0, depth: 2, role: 0, lorebook: '', title: '' });
    d.description = text;
    power_user.persona_description = text;
    if (book) {
        d.lorebook = book;
        power_user.persona_description_lorebook = book;
    }
    saveSettingsDebounced();
    setPersonaDescription();
}

async function createNewPersona(name, text, book) {
    const ctx = getContext();
    const result = await ctx.executeSlashCommandsWithOptions(
        `/persona-create name="${slashEscape(name)}" select=false`,
        { handleParserErrors: true, handleExecutionErrors: true },
    );
    const avatarId = String(result?.pipe ?? '').trim();
    const d = power_user.persona_descriptions?.[avatarId];
    if (!avatarId || !d) throw new Error(ui().createFailed);

    d.description = text;
    if (book) d.lorebook = book;
    saveSettingsDebounced();
    await getUserAvatars(true, avatarId);
    if (state.selectAfter) await setUserAvatar(avatarId);
    return avatarId;
}

async function save() {
    await run(async () => {
        const t = ui();
        if (state.target === 'new' && !state.name.trim()) throw new Error(t.needName);
        if (state.target === 'active' && !hasActivePersona()) throw new Error(t.noActive);

        const name = personaName();
        let text = finalText();
        if (!text.trim()) throw new Error(t.nothingToSave);
        if (settings().thaiSpacing) text = core.fixThaiNameSpacing(text, [name, currentCharName()]);

        let book = '';
        if (state.loreOn) {
            const entries = state.lore
                .map(e => ({ title: e.title.trim(), keys: core.splitKeys(e.keysText), content: e.content.trim() }))
                .filter(e => e.title && e.keys.length && e.content);
            if (entries.length) {
                book = await writeLorebook(name, entries);
                toastr.success(fmt(t.loreSavedOk, { name: book, n: entries.length }), t.title);
            }
        }

        if (state.target === 'active') {
            updateActivePersona(text, book);
            try { await eventSource.emit(event_types.PERSONA_UPDATED, user_avatar); } catch { /* optional */ }
            toastr.success(fmt(t.updatedOk, { name }), t.title);
        } else {
            await createNewPersona(name, text, book);
            toastr.success(fmt(t.createdOk, { name }), t.title);
        }
    });
}

async function copyText() {
    try {
        await navigator.clipboard.writeText(finalText());
        toastr.success(ui().copied, ui().title);
    } catch {
        toastr.error(ui().copyFailed, ui().title);
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function sectionEditor(key, dis) {
    const t = ui();
    const rows = ['samples', 'asymmetry', 'rules'].includes(key) ? 5 : 3;
    return `
<div class="pw-sec">
  <div class="pw-sec-head">
    <b>${esc(t['sec_' + key])}</b>
    <small>${esc(t['hint_' + key])}</small>
    <button class="menu_button pw-mini" data-act="regen:${key}" title="${esc(t.regen)}" ${dis}><i class="fa-solid fa-rotate"></i></button>
  </div>
  <textarea class="text_pole" rows="${rows}" data-field="sec:${key}">${esc(state.sections[key])}</textarea>
</div>`;
}

function loreEditor(entry, i, dis) {
    const t = ui();
    return `
<div class="pw-lore-entry">
  <div class="pw-row">
    <input class="text_pole" data-field="lore:${i}:title" value="${esc(entry.title)}" placeholder="${esc(t.loreEntryTitle)}">
    <button class="menu_button pw-mini" data-act="loreRemove:${i}" title="${esc(t.loreRemove)}" ${dis}><i class="fa-solid fa-xmark"></i></button>
  </div>
  <input class="text_pole" data-field="lore:${i}:keys" value="${esc(entry.keysText)}" placeholder="${esc(t.loreEntryKeys)}">
  <textarea class="text_pole" rows="4" data-field="lore:${i}:content" placeholder="${esc(t.loreEntryContent)}">${esc(entry.content)}</textarea>
</div>`;
}

function charPicker(dis) {
    const t = ui();
    const sel = charSel();
    const cur = characters?.[this_chid];
    const opt = (v, label) => `<option value="${esc(v)}" ${sel === v ? 'selected' : ''}>${esc(label)}</option>`;
    const others = (characters ?? [])
        .filter(c => c?.avatar && c.avatar !== cur?.avatar)
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    // A picked character that no longer exists falls back to "none" in the list.
    return `
<label class="pw-label">${esc(t.charPick)}
  <select class="text_pole" data-field="charSel" ${dis}>
    ${opt('@current', cur ? fmt(t.charCurrent, { name: cur.name }) : t.charCurrentNone)}
    ${opt('', t.charNone)}
    ${others.map(c => opt(c.avatar, c.name)).join('')}
  </select>
</label>`;
}

function ideasBlock(dis) {
    const t = ui();
    const hasChar = Boolean(currentCharCard());
    return `
<div class="pw-row">
  <button class="menu_button" data-act="ideas" ${dis} ${hasChar ? '' : 'disabled'} title="${esc(hasChar ? t.ideasRun : t.ideasNeedChar)}"><i class="fa-solid fa-lightbulb"></i> ${esc(t.ideasRun)}</button>
</div>
${state.ideas.map((idea, i) => `
<div class="pw-idea">
  <b>${esc(idea.title)}</b>
  <div>${esc(idea.text).replace(/\n/g, '<br>')}</div>
  <button class="menu_button pw-mini" data-act="useIdea:${i}" ${dis}><i class="fa-solid fa-arrow-down"></i> ${esc(t.ideasUse)}</button>
</div>`).join('')}`;
}

function weaveBody(dis) {
    const t = ui();
    const active = hasActivePersona();
    const lang = settings().lang;
    const langOption = (v, label) => `<option value="${v}" ${lang === v ? 'selected' : ''}>${esc(label)}</option>`;

    return `
<div class="pw-row pw-targets">
  <label class="pw-check"><input type="radio" name="pw_target" value="new" data-field="target" ${state.target === 'new' ? 'checked' : ''}> ${esc(t.targetNew)}</label>
  <label class="pw-check"><input type="radio" name="pw_target" value="active" data-field="target" ${state.target === 'active' ? 'checked' : ''} ${active ? '' : 'disabled'}> ${esc(t.targetActive)}${active ? ` — ${esc(name1)}` : ''}</label>
</div>
${state.target === 'new' ? `
<label class="pw-label">${esc(t.nameLabel)}
  <input class="text_pole" data-field="name" value="${esc(state.name)}" placeholder="${esc(t.namePlaceholder)}">
</label>
<label class="pw-check"><input type="checkbox" data-field="selectAfter" ${state.selectAfter ? 'checked' : ''}> ${esc(t.selectAfter)}</label>` : ''}
${charPicker(dis)}
${isFreshChat() && state.target === 'new' ? `<div class="pw-hint pw-fresh">${esc(t.freshHint)}</div>` : ''}
<label class="pw-label">${esc(t.notesLabel)} <small>${esc(t.notesHint)}</small>
  <textarea class="text_pole" rows="5" data-field="notes">${esc(state.notes)}</textarea>
</label>
${ideasBlock(dis)}
<div class="pw-row">
  <button class="menu_button" data-act="loadActive" ${dis} ${active ? '' : 'disabled'}>${esc(t.loadActive)}</button>
  <label class="pw-inline">${esc(t.langLabel)}
    <select class="text_pole" data-field="lang">${langOption('auto', t.langAuto)}${langOption('th', t.langTh)}${langOption('en', t.langEn)}</select>
  </label>
</div>
<button class="menu_button pw-primary" data-act="weaveAll" ${dis}><i class="fa-solid fa-wand-magic-sparkles"></i> ${esc(t.weaveAll)}</button>
<div class="pw-sections">${SECTION_KEYS.map(k => sectionEditor(k, dis)).join('')}</div>
<div class="pw-lore">
  <label class="pw-check"><input type="checkbox" data-field="loreOn" ${state.loreOn ? 'checked' : ''}> ${esc(t.loreToggle)}</label>
  ${state.loreOn ? `
  <div class="pw-hint">${esc(fmt(t.loreHint, { name: core.loreBookName(personaName()) }))}</div>
  <button class="menu_button" data-act="loreGen" ${dis}>${esc(t.loreGenerate)}</button>
  ${state.lore.map((e, i) => loreEditor(e, i, dis)).join('')}` : ''}
</div>
<details class="pw-preview"><summary>${esc(t.previewSummary)}</summary><pre>${esc(finalText())}</pre></details>`;
}

function countField(dis) {
    const t = ui();
    return `
<label class="pw-inline">${esc(t.msgCount)}
  <input class="text_pole pw-num" type="number" min="5" max="200" step="5" data-field="msgCount" value="${esc(state.msgCount)}" ${dis}>
</label>`;
}

function mineBody(dis) {
    const t = ui();
    const stats = core.styleStats(chat, { maxMessages: state.msgCount });
    return `
<p class="pw-hint">${esc(t.mineIntro)}</p>
<div class="pw-row">${countField(dis)}
  <button class="menu_button pw-primary" data-act="mineRun" ${dis}><i class="fa-solid fa-magnifying-glass-chart"></i> ${esc(t.mineRun)}</button>
</div>
${stats ? `<pre class="pw-stats">${esc(core.formatStats(stats))}</pre>` : `<p class="pw-hint">${esc(t.mineNoChat)} ${esc(t.mineFresh)}</p>`}`;
}

function evolveBody(dis) {
    const t = ui();
    const ev = state.evolve;
    let result = '';
    if (ev) {
        if (!ev.changed.length) {
            result = `<p class="pw-hint">${esc(t.evolveNothing)}</p>`;
        } else {
            result = ev.changed.map(k => `
<div class="pw-diff">
  <label class="pw-check"><input type="checkbox" data-field="accept:${k}" ${ev.accept[k] ? 'checked' : ''}> <b>${esc(t.evolveAccept)}: ${esc(t['sec_' + k])}</b></label>
  <div class="pw-diff-cols">
    <div><small>${esc(t.evolveBefore)}</small><pre>${esc(String(ev.base[k] || '').trim() || t.evolveEmpty)}</pre></div>
    <div><small>${esc(t.evolveAfter)}</small><pre>${esc(ev.patch[k])}</pre></div>
  </div>
</div>`).join('');
            result += `<button class="menu_button pw-primary" data-act="evolveApply" ${dis}>${esc(t.evolveApply)}</button>`;
        }
        if (ev.summary) result = `<div class="pw-why"><b>${esc(t.evolveWhy)}</b><pre>${esc(ev.summary)}</pre></div>${result}`;
    }
    return `
<p class="pw-hint">${esc(t.evolveIntro)}</p>
<div class="pw-row">${countField(dis)}
  <button class="menu_button pw-primary" data-act="evolveRun" ${dis}><i class="fa-solid fa-seedling"></i> ${esc(t.evolveRun)}</button>
</div>
${result}`;
}

function sourceSelectHtml(attrs) {
    const t = ui();
    const cur = api.resolveSource(settings().source);
    const opts = api.sourceOptions(t.apiMain)
        .map(o => `<option value="${esc(o.id)}" ${o.id === cur ? 'selected' : ''}>${esc(o.label)}</option>`)
        .join('');
    return `<select class="text_pole" ${attrs}>${opts}</select>`;
}

function sizeSelectHtml(attrs) {
    const t = ui();
    const cur = sizeNow();
    const opts = Object.keys(core.SIZES)
        .map(k => `<option value="${k}" ${k === cur ? 'selected' : ''}>${esc(fmt(t['size_' + k], { n: core.SIZES[k].tokens }))}</option>`)
        .join('');
    return `<select class="text_pole" ${attrs}>${opts}</select>`;
}

function apiBar(dis) {
    const t = ui();
    const last = state.lastCall
        ? `<small class="pw-last">${esc(fmt(t.lastCall, { api: state.lastCall.label, s: (state.lastCall.ms / 1000).toFixed(1) }))}</small>`
        : '';
    return `
<div class="pw-apibar">
  <label class="pw-inline">${esc(t.apiLabel)} ${sourceSelectHtml(`data-field="source" ${dis}`)}</label>
  <label class="pw-inline">${esc(t.sizeLabel)} ${sizeSelectHtml(`data-field="size" ${dis}`)}</label>
  ${last}
</div>`;
}

function layout() {
    const t = ui();
    const dis = state.busy ? 'disabled' : '';
    const body = state.mode === 'mine' ? mineBody(dis) : state.mode === 'evolve' ? evolveBody(dis) : weaveBody(dis);
    const tabs = ['weave', 'mine', 'evolve']
        .map(m => `<button class="pw-tab ${state.mode === m ? 'active' : ''}" data-act="tab:${m}">${esc(t['tab_' + m])}</button>`)
        .join('');

    return `
<div class="pw-panel" role="dialog" aria-modal="true" aria-label="${esc(t.title)}">
  <div class="pw-head">
    <div class="pw-title"><i class="fa-solid fa-wand-magic-sparkles"></i> ${esc(t.title)} <small class="pw-ver">v${VERSION}</small>${isStale() ? ` <button class="pw-stale" data-act="reloadNew" title="${esc(t.verReloadHint)}"><i class="fa-solid fa-circle-up"></i> v${esc(remoteVersion)}</button>` : ''}</div>
    <div class="pw-tabs">${tabs}</div>
    <button class="pw-x" data-act="close" title="${esc(t.close)}"><i class="fa-solid fa-xmark"></i></button>
  </div>
  <div class="pw-body">
    ${apiBar(dis)}
    ${state.busy && state.sendingTo ? `<div class="pw-busy"><i class="fa-solid fa-spinner fa-spin"></i> ${esc(fmt(t.busyTo, { api: state.sendingTo }))}</div>` : ''}
    ${body}
    ${state.lastRaw ? `<details class="pw-raw"><summary>${esc(t.rawOutput)}</summary><pre>${esc(state.lastRaw)}</pre></details>` : ''}
  </div>
  <div class="pw-foot">
    <span id="pw_tokens" class="pw-tokens"></span>
    <button class="menu_button" id="pw_condense" data-act="condense" title="${esc(t.condense)}" ${dis}><i class="fa-solid fa-compress"></i></button>
    <button class="menu_button" data-act="undo" title="${esc(t.undo)}" ${state.busy || !state.history.length ? 'disabled' : ''}><i class="fa-solid fa-rotate-left"></i></button>
    <button class="menu_button" data-act="copy" title="${esc(t.copy)}" ${dis}><i class="fa-regular fa-copy"></i></button>
    <button class="menu_button pw-primary" data-act="save" ${dis}><i class="fa-solid fa-floppy-disk"></i> ${esc(state.target === 'new' ? t.saveNew : t.saveActive)}</button>
  </div>
</div>`;
}

function render() {
    const root = document.getElementById('pw_overlay');
    if (!root) return;
    const prev = root.querySelector('.pw-body');
    const scroll = prev ? prev.scrollTop : 0;
    root.innerHTML = layout();
    const next = root.querySelector('.pw-body');
    if (next) next.scrollTop = scroll;
    refreshTokens();
}

async function countTokens(text) {
    try {
        return await getTokenCountAsync(text);
    } catch {
        return core.estimateTokens(text);
    }
}

let tokenTimer = null;
function refreshTokens() {
    clearTimeout(tokenTimer);
    tokenTimer = setTimeout(async () => {
        const el = document.getElementById('pw_tokens');
        if (!el) return;
        const n = await countTokens(finalText());
        state.tokenCount = n;
        const t = ui();
        const max = budgetNow();
        const over = n > max * BUDGET_SLACK;
        el.textContent = fmt(t.tokens, { n, max }) + (over ? ` · ${t.tokensWarn}` : '');
        el.classList.toggle('pw-warn', over);
        document.getElementById('pw_condense')?.classList.toggle('pw-attn', n > max);
    }, 250);
}

// ---------------------------------------------------------------------------
// Confirm before every request
// ---------------------------------------------------------------------------

/**
 * Show what is about to be sent and where. Resolves to the chosen source id, or null.
 * The API can be changed right here; the choice is saved as the new default.
 */
function confirmRequest({ task, p, maxTokens }) {
    return new Promise((resolve) => {
        const t = ui();
        let src = api.resolveSource(settings().source);
        const inTokens = core.estimateTokens(`${p.systemPrompt}\n${p.prompt}`);
        document.getElementById('pw_confirm')?.remove();

        const wrap = document.createElement('div');
        wrap.id = 'pw_confirm';
        wrap.innerHTML = `
<div class="pw-confirm" role="alertdialog" aria-modal="true" aria-labelledby="pw_confirm_title">
  <div class="pw-confirm-title" id="pw_confirm_title"><i class="fa-solid fa-paper-plane"></i> ${esc(t.confirmTitle)}</div>
  <div class="pw-confirm-row"><small>${esc(t.confirmTask)}</small><b>${esc(task)}</b></div>
  <label class="pw-confirm-row"><small>${esc(t.confirmApi)}</small>${sourceSelectHtml('data-c="src"')}</label>
  <div class="pw-hint">${esc(fmt(t.confirmCost, { n: inTokens, m: maxTokens }))}</div>
  <details class="pw-raw"><summary>${esc(t.confirmPrompt)}</summary><pre>${esc(`${p.systemPrompt}\n\n────────\n\n${p.prompt}`)}</pre></details>
  <div class="pw-confirm-btns">
    <button class="menu_button" data-c="no">${esc(t.confirmCancel)}</button>
    <button class="menu_button pw-primary" data-c="ok"><i class="fa-solid fa-paper-plane"></i> ${esc(t.confirmOk)}</button>
  </div>
</div>`;

        const finish = (value) => {
            document.removeEventListener('keydown', onKeyConfirm, true);
            wrap.remove();
            resolve(value);
        };
        const onKeyConfirm = (e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopImmediatePropagation();
            finish(null);
        };
        wrap.addEventListener('change', (e) => {
            if (e.target.dataset?.c !== 'src') return;
            src = e.target.value;
            settings().source = src;
            saveSettingsDebounced();
            syncSettingsApi();
        });
        wrap.addEventListener('click', (e) => {
            const b = e.target.closest('[data-c]');
            if (b?.dataset.c === 'ok') finish(src);
            else if (b?.dataset.c === 'no' || e.target === wrap) finish(null);
        });
        document.addEventListener('keydown', onKeyConfirm, true);
        document.body.appendChild(wrap);
        wrap.querySelector('[data-c="ok"]')?.focus();
    });
}

// ---------------------------------------------------------------------------
// Version check + hard refresh (same approach as Lore Master)
//
// SillyTavern loads extension files by a fixed URL, and browsers (and home-screen web apps
// on iOS, which rarely reload for real) keep the old files cached after "Update". Compare
// with the manifest on the server; if it is newer, say so, and offer to refetch every file
// and reload. The open draft is parked in sessionStorage across that reload.
// ---------------------------------------------------------------------------

let remoteVersion = '';
let versionCheckedAt = 0;
let versionToastShown = false;

function isStale() {
    return Boolean(remoteVersion) && core.newerVersion(remoteVersion, VERSION);
}

async function fetchRemoteVersion() {
    try {
        const res = await fetch(new URL('manifest.json', BASE_URL), { cache: 'no-store' });
        if (!res.ok) return '';
        return String((await res.json())?.version ?? '');
    } catch {
        return '';
    }
}

function remoteHtml() {
    const t = ui();
    if (!remoteVersion) return '';
    return isStale()
        ? `· <span class="pw-stale-text">${esc(fmt(t.verStale, { v: remoteVersion }))}</span>`
        : `· ${esc(t.verLatest)}`;
}

function showRemote() {
    document.querySelectorAll('[data-pw-remote]').forEach((el) => { el.innerHTML = remoteHtml(); });
}

async function checkForNewVersion(force = false) {
    if (!force && Date.now() - versionCheckedAt < 10 * 60_000) return remoteVersion;
    versionCheckedAt = Date.now();
    const wasStale = isStale();
    remoteVersion = await fetchRemoteVersion();
    showRemote();
    if (isStale() !== wasStale) render();
    if (isStale() && !versionToastShown) {
        versionToastShown = true;
        const t = ui();
        toastr.info(esc(fmt(t.verToast, { remote: remoteVersion, v: VERSION })), t.title, {
            timeOut: 0, extendedTimeOut: 0, closeButton: true, escapeHtml: false, onclick: () => reloadWithFreshFiles(),
        });
    }
    return remoteVersion;
}

function stashDraft() {
    const hasWork = state.notes.trim() || state.name.trim() || hasSections() || state.lore.length || state.ideas.length;
    if (!hasWork) return;
    try {
        sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
            mode: state.mode, target: state.target, name: state.name, notes: state.notes,
            sections: state.sections, loreOn: state.loreOn, lore: state.lore, charSel: state.charSel, ideas: state.ideas, open: Boolean(document.getElementById('pw_overlay')),
        }));
    } catch { /* storage blocked: the draft is lost, the reload still works */ }
}

function restoreDraft() {
    let draft = null;
    try {
        draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? 'null');
        sessionStorage.removeItem(DRAFT_KEY);
    } catch { return false; }
    if (!draft || typeof draft !== 'object') return false;
    state.mode = ['weave', 'mine', 'evolve'].includes(draft.mode) ? draft.mode : 'weave';
    state.target = draft.target === 'active' ? 'active' : 'new';
    state.name = String(draft.name ?? '');
    state.notes = String(draft.notes ?? '');
    state.sections = { ...core.emptySections(), ...(draft.sections ?? {}) };
    state.loreOn = Boolean(draft.loreOn);
    state.lore = Array.isArray(draft.lore) ? draft.lore : [];
    state.charSel = typeof draft.charSel === 'string' ? draft.charSel : null;
    state.ideas = Array.isArray(draft.ideas) ? draft.ideas : [];
    return draft.open ? 'open' : true;
}

async function reloadWithFreshFiles() {
    try {
        stashDraft();
        try { await saveSettings(); } catch { /* the debounced save may still land */ }
        toastr.info(ui().verFetching, ui().title, { timeOut: 2000 });
        // cache: 'reload' fetches from the server and overwrites the browser's cached copy,
        // so the page reload below runs the new files.
        await Promise.all(FILES.map(f => fetch(new URL(f, BASE_URL), { cache: 'reload' }).catch(() => null)));
    } finally {
        location.reload();
    }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function onClick(event) {
    const el = event.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const [act, arg] = el.dataset.act.split(':');

    switch (act) {
        case 'close': closeWeaver(); return;
        case 'tab': state.mode = arg; render(); return;
        case 'loadActive': loadActive(); render(); return;
        case 'weaveAll': weave(SECTION_KEYS); return;
        case 'regen': weave([arg]); return;
        case 'loreGen': generateLore(); return;
        case 'ideas': suggestIdeas(); return;
        case 'useIdea': useIdea(Number(arg)); render(); return;
        case 'condense': condense(); return;
        case 'reloadNew': reloadWithFreshFiles(); return;
        case 'loreRemove': pushHistory(); state.lore.splice(Number(arg), 1); render(); return;
        case 'mineRun': mine(); return;
        case 'evolveRun': evolve(); return;
        case 'evolveApply': applyEvolve(); render(); return;
        case 'undo': undo(); render(); return;
        case 'copy': copyText(); return;
        case 'save': save(); return;
        default:
    }
}

function onInput(event) {
    const el = event.target;
    const field = el.dataset?.field;
    if (!field) return;

    if (field === 'name') state.name = el.value;
    else if (field === 'notes') state.notes = el.value;
    else if (field === 'msgCount') state.msgCount = Math.max(5, Math.min(200, Number(el.value) || DEFAULTS.messages));
    else if (field.startsWith('sec:')) state.sections[field.slice(4)] = el.value;
    else if (field.startsWith('lore:')) {
        const [, i, prop] = field.split(':');
        const entry = state.lore[Number(i)];
        if (entry) entry[prop === 'keys' ? 'keysText' : prop] = el.value;
    } else return;

    refreshTokens();
}

function onChange(event) {
    const el = event.target;
    const field = el.dataset?.field;
    if (!field) return;

    if (field === 'target') {
        state.target = el.value;
        if (state.target === 'active' && !state.notes.trim() && !hasSections()) loadActive();
    } else if (field === 'selectAfter') state.selectAfter = el.checked;
    else if (field === 'charSel') {
        state.charSel = el.value;
        state.ideas = [];
        settings().useCharCard = el.value !== '';
        saveSettingsDebounced();
    }
    else if (field === 'lang') { settings().lang = el.value; saveSettingsDebounced(); }
    else if (field === 'source') { settings().source = el.value; saveSettingsDebounced(); syncSettingsApi(); return; }
    else if (field === 'size') { settings().size = core.sizeKey(el.value); saveSettingsDebounced(); syncSettingsApi(); }
    else if (field === 'loreOn') state.loreOn = el.checked;
    else if (field.startsWith('accept:')) { if (state.evolve) state.evolve.accept[field.slice(7)] = el.checked; return; }
    else if (field === 'msgCount') { state.msgCount = Math.max(5, Math.min(200, Number(el.value) || DEFAULTS.messages)); render(); return; }
    else return;

    render();
}

function onKey(event) {
    if (event.key !== 'Escape' || !document.getElementById('pw_overlay')) return;
    if (document.getElementById('pw_confirm')) return;
    closeWeaver();
}

function openWeaver() {
    if (document.getElementById('pw_overlay')) return;
    if (!state.initialised) {
        state.msgCount = settings().messages;
        state.initialised = true;
    }
    const root = document.createElement('div');
    root.id = 'pw_overlay';
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    document.body.appendChild(root);
    document.addEventListener('keydown', onKey);
    render();
    checkForNewVersion();
}

function closeWeaver() {
    document.getElementById('pw_overlay')?.remove();
    document.removeEventListener('keydown', onKey);
}

// ---------------------------------------------------------------------------
// Settings panel, menu entry, slash command
// ---------------------------------------------------------------------------

function mountSettings() {
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host) return;
    document.getElementById('pw_settings_root')?.remove();

    const s = settings();
    const t = ui();
    const opt = (cur, v, label) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${esc(label)}</option>`;
    const wrap = document.createElement('div');
    wrap.id = 'pw_settings_root';
    wrap.innerHTML = `
<div class="inline-drawer">
  <div class="inline-drawer-toggle inline-drawer-header">
    <b>${esc(t.title)} <small class="pw-ver">v${VERSION}</small></b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
  </div>
  <div class="inline-drawer-content">
  <div class="pw-settings">
    <label>${esc(t.setUiLang)}
      <select id="pw_set_ui" class="text_pole">${opt(s.uiLang, 'auto', t.langAuto)}${opt(s.uiLang, 'th', t.langTh)}${opt(s.uiLang, 'en', t.langEn)}</select>
    </label>
    <label>${esc(t.setApi)}${sourceSelectHtml('id="pw_set_api"')}</label>
    <small>${esc(t.apiHint)}</small>
    <label>${esc(t.setSize)}${sizeSelectHtml('id="pw_set_size"')}</label>
    <label>${esc(t.setTimeout)}<input id="pw_set_to" class="text_pole" type="number" min="15" max="600" step="15" value="${esc(s.timeoutSec)}"></label>
    <label>${esc(t.setLang)}
      <select id="pw_set_lang" class="text_pole">${opt(s.lang, 'auto', t.langAuto)}${opt(s.lang, 'th', t.langTh)}${opt(s.lang, 'en', t.langEn)}</select>
    </label>
    <label class="checkbox_label"><input id="pw_set_thai" type="checkbox" ${s.thaiSpacing ? 'checked' : ''}><span>${esc(t.setThai)}</span></label>
    <small>${esc(t.setThaiHint)}</small>
    <label>${esc(t.setWeaveTokens)}<input id="pw_set_wt" class="text_pole" type="number" min="300" max="8000" step="100" value="${esc(s.weaveTokens)}"></label>
    <label>${esc(t.setOtherTokens)}<input id="pw_set_ot" class="text_pole" type="number" min="300" max="8000" step="100" value="${esc(s.otherTokens)}"></label>
    <label>${esc(t.setMsgs)}<input id="pw_set_msgs" class="text_pole" type="number" min="5" max="200" step="5" value="${esc(s.messages)}"></label>
    <div class="pw-verline">${esc(fmt(t.verRunning, { v: VERSION }))} <span data-pw-remote>${remoteHtml()}</span></div>
    <div class="pw-set-btns">
      <div class="menu_button" id="pw_set_open"><i class="fa-solid fa-wand-magic-sparkles"></i> ${esc(t.setOpen)}</div>
      <div class="menu_button" id="pw_set_vcheck"><i class="fa-solid fa-magnifying-glass"></i> ${esc(t.verCheck)}</div>
      <div class="menu_button" id="pw_set_reload" title="${esc(t.verReloadHint)}"><i class="fa-solid fa-rotate"></i> ${esc(t.verReload)}</div>
    </div>
  </div>
  </div>
</div>`;
    host.appendChild(wrap);

    const num = (id, key, min, max) => wrap.querySelector(id).addEventListener('change', (e) => {
        const v = Number(e.target.value);
        settings()[key] = Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : DEFAULTS[key];
        e.target.value = settings()[key];
        saveSettingsDebounced();
    });
    num('#pw_set_wt', 'weaveTokens', 300, 8000);
    num('#pw_set_ot', 'otherTokens', 300, 8000);
    num('#pw_set_msgs', 'messages', 5, 200);
    num('#pw_set_to', 'timeoutSec', 15, 600);
    const apiSel = wrap.querySelector('#pw_set_api');
    // Profiles can be added while the page is open: rebuild the list whenever it is opened.
    apiSel.addEventListener('focus', () => refillSourceSelect(apiSel));
    apiSel.addEventListener('change', (e) => { settings().source = e.target.value; saveSettingsDebounced(); render(); });
    wrap.querySelector('#pw_set_size').addEventListener('change', (e) => { settings().size = core.sizeKey(e.target.value); saveSettingsDebounced(); render(); });
    wrap.querySelector('#pw_set_vcheck').addEventListener('click', async () => {
        const t2 = ui();
        const remote = await checkForNewVersion(true);
        if (!remote) toastr.warning(t2.verUnknown, t2.title);
        else if (isStale()) toastr.info(fmt(t2.verStale, { v: remote }), t2.title);
        else toastr.success(fmt(t2.verSame, { v: VERSION }), t2.title);
    });
    wrap.querySelector('#pw_set_reload').addEventListener('click', reloadWithFreshFiles);
    wrap.querySelector('#pw_set_thai').addEventListener('change', (e) => { settings().thaiSpacing = e.target.checked; saveSettingsDebounced(); });
    wrap.querySelector('#pw_set_lang').addEventListener('change', (e) => { settings().lang = e.target.value; saveSettingsDebounced(); render(); });
    wrap.querySelector('#pw_set_ui').addEventListener('change', (e) => {
        settings().uiLang = e.target.value;
        saveSettingsDebounced();
        mountSettings();
        mountMenu();
        render();
    });
    wrap.querySelector('#pw_set_open').addEventListener('click', openWeaver);
}

function refillSourceSelect(sel) {
    const t = ui();
    const cur = api.resolveSource(settings().source);
    sel.innerHTML = api.sourceOptions(t.apiMain)
        .map(o => `<option value="${esc(o.id)}" ${o.id === cur ? 'selected' : ''}>${esc(o.label)}</option>`)
        .join('');
}

/** Keep the settings drawer in step after the API or size was changed elsewhere. */
function syncSettingsApi() {
    const sel = document.getElementById('pw_set_api');
    if (sel) refillSourceSelect(sel);
    const size = document.getElementById('pw_set_size');
    if (size) size.value = sizeNow();
}

function mountMenu() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return false;
    document.getElementById('pw_menu_item')?.remove();
    const item = document.createElement('div');
    item.id = 'pw_menu_item';
    item.className = 'extension_container';
    item.innerHTML = `<div class="list-group-item flex-container flexGap5" title="${esc(ui().menu)}">
  <div class="fa-solid fa-wand-magic-sparkles extensionsMenuExtensionButton"></div>
  <span>${esc(ui().menu)}</span>
</div>`;
    item.addEventListener('click', () => {
        document.getElementById('extensionsMenu')?.style && (document.getElementById('extensionsMenu').style.display = 'none');
        openWeaver();
    });
    menu.appendChild(item);
    // The wand button hides itself when the menu has no visible children.
    document.getElementById('extensionsMenuButton')?.style.removeProperty('display');
    return true;
}

function registerSlashCommand() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'persona-weaver',
        aliases: ['pweave'],
        callback: () => { openWeaver(); return ''; },
        helpString: 'Opens Persona Weaver, the layered persona builder.',
    }));
}

jQuery(() => {
    settings();
    const restored = restoreDraft();
    mountSettings();
    registerSlashCommand();
    if (!mountMenu()) eventSource.on(event_types.APP_READY, mountMenu);
    if (restored) {
        toastr.info(ui().draftRestored, ui().title, { timeOut: 4000 });
        if (restored === 'open') {
            let opened = false;
            eventSource.on(event_types.APP_READY, () => { if (!opened) { opened = true; openWeaver(); } });
        }
    }
    setTimeout(() => checkForNewVersion(), 3000);
    eventSource.on(event_types.CHAT_CHANGED, () => checkForNewVersion());
    globalThis.PersonaWeaver = { open: openWeaver, version: VERSION, remote: () => remoteVersion, isStale };
    console.log(`[Persona Weaver] v${VERSION} ready`);
});
