import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SECTION_KEYS, emptySections, resolveLang, maskMacros, unmaskMacros, fixThaiNameSpacing,
    parseTagged, parseLore, splitKeys, assemblePersona, parsePersona, applyPatch, changedKeys,
    buildTranscript, styleStats, loreBookName, loreEntryFields, estimateTokens,
    SIZES, sizeKey, sizeSpec, capLines, fitLayer, newerVersion, parseIdeas, mergeIdeas, ideaSplit, LABELS,
} from '../core.js';
import { buildWeavePrompt, buildMinePrompt, buildEvolvePrompt, buildLorePrompt, buildCondensePrompt, blockSpecs, buildIdeasPrompt } from '../prompts.js';
import { STRINGS, fmt, resolveUiLang } from '../i18n.js';

test('i18n: every language has exactly the same keys, none empty, same placeholders', () => {
    const base = Object.keys(STRINGS.en).sort();
    for (const [lang, table] of Object.entries(STRINGS)) {
        assert.deepEqual(Object.keys(table).sort(), base, `${lang} keys differ from en`);
        for (const [key, value] of Object.entries(table)) {
            assert.ok(String(value).trim(), `${lang}.${key} is empty`);
            const ph = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).filter(n => n !== 'user' && n !== 'char').sort().join(',');
            assert.equal(ph(value), ph(STRINGS.en[key]), `${lang}.${key} placeholders differ`);
        }
    }
});

test('i18n: every section has label and hint, fmt fills placeholders, ui language resolves', () => {
    for (const table of Object.values(STRINGS)) {
        for (const k of SECTION_KEYS) assert.ok(table[`sec_${k}`] && table[`hint_${k}`], `missing section strings for ${k}`);
    }
    assert.equal(fmt('a {n} b {x}', { n: 3 }), 'a 3 b {x}');
    assert.equal(resolveUiLang('auto', 'th-TH'), 'th');
    assert.equal(resolveUiLang('auto', 'en-US'), 'en');
    assert.equal(resolveUiLang('th', 'en-US'), 'th');
});

test('resolveLang detects Thai vs English and passes explicit values through', () => {
    assert.equal(resolveLang('th', 'hello'), 'th');
    assert.equal(resolveLang('en', 'สวัสดี'), 'en');
    assert.equal(resolveLang('auto', 'เขาเป็นหมอที่เหนื่อยล้า'), 'th');
    assert.equal(resolveLang('auto', 'A tired doctor'), 'en');
    assert.equal(resolveLang('auto', ''), 'en');
});

