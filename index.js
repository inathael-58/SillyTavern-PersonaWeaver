// Persona Weaver — SillyTavern extension.
// Turns a rough persona into a layered one (inner conflict, voice samples, asymmetric knowledge,
// turn-writing rules), mines your real chat style, evolves the persona after an arc, and can
// move backstory/secrets into a keyword-triggered lorebook.

import {
    characters,
    chat,
    eventSource,
    event_types,
    generateRaw,
    name1,
    name2,
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

import * as core from './core.js';
import { SECTION_KEYS } from './core.js';
import { STRINGS, fmt, resolveUiLang } from './i18n.js';
import * as prompts from './prompts.js';

const MODULE = 'persona_weaver';
const DEFAULTS = Object.freeze({
    uiLang: 'auto',
    lang: 'auto',
    thaiSpacing: true,
    useCharCard: true,
    weaveTokens: 1500,
    otherTokens: 1000,
    messages: 40,
});
const TOKEN_WARN = 700;

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
    busy: false,
    initialised: false,
};

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

function currentCharName() {
    return characters?.[this_chid]?.name ?? '';
}

function currentCharCard() {
    if (!settings().useCharCard) return undefined;
    const c = characters?.[this_chid];
    if (!c) return undefined;
    const text = [c.description, c.personality, c.scenario].filter(Boolean).join('\n\n').slice(0, 1800);
    return text ? { name: c.name, text } : undefined;
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

async function callModel(p, responseLength) {
    const raw = await generateRaw({
        prompt: p.prompt,
        systemPrompt: p.systemPrompt,
        responseLength,
        trimNames: false,
    });
    state.lastRaw = raw;
    return raw;
}

async function askBlocks(p, keys, responseLength) {
    const raw = await callModel(p, responseLength);
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
        console.error('[Persona Weaver]', err);
        toastr.error(String(err?.message ?? err), ui().title);
    } finally {
        state.busy = false;
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
        if (!state.notes.trim() && !hasSections()) throw new Error(t.needNotes);
        const p = prompts.buildWeavePrompt({
            keys,
            lang: concreteLang(),
            name: personaName(),
            notes: state.notes,
            sections: state.sections,
            charCard: currentCharCard(),
        });
        const parsed = await askBlocks(p, keys, settings().weaveTokens);
        pushHistory();
        for (const k of keys) if (parsed[k]) state.sections[k] = tidy(parsed[k]);
    });
}

