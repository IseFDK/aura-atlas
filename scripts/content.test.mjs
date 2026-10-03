import * as glyphs from '../src/glyphs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as logic from '../src/logic.mjs';
import * as view from '../src/view.mjs';
import * as content from '../src/content.mjs';

const project = path.resolve(new URL('../', import.meta.url).pathname);
const docs = path.join(project, 'docs');
const read = file => fs.readFileSync(file, 'utf8');
const pokemon = JSON.parse(read(path.join(project, 'data/pokemon.json')));
const types = JSON.parse(read(path.join(project, 'data/types.json')));
const chart = Object.fromEntries(types.map(t => [t.name, Object.fromEntries(types.map(d => [d.name,
  t.damageRelations.noDamageTo.includes(d.name) ? 0 : t.damageRelations.halfDamageTo.includes(d.name) ? .5 : t.damageRelations.doubleDamageTo.includes(d.name) ? 2 : 1]))]));
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const htmlFiles = walk(docs).filter(f => f.endsWith('.html'));
const publicPages = htmlFiles.filter(f => !['404.html', 'qa.html'].includes(path.basename(f)));
const base = 'https://isefdk.github.io/aura-atlas/';
const attr = (tag, name) => tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];
const tags = html => [...html.matchAll(/<[a-z][^>]*>/gi)].map(m => m[0]);
const ids = html => new Set(tags(html).map(t => attr(t, 'id')).filter(Boolean));
const text = html => html.replace(/<[^>]*>/g, '').trim();

test('32 canonical public pages plus 404 and isolated viewport QA are built', () => {
  assert.equal(publicPages.length, 32);
  assert.equal(htmlFiles.length, 34);
  assert.equal(JSON.parse(read(path.join(docs, 'build.json'))).pages, 32);
  assert.equal(publicPages.filter(f => f.includes(`${path.sep}species${path.sep}`)).length, 24);
  assert.equal(publicPages.filter(f => f.includes(`${path.sep}notes${path.sep}`)).length, 3);
  const sitemap = [...read(path.join(docs, 'sitemap.xml')).matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);
  assert.equal(sitemap.length, 32);
  assert.equal(new Set(sitemap).size, 32);
  assert.ok(!sitemap.some(u => /(?:qa|404)\.html/.test(u)));
  assert.match(read(path.join(docs, 'robots.txt')), /Disallow: \/qa\.html/);
});

test('every generated local HTML route, asset and fragment reference resolves under the hosting base', () => {
  const broken = [];
  for (const file of htmlFiles) {
    const relative = path.relative(docs, file).split(path.sep).join('/');
    for (const tag of tags(read(file))) {
      for (const name of ['href', 'src']) {
        const value = attr(tag, name);
        if (!value || /^(data:|mailto:|tel:|javascript:)/i.test(value)) continue;
        const url = new URL(value.replaceAll('&amp;', '&'), base + relative);
        if (url.origin !== new URL(base).origin) continue;
        if (!url.pathname.startsWith('/aura-atlas/')) {
          broken.push(`${relative}: escapes hosting base: ${value}`);
          continue;
        }
        let target = path.join(docs, decodeURIComponent(url.pathname.slice('/aura-atlas/'.length)));
        if (url.pathname.endsWith('/')) target = path.join(target, 'index.html');
        if (!fs.existsSync(target)) broken.push(`${relative}: missing ${value}`);
        else if (url.hash && target.endsWith('.html') && !ids(read(target)).has(decodeURIComponent(url.hash.slice(1)))) broken.push(`${relative}: missing fragment ${value}`);
      }
    }
  }
  assert.deepEqual(broken, []);
});

test('all stylesheet/font and ES-module imports resolve locally without runtime APIs', () => {
  for (const file of walk(path.join(docs, 'assets'))) {
    if (file.endsWith('.css')) {
      for (const match of read(file).matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)) {
        assert.ok(fs.existsSync(path.resolve(path.dirname(file), match[1])), `${file}: ${match[1]}`);
      }
    } else if (file.endsWith('.mjs')) {
      const source = read(file);
      assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/, `${file}: runtime must remain local`);
      for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
        assert.ok(match[1].startsWith('./'), `nonlocal runtime import ${match[1]}`);
        assert.ok(fs.existsSync(path.resolve(path.dirname(file), match[1].split('?')[0])), `${file}: ${match[1]}`);
      }
    }
  }
});

