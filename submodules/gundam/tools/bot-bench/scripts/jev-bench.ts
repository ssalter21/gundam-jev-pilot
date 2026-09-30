#!/usr/bin/env node
/**
 * Jev pilot vs a built-in bot, N games, seats alternating.
 *
 *   node --experimental-transform-types --no-warnings scripts/jev-bench.ts \
 *     --deck jev-decks/nu-gundam.md \
 *     --vs combat-aware --vs-deck gd01-mixed \
 *     --matches 10 [--mock] [--dump reports/jev-requests.jsonl] [--verbose]
 *
 * --vs-deck accepts a bench deck id or another deck-notes .md file.
 * --vs-jev  makes the opponent a Jev pilot too (needs --vs-deck to be a .md file).
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { buildBenchRuntime, PLAYER_ONE, PLAYER_TWO } from "../src/runtime.ts";
import { playAsyncMatch, strategySeat, type Seat } from "../src/jev/async-match.ts";
import { JevPilot } from "../src/jev/pilot.ts";
import { makeClient, parseArgs, resolveDeck, resolveStrategy } from "../src/jev/setup.ts";

const args = parseArgs(process.argv.slice(2));
if (typeof args.deck !== "string") {
  console.error("Usage: jev-bench --deck <notes.md> [--vs combat-aware] [--vs-deck gd01-mixed] [--matches 10] [--mock]");
  process.exit(1);
}

const mine = resolveDeck(args.deck);
if (!mine.notes) throw new Error("--deck must be a deck-notes .md file (the Jev pilot needs the notes).");
const theirs = resolveDeck(typeof args["vs-deck"] === "string" ? args["vs-deck"] : "gd01-mixed");
const vsId = typeof args.vs === "string" ? args.vs : "combat-aware";
const matches = Number(args.matches ?? 10);
const fallback = resolveStrategy("combat-aware");
const dumpPath = typeof args.dump === "string" ? args.dump : undefined;
if (dumpPath) mkdirSync(dirname(dumpPath), { recursive: true });

const client = makeClient(args);
let wins = 0;
let losses = 0;
let other = 0;
const totals = { calls: 0, fallbacks: 0, latency: 0, tokens: 0 };
const planCounts = new Map<string, number>();
const started = Date.now();

console.log(
  `Jev pilot (${mine.notes.name}) vs ${args["vs-jev"] ? "Jev pilot" : vsId} (${theirs.deck.name}), ${matches} games, client=${client.name}\n`,
);

for (let i = 0; i < matches; i++) {
  const jevSeat = i % 2 === 0 ? PLAYER_ONE : PLAYER_TWO;
  const oppSeat = jevSeat === PLAYER_ONE ? PLAYER_TWO : PLAYER_ONE;
  const pilot = new JevPilot(mine.notes, client, {
    fallback,
    ...(dumpPath ? { dumpPath } : {}),
    onPlan: (p) => planCounts.set(p.plan, (planCounts.get(p.plan) ?? 0) + 1),
    ...(args.verbose
      ? {
          onDecision: (d) =>
            console.log(`   T${d.turn} [${d.plan}] ${d.chosen}  (p=${d.confidence.toFixed(2)})`),
        }
      : {}),
  });

  let oppSeatImpl: Seat;
  let oppPilot: JevPilot | undefined;
  if (args["vs-jev"]) {
    if (!theirs.notes) throw new Error("--vs-jev needs --vs-deck to be a deck-notes .md file.");
    oppPilot = new JevPilot(theirs.notes, client, { fallback });
    oppSeatImpl = { name: oppPilot.name, decide: (ctx) => oppPilot!.decide(ctx) };
  } else {
    oppSeatImpl = strategySeat(resolveStrategy(vsId));
  }

  const p1Deck = jevSeat === PLAYER_ONE ? mine.deck : theirs.deck;
  const p2Deck = jevSeat === PLAYER_ONE ? theirs.deck : mine.deck;
  const { runtime, staticResources } = buildBenchRuntime({ p1Deck, p2Deck, seed: `jev-${i}` });

  const seats = new Map<string, Seat>([
    [String(jevSeat), { name: pilot.name, decide: (ctx) => pilot.decide(ctx) }],
    [String(oppSeat), oppSeatImpl],
  ]);
  const result = await playAsyncMatch(runtime, staticResources, seats, {
    onEvent: (e) => {
      const mineActed = e.playerId === String(jevSeat);
      pilot.observe(`Turn ${e.turn}: ${mineActed ? "I" : "Opponent"} ${e.text}`);
      oppPilot?.observe(`Turn ${e.turn}: ${mineActed ? "Opponent" : "I"} ${e.text}`);
    },
  });

  const won = result.winner === String(jevSeat);
  if (won) wins++;
  else if (result.winner) losses++;
  else other++;
  totals.calls += pilot.stats.jevCalls;
  totals.fallbacks += pilot.stats.fallbacks;
  totals.latency += pilot.stats.totalLatencyMs;
  totals.tokens += pilot.stats.inputTokens;
  const plans = pilot.planHistory.map((p) => `T${p.turn}:${p.plan}`).join(" ");
  console.log(
    `Game ${i + 1}: ${won ? "WIN " : result.winner ? "LOSS" : "----"} (${jevSeat === PLAYER_ONE ? "seat 1" : "seat 2"}, ${result.turns} turns, ${result.winReason ?? result.termination}) ` +
      `jev calls=${pilot.stats.jevCalls} fallbacks=${pilot.stats.fallbacks}${pilot.stats.lastError ? ` lastError="${pilot.stats.lastError.slice(0, 120)}"` : ""}\n   plans: ${plans}`,
  );
}

const played = wins + losses + other;
console.log(`\nJev pilot: ${wins}W ${losses}L ${other} unfinished  (${((100 * wins) / Math.max(1, played)).toFixed(0)}% win rate)`);
console.log(
  `Jev calls: ${totals.calls}, fallbacks: ${totals.fallbacks}, avg latency: ${(totals.latency / Math.max(1, totals.calls)).toFixed(0)}ms, input tokens: ${totals.tokens}`,
);
console.log(`Plans chosen: ${[...planCounts].map(([k, v]) => `${k}=${v}`).join(", ")}`);
console.log(`Wall time: ${((Date.now() - started) / 1000).toFixed(1)}s`);
