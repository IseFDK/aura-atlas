import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import {
  TYPE_RU, STAT_RU, normalize, filterPokemon, statTotal, multiplier,
  sanitizeTeam, addMember, analyzeTeam, parseFilters, filtersQuery,
  parseStored, expeditionSuggestion, escapeHTML,
} from '../src/logic.mjs';

const root = new URL('../', import.meta.url);
const readJSON = name => JSON.parse(readFileSync(new URL(`data/${name}`, root), 'utf8'));
const pokemon = readJSON('pokemon.json');
const types = readJSON('types.json');
const snapshot = readJSON('source-snapshot.json');
const provenance = readJSON('provenance.json');
const artManifest = readJSON('art-manifest.json');
const byId = new Map(pokemon.map(p => [p.id, p]));
const defaults = { q: '', type: 'all', generation: 'all', sort: 'id' };
const ids = result => result.map(p => p.id);
const camel = key => key.replace(/[-_]([a-z])/g, (_, letter) => letter.toUpperCase());
const absolute = url => url.startsWith('/api/') ? `https://pokeapi.co${url}` : url;

// The attacking chart is explicitly derived from canonical *To* relations.
// Defensive *From* relations are independently used below as an oracle.
const chart = Object.fromEntries(types.map(type => {
  const values = Object.fromEntries(types.map(defender => [defender.name, 1]));
  for (const name of type.damageRelations.noDamageTo) values[name] = 0;
  for (const name of type.damageRelations.halfDamageTo) values[name] = 0.5;
  for (const name of type.damageRelations.doubleDamageTo) values[name] = 2;
  return [type.name, values];
}));
const defensiveValue = (attack, defender) => {
  const relations = types.find(type => type.name === defender).damageRelations;
  if (relations.noDamageFrom.includes(attack)) return 0;
  if (relations.halfDamageFrom.includes(attack)) return 0.5;
  if (relations.doubleDamageFrom.includes(attack)) return 2;
  return 1;
};

// These are exact type-chart cases, excluding ability/item/move modifiers.
const matchups = [
  ['ice', 445, 4], ['ice', 715, 4], ['ice', 714, 4], ['ice', 149, 4],
  ['rock', 6, 4], ['fire', 212, 4], ['fighting', 248, 4],
  ['normal', 448, 0.5], ['bug', 448, 0.25], ['rock', 448, 0.25],
  ['poison', 448, 0], ['poison', 212, 0], ['electric', 445, 0],
  ['ground', 715, 0], ['ground', 6, 0], ['normal', 94, 0],
  ['fighting', 94, 0], ['psychic', 658, 0], ['psychic', 197, 0],
  ['dragon', 700, 0], ['ghost', 133, 0],
  ['electric', 715, 1], ['ice', 131, 0.25], ['water', 6, 2],
  ['fairy', 448, 1], ['ground', 448, 2], ['fire', 448, 2],
  ['fighting', 448, 2], ['psychic', 94, 2],
];
for (const [attack, id, expected] of matchups) {
  test(`${attack} attacking ${byId.get(id).name} is exactly ×${expected}`, () => {
    assert.equal(multiplier(attack, byId.get(id).types, chart), expected);
    assert.equal(multiplier(attack, [...byId.get(id).types].reverse(), chart), expected);
  });
}

test('all 324 single-type chart entries agree with the independent defensive relations', () => {
  for (const attacker of types) {
    for (const defender of types) {
      assert.equal(chart[attacker.name][defender.name], defensiveValue(attacker.name, defender.name),
        `${attacker.name} → ${defender.name}`);
    }
  }
});

test('all roster/type combinations multiply both defending types, preserving immunities', () => {
  for (const attacker of types) {
    for (const p of pokemon) {
      const expected = p.types.reduce((value, defender) => value * defensiveValue(attacker.name, defender), 1);
      assert.equal(multiplier(attacker.name, p.types, chart), expected, `${attacker.name} → ${p.name}`);
      if (p.types.some(defender => defensiveValue(attacker.name, defender) === 0)) {
        assert.equal(expected, 0, 'an immunity must override the other type’s weakness');
      }
    }
  }
});

test('unknown chart values and empty defending types safely default to neutral', () => {
  assert.equal(multiplier('unknown', ['fire', 'water'], chart), 1);
  assert.equal(multiplier('fire', ['unknown'], chart), 1);
  assert.equal(multiplier('fire', [], chart), 1);
});