test('mask/unmask round-trips user and char macros and survives other braces', () => {
    const src = 'ไป{{user}}กับ {{ Char }} และ {{random:a,b}}';
    const masked = maskMacros(src);
    assert.ok(!/\{\{/.test(masked), 'no live macros left');
    assert.ok(masked.includes('[[user]]') && masked.includes('[[char]]'));
    assert.equal(unmaskMacros(masked), 'ไป{{user}}กับ {{char}} และ {{random:a,b}}');
});

test('fixThaiNameSpacing removes spaces between Thai and names, both sides', () => {
    assert.equal(fixThaiNameSpacing('ไป {{user}} ที่นี่'), 'ไป{{user}}ที่นี่');
    assert.equal(fixThaiNameSpacing('เขามองมาที่ ไอริส แล้วยิ้ม', ['ไอริส']), 'เขามองมาที่ไอริสแล้วยิ้ม');
    assert.equal(fixThaiNameSpacing('ก {{user}} ข {{char}} ค'), 'ก{{user}}ข{{char}}ค');
});

test('fixThaiNameSpacing leaves English spacing and non-Thai neighbours alone', () => {
    assert.equal(fixThaiNameSpacing('{{user}} smiles at {{char}}'), '{{user}} smiles at {{char}}');
    assert.equal(fixThaiNameSpacing('{{user}} {{char}}'), '{{user}} {{char}}');
    assert.equal(fixThaiNameSpacing('Iris says ไป'), 'Iris says ไป');
    assert.equal(fixThaiNameSpacing('ไป\n{{user}}'), 'ไป\n{{user}}');
});

test('fixThaiNameSpacing escapes regex characters in names', () => {
    assert.equal(fixThaiNameSpacing('ไป (A.B) ที่', ['(A.B)']), 'ไป(A.B)ที่');
    assert.equal(fixThaiNameSpacing('abc', []), 'abc');
});

test('parseTagged reads blocks, ignores chatter, fences, unknown keys and missing closers', () => {
    const raw = 'Sure! Here you go:\n```\n<<CORE>>\nA tired doctor.\n<</CORE>>\n<<TENSION>>\nwants rest / needs purpose\n<<BOGUS>>\nx\n<<VOICE>>\nShort sentences.\n```';
    const out = parseTagged(raw);
    assert.equal(out.core, 'A tired doctor.');
    assert.equal(out.tension, 'wants rest / needs purpose');
    assert.equal(out.voice, 'Short sentences.');
    assert.equal(out.bogus, undefined);
    assert.equal(out.samples, undefined);
});

test('parseTagged is case-insensitive, handles extra keys and empty blocks', () => {
    const out = parseTagged('<<core>>x<</core>><<summary>>changed core<</summary>><<voice>><</voice>>', [...SECTION_KEYS, 'summary']);
    assert.equal(out.core, 'x');
    assert.equal(out.summary, 'changed core');
    assert.equal(out.voice, undefined);
});

test('parseLore parses entries, splits keys, drops entries without keys or content', () => {
    const raw = [
        '@@ENTRY | The fire | fire, "the old house", Fire',
        'Burned down when {{user}} was nine.',
        '',
        '@@ENTRY | No keys | ',
        'ignored',
        '@@ENTRY | Empty | a, b',
        '@@ENTRY | Letter | letter, ซอง、จดหมาย',
        'Never sent.',
    ].join('\n');
    const entries = parseLore(raw);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], { title: 'The fire', keys: ['fire', 'the old house'], content: 'Burned down when {{user}} was nine.' });
    assert.deepEqual(entries[1].keys, ['letter', 'ซอง', 'จดหมาย']);
});

test('splitKeys caps at 8 and dedupes case-insensitively', () => {
    assert.equal(splitKeys('a,b,c,d,e,f,g,h,i,j').length, 8);
    assert.deepEqual(splitKeys('Fire, fire , FIRE'), ['Fire']);
});

test('assemble then parse round-trips in both languages', () => {
    const sections = {
        core: 'หมอหนุ่มที่เหนื่อยล้า',
        tension: 'อยากพัก / ต้องการเป้าหมาย',
        voice: 'ประโยคสั้น ห้วน',
        samples: '(angry) พอแล้ว\n* (casual) ว่าไง',
        asymmetry: 'รู้ว่า{{char}}โกหก\nไม่รู้ว่า{{char}}รู้ความลับ',
        rules: 'เขียนไม่เกินสองย่อหน้า',
    };
    for (const lang of ['th', 'en']) {
        const text = assemblePersona(sections, lang);
        const back = parsePersona(text);
        assert.equal(back.core, sections.core);
        assert.equal(back.tension, sections.tension);
        assert.equal(back.asymmetry, sections.asymmetry);
        assert.equal(back.samples, '- (angry) พอแล้ว\n- (casual) ว่าไง');
        assert.equal(back.rules, sections.rules);
    }
});

test('assemble skips empty sections; parse of unlabeled text goes to core', () => {
    assert.equal(assemblePersona({ core: 'x', voice: '' }, 'en'), 'Core: x');
    const p = parsePersona('Just a rough paragraph.\nWith two lines.');
    assert.equal(p.core, 'Just a rough paragraph.\nWith two lines.');
    assert.equal(p.tension, '');
});

