#!/usr/bin/env python3
"""Build AURA ATLAS's offline canonical JSON from its checked-in PokeAPI snapshot.

No network or credentials are needed. To update canonical data/artwork, run
fetch-pokemon-data.py first, review the diff, then run this script.
"""
from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data'

RU = {
    1:'Бульбазавр',2:'Ивизавр',3:'Венузавр',4:'Чармандер',5:'Чармелеон',6:'Чаризард',
    25:'Пикачу',26:'Райчу',37:'Вульпикс',38:'Найнтейлс',92:'Гастли',93:'Хонтер',94:'Генгар',
    123:'Скайтер',131:'Лапрас',133:'Иви',134:'Вапореон',135:'Джолтеон',136:'Флареон',
    147:'Дратини',148:'Драгонэйр',149:'Драгонайт',151:'Мью',172:'Пичу',196:'Эспеон',
    197:'Амбреон',212:'Сизор',246:'Ларвитар',247:'Пупитар',248:'Тиранитар',349:'Фибас',
    350:'Милотик',359:'Абсол',443:'Гибл',444:'Габит',445:'Гарчомп',447:'Риолу',448:'Лукарио',
    470:'Лифеон',471:'Гласеон',656:'Фроки',657:'Фрогадир',658:'Грениндзя',700:'Сильвеон',
    714:'Нойбат',715:'Нойверн',900:'Кливор',
}
TYPE_RU = {
    'normal':'Нормальный','fighting':'Боевой','flying':'Летающий','poison':'Ядовитый',
    'ground':'Земляной','rock':'Каменный','bug':'Насекомый','ghost':'Призрачный',
    'steel':'Стальной','fire':'Огненный','water':'Водный','grass':'Травяной',
    'electric':'Электрический','psychic':'Психический','ice':'Ледяной','dragon':'Драконий',
    'dark':'Тёмный','fairy':'Волшебный',
}
ITEM_RU = {
    'water-stone':'Водный камень','thunder-stone':'Громовой камень',
    'fire-stone':'Огненный камень','leaf-stone':'Листовой камень',
    'ice-stone':'Ледяной камень','metal-coat':'Металлическое покрытие',
    'prism-scale':'Прекрасная чешуя','black-augurite':'Чёрный авгит',
}

def resource_id(url):
    return int(url.rstrip('/').split('/')[-1])

def camel(key):
    head, *tail = key.split('_')
    return head + ''.join(word.capitalize() for word in tail)

def absolute_urls(value):
    if isinstance(value, list):
        return [absolute_urls(x) for x in value]
    if isinstance(value, dict):
        return {k:absolute_urls(v) for k,v in value.items()}
    if isinstance(value,str) and value.startswith('/api/'):
        return 'https://pokeapi.co' + value
    return value

def compact_requirement(detail):
    # Preserve all populated canonical fields, including game version and forms.
    # False, null and empty-string fields do not impose a condition.
    result = {}
    for key,value in detail.items():
        if value is None or (value is False and key != 'is_default') or value == '':
            continue
        result[camel(key)] = absolute_urls(value)
    return result