test('generated runtime modules and data match the current source revision', () => {
  const files = ['style.css', 'app.mjs', 'logic.mjs', 'view.mjs', 'content.mjs', 'scanner.mjs','glyphs.mjs'];
  const version = crypto.createHash('sha256').update(files.map(file => read(path.join(project, 'src', file))).join('\0') + JSON.stringify(pokemon) + JSON.stringify(types)).digest('hex').slice(0, 12);
  assert.equal(JSON.parse(read(path.join(docs, 'build.json'))).version, version);
  for (const file of files) {
    let expected = read(path.join(project, 'src', file));
    if (file.endsWith('.mjs')) expected = expected.replace(/from '\.\/(logic|view|content|scanner|data|glyphs)\.mjs'/g, (_, name) => `from './${name}.mjs?v=${version}'`);
    assert.equal(read(path.join(docs, 'assets', file)), expected, `${file}: rebuild before deployment`);
  }
  assert.equal(read(path.join(docs, 'assets/data.mjs')), `export const pokemon=${JSON.stringify(pokemon)};\nexport const chart=${JSON.stringify(chart)};\n`);
});

test('all valid URL generations have a visible option, including generations with zero roster matches', () => {
  const select = read(path.join(docs, 'dex.html')).match(/<select id="dex-generation"[^>]*>(.*?)<\/select>/s)[1];
  const options = [...select.matchAll(/value="([^"]*)"/g)].map(m => m[1]);
  for (let generation = 1; generation <= 9; generation++) assert.ok(options.includes(logic.parseFilters(`?generation=${generation}`).generation), `generation ${generation}`);
  const h = appHarness('dex', {}, { query: '?generation=5' });
  assert.equal(h.get('#dex-generation').value, '5');
  assert.match(h.get('#dex-count').textContent, /Найдено: 0 из 24/);
});

test('every public page has landmarks, skip target, unique IDs and a single named heading', () => {
  for (const file of publicPages) {
    const html = read(file), relative = path.relative(docs, file);
    assert.match(html, /<html lang="ru">/, relative);
    assert.match(html, /<main id="main">/, relative);
    assert.match(html, /class="skip" href="#main"/, relative);
    const heading = [...html.matchAll(/<h1\b[^>]*>(.*?)<\/h1>/gs)];
    assert.equal(heading.length, 1, `${relative}: exactly one h1`);
    assert.ok(text(heading[0][1]), `${relative}: named h1`);
    const allIds = tags(html).map(t => attr(t, 'id')).filter(Boolean);
    assert.equal(allIds.length, new Set(allIds).size, `${relative}: duplicate IDs`);
    assert.match(html, /<nav[^>]*aria-label="Главная навигация"/, relative);
    assert.match(html, /class="toast" role="status" aria-live="polite"/, relative);
    assert.equal(tags(html).filter(t => attr(t, 'aria-current') === 'page').length, relative === 'index.html' ? 0 : 1, relative);
  }
});

test('every image and input has an accessible label; new-tab links use noopener', () => {
  for (const file of publicPages) {
    const html = read(file), relative = path.relative(docs, file);
    for (const tag of tags(html)) {
      if (/^<img\b/.test(tag)) assert.notEqual(attr(tag, 'alt'), undefined, `${relative}: unlabeled image`);
      if (/^<(?:input|textarea|select)\b/.test(tag)) {
        const id = attr(tag, 'id');
        const explicit = id && html.includes(`<label for="${id}"`);
        const implicit = [...html.matchAll(/<label\b[^>]*>(.*?)<\/label>/gs)].some(m => m[1].includes(tag));
        assert.ok(explicit || implicit || attr(tag, 'aria-label'), `${relative}: unlabeled control ${id}`);
      }
      if (attr(tag, 'target') === '_blank') assert.ok(attr(tag, 'rel')?.split(/\s+/).includes('noopener'), `${relative}: unsafe new tab`);
    }
  }
});