test('exact team analysis counts weaknesses, resistance/immunity and offensive type coverage', () => {
  const team = [445, 715, 448, 94, 658, 700];
  const analysis = analyzeTeam(team, pokemon, chart);
  assert.equal(analysis.length, 18);
  assert.deepEqual(new Set(analysis.map(row => row.type)), new Set(types.map(type => type.name)));
  assert.deepEqual(analysis.find(row => row.type === 'ice'), {
    type: 'ice', weak: 2, strong: 2, immune: 0, neutral: 2, max: 4, stab: 1,
  });
  assert.deepEqual(analysis.find(row => row.type === 'normal'), {
    type: 'normal', weak: 0, strong: 2, immune: 1, neutral: 4, max: 1, stab: 1,
  });
  for (const row of analysis) {
    assert.equal(row.weak + row.strong + row.neutral, team.length);
    assert.ok(row.immune <= row.strong, 'immune defenders are included in the resistance count');
  }
});

test('analysis ignores unknown/duplicate members and reports zero counts for an empty team', () => {
  assert.deepEqual(analyzeTeam([445, 445, 99999], pokemon, chart), analyzeTeam([445], pokemon, chart));
  for (const row of analyzeTeam([], pokemon, chart)) {
    assert.deepEqual(row, { type: row.type, weak: 0, strong: 0, immune: 0, neutral: 0, max: 0, stab: 0 });
  }
});

test('storage parser handles malformed JSON, null and empty input with the supplied fallback', () => {
  const fallback = [];
  for (const text of ['', '{', '[1,', 'undefined', 'null', undefined, null]) {
    assert.equal(parseStored(text, fallback), fallback);
  }
  assert.deepEqual(parseStored('[445,"715",448]', fallback), [445, '715', 448]);
  assert.deepEqual(parseStored('{"x":1}', fallback), { x: 1 });
  assert.equal(parseStored('false', fallback), false);
});

test('sanitization rejects non-array stored values and unknown/non-integral IDs', () => {
  for (const value of [null, undefined, false, true, {}, 445, '445']) {
    assert.deepEqual(sanitizeTeam(value, pokemon), []);
  }
  assert.deepEqual(sanitizeTeam([99999, 0, -1, 445.2, NaN, Infinity, 'nope', {}, null], pokemon), []);
});

test('sanitization accepts numeric IDs/decimal strings, preserves order, deduplicates and caps six', () => {
  const raw = [445, '715', 445, '448', 94, 658, 700, 25, 151, 99999];
  const copy = structuredClone(raw);
  assert.deepEqual(sanitizeTeam(raw, pokemon), [445, 715, 448, 94, 658, 700]);
  assert.deepEqual(raw, copy, 'sanitization must not mutate stored input');
  assert.deepEqual(sanitizeTeam([25, '025', 1, '001'], pokemon), [25, 1]);
});

test('corrupt storage cannot coerce booleans or nested arrays into real Pokémon IDs', () => {
  const corrupt = parseStored('[true,false,null,{},[],[1],[25],"25",25]', []);
  assert.deepEqual(sanitizeTeam(corrupt, pokemon), [25]);
});

test('adding team members returns explicit added/duplicate/full/invalid states without mutation', () => {
  const original = [445];
  assert.deepEqual(addMember(original, '715', pokemon), { team: [445, 715], status: 'added' });
  assert.deepEqual(original, [445]);
  assert.deepEqual(addMember([445, '445'], 445, pokemon), { team: [445], status: 'duplicate' });
  const full = [445, 715, 448, 94, 658, 700];
  assert.deepEqual(addMember(full, 25, pokemon), { team: full, status: 'full' });
  assert.deepEqual(addMember(full, 445, pokemon), { team: full, status: 'duplicate' });
  assert.deepEqual(addMember([], 99999, pokemon), { team: [], status: 'invalid' });
  assert.deepEqual(addMember([], 'invalid', pokemon), { team: [], status: 'invalid' });
  assert.deepEqual(addMember(null, 445, pokemon), { team: [445], status: 'added' });
});

test('adding a member rejects corrupt non-scalar IDs rather than coercing them', () => {
  for (const id of [true, false, null, [], [1], [25], {}]) {
    assert.deepEqual(addMember([], id, pokemon), { team: [], status: 'invalid' }, `invalid ID ${JSON.stringify(id)}`);
  }
});

