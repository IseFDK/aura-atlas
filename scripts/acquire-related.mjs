#!/usr/bin/env node
/**
 * Rebuild or verify the related-species detail dataset from its checked-in source
 * snapshot. No network, credentials, runtime API calls, or curated roster changes.
 *
 * Refresh source material with the read-only GitHub file connector against
 * PokeAPI/api-data:data/api/v2/{pokemon,pokemon-species}/{id}/index.json and
 * PokeAPI/sprites:sprites/pokemon/other/official-artwork/{id}.png. Preserve blob
 * SHAs and all populated evolution conditions. Decode artwork and optimize to
 * transparent WebP before updating the related-art-manifest.json checksums.
 *
 * node scripts/acquire-related.mjs         rebuild derived related JSON
 * node scripts/acquire-related.mjs --check verify source closure and exact build
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = path.join(root, 'data');
const read = name => JSON.parse(fs.readFileSync(path.join(data, name), 'utf8'));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hashFile = name => sha256(fs.readFileSync(path.join(data, name)));
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const absoluteUrls = value => Array.isArray(value) ? value.map(absoluteUrls)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, absoluteUrls(v)]))
  : typeof value === 'string' && value.startsWith('/api/') ? `https://pokeapi.co${value}` : value;
const camel = key => key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
const resourceId = url => Number(url.replace(/\/$/, '').split('/').at(-1));
const compactRequirement = detail => Object.fromEntries(Object.entries(detail)
  .filter(([key, value]) => value !== null && value !== '' && (value !== false || key === 'is_default'))
  .map(([key, value]) => [camel(key), absoluteUrls(value)]));

const curated = read('pokemon.json');
const snapshot = read('related-source-snapshot.json');
const baseline = read('provenance.json');
const art = read('related-art-manifest.json');
const curatedIds = new Set(curated.map(p => p.id));
const familyLabels = new Map(curated.flatMap(p => p.evolution).map(p => [p.id, p]));
const expectedMissing = [...familyLabels.keys()].filter(id => !curatedIds.has(id)).sort((a, b) => a - b);
assert.deepEqual(snapshot.roster.map(([id]) => id), expectedMissing, 'Related roster must close every curated evolution family');
assert.equal(new Set(snapshot.roster.map(([id]) => id)).size, snapshot.roster.length, 'Duplicate related species');
const generations = new Map(['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix'].map((roman, i) => [`generation-${roman}`, i + 1]));

function flattenChain(source) {
  const result = [];
  function visit(node, parentId = null) {
    const id = resourceId(node.species.url);
    const label = familyLabels.get(id);
    assert.ok(label, `Missing existing curated label for ${id}`);
    assert.equal(label.name, node.species.name, `Species/source name mismatch for ${id}`);
    const requirements = node.evolution_details.map(compactRequirement);
    assert.deepEqual(requirements, label.requirements, `Full source evolution requirements differ for ${id}`);
    assert.equal(label.parentId, parentId, `Evolution parent/source mismatch for ${id}`);
    assert.equal(label.isBaby, node.is_baby, `Baby flag/source mismatch for ${id}`);
    result.push({ id, name: node.species.name, nameRu: label.nameRu, parentId,
      isBaby: node.is_baby, requirements, requirementRu: label.requirementRu,
      speciesUrl: `https://pokeapi.co/api/v2/pokemon-species/${id}/`,
      artSource: `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png` });
    node.evolves_to.forEach(child => visit(child, id));
  }
  visit(source.chain);
  return result;
}

const related = snapshot.roster.map(([id, nameRu]) => {
  const p = snapshot.pokemon[`pokemon/${id}`];
  const species = snapshot.pokemon[`pokemon-species/${id}`];
  assert.equal(p.id, id);
  assert.equal(species.id, id);
  assert.equal(resourceId(p.species.url), id);
  assert.equal(p.is_default, true, `${id}: only standard/default forms belong here`);
  assert.equal(p.name, species.name);
  assert.equal(nameRu, familyLabels.get(id).nameRu);
  const chainId = resourceId(species.evolution_chain.url);
  const chain = snapshot.chains[String(chainId)];
  assert.ok(chain, `${id}: missing source evolution chain`);
  const asset = art.find(a => a.id === id);
  assert.ok(asset, `${id}: missing local artwork manifest`);
  const bytes = fs.readFileSync(path.join(root, 'public', asset.file));
  assert.equal(bytes.length, asset.bytes);
  assert.equal(sha256(bytes), asset.sha256);
  assert.ok(asset.bytes < 90_000, `${id}: artwork exceeds size budget`);
  const stats = Object.fromEntries(p.stats.map(s => [camel(s.stat.name.replaceAll('-', '_')), s.base_stat]));
  assert.deepEqual(Object.keys(stats).sort(), ['attack', 'defense', 'hp', 'specialAttack', 'specialDefense', 'speed']);
  assert.ok(Object.values(stats).every(n => Number.isInteger(n) && n > 0 && n <= 255));
  const generation = generations.get(species.generation.name);
  assert.ok(generation, `${id}: unknown generation`);
  return {
    id, name: p.name, nameEn: p.name.replace(/(^|-)([a-z])/g, (_, sep, letter) => sep + letter.toUpperCase()), nameRu,
    types: [...p.types].sort((a, b) => a.slot - b.slot).map(t => t.type.name), stats,
    height: p.height / 10, weight: p.weight / 10,
    abilities: p.abilities.map(a => ({ name: a.ability.name, isHidden: a.is_hidden, slot: a.slot, url: absoluteUrls(a.ability.url) })),
    art: asset.file, artSource: p.artSource, evolution: flattenChain(chain),
    evolutionChain: { id: chainId, url: absoluteUrls(species.evolution_chain.url), babyTriggerItem: absoluteUrls(chain.baby_trigger_item) },
    generation, isLegendary: species.is_legendary, isMythical: species.is_mythical,
    speciesUrl: `https://pokeapi.co/api/v2/pokemon-species/${id}/`, pokemonUrl: `https://pokeapi.co/api/v2/pokemon/${id}/`
  };
});
assert.deepEqual([...new Set([...curated, ...related].map(p => p.id))].sort((a, b) => a - b), [...familyLabels.keys()].sort((a, b) => a - b));
assert.ok([...curated, ...related].every(p => p.evolution.every(stage => [...curated, ...related].some(candidate => candidate.id === stage.id))));
const relatedText = json(related);
const provenance = {
  schemaVersion: 1, snapshotDate: snapshot.snapshotDate, fetchedAt: snapshot.fetchedAt,
  canonicalSource: baseline.canonicalSource, retrievalMethod: snapshot.retrievalMethod,
  scope: { species: related.length, curatedSpecies: curated.length, evolutionClosureSpecies: curated.length + related.length,
    relatedFamilies: Object.keys(snapshot.chains).length,
    forms: 'Standard/default forms only; full family requirements preserve canonical version-group and regional/form alternatives',
    roster: 'Detail-only supplemental species; the curated catalogue remains the original 24 Pokémon' },
  units: baseline.units,
  localization: { language: 'ru', method: 'Species labels and concise evolution summaries reused verbatim from the existing curated evolution families; canonical English slugs, measurements, stats and populated requirements are retained from cited source records',
    evolutionSummaries: baseline.localization.evolutionSummaries },
  sourceDates: { pokemonAndSpecies: snapshot.snapshotDate, evolutionFamilies: baseline.snapshotDate },
  disclaimers: baseline.disclaimers, files: snapshot.sources, artwork: art,
  checksums: { 'related-pokemon.json': sha256(relatedText), 'related-source-snapshot.json': hashFile('related-source-snapshot.json'),
    'related-art-manifest.json': hashFile('related-art-manifest.json'), 'pokemon.json': hashFile('pokemon.json') }
};
if (process.argv.includes('--check')) {
  assert.deepEqual(read('related-pokemon.json'), related, 'Related detail data needs rebuilding');
  assert.deepEqual(read('related-provenance.json'), provenance, 'Related provenance needs rebuilding');
} else {
  fs.writeFileSync(path.join(data, 'related-pokemon.json'), relatedText);
  fs.writeFileSync(path.join(data, 'related-provenance.json'), json(provenance));
}
console.log(`${process.argv.includes('--check') ? 'Verified' : 'Built'} ${related.length} related species, ${curated.length + related.length} species in complete evolution closure, ${art.length} local artworks, ${snapshot.sources.length} source citations`);
