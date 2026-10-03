#!/usr/bin/env python3
"""Refresh the curated local PokeAPI snapshot and compressed official artwork.

Requires Python 3 and Pillow, network access to pokeapi.co / raw.githubusercontent.com.
No credentials, external packages beyond Pillow, or client-side API calls are used.
Run manually from any directory, review changes, then run build-pokemon-data.py.
The existing snapshot is retained if any download or validation fails.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
import argparse
import hashlib
import io
import json
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT/'data'
API = 'https://pokeapi.co/api/v2/'
MIRROR = 'https://raw.githubusercontent.com/PokeAPI/api-data/master/data/api/v2/'
ART = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/'

def get_bytes(url):
    req = urllib.request.Request(url,headers={'User-Agent':'AURA-ATLAS-local-snapshot/1.0'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req,timeout=30) as response:
                return response.read()
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt+1)

def get_json(job):
    resource,id = job
    api_url = f'{API}{resource}/{id}/'
    mirror_url = f'{MIRROR}{resource}/{id}/index.json'
    for url in [api_url,mirror_url]:
        try:
            content = get_bytes(url)
            payload = json.loads(content)
            assert payload['id'] == id
            return resource,id,payload,{'resource':resource,'id':id,'url':url,'contentSha256':hashlib.sha256(content).hexdigest()}
        except Exception as exc:
            last_error = exc
    raise RuntimeError(f'Could not fetch {resource}/{id}: {last_error}')

def resource_id(url):
    return int(url.rstrip('/').split('/')[-1])

def compact(resource,obj):
    if resource == 'pokemon':
        return {key:obj[key] for key in ['id','name','height','weight','abilities','stats','types','species']} | {'artSource':obj['sprites']['other']['official-artwork']['front_default']}
    if resource == 'pokemon-species':
        return {key:obj[key] for key in ['id','name','generation','evolution_chain','is_legendary','is_mythical','habitat','shape','color']}
    if resource == 'type':
        return {key:obj[key] for key in ['id','name','damage_relations']}
    return obj

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workers',type=int,default=4)
    args = parser.parse_args()
    old = json.loads((DATA/'source-snapshot.json').read_text())
    roster = old['roster']
    now = datetime.now(timezone.utc)
    snapshot = {'roster':roster,'pokemon':{},'chains':{},'types':{},'sources':[],
                'snapshotDate':now.date().isoformat(),'fetchedAt':now.isoformat(timespec='seconds').replace('+00:00','Z'),
                'retrievalMethod':'Python urllib HTTPS downloads: live PokeAPI, with canonical PokeAPI/api-data mirror fallback; official-artwork PNGs from PokeAPI/sprites'}
    jobs = [(resource,id) for resource in ['pokemon','pokemon-species'] for id,_ in roster]
    with ThreadPoolExecutor(max_workers=max(1,min(8,args.workers))) as pool:
        for resource,id,obj,source in pool.map(get_json,jobs):
            snapshot['pokemon'][f'{resource}/{id}'] = compact(resource,obj)
            snapshot['sources'].append(source)
        ids = sorted({resource_id(obj['evolution_chain']['url']) for key,obj in snapshot['pokemon'].items() if key.startswith('pokemon-species/')})
        jobs = [('evolution-chain',id) for id in ids] + [('type',id) for id in range(1,19)]
        for resource,id,obj,source in pool.map(get_json,jobs):
            snapshot['chains' if resource=='evolution-chain' else 'types'][str(id)] = compact(resource,obj)
            snapshot['sources'].append(source)
    with tempfile.TemporaryDirectory(prefix='aura-snapshot-') as tmp:
        stage = Path(tmp)
        manifest = []
        def art_job(entry):
            id,_ = entry
            url = ART + str(id) + '.png'
            content = get_bytes(url)
            im = Image.open(io.BytesIO(content)).convert('RGBA')
            im.thumbnail((475,475),Image.Resampling.LANCZOS)
            path = stage/f'{id}.webp'
            im.save(path,'WEBP',quality=88,method=6)
            if path.stat().st_size >= 90000:
                im.save(path,'WEBP',quality=76,method=6)
            assert path.stat().st_size < 90000
            asset = {'id':id,'file':f'pokemon/{id}.webp','bytes':path.stat().st_size,'width':im.width,'height':im.height}
            source = {'resource':'official-artwork','id':id,'url':url,'contentSha256':hashlib.sha256(content).hexdigest()}
            return asset,source
        with ThreadPoolExecutor(max_workers=max(1,min(8,args.workers))) as pool:
            for asset,source in pool.map(art_job,roster):
                manifest.append(asset)
                snapshot['sources'].append(source)
        for id,_ in roster:
            shutil.copyfile(stage/f'{id}.webp',ROOT/'public/pokemon'/f'{id}.webp')
        (DATA/'source-snapshot.json').write_text(json.dumps(snapshot,ensure_ascii=False,indent=2)+'\n')
        (DATA/'art-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    subprocess.run([sys.executable,str(ROOT/'scripts/build-pokemon-data.py')],check=True)
    print('Snapshot refreshed. Review the diff before publishing.')

if __name__ == '__main__':
    main()