test('normalization handles Russian ё, case, spaces and absent values', () => {
  assert.equal(normalize('  ТЁМНЫЙ  '), 'темный');
  assert.equal(normalize('  Greninja  '), 'greninja');
  assert.equal(normalize(undefined), '');
  assert.equal(normalize(null), '');
});

test('search matches Russian and English names and leading-zero National Dex IDs', () => {
  const cases = [
    ['ЛУКАРИО', [448]], ['  ной  ', [714, 715]], ['GrenINja', [658]],
    ['garch', [445]], ['#0006', [6]], ['#006', [6]], ['#000025', [25]],
    ['#0448', [448]], ['448', [448]], ['#99999', []], ['несуществующий', []],
  ];
  for (const [q, expected] of cases) assert.deepEqual(ids(filterPokemon(pokemon, { q })), expected, q);
});

test('all/default/reset filters restore the complete roster in National Dex order', () => {
  const expected = pokemon.map(p => p.id).sort((a, b) => a - b);
  assert.deepEqual(ids(filterPokemon(pokemon)), expected);
  assert.deepEqual(ids(filterPokemon(pokemon, defaults)), expected);
  assert.deepEqual(ids(filterPokemon(pokemon, parseFilters(''))), expected);
  assert.equal(filterPokemon(pokemon, { q: '' }).length, 24);
});

test('type and generation filters combine with search and support string/numeric generations', () => {
  assert.deepEqual(ids(filterPokemon(pokemon, { type: 'dragon' })), [149, 445, 714, 715]);
  assert.deepEqual(ids(filterPokemon(pokemon, { generation: '4' })), [445, 448, 470, 471]);
  assert.deepEqual(ids(filterPokemon(pokemon, { generation: 4 })), [445, 448, 470, 471]);
  assert.deepEqual(ids(filterPokemon(pokemon, { type: 'dragon', generation: '6', q: 'ной' })), [714, 715]);
  assert.deepEqual(ids(filterPokemon(pokemon, { type: 'fire', generation: '6' })), []);
  assert.deepEqual(ids(filterPokemon(pokemon, { generation: '9' })), []);
});

test('all sort modes are correct, have stable numeric tie-breakers and leave source order intact', () => {
  const original = ids(pokemon);
  assert.deepEqual(ids(filterPokemon(pokemon, { sort: 'id' })), [...original].sort((a, b) => a - b));
  assert.deepEqual(ids(filterPokemon(pokemon, { sort: 'name' })),
    ids([...pokemon].sort((a, b) => a.nameRu.localeCompare(b.nameRu, 'ru'))));
  const speed = filterPokemon(pokemon, { sort: 'speed' });
  const total = filterPokemon(pokemon, { sort: 'total' });
  assert.deepEqual(ids(speed).slice(0, 5), [715, 658, 94, 196, 445]);
  assert.deepEqual(ids(total).slice(0, 4), [149, 151, 248, 445]);
  for (const [result, value] of [[speed, p => p.stats.speed], [total, statTotal]]) {
    for (let i = 1; i < result.length; i++) {
      assert.ok(value(result[i - 1]) >= value(result[i]));
      if (value(result[i - 1]) === value(result[i])) assert.ok(result[i - 1].id < result[i].id);
    }
  }
  assert.deepEqual(ids(pokemon), original);
  assert.equal(statTotal(byId.get(448)), 525);
});

test('URL parser defaults invalid type, generation and sort tokens safely', () => {
  assert.deepEqual(parseFilters(''), defaults);
  assert.deepEqual(parseFilters('?type=__proto__&generation=10&sort=constructor'), defaults);
  assert.deepEqual(parseFilters('?type=constructor&generation=-1&sort=desc'), defaults);
  assert.deepEqual(parseFilters('?type=dragon&generation=6&sort=speed&q=%23%20006'), {
    q: '# 006', type: 'dragon', generation: '6', sort: 'speed',
  });
  assert.deepEqual(parseFilters('?type=fire&type=water&sort=total&sort=id'), {
    q: '', type: 'fire', generation: 'all', sort: 'total',
  });
});