test('parsePersona keeps text before the first label as part of core', () => {
    const p = parsePersona('Intro line\nVoice: calm');
    assert.equal(p.core, 'Intro line');
    assert.equal(p.voice, 'calm');
});

test('applyPatch only overrides non-empty values; changedKeys reports differences', () => {
    const base = { ...emptySections(), core: 'a', voice: 'b' };
    const merged = applyPatch(base, { core: ' ', voice: 'c', rules: 'd' });
    assert.equal(merged.core, 'a');
    assert.equal(merged.voice, 'c');
    assert.equal(merged.rules, 'd');
    assert.deepEqual(changedKeys(base, merged), ['voice', 'rules']);
});

const chat = [
    { is_user: false, name: 'Iris', mes: 'Hello <b>there</b>' },
    { is_user: true, mes: 'ไม่สนใจ... ทำไมต้องถามด้วย?' },
    { is_system: true, mes: 'system note' },
    { is_user: true, mes: '*ถอนหายใจ* "ไปก็ได้!"' },
    { is_user: false, name: 'Iris', mes: '   ' },
];

test('buildTranscript skips system/blank messages, strips html, labels speakers', () => {
    const t = buildTranscript(chat, { userName: 'Kai' });
    assert.equal(t.split('\n').length, 3);
    assert.ok(t.startsWith('Iris: Hello there'));
    assert.ok(t.includes('Kai: ไม่สนใจ'));
    assert.ok(!t.includes('system note'));
});

test('buildTranscript onlyUser, maxMessages and maxChars keep the most recent', () => {
    const only = buildTranscript(chat, { onlyUser: true, userName: 'Kai' });
    assert.equal(only.split('\n').length, 2);
    const last = buildTranscript(chat, { maxMessages: 1 });
    assert.ok(last.includes('ไปก็ได้'));
    const long = [{ is_user: true, mes: 'a'.repeat(500) }, { is_user: true, mes: 'b'.repeat(500) }];
    const cut = buildTranscript(long, { maxChars: 600, perMessageChars: 500, userName: 'U' });
    assert.ok(cut.includes('bbbb') && !cut.includes('aaaa'));
});

test('styleStats computes percentages and handles no user messages', () => {
    const s = styleStats(chat);
    assert.equal(s.count, 2);
    assert.equal(s.questionPct, 50);
    assert.equal(s.ellipsisPct, 50);
    assert.equal(s.exclaimPct, 50);
    assert.equal(s.actionMarkupPct, 50);
    assert.equal(s.quotedSpeechPct, 50);
    assert.equal(s.shortPct, 100);
    assert.equal(styleStats([{ is_user: false, mes: 'x' }]), null);
    assert.equal(styleStats([]), null);
});

test('lorebook helpers produce a safe name and ST entry fields', () => {
    assert.equal(loreBookName('A/B:C?'), 'PW - ABC');
    assert.equal(loreBookName(''), 'PW - Persona');
    const f = loreEntryFields({ title: 'T', keys: ['k'], content: 'c' }, 2);
    assert.deepEqual(f, { key: ['k'], comment: 'T', content: 'c', order: 102 });
});

test('estimateTokens is monotonic and nonzero for text', () => {
    assert.equal(estimateTokens(''), 0);
    assert.ok(estimateTokens('สวัสดีครับ') > 0);
    assert.ok(estimateTokens('a'.repeat(400)) >= 100);
});

