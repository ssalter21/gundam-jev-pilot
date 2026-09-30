# Gundam Jev Pilot

A practice opponent for the [Gundam Card Game](https://www.gundam-gcg.com/) that plays a meta deck
the way you describe it in plain English.

You write the deck's list, strategy, key plays and card notes. A rules engine handles every rule and
card effect. For each decision, Jev (TypeSafe's System One model) picks one of the engine's legal
moves, guided by your notes and a set of gameplay guides.

> Built on [TheCardGoat/tcg-engines](https://github.com/TheCardGoat/tcg-engines) (MIT). Their
> original README is in [UPSTREAM-README.md](UPSTREAM-README.md). This is a personal project and is
> not affiliated with Bandai or TCG Online.

## How it works

- **The engine** decides what's legal and resolves everything. The bot can only pick from moves the
  engine offers.
- **The board and each move are described in plain English**, with every number already worked out.
  For example, "Attack enemy Loto (AP 3, HP 2 left) with Strike (AP 4, HP 3 left): enemy is destroyed,
  mine survives".
- **Game plans give it memory.** At the start of each of its turns, the bot picks which of the deck's
  plans applies ("When: … Do: …") and follows it until its next turn.
- **Guides** give it general knowledge: a how-to-play guide for every deck, plus an Aggro, Midrange or
  Control guide depending on the deck's playstyle.
- **It never sees hidden information**, such as your hand or deck order.
- **If a Jev call fails**, that one decision falls back to the engine's built-in `combat-aware` bot.

## Quick start

Needs Node 22.18+ and pnpm 10.33 through corepack. From the repo root:

```bash
corepack prepare pnpm@10.33.0 --activate
cd submodules/gundam
CI=1 corepack pnpm install --frozen-lockfile
cd tools/bot-bench
corepack pnpm jev:check        # plumbing test: expect "identical games: 20/20"
```

In PowerShell, set `$env:CI = "1"` before the install instead of prefixing the command with `CI=1`.
If `corepack enable` works on your machine, you can type `pnpm` in place of `corepack pnpm`.

To use real Jev, get a key from https://console.typesafe.ai and set `TYPESAFE_API_KEY`. Without a key,
everything runs against a mock that copies the built-in `combat-aware` bot, which is useful for
checking your setup.

## Play in the browser

```bash
corepack pnpm jev:studio       # open http://localhost:4747
```

1. **My decks → + New**: name it and paste your 50 cards (`4x GD05-111`). No notes needed.
2. **▶ Play**: pick your deck (or a built-in one), pick the meta deck to face, press **Start game**.
3. Click a move (or press 1-9). Hover any card to see it full size with its text. Afterwards you can
   rematch with the same shuffle and see what the bot was thinking.

Your own decks are saved in `submodules/gundam/tools/bot-bench/my-decks/`, which is kept out of git.

## Write a meta deck in the studio

In the same studio, **Meta decks → + New**:

- Paste the 50 cards in standard notation (`4x GD05-111`). The list is checked as you type: card
  names, exactly 50 cards, at most 4 copies, at most 2 colours.
- Pick a playstyle and write the overall strategy, key plays, rules and per-card notes.
- Game plans are optional. Without them, the deck uses its playstyle's default plans.
- Edit the how-to-play and playstyle guides.

Decks are saved as Markdown in `submodules/gundam/tools/bot-bench/jev-decks/`, and you can edit them
by hand too. See [`TEMPLATE.md`](submodules/gundam/tools/bot-bench/jev-decks/TEMPLATE.md) and the
example deck [`nu-gundam.md`](submodules/gundam/tools/bot-bench/jev-decks/nu-gundam.md).

## Play in the terminal

```bash
corepack pnpm jev:play --opponent jev-decks/nu-gundam.md --my-deck gd01-mixed --show-plan
```

- `--my-deck` takes a decklist file, a deck `.md` file, or a built-in deck id.
- To play, type the number of the move you want.
- `--show-plan` prints the bot's plan at the start of each of its turns.
- After the game, `reports/last-game.md` shows the bot's plans and its closest decisions.

To test a deck against the built-in bots:

```bash
corepack pnpm jev:bench --deck jev-decks/nu-gundam.md --vs combat-aware --vs-deck gd01-mixed --matches 10 --verbose
```

[JEV-PILOT.md](submodules/gundam/tools/bot-bench/JEV-PILOT.md) has the full options and tips for
writing decks that play well.

## Repo layout

Only the Gundam workspace and the shared simulator are included. Everything added by this project
is in `submodules/gundam/tools/bot-bench/`:

| Path | What it is |
| --- | --- |
| `jev-decks/` | Meta deck files (Markdown) |
| `jev-guides/` | How-to-play guide and Aggro / Midrange / Control guides |
| `src/jev/` | Deck parser, plain-English describer, Jev client, pilot, match loop |
| `scripts/jev-*.ts` | `jev:play`, `jev:bench`, `jev:check`, `jev:studio` |
| `studio/index.html` | The studio's web page (play, my decks, meta decks, guides) |
| `my-decks/` | Your own decks saved from the studio (git-ignored) |

## Status

Everything works end to end against the mock, including full games and the studio. It has not yet
been tuned against real Jev.

## License

MIT, same as the upstream project. See [LICENSE](LICENSE).
