import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const project = path.resolve(new URL('../', import.meta.url).pathname);
const read = file => fs.readFileSync(path.join(project, file), 'utf8');
const css = read('src/style.css').replace(/\/\*[\s\S]*?\*\//g, '');
const widths = [320, 390, 768, 1440];

// This checks the actual stylesheet's viewport rules, not browser geometry.
// Rendered overflow and visual QA are deliberately a separate verification stage.
function rulesAt(width, source = css) {
  const rules = []; let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf('{', cursor); if (open < 0) break;
    let depth = 1, end = open + 1;
    while (end < source.length && depth) { if (source[end] === '{') depth++; if (source[end] === '}') depth--; end++; }
    assert.equal(depth, 0, 'CSS block must be balanced');
    const head = source.slice(cursor, open).trim(), body = source.slice(open + 1, end - 1); cursor = end;
    if (head.startsWith('@media')) {
      if (/prefers-|forced-colors|hover:|pointer:/.test(head)) continue;
      const max = head.match(/max-width\s*:\s*([\d.]+)px/), min = head.match(/min-width\s*:\s*([\d.]+)px/);
      if ((!max || width <= Number(max[1])) && (!min || width >= Number(min[1]))) rules.push(...rulesAt(width, body));
    } else if (!head.startsWith('@')) {
      const declarations = Object.fromEntries(body.split(';').filter(part => part.includes(':')).map(part => { const colon = part.indexOf(':'); return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()]; }));
      rules.push({ selectors: head.split(',').map(selector => selector.trim()), declarations });
    }
  }
  return rules;
}
function style(selector, width) {
  return Object.assign({}, ...rulesAt(width).filter(rule => rule.selectors.includes(selector)).map(rule => rule.declarations));
}

for (const width of widths) {
  test(`stylesheet supplies safe grid, navigation, type-lab and reading-path rules at ${width}px`, () => {
    const grid = style('.pokemon-grid', width), team = style('.team-slots', width), coverage = style('.coverage-grid', width);
    assert.equal(grid['grid-template-columns'], `repeat(${width <= 800 ? 2 : 4},minmax(0,1fr))`);
    assert.equal(team['grid-template-columns'], `repeat(${width <= 600 ? 2 : width <= 1100 ? 3 : 6},minmax(0,1fr))`);
    assert.equal(coverage['grid-template-columns'], team['grid-template-columns']);
    assert.equal(style('.site-nav', width).display, width <= 600 ? 'none' : 'flex');
    assert.equal(style('.menu-toggle', width).display, width <= 600 ? 'block' : 'none');
    assert.equal(style('.nav-open .site-nav', width).display, 'flex');
    if (width <= 600) assert.equal(style('.site-nav', width).top, '100%', 'menu follows variable-height header');
    assert.equal(style('.path-grid', width)['grid-template-columns'], width <= 800 ? '1fr' : 'repeat(3,minmax(0,1fr))');
    assert.equal(style('.scan-controls', width)['grid-template-columns'], width <= 350 ? '1fr' : '1fr 1fr');
    assert.equal(style('.scan-controls label', width)['min-width'], '0');
    assert.equal(style('.coverage-cell', width)['min-width'], '0');
    assert.equal(style('.coverage-members', width)['overflow-wrap'], 'anywhere');
    assert.equal(style('.species-copy h1', width)['overflow-wrap'], 'anywhere');
    assert.ok(parseFloat(style('.scan-controls select', width)['min-height']) >= 44);
    assert.ok(parseFloat(style('.filter-row input', width)['min-height']) >= 44);
    assert.equal(style('.scan-controls select', width).width, '100%');
    assert.equal(style('img', width)['max-width'], '100%');
  });
}

test('responsive QA page actually changes its iframe at all four viewports and permits 200% text', () => {
  const html = read('docs/qa.html');
  assert.match(html, /name="robots" content="noindex,nofollow"/);
  const elements = Object.fromEntries(['iframe', '#width', '#route', '#text-size'].map(selector => [selector, { value: '', listeners: {}, addEventListener(key, fn) { this.listeners[key] = fn; } }]));
  elements.iframe.contentDocument = { documentElement: { style: {} } };
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  new Function('document', script)({ querySelector: selector => elements[selector] });
  for (const width of widths) {
    assert.ok(html.includes(`<option value="${width}"`));
    elements['#width'].value = String(width); elements['#width'].onchange();
    assert.equal(Number(elements.iframe.width), width);
    assert.equal(elements.iframe.height, { 320: 740, 390: 844, 768: 1024, 1440: 1000 }[width]);
  }
  elements['#text-size'].value = '200'; elements['#text-size'].onchange();
  assert.equal(elements.iframe.contentDocument.documentElement.style.fontSize, '200%');
  elements['#route'].value = 'species/eevee.html'; elements['#route'].onchange();
  assert.match(elements.iframe.src, /^\.\/species\/eevee\.html\?qa=[a-f0-9]{12}$/);
});

test('responsive and keyboard affordances remain visible in source and every public HTML page', () => {
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /forced-colors:active/);
  assert.match(css, /\.skip:focus\{top:10px\}/);
  assert.match(css, /summary:focus-visible/);
  assert.match(css, /\[hidden\]\{display:none!important\}/);
  const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
  for (const file of walk(path.join(project, 'docs')).filter(file => file.endsWith('.html') && path.basename(file) !== 'qa.html')) {
    const html = fs.readFileSync(file, 'utf8');
    assert.match(html, /name="viewport" content="width=device-width,initial-scale=1"/, file);
    assert.match(html, /class="menu-toggle" type="button" aria-controls="site-nav" aria-expanded="false"/, file);
    assert.match(html, /id="site-nav" aria-label="Главная навигация"/, file);
    for (const tag of html.match(/<img\b[^>]*>/g) ?? []) {
      assert.match(tag, /width="\d+"/, `${file}: reserves image width`);
      assert.match(tag, /height="\d+"/, `${file}: reserves image height`);
    }
  }
});