test('prompt builders mask macros, never leak live {{user}} and request the right blocks', () => {
    const w = buildWeavePrompt({
        lang: 'th', name: 'Kai', notes: 'เป็นหมอ ชอบ {{char}}', sections: { core: 'x {{user}}' },
        charCard: { name: 'Iris', text: '{{char}} is cold to {{user}}' }, styleNotes: 'median 40',
    });
    for (const s of [w.systemPrompt, w.prompt]) assert.ok(!/\{\{\s*(user|char)\s*\}\}/i.test(s), 'live macro leaked');
    assert.ok(w.prompt.includes('<<TENSION>>') && w.prompt.includes('<<RULES>>'));
    assert.ok(w.systemPrompt.includes('Thai'));

    const one = buildWeavePrompt({ keys: ['voice'], lang: 'en', name: 'Kai', notes: '', sections: {} });
    assert.ok(one.prompt.includes('Write ONLY these blocks'));
    assert.ok(one.prompt.includes('<<VOICE>>') && !one.prompt.includes('<<TENSION>>'));

    const m = buildMinePrompt({ lang: 'en', name: 'Kai', transcript: 'Kai: hi {{char}}', stats: { count: 1, medianChars: 2, avgChars: 2, shortPct: 100, questionPct: 0, exclaimPct: 0, ellipsisPct: 0, quotedSpeechPct: 0, actionMarkupPct: 0 } });
    assert.ok(!/\{\{/.test(m.prompt) && m.prompt.includes('<<SAMPLES>>') && m.prompt.includes('median 2'));

    const e = buildEvolvePrompt({ lang: 'en', name: 'Kai', sections: { core: 'c' }, transcript: 'x' });
    assert.ok(e.prompt.includes('<<SUMMARY>>'));

    const l = buildLorePrompt({ lang: 'en', name: 'Kai', notes: 'n', sections: { core: 'c' } });
    assert.ok(l.prompt.includes('@@ENTRY'));
});

test('sizes: lean is the default, budgets grow, unknown falls back to lean', () => {
    assert.equal(sizeKey('nope'), 'lean');
    assert.equal(sizeKey(undefined), 'lean');
    assert.equal(sizeKey('rich'), 'rich');
    assert.ok(SIZES.lean.tokens < SIZES.standard.tokens && SIZES.standard.tokens < SIZES.rich.tokens);
    for (const k of ['tension', 'samples', 'asymmetry', 'rules']) {
        assert.ok(SIZES.lean.lines[k] <= SIZES.standard.lines[k] && SIZES.standard.lines[k] <= SIZES.rich.lines[k], k);
    }
    assert.equal(sizeSpec('x'), SIZES.lean);
});

test('capLines / fitLayer enforce the line caps on model output', () => {
    assert.equal(capLines('a\n\n b\nc\nd', 2), 'a\n b');
    assert.equal(capLines('a\nb', 0), 'a\nb');
    const six = ['(angry) a', '(affectionate) b', '(lying) c', '(casual) d', '(embarrassed) e', 'extra'].join('\n');
    assert.equal(fitLayer('samples', six, 'lean').split('\n').length, SIZES.lean.lines.samples);
    assert.equal(fitLayer('samples', six, 'rich').split('\n').length, SIZES.rich.lines.samples);
    assert.equal(fitLayer('core', '  one\n\ntwo  ', 'lean'), 'one\n\ntwo', 'prose layers are not cut by lines');
});

test('newerVersion compares numerically, not as text', () => {
    assert.equal(newerVersion('0.10.0', '0.9.9'), true);
    assert.equal(newerVersion('0.2.0', '0.2.0'), false);
    assert.equal(newerVersion('0.2', '0.2.1'), false);
    assert.equal(newerVersion('1.0.0', '0.99.99'), true);
    assert.equal(newerVersion('', '0.1.0'), false);
});

test('prompts carry the size budget and the right line counts', () => {
    for (const size of Object.keys(SIZES)) {
        const spec = blockSpecs(size);
        assert.ok(spec.samples.includes(`exactly ${SIZES[size].lines.samples} lines`), size);
        assert.ok(spec.rules.includes(`exactly ${SIZES[size].lines.rules}`), size);
        const w = buildWeavePrompt({ lang: 'en', size, name: 'Kai', notes: 'n', sections: {} });
        assert.ok(w.prompt.includes(`under about ${SIZES[size].tokens} tokens`), size);
    }
    const lean = blockSpecs('lean').samples;
    assert.ok(lean.includes('(angry)') && !lean.includes('(embarrassed)'), 'lean asks for fewer moods');
    const m = buildMinePrompt({ lang: 'en', size: 'lean', name: 'K', transcript: 't', stats: { count: 3, medianChars: 1, avgChars: 1, shortPct: 0, questionPct: 0, exclaimPct: 0, ellipsisPct: 0, quotedSpeechPct: 0, actionMarkupPct: 0 } });
    assert.ok(m.prompt.includes(`exactly ${SIZES.lean.lines.samples} lines`));
});

test('condense prompt asks only for the filled blocks and masks macros', () => {
    const c = buildCondensePrompt({ lang: 'th', size: 'lean', name: 'Kai', sections: { core: 'หมอ {{user}}', samples: '(angry) พอ', voice: '' } });
    assert.deepEqual(c.keys, ['core', 'samples']);
    assert.ok(c.prompt.includes('<<CORE>>') && c.prompt.includes('<<SAMPLES>>') && !c.prompt.includes('<<VOICE>>'));
    assert.ok(!/\{\{\s*(user|char)\s*\}\}/i.test(c.prompt));
    assert.ok(c.prompt.includes(`${SIZES.lean.tokens} tokens`));
});

test('manifest and index.js agree on the version', async () => {
    const { readFile } = await import('node:fs/promises');
    const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
    const index = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    const m = index.match(/const VERSION = '([^']+)'/);
    assert.ok(m, 'VERSION constant missing');
    assert.equal(m[1], manifest.version);
    const files = index.match(/const FILES = \[([^\]]+)\]/)[1];
    for (const f of ['index.js', 'api.js', 'core.js', 'prompts.js', 'i18n.js', 'style.css', 'manifest.json']) {
        assert.ok(files.includes(`'${f}'`), `${f} missing from FILES`);
    }
});

