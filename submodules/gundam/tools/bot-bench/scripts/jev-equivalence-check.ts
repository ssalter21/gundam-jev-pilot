// Plumbing check: a mock-Jev pilot must play move-for-move like its fallback bot.
import { buildBenchRuntime, PLAYER_ONE, PLAYER_TWO } from "../src/runtime.ts";
import { playAsyncMatch, strategySeat, type Seat } from "../src/jev/async-match.ts";
import { JevPilot } from "../src/jev/pilot.ts";
import { MockJevClient } from "../src/jev/client.ts";
import { loadDeckNotes } from "../src/jev/deck-notes.ts";
import { resolveDeck, resolveStrategy } from "../src/jev/setup.ts";
const notes = loadDeckNotes("jev-decks/seed-aggro.md");
const opp = resolveDeck("gd01-mixed").deck;
const ca = resolveStrategy("combat-aware"), st = resolveStrategy("strategic");
let same = 0, diff = 0;
for (let i = 0; i < 20; i++) {
  const logs: string[][] = [];
  for (const useJev of [true, false]) {
    const log: string[] = [];
    const { runtime, staticResources } = buildBenchRuntime({ p1Deck: notes.deck, p2Deck: opp, seed: `eq-${i}` });
    const pilot = new JevPilot(notes, new MockJevClient(), { fallback: ca });
    const mine: Seat = useJev ? { name: "jev", decide: (c) => pilot.decide(c) } : strategySeat(ca);
    await playAsyncMatch(runtime, staticResources, new Map([[String(PLAYER_ONE), mine], [String(PLAYER_TWO), strategySeat(st)]]),
      { onEvent: (e) => log.push(`${e.playerId}:${e.text}`) });
    log.push(`winner=${runtime.getState().ctx.status.winner}`);
    logs.push(log);
  }
  const a = logs[0]!.join("\n"), b = logs[1]!.join("\n");
  if (a === b) same++; else { diff++; const la = logs[0]!, lb = logs[1]!; const k = la.findIndex((x, j) => x !== lb[j]); console.log(`game ${i} diverges at event ${k}:\n  jev: ${la[k]}\n  ca:  ${lb[k]}`); }
}
console.log(`identical games: ${same}/20, divergent: ${diff}`);