test('URL serializer omits defaults and round-trips multilingual/search metacharacters', () => {
  assert.equal(filtersQuery(defaults), '');
  for (const state of [
    { q: 'Нойверн', type: 'dragon', generation: '6', sort: 'speed' },
    { q: '#006 & <img src=x onerror="bad"> + / ?', type: 'all', generation: 'all', sort: 'id' },
  ]) {
    const query = filtersQuery(state);
    assert.deepEqual(parseFilters(`?${query}`), state);
    assert.equal(new URLSearchParams(query).get('q'), state.q);
    assert.ok(!query.includes('<') && !query.includes('>'), 'search markup must be URL-encoded');
  }
});

test('HTML escaping neutralizes all five markup delimiters in arbitrary search/display strings', () => {
  assert.equal(escapeHTML(`<img title="A&B" onerror='x'>`), '&lt;img title=&quot;A&amp;B&quot; onerror=&#39;x&#39;&gt;');
  assert.equal(escapeHTML(445), '445');
  assert.equal(escapeHTML('Нойверн'), 'Нойверн');
});

test('expedition suggestions use only known roster IDs, have no duplicates and a safe default', () => {
  assert.deepEqual(expeditionSuggestion('water', pokemon), [658, 350, 134]);
  assert.deepEqual(expeditionSuggestion('mountain', pokemon), [445, 448, 715]);
  assert.ok(expeditionSuggestion('forest', pokemon).length > 0);
  assert.deepEqual(expeditionSuggestion('unknown', pokemon), expeditionSuggestion('water', pokemon));
  assert.deepEqual(expeditionSuggestion('water', []), []);
  for (const mode of ['water', 'mountain', 'forest', 'unknown']) {
    const result = expeditionSuggestion(mode, pokemon);
    assert.equal(new Set(result).size, result.length);
    assert.ok(result.every(id => byId.has(id)));
  }
});

test('canonical roster includes 24 unique standard forms and all 18 supported types', () => {
  assert.equal(pokemon.length, 24);
  assert.equal(byId.size, 24);
  assert.equal(types.length, 18);
  assert.deepEqual(new Set(types.map(type => type.name)), new Set(Object.keys(TYPE_RU)));
  assert.deepEqual(new Set(pokemon.flatMap(p => p.types)), new Set(types.map(type => type.name)));
  assert.deepEqual(pokemon.map(p => [p.id, p.nameRu]), snapshot.roster);
  for (const p of pokemon) {
    assert.ok(p.types.length >= 1 && p.types.length <= 2);
    assert.equal(new Set(p.types).size, p.types.length);
    assert.deepEqual(new Set(Object.keys(p.stats)), new Set(Object.keys(STAT_RU)));
    assert.ok(Object.values(p.stats).every(value => Number.isInteger(value) && value > 0));
    assert.ok(p.generation >= 1 && p.generation <= 9);
  }
});

test('all species stats, types, units, abilities and generations match the offline canonical snapshot', () => {
  const romans = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix'];
  for (const p of pokemon) {
    const source = snapshot.pokemon[`pokemon/${p.id}`];
    const species = snapshot.pokemon[`pokemon-species/${p.id}`];
    assert.equal(p.name, source.name);
    assert.deepEqual(p.stats, Object.fromEntries(source.stats.map(stat => [camel(stat.stat.name), stat.base_stat])));
    assert.deepEqual(p.types, [...source.types].sort((a, b) => a.slot - b.slot).map(type => type.type.name));
    assert.equal(p.height, source.height / 10);
    assert.equal(p.weight, source.weight / 10);
    assert.deepEqual(p.abilities, source.abilities.map(ability => ({
      name: ability.ability.name, isHidden: ability.is_hidden, slot: ability.slot, url: absolute(ability.ability.url),
    })));
    assert.equal(p.generation, romans.indexOf(species.generation.name.replace('generation-', '')) + 1);
    assert.equal(p.isLegendary, species.is_legendary);
    assert.equal(p.isMythical, species.is_mythical);
    assert.equal(p.pokemonUrl, `https://pokeapi.co/api/v2/pokemon/${p.id}/`);
    assert.equal(p.speciesUrl, `https://pokeapi.co/api/v2/pokemon-species/${p.id}/`);
  }
});

