/**
 * Async match loop. The engine's `playMatch` is synchronous, but Jev and a
 * human at a terminal are not. For each decision we:
 *   1. build the same context the planner would,
 *   2. await the seat's ranking,
 *   3. hand the planner a strategy that replays that ranking.
 * Enumeration is deterministic, so the planner sees the same candidates.
 * Submission still goes through the engine's own planner and validation.
 */

import {
  createDeadlockDetector,
  enumerateGundamBotCandidates,
  fingerprint,
  takeAutomatedActionWithFallback,
  type CandidateStrategy,
  type CandidateStrategyContext,
  type GundamBotCandidate,
  type MatchRuntime,
  type MatchStaticResources,
  type PlayerId,
} from "@tcg/gundam-engine";

import { candidateKey, describeEvent } from "./describe.ts";

export interface Seat {
  readonly name: string;
  /** Return candidates in preferred order (must come from ctx.candidates). */
  decide(ctx: CandidateStrategyContext): Promise<readonly GundamBotCandidate[]>;
}

export function strategySeat(strategy: CandidateStrategy): Seat {
  return { name: strategy.name, decide: async (ctx) => strategy.selectCandidates(ctx) };
}

export interface MatchEvent {
  readonly playerId: string;
  readonly turn: number;
  readonly text: string;
}

export interface AsyncMatchResult {
  readonly winner: string | null;
  readonly winReason: string | null;
  readonly turns: number;
  readonly actions: number;
  readonly termination: "game-won" | "max-actions" | "stuck" | "repeated-state";
}

export function buildContext(
  runtime: MatchRuntime,
  staticResources: MatchStaticResources,
  playerId: PlayerId,
): CandidateStrategyContext {
  const state = runtime.getState();
  return {
    playerId,
    state,
    view: runtime.getFilteredView({ role: "player", playerId }),
    candidates: enumerateGundamBotCandidates(state, playerId, staticResources),
    turnNumber: state.ctx.status.turn,
    pendingChoice: runtime.getPendingChoice({ role: "player", playerId }) ?? null,
    cards: runtime.getCardReadAPI(),
  };
}

export async function playAsyncMatch(
  runtime: MatchRuntime,
  staticResources: MatchStaticResources,
  seats: ReadonlyMap<string, Seat>,
  options: { maxActions?: number; onEvent?: (e: MatchEvent) => void } = {},
): Promise<AsyncMatchResult> {
  const maxActions = options.maxActions ?? 1500;
  const deadlock = createDeadlockDetector();
  let actions = 0;

  while (actions < maxActions) {
    const state = runtime.getState();
    if (state.ctx.status.gameEnded) break;
    deadlock.recordState(fingerprint(state));
    if (deadlock.isDeadlocked()) return finish(runtime, actions, "repeated-state");

    const playerId = state.ctx.status.activePlayer;
    const seat = seats.get(String(playerId));
    if (!seat) throw new Error(`No seat for ${String(playerId)}`);

    const ctx = buildContext(runtime, staticResources, playerId);
    const ordered = await seat.decide(ctx);
    const wanted = ordered.map(candidateKey);

    const replay: CandidateStrategy = {
      name: seat.name,
      selectCandidates: (fresh) => {
        const byKey = new Map(fresh.candidates.map((c) => [candidateKey(c), c]));
        return wanted.flatMap((k) => (byKey.has(k) ? [byKey.get(k)!] : []));
      },
    };
    const result = takeAutomatedActionWithFallback(runtime, playerId, replay, staticResources, {
      maxCandidateAttempts: 4,
    });
    actions++;

    if (result.selectedCandidate && options.onEvent) {
      const text = describeEvent(ctx, result.selectedCandidate);
      if (text) options.onEvent({ playerId: String(playerId), turn: ctx.turnNumber, text });
    }
    if (result.outcome === "game-ended") break;
    if (result.outcome.includes("concede-failed")) return finish(runtime, actions, "stuck");
  }
  return finish(runtime, actions, runtime.getState().ctx.status.gameEnded ? "game-won" : "max-actions");
}

function finish(
  runtime: MatchRuntime,
  actions: number,
  termination: AsyncMatchResult["termination"],
): AsyncMatchResult {
  const s = runtime.getState().ctx.status;
  return {
    winner: s.winner ? String(s.winner) : null,
    winReason: s.winReason ?? null,
    turns: s.turn,
    actions,
    termination: s.gameEnded ? "game-won" : termination,
  };
}