test('parseIdeas reads @@IDEA blocks, tolerates a missing bar and drops empty ones', () => {
    const raw = 'Here:\n@@IDEA | The debtor\nOwes {{char}} money.\nHides it.\n@@IDEA Rival squire\nWants the same post.\n@@IDEA | Empty\n';
    const ideas = parseIdeas(raw);
    assert.equal(ideas.length, 2);
    assert.deepEqual(ideas[0], { kind: 'fit', title: 'The debtor', text: 'Owes {{char}} money.\nHides it.' });
    assert.equal(ideas[1].title, 'Rival squire');
    assert.equal(parseIdeas('no ideas here').length, 0);
});

test('fresh start: the opening scene is sent, empty notes ask the model to invent a fitting persona', () => {
    const card = { name: 'Iris', text: '{{char}} is a knight.', greeting: '{{char}} drags {{user}} out of the river.' };
    const w = buildWeavePrompt({ lang: 'en', size: 'lean', name: 'Kai', notes: '', sections: {}, charCard: card });
    assert.ok(w.prompt.includes('OPENING SCENE') && w.prompt.includes('[[char]] drags [[user]] out of the river.'));
    assert.ok(w.prompt.includes('Invent [[user]] to fit [[char]]'));
    assert.ok(!/\{\{\s*(user|char)\s*\}\}/i.test(w.prompt));
    const withNotes = buildWeavePrompt({ lang: 'en', name: 'Kai', notes: 'a thief', sections: {}, charCard: card });
    assert.ok(withNotes.prompt.includes('a thief') && !withNotes.prompt.includes('Invent [[user]]'));
    const noCard = buildWeavePrompt({ lang: 'en', name: 'Kai', notes: '', sections: {} });
    assert.ok(noCard.prompt.includes('(none)') && !noCard.prompt.includes('OPENING SCENE'));
    const greetingOnly = buildWeavePrompt({ lang: 'en', name: 'Kai', notes: '', sections: {}, charCard: { name: 'X', text: '', greeting: 'hi' } });
    assert.ok(greetingOnly.prompt.includes('OPENING SCENE') && !greetingOnly.prompt.includes('OTHER CHARACTER'));

    const ideas = buildIdeasPrompt({ lang: 'th', notes: 'เป็นหมอ', charCard: card });
    assert.ok(ideas.prompt.includes('@@IDEA') && ideas.prompt.includes('exactly 6') && ideas.prompt.includes('เป็นหมอ'));
    assert.ok(!/\{\{\s*(user|char)\s*\}\}/i.test(ideas.prompt));
});

