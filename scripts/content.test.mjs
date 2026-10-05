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
import { mountScanner } from '../src/scanner.mjs';

const project = path.resolve(new URL('../', import.meta.url).pathname);
const docs = path.join(project, 'docs');
const read = file => fs.readFileSync(file, 'utf8');
const pokemon = JSON.parse(read(path.join(project, 'data/pokemon.json')));
const relatedPokemon = JSON.parse(read(path.join(project, 'data/related-pokemon.json')));
const allPokemon = [...pokemon, ...relatedPokemon].sort((a, b) => a.id - b.id);
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

test('all 47 canonical family species and eight other public pages plus 404 and isolated QA are built', () => {
  assert.equal(pokemon.length, 24, 'curated roster remains intact');
  assert.equal(relatedPokemon.length, 23);
  assert.equal(allPokemon.length, 47);
  assert.equal(publicPages.length, allPokemon.length + 8);
  assert.equal(htmlFiles.length, allPokemon.length + 10);
  assert.equal(JSON.parse(read(path.join(docs, 'build.json'))).pages, allPokemon.length + 8);
  assert.equal(publicPages.filter(f => f.includes(`${path.sep}species${path.sep}`)).length, allPokemon.length);
  assert.equal(publicPages.filter(f => f.includes(`${path.sep}notes${path.sep}`)).length, 3);
  const sitemap = [...read(path.join(docs, 'sitemap.xml')).matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);
  assert.equal(sitemap.length, publicPages.length);
  assert.equal(new Set(sitemap).size, publicPages.length);
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

test('generated versioned runtime modules and data match the current source revision', async () => {
  const manifest = JSON.parse(read(path.join(docs, 'build.json')));
  const version = manifest.version;
  assert.match(version, /^[a-f0-9]{12}$/);
  const inputs = ['style.css', 'app.mjs', 'logic.mjs', 'view.mjs', 'content.mjs', 'scanner.mjs', 'glyphs.mjs'];
  const expectedVersion = crypto.createHash('sha256').update(inputs.map(file => read(path.join(project, 'src', file))).join('\0') + read(path.join(project, 'scripts/build.mjs')) + JSON.stringify(allPokemon) + JSON.stringify(types)).digest('hex').slice(0, 12);
  assert.equal(version, expectedVersion, 'all generated routes, source runtime and combined data participate in the revision');
  const assets = walk(path.join(docs, 'assets'));
  const resolveAsset = name => {
    const matches = assets.filter(file => path.basename(file) === name || path.basename(file) === name.replace(/(\.[^.]+)$/, `.${version}$1`));
    assert.equal(matches.length, 1, `${name}: exactly one current asset`);
    return matches[0];
  };
  for (const file of ['style.css', 'app.mjs', 'logic.mjs', 'view.mjs', 'content.mjs', 'scanner.mjs', 'glyphs.mjs']) {
    let expected = read(path.join(project, 'src', file));
    if (file.endsWith('.mjs')) expected = expected.replace(/from '\.\/(logic|view|content|scanner|data|glyphs)\.mjs'/g, (_, name) => `from './${path.basename(resolveAsset(`${name}.mjs`))}'`);
    assert.equal(read(resolveAsset(file)), expected, `${file}: rebuild before deployment`);
  }
  const generated = await import(`file://${resolveAsset('data.mjs')}?audit=${version}`);
  assert.deepEqual(generated.pokemon, allPokemon);
  assert.deepEqual(generated.featuredPokemon, pokemon);
  assert.deepEqual(generated.chart, chart);
  for (const file of htmlFiles.filter(file => path.basename(file) !== 'qa.html')) {
    const html = read(file);
    for (const name of ['style.css', 'app.mjs']) assert.ok(html.includes(path.basename(resolveAsset(name))), `${path.relative(docs, file)}: uses current ${name}`);
    assert.doesNotMatch(html, /assets\/(?:app\.mjs|style\.css)(?:[?"'])/, 'immutable hashed filenames prevent stale HTML from mixing runtime revisions');
  }
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

test('all 47 species pages expose exact six base stats, total, types and complete local parent-aware evolution', () => {
  for (const p of allPokemon) {
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
      const local = allPokemon.find(x => x.id === stage.id);
      assert.ok(local, `${p.name}: every family stage has local data`);
      if (stage.id !== p.id) assert.ok(stages[index].includes(`href="./${local.name}.html"`), `${p.name}: ${stage.name} local destination`);
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
    assert.match(html, /авторский текст фан-проекта/);
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
  for (const name of ['pokemon.json', 'related-pokemon.json', 'types.json', 'provenance.json', 'hero-greninja-provenance.json']) assert.doesNotThrow(() => JSON.parse(read(path.join(docs, 'data', name))));
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
  constructor({ value = '', dataset = {}, options = null, classes = [] } = {}) {
    this.dataset = dataset; this.options = options; this.value = value; this.listeners = {}; this.attributes = {};
    this.textContent = ''; this.innerHTML = ''; this.hidden = false; this.disabled = false; this.focused = false;
    const names = new Set(classes);
    this.classList = { contains: name => names.has(name), add(...list) { list.forEach(name => names.add(name)); }, remove(...list) { list.forEach(name => names.delete(name)); }, toggle(name, force) { const next = force ?? !names.has(name); if (next) names.add(name); else names.delete(name); return next; } };
  }
  set value(v) { this._value = this.options && !this.options.includes(String(v)) ? '' : String(v); }
  get value() { return this._value; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k]; }
  addEventListener(k, fn) { (this.listeners[k] ??= []).push(fn); }
  emit(k, ev = {}) { const event = { preventDefault() {}, ...ev }; for (const fn of this.listeners[k] ?? []) fn(event); this[`on${k}`]?.(event); }
  focus() { this.focused = true; }
  querySelector(selector) { return this.children?.get(selector) ?? (this.button ??= new Element()); }
  querySelectorAll() { return []; }
  append() {}
  click() { this.emit('click'); }
  remove() {}
}
function appHarness(page, stored = {}, { blocked = false, query = '', hash = '', root = '' } = {}) {
  const elements = new Map(), listeners = {}, globalListeners = {}, pending = new Map(), downloads = [], removedButtons = new Map();
  const saveButtons = content.NOTES.map(n => new Element({ dataset: { saveNote: n.id } }));
  const indicators = content.NOTES.map(n => new Element({ dataset: { savedIndicator: n.id } }));
  const habitats = ['water', 'mountain', 'forest'].map(mode => new Element({ dataset: { habitat: mode } }));
  const navLinks = Array.from({ length: 4 }, () => new Element());
  const addButtons = allPokemon.map(p => new Element({ dataset: { add: String(p.id) }, classes: ['add-member'] }));
  const countIndicators = [new Element(), new Element()];
  const menu = new Element(); menu.setAttribute('aria-expanded', 'false');
  const html = read(path.join(docs, 'dex.html'));
  const selectOptions = id => {
    const select = html.match(new RegExp(`<select id="${id}"[^>]*>(.*?)</select>`, 's'));
    return select ? [...select[1].matchAll(/value="([^\"]*)"/g)].map(m => m[1]) : null;
  };
  const get = selector => {
    if (selector === '[data-scanner]') return null;
    if (selector === '.menu-toggle') return menu;
    if (!elements.has(selector)) {
      const id = selector.slice(1);
      const value = id === 'dex-sort' ? 'id' : id === 'dex-scope' ? 'featured' : ['dex-type', 'dex-generation', 'picker-type'].includes(id) ? 'all' : '';
      elements.set(selector, new Element({ options: selector.startsWith('#dex-') ? selectOptions(id) : null, value }));
    }
    return elements.get(selector);
  };
  const body = new Element({ dataset: { page, root } }); body.append = () => {};
  const document = {
    body, querySelector: get,
    querySelectorAll(selector) {
      if (selector === '[data-save-note]') return saveButtons;
      if (selector === '[data-saved-indicator]') return indicators;
      if (selector === '[data-habitat]') return habitats;
      if (selector === '.site-nav a') return navLinks;
      if (selector === '[data-add]') return addButtons;
      if (selector === '[data-team-count]') return countIndicators;
      if (selector === '[data-remove]') return [...get('#team-slots').innerHTML.matchAll(/data-remove="(\d+)"/g)].map(([, id]) => {
        if (!removedButtons.has(id)) removedButtons.set(id, new Element({ dataset: { remove: id } }));
        return removedButtons.get(id);
      });
      return [];
    },
    addEventListener(k, fn) { (listeners[k] ??= []).push(fn); },
    createElement() { const a = new Element(); a.click = () => downloads.push({ name: a.download, href: a.href }); return a; },
  };
  const location = { pathname: `/${page}.html`, search: query, hash };
  const entries = [], historyStack = [location.pathname + query + hash]; let historyIndex = 0;
  const setURL = url => { const u = new URL(url, 'https://local.test'); Object.assign(location, { pathname: u.pathname, search: u.search, hash: u.hash }); };
  const history = Object.fromEntries(['pushState', 'replaceState'].map(kind => [kind, (_, __, url) => {
    entries.push({ kind, url }); setURL(url);
    if (kind === 'pushState') { historyStack.splice(++historyIndex); historyStack.push(url); } else historyStack[historyIndex] = url;
  }]));
  const localStorage = { getItem(k) { if (blocked) throw Error('disabled storage'); return stored[k] ?? null; }, setItem(k, v) { if (blocked) throw Error('disabled storage'); stored[k] = String(v); } };
  const blobs = [];
  const environment = { document, localStorage, location, history, addEventListener(k, fn) { (globalListeners[k] ??= []).push(fn); }, setTimeout(fn) { const id = Symbol(); pending.set(id, fn); return id; }, clearTimeout(id) { pending.delete(id); }, URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:test'; }, revokeObjectURL() {} }, Blob };
  const helpers = { ...glyphs, ...logic, ...view, ...content, pokemon: allPokemon, featuredPokemon: pokemon, chart, e: logic.escapeHTML, mountScanner() {} };
  const source = read(path.join(project, 'src/app.mjs')).replace(/^(?:\s*import\b[^;]*;)+\s*/, '');
  const evaluate = new Function('environment', 'helpers', `const {${Object.keys(environment).join(',')}}=environment;const {${Object.keys(helpers).join(',')}}=helpers;\n${source}`);
  evaluate(environment, helpers);
  return { get, stored, entries, location, document, saveButtons, indicators, habitats, navLinks, addButtons, countIndicators, menu, body, downloads, blobs, removedButtons,
    flush() { const jobs = [...pending.values()]; pending.clear(); jobs.forEach(fn => fn()); },
    event(k, ev) { (globalListeners[k] ?? []).forEach(fn => fn(ev)); },
    documentEvent(k, ev) { (listeners[k] ?? []).forEach(fn => fn(ev)); },
    go(delta) { historyIndex = Math.max(0, Math.min(historyStack.length - 1, historyIndex + delta)); setURL(historyStack[historyIndex]); (globalListeners.popstate ?? []).forEach(fn => fn({})); },
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
  assert.match(h.get('#picker-count').textContent, /47/);
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

test('detail page kinds remain separate from their active navigation sections', () => {
  for (const p of allPokemon) {
    const html = read(path.join(docs, `species/${p.name}.html`));
    assert.match(html, /<body data-page="species"/);
    assert.match(html, /href="\.\.\/dex\.html" aria-current="page"/);
  }
  for (const n of content.NOTES) {
    const html = read(path.join(docs, `notes/${n.id}.html`));
    assert.match(html, /<body data-page="note"/);
    assert.match(html, /href="\.\.\/expeditions\.html" aria-current="page"/);
  }
});

test('species bootstrap skips absent catalog controls while preserving global team actions', () => {
  const h = appHarness('species', { [TEAM]: '[658]' });
  assert.equal(h.get('#dex-q').listeners.input, undefined);
  h.delegated('data-add', '151');
  assert.deepEqual(JSON.parse(h.stored[TEAM]), [658, 151]);
});

test('article bootstrap skips the planner and notebook while preserving saved-note controls', () => {
  const h = appHarness('note', { [SAVED]: '[]' });
  assert.equal(h.get('#field-note').listeners.input, undefined);
  h.saveButtons[0].emit('click');
  assert.equal(h.saveButtons[0].getAttribute('aria-pressed'), 'true');
  assert.deepEqual(JSON.parse(h.stored[SAVED]), ['before-the-leap']);
});


test('the curated catalog is preserved while every evolution-family species has a discoverable local detail route', () => {
  const familyIds = new Set(pokemon.flatMap(p => p.evolution.map(stage => stage.id)));
  assert.deepEqual(new Set(allPokemon.map(p => p.id)), familyIds);
  assert.equal(new Set(allPokemon.map(p => p.name)).size, 47);
  for (const p of allPokemon) {
    assert.ok(fs.existsSync(path.join(docs, `species/${p.name}.html`)), p.name);
    assert.ok(p.types.length >= 1 && p.types.length <= 2);
    assert.deepEqual(new Set(Object.keys(p.stats)), new Set(Object.keys(logic.STAT_RU)));
    assert.ok(Object.values(p.stats).every(value => Number.isInteger(value) && value > 0 && value <= 255));
    assert.ok(p.evolution.some(stage => stage.id === p.id));
    assert.ok(p.evolution.every(stage => familyIds.has(stage.id)));
  }
  const h = appHarness('dex');
  assert.match(h.get('#dex-count').textContent, /24/);
  const initial = h.get('#dex-grid').innerHTML;
  for (const p of pokemon) assert.ok(initial.includes(`species/${p.name}.html`), `${p.name}: curated route`);
  for (const p of relatedPokemon) assert.ok(!initial.includes(`species/${p.name}.html`), `${p.name}: outside curated default`);
  h.get('#dex-scope').value = 'all'; h.get('#dex-scope').emit('change');
  assert.match(h.get('#dex-count').textContent, /47/);
  for (const p of allPokemon) assert.ok(h.get('#dex-grid').innerHTML.includes(`species/${p.name}.html`), `${p.name}: discoverable in family catalog`);
  h.get('#dex-q').value = 'Riolu'; h.get('#dex-q').emit('input'); h.flush();
  assert.match(h.get('#dex-grid').innerHTML, /species\/riolu\.html/);
  assert.match(h.location.search, /scope=all/);
  const reload = appHarness('dex', {}, { query: h.location.search });
  assert.equal(reload.get('#dex-scope').value, 'all');
  assert.match(reload.get('#dex-grid').innerHTML, /species\/riolu\.html/);
});

test('404 links and assets stay at the project root when the fallback is served for unknown nested URLs', () => {
  const fallback = read(path.join(docs, '404.html'));
  for (const unknown of ['lost.html', 'unknown/deep/page.html', 'species/unknown', 'unknown/deep/']) {
    const current = new URL(unknown, base), fallbackIds = ids(fallback);
    for (const tag of tags(fallback)) for (const name of ['href', 'src']) {
      const value = attr(tag, name);
      if (!value || /^(data:|mailto:|tel:)/.test(value)) continue;
      if (value.startsWith('#')) { assert.ok(fallbackIds.has(value.slice(1)), `${unknown}: ${value}`); continue; }
      if (name === 'href' && attr(tag, 'rel') === 'canonical') continue;
      const url = new URL(value.replaceAll('&amp;', '&'), current);
      if (url.origin !== current.origin) continue;
      assert.ok(url.pathname.startsWith('/aura-atlas/'), `${unknown}: ${value} escapes project`);
      const target = path.join(docs, url.pathname.slice('/aura-atlas/'.length), url.pathname.endsWith('/') ? 'index.html' : '');
      assert.ok(fs.existsSync(target), `${unknown}: ${value} targets nonexistent ${target}`);
      if (url.hash && target.endsWith('.html')) assert.ok(ids(read(target)).has(url.hash.slice(1)), `${unknown}: ${value} missing anchor`);
    }
  }
  assert.match(fallback, /data-root="https:\/\/isefdk\.github\.io\/aura-atlas\/"/);
});

test('mobile menu click, Escape and navigation keep expanded state, glyph and focus consistent', () => {
  const h = appHarness('home');
  h.menu.click();
  assert.equal(h.menu.getAttribute('aria-expanded'), 'true');
  assert.equal(h.body.classList.contains('nav-open'), true);
  h.documentEvent('keydown', { key: 'Escape' });
  assert.equal(h.menu.getAttribute('aria-expanded'), 'false');
  assert.equal(h.body.classList.contains('nav-open'), false);
  assert.equal(h.menu.focused, true);
  h.menu.click(); h.navLinks[0].click();
  assert.equal(h.menu.getAttribute('aria-expanded'), 'false');
  assert.equal(h.body.classList.contains('nav-open'), false);
  assert.equal(h.menu.querySelector('span').innerHTML, glyphs.glyph('＋'));
  h.menu.click();
  assert.equal(h.menu.getAttribute('aria-expanded'), 'true');
  assert.match(h.menu.querySelector('span').innerHTML, /<svg/);
  h.menu.click();
  assert.equal(h.menu.getAttribute('aria-expanded'), 'false');
});

test('team add/remove states, family detail links and existing persistence keys survive reload and cross-tab changes', () => {
  const stored = { [TEAM]: '[658,448]', [SAVED]: '["before-the-leap"]', [NOTE]: 'Старая заметка' };
  const h = appHarness('team', stored, { root: '../' });
  const button = id => h.addButtons.find(b => b.dataset.add === String(id));
  assert.equal(button(658).getAttribute('aria-pressed'), 'true');
  assert.equal(button(447).getAttribute('aria-pressed'), 'false');
  h.delegated('data-add', '447');
  assert.equal(button(447).getAttribute('aria-pressed'), 'true');
  assert.ok(h.countIndicators.every(element => element.textContent === 3));
  assert.match(h.get('#team-slots').innerHTML, /href="\.\.\/species\/riolu\.html"/);
  const reload = appHarness('team', stored);
  assert.equal(reload.get('#team-length').textContent, '3 / 6');
  assert.equal(reload.addButtons.find(b => b.dataset.add === '447').getAttribute('aria-pressed'), 'true');
  h.delegated('data-remove', '448');
  assert.equal(button(448).getAttribute('aria-pressed'), 'false');
  assert.equal(h.removedButtons.get('447').focused, true, 'next visible remove action receives focus');
  h.delegated('data-remove', '658'); h.delegated('data-remove', '447');
  assert.equal(h.get('#picker-q').focused, true, 'empty team returns focus to the picker');
  h.event('storage', { key: TEAM, newValue: '[447,443,900,447]' });
  assert.equal(h.get('#team-length').textContent, '3 / 6');
  for (const id of [447, 443, 900]) assert.equal(button(id).getAttribute('aria-pressed'), 'true');
  h.event('storage', { key: TEAM, newValue: null });
  assert.equal(h.get('#team-length').textContent, '0 / 6');
  assert.ok(h.addButtons.every(b => b.getAttribute('aria-pressed') === 'false'));
  assert.deepEqual(Object.keys(stored).sort(), [TEAM, SAVED, NOTE].sort(), 'keys stay backwards compatible');
  assert.equal(stored[NOTE], 'Старая заметка');
  assert.equal(stored[SAVED], '["before-the-leap"]');
});

test('Enter submits the latest search, Back/Forward restores all filters and reset creates a clean history entry', () => {
  const h = appHarness('dex', {}, { hash: '#dex-grid' });
  h.get('#dex-q').value = '#0448'; h.get('#dex-q').emit('input');
  h.get('#dex-filters').emit('submit');
  assert.match(h.get('#dex-grid').innerHTML, /lucario\.html/);
  assert.equal(new URLSearchParams(h.location.search).get('q'), '#0448');
  assert.equal(h.location.hash, '#dex-grid');
  h.get('#dex-type').value = 'steel'; h.get('#dex-type').emit('change');
  assert.equal(new URLSearchParams(h.location.search).get('type'), 'steel');
  h.go(-1);
  assert.equal(h.get('#dex-type').value, 'all');
  assert.equal(h.get('#dex-q').value, '#0448');
  h.go(1);
  assert.equal(h.get('#dex-type').value, 'steel');
  h.get('#dex-filters').emit('reset');
  assert.equal(h.get('#dex-q').value, '');
  assert.equal(h.get('#dex-q').focused, true);
  assert.equal(h.location.search, '');
  assert.equal(h.location.hash, '#dex-grid');
  h.go(-1);
  assert.equal(h.get('#dex-q').value, '#0448');
  assert.equal(h.get('#dex-type').value, 'steel');
});

test('dynamic catalog and team HTML never produces missing local species, asset or fragment destinations', () => {
  const h = appHarness('team');
  for (const p of allPokemon) {
    h.get('#picker-q').value = p.name; h.get('#picker-q').emit('input');
    const html = h.get('#team-picker-grid').innerHTML;
    assert.ok(html.includes(`species/${p.name}.html`), p.name);
    for (const tag of tags(html)) for (const name of ['src', 'href']) {
      const value = attr(tag, name); if (!value) continue;
      const url = new URL(value.replaceAll('&amp;', '&'), base + 'team.html');
      assert.equal(url.origin, new URL(base).origin);
      assert.ok(fs.existsSync(path.join(docs, url.pathname.slice('/aura-atlas/'.length))), `${p.name}: ${value}`);
    }
  }
  assert.equal(appHarness('species', {}, { root: '../' }).get('#dex-q').listeners.input, undefined);
  assert.equal(appHarness('404', {}, { root: base }).get('#dex-q').listeners.input, undefined);
});


test('the type lab works without graphics APIs and names exact results for all 54 offered combinations', () => {
  const elements = new Map(['#scan-species', '#scan-attack', '#scan-result', '#scan-art', '#scan-types'].map(id => [id, new Element()]));
  elements.get('#scan-species').value = '658'; elements.get('#scan-attack').value = 'electric';
  const host = new Element(); host.querySelector = id => elements.get(id) ?? null;
  assert.doesNotThrow(() => mountScanner(null, allPokemon, chart));
  assert.doesNotThrow(() => mountScanner({ querySelector: () => null }, allPokemon, chart));
  mountScanner(host, allPokemon, chart);
  const defensive = (attack, defender) => {
    const r = types.find(type => type.name === defender).damageRelations;
    return r.noDamageFrom.includes(attack) ? 0 : r.halfDamageFrom.includes(attack) ? .5 : r.doubleDamageFrom.includes(attack) ? 2 : 1;
  };
  for (const id of [658, 448, 715]) for (const attack of types.map(type => type.name)) {
    const p = allPokemon.find(p => p.id === id), expected = p.types.reduce((value, type) => value * defensive(attack, type), 1);
    elements.get('#scan-species').value = String(id); elements.get('#scan-species').emit('change');
    elements.get('#scan-attack').value = attack; elements.get('#scan-attack').emit('change');
    assert.ok(elements.get('#scan-result').textContent.includes(`${logic.TYPE_RU[attack]} → ${p.nameRu}: ×${String(expected).replace('.', ',')}.`), `${attack} → ${p.name}`);
    assert.equal(host.dataset.damage, expected === 0 ? 'immune' : expected > 1 ? 'weak' : expected < 1 ? 'resist' : 'neutral');
    assert.equal(elements.get('#scan-art').src, p.art);
    assert.equal(elements.get('#scan-art').alt, `${p.nameRu} — официальная иллюстрация`);
    assert.equal(elements.get('#scan-types').innerHTML, view.badges(p.types));
  }
  elements.get('#scan-species').value = '999999'; elements.get('#scan-species').emit('change');
  assert.equal(elements.get('#scan-result').textContent, 'Выбери покемона и тип атаки.');
  const source = read(path.join(project, 'src/scanner.mjs'));
  assert.doesNotMatch(source, /getContext|requestAnimationFrame|IntersectionObserver|matchMedia/);
  const html = read(path.join(docs, 'index.html'));
  assert.match(html, /id="scan-result"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /<noscript>.*электрический тип наносит Грениндзя ×2/s);
  assert.doesNotMatch(html, /<canvas|data-pause|data-turn-left|data-reset-scan/);
  const choices = id => [...html.match(new RegExp(`<select id="${id}"[^>]*>(.*?)</select>`, 's'))[1].matchAll(/value="([^\"]*)"/g)].map(m => m[1]);
  assert.deepEqual(choices('scan-species'), ['658', '448', '715']);
  assert.deepEqual(choices('scan-attack'), Object.keys(logic.TYPE_RU));
});

test('every defensive type row exposes exact named weak, resistant and immune members with local links', () => {
  for (const team of [[715], [445, 715, 448, 94, 658, 700], [656, 657, 26, 123, 900, 447]]) {
    const h = appHarness('team', { [TEAM]: JSON.stringify(team) });
    const cells = [...h.get('#coverage-grid').innerHTML.matchAll(/<div class="coverage-cell ([^\"]*)">([\s\S]*?)<\/details><\/div>/g)];
    assert.equal(cells.length, 18);
    for (const row of logic.analyzeTeam(team, allPokemon, chart)) {
      const [, classes, cell] = cells.find(([, , html]) => html.includes(`type-${row.type}`));
      const weak = cell.match(/<p><strong>Повышенный урон:<\/strong> ([\s\S]*?)<\/p>/)[1];
      const strong = cell.match(/<p><strong>Меньше урона \/ иммунитет:<\/strong> ([\s\S]*?)<\/p>/)[1];
      const members = logic.defenseMembers(team, allPokemon, chart, row.type);
      for (const member of members) {
        const link = `<a href="species/${member.name}.html">${member.nameRu} ×${String(member.multiplier).replace('.', ',')}</a>`;
        assert.equal(weak.includes(link), member.multiplier > 1, `${row.type}: weak ${member.name}`);
        assert.equal(strong.includes(link), member.multiplier < 1, `${row.type}: strong ${member.name}`);
      }
      assert.equal((weak.match(/<a /g) ?? []).length, row.weak);
      assert.equal((strong.match(/<a /g) ?? []).length, row.strong);
      assert.equal(classes.split(/\s+/).includes('risk'), row.weak > 0 && row.strong === 0);
      assert.ok(cell.includes(`Обычный урон ×1: ${row.neutral}.`));
      if (row.max >= 4) assert.ok(cell.includes('ЕСТЬ СЛАБОСТЬ ×4'));
      if (row.immune) assert.ok(cell.includes(`ИММУНИТЕТЫ: ${row.immune}`));
    }
    assert.ok(h.get('#team-summary').innerHTML.includes('Что проверить в составе'));
  }
  const empty = appHarness('team');
  assert.equal(empty.get('#team-summary').innerHTML, '');
  assert.doesNotMatch(empty.get('#coverage-grid').innerHTML, /Кого касается/);
});

test('adding the example preserves existing participants, remains idempotent and respects a full team', () => {
  const h = appHarness('team', { [TEAM]: '[25,1]' });
  h.get('#team-example').click();
  assert.deepEqual(JSON.parse(h.stored[TEAM]), [25, 1, 658, 448, 715, 151]);
  h.get('#team-example').click();
  assert.deepEqual(JSON.parse(h.stored[TEAM]), [25, 1, 658, 448, 715, 151]);
  h.delegated('data-remove', '715'); h.delegated('data-add', '447');
  h.get('#team-example').click();
  assert.deepEqual(JSON.parse(h.stored[TEAM]), [25, 1, 658, 448, 151, 447]);
  for (const id of ['999999', 'undefined', '715']) assert.doesNotThrow(() => h.delegated('data-remove', id));
  assert.deepEqual(JSON.parse(h.stored[TEAM]), [25, 1, 658, 448, 151, 447]);
});

test('the diary offers exactly three real reading paths and preserves notebook text across reload and tabs', () => {
  const html = read(path.join(docs, 'expeditions.html'));
  const pathGrid = html.match(/<div class="path-grid">([\s\S]*?)<\/div><\/section>/)[1];
  assert.equal((pathGrid.match(/<article>/g) ?? []).length, 3);
  for (const note of content.NOTES) assert.ok(pathGrid.includes(`href="notes/${note.id}.html"`), note.id);
  assert.doesNotMatch(html, /planner-map|map-pin|planner-results|data-habitat/);
  assert.match(html, /<textarea id="field-note" maxlength="5000"/);
  const h = appHarness('expeditions', { [NOTE]: 'Моя первая заметка' });
  assert.equal(h.get('#field-note').value, 'Моя первая заметка');
  h.get('#field-note').value = 'Новый вывод: лёд ×4'; h.get('#field-note').emit('input'); h.flush();
  const reload = appHarness('expeditions', h.stored);
  assert.equal(reload.get('#field-note').value, 'Новый вывод: лёд ×4');
  h.event('storage', { key: NOTE, newValue: 'Обновление из другой вкладки' });
  assert.equal(h.get('#field-note').value, 'Обновление из другой вкладки');
  h.document.activeElement = h.get('#field-note');
  h.get('#field-note').value = 'Незаконченный текст';
  h.event('storage', { key: NOTE, newValue: 'Чужое обновление' });
  assert.equal(h.get('#field-note').value, 'Незаконченный текст', 'focused draft is preserved');
  h.document.activeElement = null;
  h.event('storage', { key: NOTE, newValue: null });
  assert.equal(h.get('#field-note').value, '');
});


test('clearing storage in another tab resets team and saved-note state without overwriting a focused notebook draft', () => {
  const h = appHarness('expeditions', { [TEAM]: '[658,447]', [SAVED]: '["before-the-leap"]', [NOTE]: 'Stored text' });
  h.document.activeElement = h.get('#field-note'); h.get('#field-note').value = 'Focused draft';
  h.event('storage', { key: null, newValue: null });
  assert.ok(h.addButtons.every(button => button.getAttribute('aria-pressed') === 'false'));
  assert.ok(h.saveButtons.every(button => button.getAttribute('aria-pressed') === 'false'));
  assert.equal(h.get('#field-note').value, 'Focused draft');
  h.document.activeElement = null;
  h.event('storage', { key: null, newValue: null });
  assert.equal(h.get('#field-note').value, '');
  const teamTab = appHarness('team', { [TEAM]: '[658,447]' });
  teamTab.event('storage', { key: null, newValue: null });
  assert.equal(teamTab.get('#team-length').textContent, '0 / 6');
  assert.equal(teamTab.get('#team-export').disabled, true);
});