def requirement_ru(detail):
    trigger = (detail.get('trigger') or {}).get('name')
    parts = []
    if trigger == 'level-up':
        parts.append('Уровень ' + str(detail['min_level']) if detail.get('min_level') else 'Повышение уровня')
    elif trigger == 'use-item':
        item = (detail.get('item') or {}).get('name', '')
        parts.append(ITEM_RU.get(item, item.replace('-',' ')))
    elif trigger == 'trade':
        parts.append('Обмен')
    else:
        parts.append({'other':'Особое условие','shed':'Свободное место в команде'}.get(trigger, trigger or ''))
    if detail.get('held_item'):
        item = detail['held_item']['name']
        parts.append('с предметом «' + ITEM_RU.get(item,item.replace('-',' ')) + '»')
    if detail.get('min_happiness') is not None:
        parts.append('высокая дружба')
    if detail.get('min_beauty') is not None:
        parts.append('высокая красота')
    if detail.get('min_affection') is not None:
        parts.append('привязанность ≥ ' + str(detail['min_affection']))
    if detail.get('time_of_day'):
        parts.append({'day':'днём','night':'ночью','dusk':'в сумерках'}.get(detail['time_of_day'],detail['time_of_day']))
    if detail.get('known_move_type'):
        parts.append('знать приём типа «' + TYPE_RU.get(detail['known_move_type']['name'],detail['known_move_type']['name']) + '»')
    if detail.get('known_move'):
        parts.append('знать ' + detail['known_move']['name'])
    if detail.get('near_special_rock'):
        parts.append('рядом с особым камнем')
    if detail.get('location'):
        parts.append(detail['location']['name'].replace('-',' '))
    if detail.get('needs_overworld_rain'):
        parts.append('во время дождя')
    if detail.get('region'):
        parts.append('регион ' + detail['region']['name'])
    if detail.get('gender'):
        parts.append({1:'самка',2:'самец',3:'без пола'}.get(detail['gender'],str(detail['gender'])))
    return ' · '.join(parts)

def flatten_chain(chain):
    nodes = []
    def visit(node,parent_id=None):
        id = resource_id(node['species']['url'])
        details = node['evolution_details']
        defaults = [d for d in details if d.get('is_default')]
        # Prefer conditions for the standard form. Preserve every alternative below.
        standard = [d for d in defaults if not d.get('required_pokemon_form') or d['required_pokemon_form']['name'] == next((n['name'] for n in nodes if n['id']==parent_id),'')]
        display = standard or defaults or details
        labels = list(dict.fromkeys(requirement_ru(d) for d in display))
        nodes.append({
            'id':id,'name':node['species']['name'],'nameRu':RU.get(id,node['species']['name'].title()),
            'parentId':parent_id,'isBaby':node['is_baby'],
            'requirements':[compact_requirement(d) for d in details],
            'requirementRu':' / '.join(labels) if labels else 'Базовая стадия',
            'speciesUrl':'https://pokeapi.co/api/v2/pokemon-species/' + str(id) + '/',
            'artSource':'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/' + str(id) + '.png',
        })
        for child in node['evolves_to']:
            visit(child,id)
    visit(chain['chain'])
    return nodes

def write_json(path,obj):
    path.write_text(json.dumps(obj,ensure_ascii=False,indent=2) + '\n',encoding='utf-8')