test('parseIdeas reads fit/wild kinds and keeps titles that contain a bar', () => {
    const raw = '@@IDEA | wild | The drowned girl\nShe died last spring.\n@@IDEA | FIT | Squire\nWants the post.\n@@IDEA | Cat | Dog\nNot a kind tag.';
    const ideas = parseIdeas(raw);
    assert.deepEqual(ideas.map(i => i.kind), ['wild', 'fit', 'fit']);
    assert.equal(ideas[0].title, 'The drowned girl');
    assert.equal(ideas[2].title, 'Cat | Dog');
});

test('ideaSplit and mergeIdeas: mixes add up, new batches skip repeated titles', () => {
    assert.deepEqual(ideaSplit('mix'), { fit: 3, wild: 3 });
    assert.deepEqual(ideaSplit('fit'), { fit: 6, wild: 0 });
    assert.deepEqual(ideaSplit('wild'), { fit: 0, wild: 6 });
    const a = [{ title: 'One', kind: 'fit', text: 'x' }];
    const merged = mergeIdeas(a, [{ title: ' one ', kind: 'wild', text: 'y' }, { title: 'Two', kind: 'wild', text: 'z' }]);
    assert.deepEqual(merged.map(i => i.title), ['One', 'Two']);
    const many = Array.from({ length: 30 }, (_, i) => ({ title: `T${i}`, kind: 'fit', text: 't' }));
    assert.equal(mergeIdeas([], many).length, 24);
});

test('ideas prompt: wild-only asks only for wild ideas, avoid list is passed and masked', () => {
    const card = { name: 'Iris', text: 'knight', greeting: 'hi' };
    const wild = buildIdeasPrompt({ lang: 'en', charCard: card, mix: 'wild', avoid: ['Ghost of {{char}}'] });
    assert.ok(wild.prompt.includes('6 WILD ideas') && !wild.prompt.includes('FIT idea'));
    assert.ok(wild.prompt.includes('ALREADY SUGGESTED') && wild.prompt.includes('Ghost of [[char]]'));
    assert.equal(wild.count, 6);
    const fit = buildIdeasPrompt({ lang: 'en', charCard: card, mix: 'fit' });
    assert.ok(fit.prompt.includes('6 FIT ideas') && !fit.prompt.includes('WILD idea'));
});

test('appearance layer: own label, spec sized per persona size, round-trips through the text', () => {
    assert.equal(SECTION_KEYS[1], 'look');
    assert.equal(LABELS.th.look, 'รูปลักษณ์');
    for (const size of Object.keys(SIZES)) {
        assert.ok(blockSpecs(size).look.includes(`at most ${SIZES[size].lookWords} words`), size);
    }
    const w = buildWeavePrompt({ lang: 'en', name: 'K', notes: 'n', sections: {} });
    assert.ok(w.prompt.includes('<<LOOK>>'));
    for (const lang of ['th', 'en']) {
        const back = parsePersona(assemblePersona({ core: 'c', look: 'tall, scar on the lip' }, lang));
        assert.equal(back.look, 'tall, scar on the lip');
        assert.equal(back.core, 'c');
    }
    const e = buildEvolvePrompt({ lang: 'en', name: 'K', sections: { core: 'c' }, transcript: 'x' });
    assert.ok(e.prompt.includes('LOOK'));
});
