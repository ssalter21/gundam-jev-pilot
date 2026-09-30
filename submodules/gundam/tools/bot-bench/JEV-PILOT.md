# Jev pilot for the Gundam Card Game

A practice opponent that plays a meta deck the way you describe it in plain English.
The rules engine (TheCardGoat/tcg-engines, MIT) handles every rule and card effect.
Jev (TypeSafe's System One model) makes each decision as a Choice over the legal moves.

## How it works

For every decision the bot sends Jev:
- the deck's overview (overall strategy), key plays, all its game plans, its rules, and notes for the
  cards currently visible
- the playstyle guide for the deck's playstyle (`jev-guides/aggro.md`, `midrange.md`, `control.md`)
  and the general how-to-play guide (`jev-guides/how-to-play.md`)
- the **current game plan** and the turn it started (this is the multi-turn memory)
- the last ~14 things that happened (both players)
- the board, with every number already worked out by the engine: effective AP, HP left, shields,
  base HP, active resources, total AP, active Blockers
- each legal move in plain English with its outcome already calculated
  ("Attack enemy Loto (AP 3, HP 2 left) with Strike (AP 4, HP 3 left): enemy is destroyed, mine survives")

At the start of each of its turns it asks one extra question: which game plan applies now.
The answer is kept and sent with every decision until its next turn.

If a Jev call fails, that one decision falls back to the engine's `combat-aware` bot, and the
game carries on. The run summary shows how many fallbacks happened.

Jev never sees your hand or your deck order.

## Setup (once)

Needs Node 22.18+ (you have 24) and pnpm 10.33 via corepack. From the repo root in PowerShell:

```powershell
corepack enable            # needs an admin terminal; if it fails, write "corepack pnpm" wherever this says "pnpm"
corepack prepare pnpm@10.33.0 --activate
cd submodules\gundam
$env:CI = "1"; pnpm install --frozen-lockfile; Remove-Item Env:CI
```

(`CI=1` skips a `prepare` hook that installs git hooks via the `vp` tool; leave it out if you want those.)

Get an API key at https://console.typesafe.ai and set it for the session, or permanently:

```powershell
$env:TYPESAFE_API_KEY = "sk-..."                                   # this terminal only
[Environment]::SetEnvironmentVariable("TYPESAFE_API_KEY", "sk-...", "User")   # permanent (new terminals)
```

Without a key the scripts run a mock that simply copies the built-in `combat-aware` bot, so you
can check everything works first.

All commands below run from `submodules\gundam\tools\bot-bench`. Paths you pass are relative to
that folder. Sanity check first:

```powershell
pnpm jev:check      # expect: identical games: 20/20
```

## Play in the browser (studio)

```sh
pnpm jev:studio      # then open http://localhost:4747
```

- **My decks → + New**: a name and a 50-card list, nothing else. Saved to `my-decks/` (git-ignored).
- **▶ Play**: pick your deck (yours or a built-in one) and a meta deck, optionally show the bot's plan,
  and press Start. Click a move or press 1-9; hover cards for full text. At the end: play again,
  rematch with the same shuffle, and "what the bot was thinking" (the same review as `jev:play`).
- The studio reads `TYPESAFE_API_KEY` when it starts. Without it the Play screen says you're in
  practice mode (the built-in bot).

## Write meta decks in the studio

- **New meta deck**: name it, pick a playstyle (Aggro / Midrange / Control), paste the 50 cards as
  `4x GD05-111` lines. The list is checked as you type: card names, 50 cards, max 4 copies,
  at most 2 colours. Hover a card to see its image and text.
- Fill in the overall strategy, key plays, rules and per-card notes. Game plans are optional when a
  playstyle is set: the deck then uses that playstyle's default plans, or you can copy them in and edit them.
- Save (Ctrl+S) writes `jev-decks/<name>.md`. The green dot means the pilot can load it. The page
  shows the command to play against it.
- **Guides**: edit the how-to-play guide and the three playstyle guides. They're sent to the bot
  on every decision (together about 1,500 tokens per call), so keep them to what changes decisions.

The studio only listens on this machine (127.0.0.1). The `.md` files are the real data; editing them
by hand works too.

## Play against it

```sh
pnpm jev:play --opponent jev-decks/nu-gundam.md --my-deck my-deck.txt
```

- `--my-deck` takes a plain decklist file (`4 GD01-008` per line, 50 cards), a deck-notes `.md`,
  or a built-in id (`ef-starter`, `seed-aggro`, `gd01-mixed`, `topdecks-01` … `topdecks-10`).
- Type the option number. `b` shows the board, `h` toggles card text, `q` concedes.
- Steps where passing is your only option are skipped.
- `--show-plan` prints the bot's plan at the start of each of its turns (spoilers, good for learning).
- `--seed x` replays the same shuffle, so you can replay a game with a different line.
- After the game, `reports/last-game.md` has the bot's plan for each turn and its closest calls.

## Test a deck file against the built-in bots

```sh
pnpm jev:bench --deck jev-decks/nu-gundam.md --vs combat-aware --vs-deck gd01-mixed --matches 10 --verbose
```

- `--vs`: `strategic`, `combat-aware`, `tempo`, `value-ranked`, `greedy-legal`, …
- `--vs-deck`: a built-in id, a decklist file, or another deck-notes `.md`
- `--vs-jev`: make the opponent a Jev pilot too (with `--vs-deck some-deck.md`) for meta-vs-meta
- `--dump reports/requests.jsonl`: save every request and answer, to see exactly what Jev was told
- Seats alternate each game. About 30-45 Jev calls per game.

Baseline for comparison (built-in bots, same engine): `strategic` vs `combat-aware` in the mirror
is roughly even; `strategic` beats `greedy-legal` 60-90% depending on decks. A good deck file
should get the Jev pilot at or above `combat-aware`.

## Writing a meta deck file

Use the studio, or copy `jev-decks/TEMPLATE.md`. `jev-decks/nu-gundam.md` is an example. The quality of the
opponent comes almost entirely from the plans and rules: write them as conditions and priorities,
the way you'd coach a newer player on the deck.

Workflow that works well:
1. Write the file, run `jev-bench --verbose` against `combat-aware` for 10 games.
2. Read the moves that look wrong, and the low-confidence calls in the review.
   Low confidence usually means your notes don't cover that situation.
3. Add a rule or sharpen a plan's "When", rerun.

## Files

- `src/jev/deck-notes.ts`: reads the deck `.md` files
- `src/jev/guides.ts`: reads `jev-guides/*.md` (how-to-play + playstyle guides and their default plans)
- `src/jev/deck-form.ts`: studio form ⇄ deck Markdown, decklist check against the card database
- `src/jev/play-session.ts`: one human-vs-Jev game a UI can drive (waits for `choose()`), plus the review builder
- `scripts/jev-studio.ts` + `studio/index.html`: the web UI (`pnpm jev:studio`)
- `src/jev/describe.ts`: board and moves to plain English, all maths done here
- `src/jev/client.ts`: Jev HTTP client (`POST /v1/systemone`) and the offline mock
- `src/jev/pilot.ts`: the bot: plan memory, event history, the two Jev questions, fallback
- `src/jev/async-match.ts`: game loop that lets a seat wait on Jev or on you
- `scripts/jev-play.ts`, `scripts/jev-bench.ts`: the two tools
- `scripts/jev-equivalence-check.ts` (`pnpm jev:check`): plumbing test; mock pilot must match `combat-aware` move for move
