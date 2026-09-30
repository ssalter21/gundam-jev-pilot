# gundam-jev-pilot

Personal practice tool for the Gundam Card Game: a bot opponent that pilots a "meta" deck
according to plain-English notes, with each decision made by Jev (TypeSafe's System One model).

This repo is a sparse clone of TheCardGoat/tcg-engines (MIT). Only `submodules/gundam` and
`submodules/agnostic-simulator` are checked out. `origin` is upstream; our work is on branch
`jev-pilot`. To pull engine updates: `git fetch origin && git merge origin/main` (or rebase).

## Where things are

- `submodules/gundam/` — upstream Gundam rules engine, cards, bots. Read its `AGENTS.md` before
  touching rules/engine code (on Windows its `CLAUDE.md` is a symlink stub, so read `AGENTS.md`
  directly). Avoid editing engine packages; build on the public API from `@tcg/gundam-engine`.
- `submodules/gundam/tools/bot-bench/` — upstream self-play bench. **All our code lives here:**
  - `JEV-PILOT.md` — user-facing README: setup, commands, deck file format. Keep it current.
  - `src/jev/deck-notes.ts` — parses `jev-decks/*.md` (decklist, playstyle, overview, key plays, `### plan`
    sections, rules, card notes). `loadDeckNotes` attaches the guides and, if the deck has no plans, its
    playstyle guide's default plans.
  - `src/jev/guides.ts` — `jev-guides/how-to-play.md` + `aggro.md` / `midrange.md` / `control.md`. Text above
    `## Game plans` is sent to Jev as `game_guide` / `playstyle_guide`; `###` plans below are defaults.
  - `src/jev/deck-form.ts` — studio form ⇄ Markdown (`markdownToForm`/`formToMarkdown`), `checkDecklist`
    (card catalog lookup, 50 cards, ≤4 copies, ≤2 colours)
  - `scripts/jev-studio.ts` + `studio/index.html` — local web UI (`pnpm jev:studio`, 127.0.0.1:4747), vanilla JS, no build
  - `src/jev/describe.ts` — engine state and legal moves → plain English. All arithmetic lives here
    (effective AP/HP via `combatUnitValue`, attack results via `combatOutcome`), because Jev is weak
    at maths/counting. `describeEvent` gives perspective-neutral history lines.
  - `src/jev/client.ts` — `HttpJevClient` (raw fetch, `POST https://api.typesafe.ai/v1/systemone`,
    Bearer `TYPESAFE_API_KEY`) and `MockJevClient` (echoes an oracle ranking; used when no key)
  - `src/jev/pilot.ts` — `JevPilot`: plan memory (plan Choice at the start of each of its turns),
    rolling event history, action Choice per decision, fallback to `combat-aware` on any error
  - `src/jev/async-match.ts` — async game loop; each decision is awaited, then replayed through the
    engine's synchronous `takeAutomatedActionWithFallback` (candidates matched by `candidateKey`)
  - `scripts/jev-play.ts` (terminal human vs bot), `scripts/jev-bench.ts` (bot vs built-in bots),
    `scripts/jev-equivalence-check.ts` (plumbing test)
  - `jev-decks/` — `TEMPLATE.md`, `seed-aggro.md` example
  - `jev-guides/` — how-to-play and playstyle guides

## Commands (run in `submodules/gundam/tools/bot-bench`)

- `pnpm jev:studio` — deck/guide editor at http://localhost:4747
- `pnpm jev:check` — must print `identical games: 20/20`. Run after any change to describe/pilot/loop.
- `pnpm jev:bench --deck jev-decks/seed-aggro.md --vs combat-aware --vs-deck gd01-mixed --matches 10 [--mock] [--verbose] [--dump reports/req.jsonl]`
- `pnpm jev:play --opponent jev-decks/seed-aggro.md --my-deck gd01-mixed [--show-plan] [--seed x]`
- `pnpm bench -- --p1 strategic --p2 combat-aware ...` — upstream bench for built-in bots
- Typecheck: `..\..\node_modules\.bin\tsc --noEmit -p tsconfig.json` (2 pre-existing errors in
  `agnostic-simulator` are upstream and expected; there should be none in `src/jev` or `scripts/jev-*`)

First-time setup is in `JEV-PILOT.md` (corepack pnpm 10.33, `pnpm install` in `submodules/gundam`).
On this machine `corepack enable` fails without admin; use `corepack pnpm <cmd>`.

## Invariants

- The pilot must only return candidates from `ctx.candidates`; the engine validates every move.
- Never send Jev hidden info (opponent hand, deck order). `describeBoard` uses the player's filtered view.
- Concede is never offered to Jev. Passing-only moments are skipped without a Jev call.
- The deck `.md` files are the source of truth; the studio must round-trip them (`formToMarkdown(markdownToForm(md))`
  loads to the same plans/rules/notes/decklist).
- Keep numbers out of Jev's job: if a decision needs a count or comparison, compute it in `describe.ts`.

## Status and next steps

- Verified: engine setup, mock pilot matches `combat-aware` move for move (20/20), full terminal games,
  typecheck clean. **Not yet run against real Jev** (built in a sandbox without API access).
- First real run: set `TYPESAFE_API_KEY`, `pnpm jev:bench ... --matches 4 --verbose --dump reports/req.jsonl`,
  read the chosen moves and low-confidence calls, tune prompts in `pilot.ts` / deck notes.
- Ideas: browser play via the simulator's `/vs-ai` bot hook (`agnostic-simulator/apps/multi-game-simulator/src/games/gundam/src/game/bot/strategy-bot.ts`
  waits ~800ms before acting; prefetch the Jev ranking on state update and read it at timer expiry;
  needs a small local proxy so the API key isn't in the browser). Per-deck mulligan rules. A Score
  question for "how far ahead am I" to drive plan switching.
