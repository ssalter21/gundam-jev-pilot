import { existsSync } from "node:fs";

import type { DeckList } from "@tcg/gundam-engine";

import { REGISTERED_DECKS, type BenchDeckId } from "../runtime.ts";
import { REGISTERED_STRATEGIES, type BenchStrategyId } from "../strategies.ts";
import { HttpJevClient, MockJevClient, type JevClient } from "./client.ts";
import { loadDeckNotes, loadDecklistOnly, type DeckNotes } from "./deck-notes.ts";

export function parseArgs(argv: readonly string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--") || a === "--") continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

/** A deck argument is either a registered bench deck id or a path to a deck-notes .md file. */
export function resolveDeck(arg: string): { deck: DeckList; notes?: DeckNotes } {
  if (arg.endsWith(".md")) {
    const notes = loadDeckNotes(arg);
    return { deck: notes.deck, notes };
  }
  if (existsSync(arg)) return { deck: loadDecklistOnly(arg) };
  const deck = REGISTERED_DECKS[arg as BenchDeckId];
  if (!deck) {
    throw new Error(
      `Unknown deck "${arg}". Use a .md deck-notes file or one of: ${Object.keys(REGISTERED_DECKS).join(", ")}`,
    );
  }
  return { deck };
}

export function resolveStrategy(id: string) {
  const s = REGISTERED_STRATEGIES[id as BenchStrategyId];
  if (!s) throw new Error(`Unknown strategy "${id}".`);
  return s;
}

export function makeClient(args: Record<string, string | true>): JevClient {
  const key = process.env.TYPESAFE_API_KEY;
  if (args.mock || !key) {
    if (!args.mock) {
      console.warn(
        "TYPESAFE_API_KEY is not set: using the MOCK Jev client (it just copies the fallback bot).\n" +
          "Set the key to use real Jev, or pass --mock to silence this warning.\n",
      );
    }
    return new MockJevClient();
  }
  return new HttpJevClient(key, typeof args.model === "string" ? args.model : "jev-latest");
}