async function generateLore() {
    await run(async () => {
        const t = ui();
        if (!state.notes.trim() && !hasSections()) throw new Error(t.needNotes);
        const p = prompts.buildLorePrompt({
            lang: concreteLang(),
            name: personaName(),
            notes: state.notes,
            sections: state.sections,
            charCard: currentCharCard(),
        });
        const raw = await callModel(p, settings().otherTokens);
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
        const p = prompts.buildMinePrompt({
            lang: concreteLang(),
            name: personaName(),
            transcript,
            stats,
            sections: state.sections,
        });
        const keys = ['voice', 'samples', 'rules'];
        const parsed = await askBlocks(p, keys, settings().otherTokens);
        pushHistory();
        for (const k of keys) if (parsed[k]) state.sections[k] = tidy(parsed[k]);
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

        const p = prompts.buildEvolvePrompt({ lang: concreteLang(), name: personaName(), sections: base, transcript });
        const raw = await callModel(p, settings().otherTokens);
        const parsed = core.parseTagged(raw, [...SECTION_KEYS, 'summary']);
        if (!SECTION_KEYS.some(k => parsed[k]) && !parsed.summary) throw new Error(t.errFormat);

        const patch = {};
        for (const k of SECTION_KEYS) if (parsed[k]) patch[k] = tidy(parsed[k]);
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

function weaveBody(dis) {
    const t = ui();
    const active = hasActivePersona();
    const charName = currentCharName();
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
<label class="pw-label">${esc(t.notesLabel)} <small>${esc(t.notesHint)}</small>
  <textarea class="text_pole" rows="5" data-field="notes">${esc(state.notes)}</textarea>
</label>
<div class="pw-row">
  <button class="menu_button" data-act="loadActive" ${dis} ${active ? '' : 'disabled'}>${esc(t.loadActive)}</button>
  <label class="pw-check"><input type="checkbox" data-field="useChar" ${settings().useCharCard ? 'checked' : ''}> ${esc(t.useChar)}${charName ? ` (${esc(charName)})` : ''}</label>
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
${stats ? `<pre class="pw-stats">${esc(core.formatStats(stats))}</pre>` : `<p class="pw-hint">${esc(t.mineNoChat)}</p>`}`;
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
    <div class="pw-title"><i class="fa-solid fa-wand-magic-sparkles"></i> ${esc(t.title)}</div>
    <div class="pw-tabs">${tabs}</div>
    <button class="pw-x" data-act="close" title="${esc(t.close)}"><i class="fa-solid fa-xmark"></i></button>
  </div>
  <div class="pw-body">
    ${state.busy ? `<div class="pw-busy"><i class="fa-solid fa-spinner fa-spin"></i> ${esc(t.busy)}</div>` : ''}
    ${body}
    ${state.lastRaw ? `<details class="pw-raw"><summary>${esc(t.rawOutput)}</summary><pre>${esc(state.lastRaw)}</pre></details>` : ''}
  </div>
  <div class="pw-foot">
    <span id="pw_tokens" class="pw-tokens"></span>
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

let tokenTimer = null;
function refreshTokens() {
    clearTimeout(tokenTimer);
    tokenTimer = setTimeout(async () => {
        const el = document.getElementById('pw_tokens');
        if (!el) return;
        const text = finalText();
        let n;
        try {
            n = await getTokenCountAsync(text);
        } catch {
            n = core.estimateTokens(text);
        }
        const t = ui();
        el.textContent = fmt(t.tokens, { n }) + (n > TOKEN_WARN ? ` · ${t.tokensWarn}` : '');
        el.classList.toggle('pw-warn', n > TOKEN_WARN);
    }, 250);
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
    else if (field === 'useChar') { settings().useCharCard = el.checked; saveSettingsDebounced(); }
    else if (field === 'lang') { settings().lang = el.value; saveSettingsDebounced(); }
    else if (field === 'loreOn') state.loreOn = el.checked;
    else if (field.startsWith('accept:')) { if (state.evolve) state.evolve.accept[field.slice(7)] = el.checked; return; }
    else if (field === 'msgCount') { state.msgCount = Math.max(5, Math.min(200, Number(el.value) || DEFAULTS.messages)); render(); return; }
    else return;

    render();
}

function onKey(event) {
    if (event.key === 'Escape' && document.getElementById('pw_overlay')) closeWeaver();
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
    <b>${esc(t.title)}</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
  </div>
  <div class="inline-drawer-content pw-settings">
    <label>${esc(t.setUiLang)}
      <select id="pw_set_ui" class="text_pole">${opt(s.uiLang, 'auto', t.langAuto)}${opt(s.uiLang, 'th', t.langTh)}${opt(s.uiLang, 'en', t.langEn)}</select>
    </label>
    <label>${esc(t.setLang)}
      <select id="pw_set_lang" class="text_pole">${opt(s.lang, 'auto', t.langAuto)}${opt(s.lang, 'th', t.langTh)}${opt(s.lang, 'en', t.langEn)}</select>
    </label>
    <label class="checkbox_label"><input id="pw_set_thai" type="checkbox" ${s.thaiSpacing ? 'checked' : ''}><span>${esc(t.setThai)}</span></label>
    <small>${esc(t.setThaiHint)}</small>
    <label>${esc(t.setWeaveTokens)}<input id="pw_set_wt" class="text_pole" type="number" min="300" max="8000" step="100" value="${esc(s.weaveTokens)}"></label>
    <label>${esc(t.setOtherTokens)}<input id="pw_set_ot" class="text_pole" type="number" min="300" max="8000" step="100" value="${esc(s.otherTokens)}"></label>
    <label>${esc(t.setMsgs)}<input id="pw_set_msgs" class="text_pole" type="number" min="5" max="200" step="5" value="${esc(s.messages)}"></label>
    <div class="menu_button" id="pw_set_open">${esc(t.setOpen)}</div>
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
    mountSettings();
    registerSlashCommand();
    if (!mountMenu()) eventSource.on(event_types.APP_READY, mountMenu);
});
