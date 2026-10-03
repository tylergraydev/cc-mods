# booster-pane

Open pretend Pokémon TCG booster packs in a side pane of [Claude Code](https://claude.com/claude-code) while Claude works. Pick a set, open a pack built the way that era's packs were built, and flip the cards one at a time. In the terminal the card art is drawn in the pane; a collection and pull stats are kept between sessions.

> **Status:** built against Claude Code 2.1.288's early-access mod (function hooks) API, which may change between releases. Nothing here is real: packs are simulated, with approximate odds, and no prices or values are shown.

## Install

```sh
claude --plugin-dir C:\code\cc-mods\booster-pane
```

Then type `/booster` in a terminal wide enough for a side pane (or press **show** for booster-pane in mod-menu). If something else already owns `/booster`, the command is `/booster-pane`.

## Commands

| Command | What it does |
|---|---|
| `/booster` | Open the pane on the set list |
| `/booster set <name or id>` | Select a set (`base1`, `sv3pt5`, `rebel clash`); a unique match is selected, several are listed |
| `/booster open` | Open a pack of the selected set |
| `/booster random [series words]` | Select a random set, optionally from matching series (`random sword`) |
| `/booster collection [set]` | What you have pulled, for the selected or a named set |
| `/booster stats` | Packs opened, cards pulled, hits by rarity |
| `/booster clear-cache` | Empty `run/cache` (images and card lists); the collection is kept |

## Keys

With the pane focused: `p` opens a pack, `e` flips the next card (Enter on the focused button too), `f` flips them all, `i` goes back to the sets, `l` shows the collection, `z` picks a random set. Esc returns to the prompt. On the set list, type to search and press Enter to select the first match.

## Where the cards come from

- **TCGdex** ([tcgdex.dev](https://tcgdex.dev), `api.tcgdex.net`, MIT-licensed database, no key) is the primary source: the set list, then a card list per set.
- **api.pokemontcg.io** is the fallback. It is deprecated (its docs say existing keys work through 2027-03-01) and is slow and flaky, so it is only asked when TCGdex fails. Without a key it allows 1,000 requests a day and 30 a minute; with one, 20,000 a day.
- The `source` option picks `auto` (TCGdex, then pokemontcg.io), or one source only. Card ids are kept per source.
- The optional `apiKey` is sent only as an `X-Api-Key` header to api.pokemontcg.io. It is never written to a file, a toast, a log line or a command line.

Requests are retried on network errors and 5xx answers: three tries, waiting 1 s then 3 s. A rate limit (429) is not retried.

## How a pack is built

The slot structure follows the era of the set, with approximate rarity odds. Official pull rates are not published, so every figure below is an estimate; where a public source exists it is named.

| Era | Cards | Slots |
|---|---|---|
| WotC (Base, Gym, Neo, E-Card) | 11 | 7 common, 3 uncommon, 1 rare slot: holo 1 in 3, else rare ([source](https://flipsidegaming.com/blogs/pokemon-blog/a-comprehensive-review-of-rarity-in-the-pokemon-tcg)) |
| EX to HGSS | 10 | 5 common, 3 uncommon, 1 reverse, 1 rare slot: ex 1/12, secret 1/72, holo 1/3 (approximate) |
| BW and XY | 10 | 5 common, 3 uncommon, 1 reverse, 1 rare slot: ex 1/9, ultra 1/36, secret 1/72, holo 1/4 (approximate) |
| SM and SWSH | 10 | 5 common, 3 uncommon, 1 reverse (a special card 1 in 20), 1 rare slot: ex 1/7, VMAX 1/18, ultra 1/36, secret 1/72, holo 1/4 ([source](https://www.digitaltq.com/brilliant-stars-pull-rates-pokemon-tcg), approximate) |
| SV and Mega Evolution | 10 | 4 common, 3 uncommon, reverse (special 1/20), a hit reverse (illustration 1/13, special illustration 1/32, hyper 1/54), 1 rare slot (ex 1/7, ultra 1/15) ([source](https://www.tcgplayer.com/content/article/Pok%C3%A9mon-TCG-Scarlet-Violet-Pull-Rates/a7702fce-dd64-4a58-beb1-0f871c853215/)) |
| Mini sets (under 40 cards, POP, McDonald's, galleries) | up to 4 | one card from rare or better with probability 1/3, the rest uniform |
| Promo sets | 1 | one card, uniform |

A tier a set does not have folds into the slot's base outcome; an empty common or uncommon pool falls back to commons, then any card; draws within a slot group are without replacement. Cards with no rarity count as commons, and there is no basic-energy slot. Cards show in reveal order: commons, uncommons, reverse slots, the rare last. The seed (time, set, pack number) is kept in the pack.

## Card art

In the terminal each card is a static `Raster` built by `scripts/card_cells.py` (Python 3 with Pillow: `python -m pip install pillow`). The helper downloads the small card image once, resizes it to twice the cell grid and packs each 2x2 block into a quadrant glyph and two colours, the same packing as nes-pane. Sizes step down a ladder with the pane: a 40-column slot gets 36x25 cells, a tab of your own up to 60x42. The `artMode` option can show just the illustration window (an approximate crop). Other surfaces (desktop, VS Code, mobile) and any card whose art fails draw a framed text card. The pane waits with a card back and "loading art" while the helper works; two images are converted at a time.

## Options

| Option | Default | Meaning |
|---|---|---|
| `apiKey` | empty | Optional `X-Api-Key` for api.pokemontcg.io |
| `artMode` | `card` | `card` the whole card, `art` only the illustration window |
| `source` | `auto` | `auto`, `pokemontcg` or `tcgdex` |
| `python` | `python` | Python 3 with Pillow: a command on PATH or a full path |

## Cache and data

Everything lives in the mod's `run/` folder, which is git-ignored.

| Path | Contents |
|---|---|
| `run/cache/catalog.json` | the set list, kept 7 days (a stale one still works offline) |
| `run/cache/sets/<set>.json` | a set's card list; written only when whole |
| `run/cache/img/<card>.png` | downloaded card images |
| `run/cache/cells/<card>-<cols>x<rows>-<mode>.json` | the packed cells |
| `run/collection.json` | your pulls: counts per card, packs per set, rarities |

`/booster clear-cache` empties `run/cache` and keeps the collection. A corrupt collection file is copied to `collection.bad-<time>.json` and a fresh one started. The file is read and merged before each write, but two sessions writing at the same moment can still lose a pack.

## Limits

No prices or values (TCGdex returns them; the mod does not show them). No trading. Odds are approximations. Card art needs the terminal and Python with Pillow. The pane needs at least 16 columns, and shows text cards below about 22. Card lists need one of the two APIs to be up the first time a set is opened; after that it works offline.

## Workbench

Hostable: a static `Raster` with a static cell string is an ordinary terminal element, so booster-pane can fill a workbench slot. If the art does not paint inside the slot, release it to its own tab with `/workbench release booster-pane`.

## Legal

Card images, names and data are the property of The Pokémon Company, Nintendo, Creatures and GAME FREAK. They are fetched for personal, non-commercial display only, cached locally in the git-ignored `run/` folder and never redistributed; nothing from the APIs is committed. This project is not produced, endorsed, supported or affiliated with Nintendo or The Pokémon Company. The TCGdex database is MIT-licensed ([tcgdex/cards-database](https://github.com/tcgdex/cards-database)).

## Check

```sh
claude plugin validate ./booster-pane
claude plugin test ./booster-pane
python -m unittest discover -s booster-pane/scripts
```