test('all 24 species pages expose exact six base stats, total, types and complete parent-aware evolution', () => {
  for (const p of pokemon) {
    const html = read(path.join(docs, `species/${p.name}.html`));
    assert.match(html, new RegExp(`data-species="${p.id}"`));
    for (const [name, value] of Object.entries(p.stats)) assert.ok(html.includes(`aria-label="${logic.STAT_RU[name]}: ${value} из 255"`), `${p.name}: ${name}`);
    assert.ok(html.includes(`<strong>${logic.statTotal(p)}</strong>`), `${p.name}: total`);
    for (const type of p.types) assert.ok(html.includes(view.badges([type])), `${p.name}: type`);
    const stages = [...html.matchAll(/<div class="evolution-stage[^>]*>(.*?)<\/div>/gs)].map(m => m[1]);
    assert.equal(stages.length, p.evolution.length, p.name);
    for (let index = 0; index < p.evolution.length; index++) {
      const stage = p.evolution[index], parent = p.evolution.find(x => x.id === stage.parentId);
      assert.ok(stages[index].includes(`№ ${view.number(stage.id)}`), `${p.name}: stage order`);
      assert.ok(stages[index].includes(logic.escapeHTML(stage.requirementRu)), `${p.name}: ${stage.name} condition`);
      if (parent) assert.ok(stages[index].includes(`ИЗ ${logic.escapeHTML(parent.nameRu)}`), `${p.name}: ${stage.name} parent`);
      const local = pokemon.find(x => x.id === stage.id);
      if (stage.id !== p.id) assert.ok(stages[index].includes(`href="${local ? `./${local.name}.html` : stage.speciesUrl}"`), `${p.name}: ${stage.name} destination`);
    }
    assert.match(html, /Без влияния способностей, предметов, погоды/);
    assert.match(html, /Альтернативы по играм и формам/);
  }
});

test('all three editorial notes are real, contain verified numeric callouts and local next-note links', () => {
  for (const [index, note] of content.NOTES.entries()) {
    const html = read(path.join(docs, `notes/${note.id}.html`));
    assert.ok(html.includes(`data-save-note="${note.id}" aria-pressed="false"`));
    assert.ok(html.includes(note.title));
    assert.ok(html.includes(note.exercise));
    assert.ok(html.includes(`href="${content.NOTES[(index + 1) % 3].id}.html"`));
    assert.match(html, /художественный вымысел фан-проекта/);
  }
  assert.match(read(path.join(docs, 'notes/before-the-leap.html')), /скорость 122, сумма базовых характеристик 530/);
  assert.match(read(path.join(docs, 'notes/wings-after-dark.html')), /уровень 48/);
  assert.match(read(path.join(docs, 'notes/wings-after-dark.html')), /Noivern ×4/);
});

test('public provenance and generated hero art are accurately disclosed', () => {
  const html = read(path.join(docs, 'about.html'));
  assert.match(html, /Это не официальная иллюстрация Pokémon/);
  assert.match(html, /оригинальный фан-арт/);
  assert.match(html, /неофициальный некоммерческий фан-проект/);
  for (const name of ['pokemon.json', 'types.json', 'provenance.json', 'hero-greninja-provenance.json']) assert.doesNotThrow(() => JSON.parse(read(path.join(docs, 'data', name))));
});

test('a clean build is deterministic byte-for-byte, including versioned modules and all public assets', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-atlas-content-'));
  try {
    for (const name of ['src', 'scripts', 'data', 'public', 'artwork']) fs.cpSync(path.join(project, name), path.join(tmp, name), { recursive: true });
    const run = () => {
      execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: tmp, stdio: 'pipe' });
      return Object.fromEntries(walk(path.join(tmp, 'docs')).sort().map(file => [path.relative(path.join(tmp, 'docs'), file), crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
    };
    const first = run(), second = run();
    assert.deepEqual(second, first);
    assert.ok(Object.keys(first).length > 50);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// Lightweight DOM doubles exercise actual application event code without a browser,
// network, dependency installation or modifications to generated production pages.
class Element {
  constructor({ value = '', dataset = {}, options = null } = {}) { this.dataset = dataset; this.options = options; this.value = value; this.listeners = {}; this.attributes = {}; this.textContent = ''; this.innerHTML = ''; this.classList = { contains: () => false, add() {}, remove() {}, toggle() {} }; this.hidden = false; this.disabled = false; }
  set value(v) { this._value = this.options && !this.options.includes(String(v)) ? '' : String(v); }
  get value() { return this._value; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k]; }
  addEventListener(k, fn) { (this.listeners[k] ??= []).push(fn); }
  emit(k, ev = {}) { for (const fn of this.listeners[k] ?? []) fn({ preventDefault() {}, ...ev }); this[`on${k}`]?.(ev); }
  focus() { this.focused = true; }
  querySelector() { return this.button ??= new Element(); }
  querySelectorAll() { return []; }
  append() {}
  click() { this.emit('click'); }
  remove() {}
}
function appHarness(page, stored = {}, { blocked = false, query = '' } = {}) {
  const elements = new Map(), listeners = {}, globalListeners = {}, pending = new Map(), downloads = [];
  const saveButtons = content.NOTES.map(n => new Element({ dataset: { saveNote: n.id } }));
  const indicators = content.NOTES.map(n => new Element({ dataset: { savedIndicator: n.id } }));
  const habitats = ['water', 'mountain', 'forest'].map(mode => new Element({ dataset: { habitat: mode } }));
  const html = read(path.join(docs, 'dex.html'));
  const selectOptions = id => [...html.match(new RegExp(`<select id="${id}"[^>]*>(.*?)</select>`, 's'))[1].matchAll(/value="([^"]*)"/g)].map(m => m[1]);
  const get = selector => {
    if (selector === '[data-scanner]' || selector === '.menu-toggle') return null;
    if (!elements.has(selector)) elements.set(selector, new Element(selector === '#dex-type' || selector === '#dex-generation' || selector === '#dex-sort' ? { options: selectOptions(selector.slice(1)), value: selector === '#dex-sort' ? 'id' : 'all' } : { value: selector === '#picker-type' ? 'all' : '' }));
    return elements.get(selector);
  };
  const document = {
    body: { dataset: { page, root: '' }, classList: { remove() {}, toggle() {} }, append() {} },
    querySelector: get,
    querySelectorAll(selector) { return selector === '[data-save-note]' ? saveButtons : selector === '[data-saved-indicator]' ? indicators : selector === '[data-habitat]' ? habitats : []; },
    addEventListener(k, fn) { (listeners[k] ??= []).push(fn); },
    createElement() { const a = new Element(); a.click = () => downloads.push({ name: a.download, href: a.href }); return a; },
  };
  const location = { pathname: `/${page}.html`, search: query, hash: '' };
  const entries = [];
  const history = Object.fromEntries(['pushState', 'replaceState'].map(kind => [kind, (_, __, url) => { entries.push({ kind, url }); const u = new URL(url, 'https://local.test'); Object.assign(location, { pathname: u.pathname, search: u.search, hash: u.hash }); }]));
  const localStorage = { getItem(k) { if (blocked) throw Error('disabled storage'); return stored[k] ?? null; }, setItem(k, v) { if (blocked) throw Error('disabled storage'); stored[k] = v; } };
  const blobs = [];
  const environment = { document, localStorage, location, history, addEventListener(k, fn) { (globalListeners[k] ??= []).push(fn); }, setTimeout(fn) { const id = Symbol(); pending.set(id, fn); return id; }, clearTimeout(id) { pending.delete(id); }, URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:test'; }, revokeObjectURL() {} }, Blob };
  const helpers = { ...glyphs, ...logic, ...view, ...content, pokemon, chart, e: logic.escapeHTML, mountScanner() {} };
  const evaluate = new Function('environment', 'helpers', `const {${Object.keys(environment).join(',')}}=environment;const {${Object.keys(helpers).join(',')}}=helpers;\n${read(path.join(project, 'src/app.mjs')).split('\n').slice(1).join('\n')}`);
  evaluate(environment, helpers);
  return { get, stored, entries, location, saveButtons, indicators, habitats, downloads, blobs,
    flush() { const jobs = [...pending.values()]; pending.clear(); jobs.forEach(fn => fn()); },
    event(k, ev) { (globalListeners[k] ?? []).forEach(fn => fn(ev)); },
    delegated(data, value) { (listeners.click ?? []).forEach(fn => fn({ target: { closest(selector) { return selector === `[${data}]` ? { dataset: { [data.slice(5)]: value } } : null; } } })); },
  };
}

const TEAM = 'aura-atlas-team-v1', SAVED = 'aura-atlas-notes-v1', NOTE = 'aura-atlas-field-note-v1';
test('actual team handlers sanitize storage, deduplicate, enforce six, remove, reset and export valid JSON', async () => {
  const h = appHarness('team', { [TEAM]: '[658,658,"448",999999,true]' });
  assert.equal(h.get('#team-length').textContent, '2 / 6');
  h.delegated('data-add', '658');
  assert.equal(h.get('#team-length').textContent, '2 / 6');
  for (const id of [715, 151, 445, 700, 25]) h.delegated('data-add', String(id));
  assert.deepEqual(JSON.parse(h.stored[TEAM]), [658, 448, 715, 151, 445, 700]);
  assert.match(h.get('.toast').textContent, /Все шесть мест заняты/);
  h.delegated('data-remove', '448');
  assert.equal(h.get('#team-length').textContent, '5 / 6');
  h.get('#team-export').emit('click');
  assert.equal(h.downloads[0].name, 'aura-atlas-team.json');
  const exported = JSON.parse(await h.blobs[0].text());
  assert.deepEqual(exported.team.map(p => p.id), [658, 715, 151, 445, 700]);
  assert.ok(exported.team.every(p => p.name && p.nameRu && p.types.length));
  h.get('#team-clear').emit('click');
  assert.deepEqual(JSON.parse(h.stored[TEAM]), []);
  assert.equal(h.get('#team-export').disabled, true);
  assert.equal(h.get('#team-clear').disabled, true);
  assert.equal(h.get('#team-empty').hidden, false);
});

test('actual team example, picker empty reset and cross-tab events continue to work after rerender', () => {
  const h = appHarness('team');
  h.get('#team-example').emit('click');
  assert.deepEqual(JSON.parse(h.stored[TEAM]), [658, 448, 715, 151]);
  h.get('#picker-q').value = 'no such pokemon'; h.get('#picker-q').emit('input');
  assert.match(h.get('#team-picker-grid').innerHTML, /data-empty-reset/);
  h.get('#team-picker-grid').emit('click', { target: { closest: () => true } });
  assert.equal(h.get('#picker-q').value, '');
  assert.match(h.get('#picker-count').textContent, /24/);
  h.event('storage', { key: TEAM, newValue: '[25,25,"1",null,99999]' });
  assert.equal(h.get('#team-length').textContent, '2 / 6');
  assert.match(h.get('#team-slots').innerHTML, /Пикачу/);
  h.event('storage', { key: TEAM, newValue: '{invalid' });
  assert.equal(h.get('#team-length').textContent, '0 / 6');
});

test('blocked localStorage keeps in-memory team functional and displays an honest persistence warning', () => {
  const h = appHarness('team', {}, { blocked: true });
  h.delegated('data-add', '658');
  assert.equal(h.get('#team-length').textContent, '1 / 6');
  assert.match(h.get('#storage-status').textContent, /Браузер запретил сохранение/);
  assert.equal(h.stored[TEAM], undefined);
});

test('actual dex listeners debounce search, preserve filter history, restore popstate and reset empty results', () => {
  const h = appHarness('dex', {}, { query: '?q=Noivern&type=dragon&sort=speed' });
  assert.equal(h.get('#dex-q').value, 'Noivern');
  assert.match(h.get('#dex-count').textContent, /Найдено: 1 из 24/);
  h.get('#dex-q').value = 'Ной'; h.get('#dex-q').emit('input'); h.flush();
  assert.equal(h.entries.at(-1).kind, 'pushState');
  h.get('#dex-q').value = 'Нойбат'; h.get('#dex-q').emit('input'); h.flush();
  assert.equal(h.entries.at(-1).kind, 'replaceState');
  h.location.search = '?type=fire'; h.event('popstate', {});
  assert.equal(h.get('#dex-q').value, '');
  assert.equal(h.get('#dex-type').value, 'fire');
  assert.match(h.get('#dex-count').textContent, /Найдено: 2 из 24/);
  h.get('#dex-q').value = 'missing'; h.get('#dex-q').emit('input'); h.flush();
  assert.match(h.get('#dex-grid').innerHTML, /data-empty-reset/);
  h.get('#dex-grid').emit('click', { target: { closest: () => true } });
  assert.equal(h.location.search, '');
  assert.match(h.get('#dex-count').textContent, /Найдено: 24 из 24/);
});

test('actual saved-note toggle rejects corrupt records, updates indicators and synchronizes cross-tab state', () => {
  const h = appHarness('home', { [SAVED]: '["before-the-leap","unknown",false]' });
  assert.equal(h.saveButtons[0].getAttribute('aria-pressed'), 'true');
  assert.equal(h.indicators[0].hidden, false);
  h.saveButtons[0].emit('click');
  assert.deepEqual(JSON.parse(h.stored[SAVED]), []);
  h.saveButtons[1].emit('click');
  assert.deepEqual(JSON.parse(h.stored[SAVED]), ['wings-after-dark']);
  h.event('storage', { key: SAVED, newValue: '["aura-as-a-compass"]' });
  assert.equal(h.saveButtons[1].getAttribute('aria-pressed'), 'false');
  assert.equal(h.saveButtons[2].getAttribute('aria-pressed'), 'true');
});

test('actual notebook enforces initial length, saves input/blur, exports Unicode TXT and rejects empty downloads', async () => {
  const h = appHarness('expeditions', { [NOTE]: 'я'.repeat(5500) });
  assert.equal(h.get('#field-note').value.length, 5000);
  h.get('#field-note').value = 'Нойверн у перевала 🦇'; h.get('#field-note').emit('input'); h.flush();
  assert.equal(h.stored[NOTE], 'Нойверн у перевала 🦇');
  h.get('#field-note').value = 'Другой след'; h.get('#field-note').emit('blur');
  assert.equal(h.stored[NOTE], 'Другой след');
  h.get('#note-download').emit('click');
  assert.equal(h.downloads[0].name, 'aura-atlas-field-note.txt');
  assert.equal(await h.blobs[0].text(), 'Другой след');
  h.get('#field-note').value = '   '; h.get('#note-download').emit('click');
  assert.equal(h.downloads.length, 1);
  assert.match(h.get('.toast').textContent, /Сначала добавь запись/);
});

test('actual route collection add preserves duplicates and six-place limit across repeated clicks', () => {
  const h = appHarness('expeditions', { [TEAM]: '[658,448,715,151,445]' });
  h.get('#planner-results').querySelector('button').emit('click');
  assert.deepEqual(JSON.parse(h.stored[TEAM]), [658, 448, 715, 151, 445, 350]);
  h.get('#planner-results').querySelector('button').emit('click');
  assert.equal(JSON.parse(h.stored[TEAM]).length, 6);
  h.habitats[2].emit('click');
  assert.equal(h.habitats[2].getAttribute('aria-pressed'), 'true');
  assert.equal(h.habitats[0].getAttribute('aria-pressed'), 'false');
  assert.match(h.get('#planner-results').innerHTML, /Лесной маршрут/);
});

function scannerHarness({ reduced = false, unavailable = false, throws = false, shaderFails = false, programFails = false } = {}) {
  const uniforms = new Map(), frames = new Map(), media = { matches: reduced, listeners: {}, addEventListener(k, fn) { this.listeners[k] = fn; } };
  const canvas = new Element(), fallback = new Element(), status = new Element();
  const buttons = Object.fromEntries(['pause', 'turn-left', 'turn-right', 'reset-scan'].map(key => [key, new Element()]));
  canvas.width = 0; canvas.height = 0;
  canvas.hidden = true; fallback.hidden = false;
  for (const [key, button] of Object.entries(buttons)) button.disabled = key !== 'pause';
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, ARRAY_BUFFER: 5, STATIC_DRAW: 6, FLOAT: 7, COLOR_BUFFER_BIT: 8, TRIANGLES: 9,
    createShader: () => ({}), shaderSource() {}, compileShader() {}, getShaderParameter: () => !shaderFails,
    createProgram: () => ({}), attachShader() {}, linkProgram() {}, getProgramParameter: () => !programFails, useProgram() {},
    createBuffer: () => ({}), bindBuffer() {}, bufferData() {}, getAttribLocation: () => 0, enableVertexAttribArray() {}, vertexAttribPointer() {},
    getUniformLocation: (_, key) => key, uniform2f: (key, x, y) => uniforms.set(key, [x, y]), uniform1f: (key, value) => uniforms.set(key, value),
    viewport(x, y, w, h) { this.viewportSize = [w, h]; }, clearColor() {}, clear() {}, drawArrays() { this.drawCount = (this.drawCount ?? 0) + 1; },
  };
  canvas.getContext = () => { if (throws) throw Error('context unavailable'); return unavailable ? null : gl; };
  canvas.getBoundingClientRect = () => ({ width: 500, height: 360 });
  const host = new Element();
  host.getBoundingClientRect = () => ({ width: 500, height: 360, top: 0, left: 0 });
  host.querySelector = selector => selector === 'canvas' ? canvas : selector === '.scanner-fallback' ? fallback : selector === '[data-scanner-status]' ? status : buttons[selector.slice(6, -1)];
  host.querySelectorAll = selector => selector === 'button' ? Object.values(buttons) : [buttons['turn-left'], buttons['turn-right'], buttons['reset-scan']];
  let frameId = 0, intersection;
  const document = { hidden: false };
  const source = read(path.join(project, 'src/scanner.mjs')).replace('export function', 'function');
  const mount = new Function('document', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame', 'IntersectionObserver', 'devicePixelRatio', `${source};return mountScanner;`)(
    document, () => media, fn => { const id = ++frameId; frames.set(id, fn); return id; }, id => frames.delete(id),
    class { constructor(fn) { intersection = fn; } observe() {} }, 3,
  );
  mount(host);
  return { host, canvas, fallback, status, buttons, uniforms, gl, frames, media, document,
    draw(time) { const [id, fn] = frames.entries().next().value; frames.delete(id); fn(time); },
    visible(value) { intersection([{ isIntersecting: value }]); },
    setReduced(value) { media.matches = value; media.listeners.change?.(); },
  };
}

test('scanner falls back gracefully when WebGL is absent or context creation throws', () => {
  for (const config of [{ unavailable: true }, { throws: true }]) {
    const h = scannerHarness(config);
    assert.equal(h.canvas.hidden, true);
    assert.equal(h.fallback.hidden, false);
    assert.equal(h.buttons.pause.disabled, true);
    assert.ok(Object.values(h.buttons).every(button => button.disabled));
    assert.equal(h.frames.size, 0);
    assert.match(h.status.textContent, /БЕЗ WEBGL/);
  }
});

test('scanner shader or link failure provides a static illustration and disables all controls', () => {
  for (const config of [{ shaderFails: true }, { programFails: true }]) {
    const h = scannerHarness(config);
    assert.equal(h.canvas.hidden, true);
    assert.equal(h.fallback.hidden, false);
    assert.ok(Object.values(h.buttons).every(button => button.disabled));
    assert.equal(h.frames.size, 0);
  }
});

test('scanner respects reduced motion, caps DPR, provides deterministic manual turn and reset controls', () => {
  const h = scannerHarness({ reduced: true });
  assert.equal(h.canvas.hidden, false);
  assert.equal(h.fallback.hidden, true);
  assert.equal(h.buttons.pause.getAttribute('aria-pressed'), 'true');
  assert.equal(h.buttons.pause.textContent, 'Включить вращение');
  h.draw(1000); h.draw(2000);
  assert.deepEqual(h.gl.viewportSize, [1000, 720]);
  assert.equal(h.uniforms.get('time'), 0);
  assert.deepEqual(h.uniforms.get('turn'), [.6, .25]);
  h.buttons['turn-left'].emit('click'); h.draw(3000);
  assert.deepEqual(h.uniforms.get('turn'), [.25, .25]);
  h.buttons['turn-right'].emit('click'); h.draw(4000);
  assert.deepEqual(h.uniforms.get('turn'), [.6, .25]);
  h.host.emit('pointermove', { pointerType: 'mouse', clientY: 360 }); h.draw(5000);
  assert.deepEqual(h.uniforms.get('turn'), [.6, .25], 'hover tilt must be disabled with reduced motion');
  h.buttons['reset-scan'].emit('click'); h.draw(6000);
  assert.deepEqual(h.uniforms.get('turn'), [.6, .25]);
});

test('scanner rotation responds to pause, visibility and a live reduced-motion preference change', () => {
  const h = scannerHarness();
  assert.equal(h.buttons.pause.getAttribute('aria-pressed'), 'false');
  h.draw(1000); h.draw(2000);
  const rotated = h.uniforms.get('turn')[0];
  assert.ok(rotated > .6);
  h.buttons.pause.emit('click'); h.draw(3000);
  assert.equal(h.uniforms.get('turn')[0], rotated);
  assert.equal(h.uniforms.get('time'), 0);
  h.buttons.pause.emit('click'); h.visible(false); h.draw(4000);
  assert.equal(h.uniforms.get('turn')[0], rotated);
  h.visible(true); h.document.hidden = true; h.draw(5000);
  assert.equal(h.uniforms.get('turn')[0], rotated);
  h.document.hidden = false; h.setReduced(true); h.draw(6000);
  assert.equal(h.uniforms.get('turn')[0], rotated);
  assert.equal(h.buttons.pause.getAttribute('aria-pressed'), 'true');
});

test('scanner WebGL context loss cancels its frame loop and shows a fully disabled fallback', () => {
  const h = scannerHarness();
  h.draw(1000);
  let prevented = false;
  h.canvas.emit('webglcontextlost', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(h.frames.size, 0);
  assert.equal(h.canvas.hidden, true);
  assert.equal(h.fallback.hidden, false);
  assert.match(h.status.textContent, /WEBGL НЕДОСТУПЕН/);
  assert.ok(Object.values(h.buttons).every(button => button.disabled));
});

test('search blur does not redraw an already rendered grid and swallow its first card click', () => {
  const h = appHarness('dex'), grid = h.get('#dex-grid');
  let html = grid.innerHTML, writes = 0;
  Object.defineProperty(grid, 'innerHTML', { get() { return html; }, set(value) { writes++; html = value; } });
  h.get('#dex-q').value = 'Greninja';
  h.get('#dex-q').emit('input'); h.flush();
  const renderedWrites = writes;
  assert.match(html, /greninja\.html/);
  h.get('#dex-q').emit('blur');
  assert.equal(writes, renderedWrites, 'blur after debounce must preserve the clicked card DOM');
  h.get('#dex-q').value = 'Mew';
  h.get('#dex-filters').emit('submit', { preventDefault() {} });
  const submittedWrites = writes;
  h.get('#dex-q').emit('blur');
  assert.equal(writes, submittedWrites, 'blur after Enter must preserve the clicked card DOM');
});

test('decorative symbols render as accessible-hidden vector icons rather than missing font glyphs', () => {
  for (const symbol of ['↗','↺','↓','↑','←','→','♡','♥','＋','✓','−']) {
    const icon = glyphs.glyph(symbol);
    assert.match(icon, /<svg.*aria-hidden="true"/);
    assert.match(icon, /<path/);
  }
  for (const page of publicPages) assert.doesNotMatch(read(page), /[↗↺↓↑←→♡♥＋✓−]/, `${page}: unresolved UI symbol`);
  for (const page of publicPages) for (const tag of tags(read(page))) {
    const label = attr(tag, 'aria-label');
    if (label) assert.ok(!label.includes('<svg'), `${page}: no markup inside accessible attributes`);
  }
  assert.doesNotMatch(read(path.join(docs, 'dex.html')), /<option[^>]*>[^<]*<svg/);
});