test('all 18 type relations match the source snapshot and reference supported types only', () => {
  const names = new Set(types.map(type => type.name));
  for (const type of types) {
    const source = snapshot.types[String(type.id)];
    assert.equal(type.name, source.name);
    const expected = Object.fromEntries(Object.entries(source.damage_relations)
      .map(([key, values]) => [camel(key), values.map(value => value.name)]));
    assert.deepEqual(type.damageRelations, expected);
    for (const values of Object.values(type.damageRelations)) {
      assert.equal(new Set(values).size, values.length);
      assert.ok(values.every(value => names.has(value)));
    }
    assert.equal(type.sourceUrl, `https://pokeapi.co/api/v2/type/${type.id}/`);
  }
});

test('complete evolution families preserve source node order, parents and populated canonical conditions', () => {
  const absoluteValue = value => {
    if (Array.isArray(value)) return value.map(absoluteValue);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, absoluteValue(v)]));
    return typeof value === 'string' && value.startsWith('/api/') ? absolute(value) : value;
  };
  for (const p of pokemon) {
    const species = snapshot.pokemon[`pokemon-species/${p.id}`];
    const chainId = Number(species.evolution_chain.url.split('/').filter(Boolean).at(-1));
    const source = snapshot.chains[String(chainId)];
    const flattened = [];
    const visit = (node, parentId = null) => {
      const id = Number(node.species.url.split('/').filter(Boolean).at(-1));
      flattened.push({ id, name: node.species.name, parentId, isBaby: node.is_baby,
        requirements: node.evolution_details.map(detail => Object.fromEntries(Object.entries(detail)
          .filter(([key, value]) => value !== null && value !== '' && !(value === false && key !== 'is_default'))
          .map(([key, value]) => [camel(key), absoluteValue(value)]))),
      });
      for (const child of node.evolves_to) visit(child, id);
    };
    visit(source.chain);
    assert.deepEqual(p.evolution.map(({ id, name, parentId, isBaby, requirements }) => ({ id, name, parentId, isBaby, requirements })), flattened);
    assert.equal(p.evolutionChain.id, chainId);
    assert.equal(p.evolutionChain.url, `https://pokeapi.co/api/v2/evolution-chain/${chainId}/`);
    assert.ok(p.evolution.some(node => node.id === p.id));
    assert.ok(p.evolution.every(node => node.nameRu && node.requirementRu && node.speciesUrl && node.artSource));
  }
});

test('provenance has exact source citations and valid upstream Git object SHAs for every data/art resource', () => {
  assert.equal(provenance.scope.species, pokemon.length);
  assert.equal(provenance.scope.types, types.length);
  assert.deepEqual(provenance.files, snapshot.sources);
  assert.match(provenance.snapshotDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Number.isFinite(Date.parse(provenance.fetchedAt)));
  for (const source of provenance.files) {
    assert.match(source.sha, /^[0-9a-f]{40}$/);
    assert.match(source.url, /^https:\/\/github\.com\/PokeAPI\/(api-data|sprites)\/blob\/master\//);
  }
  const citation = (resource, id) => provenance.files.find(source => source.resource === resource && source.id === id);
  for (const p of pokemon) {
    assert.ok(citation('pokemon', p.id), p.name);
    assert.ok(citation('pokemon-species', p.id), p.name);
    assert.ok(citation('evolution-chain', p.evolutionChain.id), p.name);
    assert.ok(citation('official-artwork', p.id), p.name);
  }
  for (const type of types) assert.ok(citation('type', type.id), type.name);
});

test('provenance checksums and local transparent artwork manifest are internally consistent', () => {
  for (const [file, expected] of Object.entries(provenance.checksums)) {
    const bytes = readFileSync(new URL(`data/${file}`, root));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, file);
  }
  assert.equal(artManifest.length, pokemon.length);
  assert.equal(new Set(artManifest.map(asset => asset.id)).size, pokemon.length);
  for (const asset of artManifest) {
    const p = byId.get(asset.id);
    assert.ok(p);
    assert.equal(asset.file, p.art);
    assert.equal(statSync(new URL(`public/${asset.file}`, root)).size, asset.bytes);
    assert.ok(asset.bytes < 90 * 1024);
    assert.ok(asset.width > 0 && asset.height > 0);
    const enriched = provenance.artwork.find(record => record.id === asset.id);
    assert.ok(enriched);
    assert.equal(enriched.file, asset.file);
    assert.equal(enriched.sha256, createHash('sha256').update(readFileSync(new URL(`public/${asset.file}`, root))).digest('hex'));
    assert.equal(enriched.sourceUrl, provenance.files.find(source => source.resource === 'official-artwork' && source.id === asset.id).url);
  }
});