def main():
    snapshot = json.loads((DATA / 'source-snapshot.json').read_text())
    result = []
    generations = {roman:i+1 for i,roman in enumerate(['i','ii','iii','iv','v','vi','vii','viii','ix'])}
    for id,name_ru in snapshot['roster']:
        p = snapshot['pokemon'][f'pokemon/{id}']
        species = snapshot['pokemon'][f'pokemon-species/{id}']
        chain_id = resource_id(species['evolution_chain']['url'])
        chain = snapshot['chains'][str(chain_id)]
        stats = {camel(s['stat']['name'].replace('-','_')):s['base_stat'] for s in p['stats']}
        result.append({
            'id':id,'name':p['name'],'nameEn':p['name'].title(),'nameRu':name_ru,
            'types':[t['type']['name'] for t in sorted(p['types'],key=lambda t:t['slot'])],
            'stats':stats,'height':p['height']/10,'weight':p['weight']/10,
            'abilities':[{'name':a['ability']['name'],'isHidden':a['is_hidden'],'slot':a['slot'],'url':absolute_urls(a['ability']['url'])} for a in p['abilities']],
            'art':f'pokemon/{id}.webp','artSource':p['artSource'],
            'evolution':flatten_chain(chain),
            'evolutionChain':{'id':chain_id,'url':absolute_urls(species['evolution_chain']['url']),'babyTriggerItem':absolute_urls(chain['baby_trigger_item'])},
            'generation':generations[species['generation']['name'].replace('generation-','')],
            'isLegendary':species['is_legendary'],'isMythical':species['is_mythical'],
            'speciesUrl':f'https://pokeapi.co/api/v2/pokemon-species/{id}/',
            'pokemonUrl':f'https://pokeapi.co/api/v2/pokemon/{id}/',
        })
    types = []
    for id in range(1,19):
        t = snapshot['types'][str(id)]
        types.append({'id':id,'name':t['name'],'nameRu':TYPE_RU[t['name']],
                      'damageRelations':{camel(k):[x['name'] for x in v] for k,v in t['damage_relations'].items()},
                      'sourceUrl':f'https://pokeapi.co/api/v2/type/{id}/'})
    write_json(DATA/'pokemon.json',result)
    write_json(DATA/'types.json',types)
    sources = snapshot['sources']
    art = json.loads((DATA/'art-manifest.json').read_text()) if (DATA/'art-manifest.json').exists() else []
    for asset in art:
        path = ROOT/'public'/asset['file']
        asset['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        asset['sourceUrl'] = next(s['url'] for s in sources if s['resource']=='official-artwork' and s['id']==asset['id'])
    provenance = {
        'schemaVersion':1,
        'snapshotDate':snapshot.get('snapshotDate','2026-10-03'),
        'fetchedAt':snapshot.get('fetchedAt','2026-10-03T23:11:24Z'),
        'canonicalSource':{'name':'PokéAPI','url':'https://pokeapi.co/','documentation':'https://pokeapi.co/docs/v2',
                           'snapshotRepository':'https://github.com/PokeAPI/api-data','artworkRepository':'https://github.com/PokeAPI/sprites'},
        'retrievalMethod':snapshot.get('retrievalMethod','Connected GitHub read-only file API; original PokeAPI JSON mirror and base64 official-artwork PNGs'),
        'scope':{'species':24,'types':18,'forms':'Standard/default forms only; evolution conditions include full canonical species families and form/version-specific alternatives',
                 'typeChart':'Current main-series 18-type damage relations; dual types multiply. No ability, move, weather, item, Terastallization, or other battle modifiers'},
        'units':{'height':'metres, converted from PokéAPI decimetres by dividing by 10','weight':'kilograms, converted from PokéAPI hectograms by dividing by 10','stats':'base stats, not level-specific battle stats'},
        'localization':{'language':'ru','method':'Manually curated species and type display labels; English slugs and numeric canonical fields retain source values',
                        'evolutionSummaries':'Concise editorial Russian translations. The requirements array is canonical; consult its versionGroup and form fields for game-specific alternatives'},
        'disclaimers':[
            'Unofficial fan project; not affiliated with or endorsed by Nintendo, Creatures, GAME FREAK, or The Pokémon Company.',
            'Pokémon and Pokémon character names/artwork are trademarks and copyrighted property of their respective owners. Artwork is reproduced from the PokeAPI official-artwork repository; no ownership or general artwork licence is claimed.',
            'PokéAPI is a community-maintained data source, not an official game API. Data is a dated local snapshot and may change or differ by game version.',
            'Habitats, expedition narratives, field observations, mood tags and other editorial site copy are separate fan-written interpretation, not canonical facts.',
        ],
        'files':sources,'artwork':art,
        'checksums':{file:hashlib.sha256((DATA/file).read_bytes()).hexdigest() for file in ['pokemon.json','types.json','source-snapshot.json']},
    }
    write_json(DATA/'provenance.json',provenance)
    assert len(result)==24 and len(types)==18
    assert len({t for p in result for t in p['types']})==18
    assert all(set(p['stats'])=={'hp','attack','defense','specialAttack','specialDefense','speed'} for p in result)
    assert all((ROOT/'public'/p['art']).exists() for p in result)
    print(f'Built {len(result)} species, {len(types)} types, {len(sources)} source citations, {len(art)} local artworks')

if __name__ == '__main__':
    main()
