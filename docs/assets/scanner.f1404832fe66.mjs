import {TYPE_RU,multiplier} from './logic.f1404832fe66.mjs';
import {badges} from './view.f1404832fe66.mjs';
// A small, dependable type lesson. No GPU, animation, external model or network.
export function mountScanner(host,pokemon,chart){
  if(!host)return;
  const species=host.querySelector('#scan-species'),attack=host.querySelector('#scan-attack'),result=host.querySelector('#scan-result'),art=host.querySelector('#scan-art'),types=host.querySelector('#scan-types');
  if(!species||!attack||!result||!art||!types)return;
  function render(){
    const p=pokemon.find(p=>p.id===Number(species.value));
    if(!p||!Object.hasOwn(TYPE_RU,attack.value)){result.textContent='Выбери покемона и тип атаки.';return;}
    const value=multiplier(attack.value,p.types,chart),label=value===0?'Иммунитет по типам.':value<1?'Сопротивление по типам.':value>1?'Слабость по типам.':'Обычный типовой урон.';
    art.src=p.art;art.alt=`${p.nameRu} — официальная иллюстрация`;types.innerHTML=badges(p.types);
    result.textContent=`${TYPE_RU[attack.value]} → ${p.nameRu}: ×${String(value).replace('.',',')}. ${label}`;
    host.dataset.damage=value===0?'immune':value>1?'weak':value<1?'resist':'neutral';
  }
  species.addEventListener('change',render);attack.addEventListener('change',render);render();
}
