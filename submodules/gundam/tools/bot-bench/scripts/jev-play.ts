#!/usr/bin/env node
/**
 * Play a game against the Jev pilot in your terminal.
 *
 *   node --experimental-transform-types --no-warnings scripts/jev-play.ts \
 *     --opponent jev-decks/nu-gundam.md \
 *     --my-deck my-deck.txt            (or a bench deck id like gd01-mixed, or a .md)
 *     [--seed anything] [--mock] [--show-plan]
 *
 * At each prompt type the option number. Other commands:
 *   b = show the board again    h = hide/show card text    q = concede and quit
 *
 * Moments where passing is your only option are skipped automatically.
 * After the game you get the bot's plan for each turn and its closest calls,
 * saved to reports/last-game.md.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

import type { CandidateStrategyContext, GundamBotCandidate } from "@tcg/gundam-engine";

import { buildBenchRuntime, PLAYER_ONE, PLAYER_TWO } from "../src/runtime.ts";
import { playAsyncMatch, type Seat } from "../src/jev/async-match.ts";
import { describeBoard, describeCandidate, type BoardFacts } from "../src/jev/describe.ts";
import { JevPilot, type PilotDecisionLog } from "../src/jev/pilot.ts";
import { makeClient, parseArgs, resolveDeck, resolveStrategy } from "../src/jev/setup.ts";

const args = parseArgs(process.argv.slice(2));
if (typeof args.opponent !== "string" || typeof args["my-deck"] !== "string") {
  console.error("Usage: jev-play --opponent <meta-deck.md> --my-deck <deck.txt|deck.md|bench-id> [--seed x] [--mock] [--show-plan]");
  process.exit(1);
}

const bot = resolveDeck(args.opponent);
if (!bot.notes) throw new Error("--opponent must be a deck-notes .md file.");
const me = resolveDeck(args["my-deck"]);
const seed = typeof args.seed === "string" ? args.seed : `play-${Date.now()}`;
const client = makeClient(args);
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
const lineQueue: string[] = [];
const lineWaiters: ((line: string | null) => void)[] = [];
let inputClosed = false;
rl.on("line", (line) => {
  const waiter = lineWaiters.shift();
  if (waiter) waiter(line);
  else lineQueue.push(line);
});
rl.on("close", () => {
  inputClosed = true;
  for (const w of lineWaiters.splice(0)) w(null);
});
/** Next line of input, or null once input has closed. */
function ask(prompt: string): Promise<string | null> {
  process.stdout.write(prompt);
  if (lineQueue.length) return Promise.resolve(lineQueue.shift()!);
  if (inputClosed) return Promise.resolve(null);
  return new Promise((resolve) => lineWaiters.push(resolve));
}

const decisions: PilotDecisionLog[] = [];
const pilot = new JevPilot(bot.notes, client, {
  fallback: resolveStrategy("combat-aware"),
  onDecision: (d) => decisions.push(d),
  onPlan: (p) => {
    if (args["show-plan"]) console.log(`\n  [bot plan for turn ${p.turn}: ${p.plan} (${(p.confidence * 100).toFixed(0)}%)]`);
  },
});

// You are seat 1; who goes first is decided in-game by the first-player choice.
const HUMAN = PLAYER_ONE;
const BOT = PLAYER_TWO;
const { runtime, staticResources } = buildBenchRuntime({ p1Deck: me.deck, p2Deck: bot.deck, seed });

let showText = true;
let pendingBotEvents: string[] = [];
let lastBoardKey = "";

function renderBoard(b: BoardFacts): string {
  const unit = (u: BoardFacts["me"]["units"][number]) =>
    `    ${u.status === "rested" ? "(rested) " : ""}${u.name}  AP ${u.ap} / HP ${u.hp_left}` +
    `${u.pilot ? `  + ${u.pilot}` : ""}${u.keywords ? `  [${u.keywords}]` : ""}` +
    `${showText && u.text ? `\n        ${u.text}` : ""}`;
  const lines = [
    "",
    `══ Turn ${b.turn} · ${b.whose_turn === "mine" ? "YOUR turn" : "Bot's turn"} · ${b.phase} ══`,
    `BOT   level ${b.opponent.level} (${b.opponent.resources_active} active) · ${b.opponent.defences} · ${b.opponent.cards_in_hand} in hand · ${b.opponent.cards_in_deck} in deck`,
    ...(b.opponent.units.length ? b.opponent.units.map(unit) : ["    (no units)"]),
    `YOU   level ${b.me.level} (${b.me.resources_active} active) · ${b.me.defences} · ${b.me.cards_in_deck} in deck`,
    ...(b.me.units.length ? b.me.units.map(unit) : ["    (no units)"]),
    "  Hand:",
    ...b.me.hand.map(
      (h) =>
        `    ${h.copies > 1 ? `${h.copies}x ` : ""}${h.name}  (${h.type}, Lv${h.level}, cost ${h.cost}${h.stats ? `, ${h.stats}` : ""})` +
        `${showText && h.text ? `\n        ${h.text}` : ""}`,
    ),
  ];
  if (b.pending_prompt) lines.push(`  Effect waiting on you: ${b.pending_prompt}`);
  return lines.join("\n");
}

