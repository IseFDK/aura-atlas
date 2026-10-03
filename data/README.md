# Canonical local dataset

- `pokemon.json`: 24 standard-form species with exact base stats, abilities, metric height/weight, complete evolutionary families, generation and source links
- `types.json`: all 18 main-series types with current offensive and defensive damage relations
- `provenance.json`: dated sources, upstream Git blob SHAs, asset sizes/checksums, units, scope and fan-project notices
- `source-snapshot.json`: compact canonical source material, kept for reproducible offline builds
- `art-manifest.json`: 24 transparent local WebP official-artwork files, each under 90 KB

The source of canonical facts is the community-maintained [PokéAPI](https://pokeapi.co/), retrieved through the project's [canonical API-data mirror](https://github.com/PokeAPI/api-data). Artwork was retrieved from [PokeAPI/sprites](https://github.com/PokeAPI/sprites/tree/master/sprites/pokemon/other/official-artwork). Each source file's link and original Git SHA are recorded in `provenance.json`.

English `name` is the source slug; `nameEn` is display capitalization. Russian species/type labels and short evolution summaries are curated display translations. Evolution `requirements` retain every populated source condition, including version group and form constraints. Evolution labels favor the current/default standard-form condition; alternative games and regional conditions remain in the structured data. Height is metres; weight is kilograms; stats are base stats, not level-specific values.

The 18-type table is the modern main-series table. Multiply both defending types for dual-type effectiveness. It excludes abilities, items, weather, move-specific rules, Terastallization and other battle modifiers. No Stellar, Shadow or unknown meta-types are represented.

Habitats, routes, observations, moods and expedition prose belong in separate editorial files. They must not be presented as facts supplied by this snapshot.

## Rebuild

`python scripts/build-pokemon-data.py` rebuilds the derived files without network access.

`python scripts/fetch-pokemon-data.py` manually refreshes source facts and artwork from HTTPS canonical sources (Python 3 and Pillow required), then rebuilds the derived files. The downloader is intentionally separate from the browser app; the deployed site makes no runtime API calls. Review changes before deployment.

## Rights and attribution

Unofficial fan project; no affiliation with or endorsement by Nintendo, Creatures, GAME FREAK or The Pokémon Company. Pokémon names and artwork remain the property of their respective rights holders. PokéAPI's data/software repository licence is not a general licence for Pokémon artwork. No ownership of the supplied artwork is claimed.

Data is a dated community snapshot and conditions can differ by game. Source links are supplied so discrepancies can be checked.