const human: Seat = {
  name: "you",
  async decide(ctx: CandidateStrategyContext): Promise<readonly GundamBotCandidate[]> {
    const options: { text: string; c: GundamBotCandidate }[] = [];
    const seen = new Set<string>();
    for (const c of ctx.candidates) {
      const text = describeCandidate(ctx, c);
      if (text && !seen.has(text)) {
        seen.add(text);
        options.push({ text, c });
      }
    }
    const isPass = (c: GundamBotCandidate) =>
      c.family === "passActionStep" || c.family === "passBattleAction";
    if (options.length === 1 && isPass(options[0]!.c)) return [options[0]!.c];

    const board = describeBoard(ctx);
    if (pendingBotEvents.length) {
      console.log(`\nBot: ${pendingBotEvents.join("\n     ")}`);
      pendingBotEvents = [];
    }
    const key = JSON.stringify(board);
    if (key !== lastBoardKey) {
      console.log(renderBoard(board));
      lastBoardKey = key;
    }
    console.log("\nYour options:");
    options.forEach((o, i) => console.log(`  ${String(i + 1).padStart(2)}. ${o.text}`));

    for (;;) {
      const line = await ask("> ");
      if (line === null) return ctx.candidates.filter((c) => c.family === "concede");
      const answer = line.trim().toLowerCase();
      if (answer === "b") {
        console.log(renderBoard(board));
        continue;
      }
      if (answer === "h") {
        showText = !showText;
        console.log(renderBoard(board));
        continue;
      }
      if (answer === "q") return ctx.candidates.filter((c) => c.family === "concede");
      const n = Number(answer);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return [options[n - 1]!.c];
      console.log(`Type 1-${options.length}, b (board), h (toggle card text) or q (concede).`);
    }
  },
};

const botSeat: Seat = {
  name: pilot.name,
  async decide(ctx) {
    return pilot.decide(ctx);
  },
};

console.log(`You (${me.deck.name}) vs Jev pilot (${bot.notes.name}) · client=${client.name} · seed=${seed}`);

const result = await playAsyncMatch(
  runtime,
  staticResources,
  new Map<string, Seat>([
    [String(HUMAN), human],
    [String(BOT), botSeat],
  ]),
  {
    onEvent: (e) => {
      const botActed = e.playerId === String(BOT);
      pilot.observe(`Turn ${e.turn}: ${botActed ? "I" : "Opponent"} ${e.text}`);
      if (botActed) pendingBotEvents.push(e.text);
    },
  },
);
rl.close();

if (pendingBotEvents.length) console.log(`\nBot: ${pendingBotEvents.join("\n     ")}`);
const youWon = result.winner === String(HUMAN);
console.log(`\n${youWon ? "YOU WIN" : result.winner ? "BOT WINS" : "Game ended"} · turn ${result.turns} · ${result.winReason ?? result.termination}`);

// Post-game review
const review: string[] = [
  `# Game review: you (${me.deck.name}) vs ${bot.notes.name}`,
  "",
  `Result: ${youWon ? "you won" : result.winner ? "bot won" : "no winner"} on turn ${result.turns} (${result.winReason ?? result.termination}). Seed: \`${seed}\``,
  "",
  "## What the bot was planning",
  ...pilot.planHistory.map(
    (p) => `- Turn ${p.turn}: **${p.plan}** (${(p.confidence * 100).toFixed(0)}%) · ${Object.entries(p.probabilities).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(", ")}`,
  ),
  "",
  "## Its closest calls (lowest confidence)",
  ...[...decisions]
    .sort((a, b) => a.confidence - b.confidence)
    .slice(0, 8)
    .map(
      (d) =>
        `- Turn ${d.turn} [${d.plan}] chose: ${d.chosen} (${(d.confidence * 100).toFixed(0)}%)\n` +
        d.alternatives.map((a) => `  - vs ${a.action} (${(a.p * 100).toFixed(0)}%)`).join("\n"),
    ),
  "",
  `Jev calls: ${pilot.stats.jevCalls}, fallbacks to the built-in bot: ${pilot.stats.fallbacks}${pilot.stats.lastError ? ` (last error: ${pilot.stats.lastError})` : ""}`,
];
mkdirSync("reports", { recursive: true });
writeFileSync("reports/last-game.md", review.join("\n"));
console.log(`\n${review.slice(4).join("\n")}\n\nSaved to reports/last-game.md`);
