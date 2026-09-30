/**
 * PlaySession: one human-vs-Jev game that a UI can drive step by step.
 *
 * The match loop runs in the background. When it is the human's turn to decide, the session
 * publishes the board and the options and waits until choose() or concede() is called.
 * Same seats, pilot and review as scripts/jev-play.ts, minus the terminal.
 */

import type { CandidateStrategyContext, DeckList, GundamBotCandidate } from "@tcg/gundam-engine";

import { buildBenchRuntime, PLAYER_ONE, PLAYER_TWO } from "../runtime.ts";
import { playAsyncMatch, type AsyncMatchResult, type Seat } from "./async-match.ts";
import type { JevClient } from "./client.ts";
import type { DeckNotes } from "./deck-notes.ts";
import { describeBoard, describeCandidate, opponentOf, type BoardFacts } from "./describe.ts";
import { JevPilot, type PilotDecisionLog } from "./pilot.ts";
import { resolveStrategy } from "./setup.ts";

export interface LogEntry {
  readonly who: "you" | "bot" | "plan" | "system";
  readonly turn: number;
  readonly text: string;
}

export interface CardImages {
  readonly myUnits: readonly (string | null)[];
  readonly oppUnits: readonly (string | null)[];
  readonly hand: readonly (string | null)[];
}

export interface SessionSnapshot {
  readonly id: string;
  readonly status: "your-move" | "bot-thinking" | "over";
  readonly myDeck: string;
  readonly metaDeck: string;
  readonly client: string;
  readonly seed: string;
  readonly board: BoardFacts | null;
  readonly images: CardImages | null;
  readonly options: readonly string[];
  readonly log: readonly LogEntry[];
  readonly botPlan: string | null;
  readonly result: { youWon: boolean; winner: string | null; reason: string; turns: number } | null;
  readonly review: string | null;
  readonly fallbacks: number;
  readonly error: string | null;
}

const HUMAN = PLAYER_ONE;
const BOT = PLAYER_TWO;

function imageOf(ctx: CandidateStrategyContext, id: string): string | null {
  const def = ctx.cards.getDefinition(id) as { imageUrl?: unknown } | undefined;
  return typeof def?.imageUrl === "string" ? def.imageUrl : null;
}

/** Images in the same order describeBoard lists units and (deduplicated) hand cards. */
function cardImages(ctx: CandidateStrategyContext): CardImages {
  const zones = ctx.view.zones.zones;
  const me = String(ctx.playerId);
  const opp = opponentOf(ctx);
  const units = (pid: string) =>
    (zones[`battleArea:${pid}`]?.cards ?? [])
      .filter((c) => ctx.cards.getDefinition(c.instanceId)?.type === "unit")
      .map((c) => imageOf(ctx, c.instanceId));
  const seen = new Set<string>();
  const hand = (zones[`hand:${me}`]?.cards ?? []).flatMap((c) => {
    const name = c.definition?.name;
    if (!name || seen.has(name)) return [];
    seen.add(name);
    return [imageOf(ctx, c.instanceId)];
  });
  return { myUnits: units(me), oppUnits: units(opp), hand };
}

export class PlaySession {
  private status: SessionSnapshot["status"] = "bot-thinking";
  private board: BoardFacts | null = null;
  private images: CardImages | null = null;
  private options: { text: string; c: GundamBotCandidate }[] = [];
  private concedeCandidates: GundamBotCandidate[] = [];
  private resolveMove: ((c: readonly GundamBotCandidate[]) => void) | null = null;
  private readonly log: LogEntry[] = [];
  private readonly decisions: PilotDecisionLog[] = [];
  private readonly pilot: JevPilot;
  private result: SessionSnapshot["result"] = null;
  private review: string | null = null;
  private error: string | null = null;
  private currentTurn = 0;
  private concedeWhenAsked = false;

  constructor(
    readonly id: string,
    private readonly me: { name: string; deck: DeckList },
    private readonly meta: DeckNotes,
    private readonly client: JevClient,
    readonly seed: string,
    private readonly showPlan: boolean,
  ) {
    this.pilot = new JevPilot(meta, client, {
      fallback: resolveStrategy("combat-aware"),
      onDecision: (d) => this.decisions.push(d),
      onPlan: (p) => {
        if (this.showPlan) this.push("plan", p.turn, `Bot plan: ${p.plan} (${Math.round(p.confidence * 100)}%)`);
      },
    });
  }

  start(): void {
    this.run().catch((err: unknown) => {
      this.error = err instanceof Error ? err.message : String(err);
      this.status = "over";
      this.push("system", this.currentTurn, `Game stopped: ${this.error}`);
    });
  }

  snapshot(): SessionSnapshot {
    return {
      id: this.id,
      status: this.status,
      myDeck: this.me.name,
      metaDeck: this.meta.name,
      client: this.client.name,
      seed: this.seed,
      board: this.board,
      images: this.images,
      options: this.status === "your-move" ? this.options.map((o) => o.text) : [],
      log: this.log,
      botPlan: this.showPlan ? (this.pilot.currentPlan?.id ?? null) : null,
      result: this.result,
      review: this.review,
      fallbacks: this.pilot.stats.fallbacks,
      error: this.error,
    };
  }

  choose(index: number): void {
    const option = this.options[index];
    if (this.status !== "your-move" || !option || !this.resolveMove) {
      throw new Error("That move isn't available right now.");
    }
    this.answer([option.c]);
  }

  concede(): void {
    if (this.status === "over") return;
    if (this.status === "your-move" && this.resolveMove) this.answer(this.concedeCandidates);
    else this.concedeWhenAsked = true;
  }

  private answer(candidates: readonly GundamBotCandidate[]): void {
    const resolve = this.resolveMove!;
    this.resolveMove = null;
    this.options = [];
    this.status = "bot-thinking";
    resolve(candidates);
  }

  private push(who: LogEntry["who"], turn: number, text: string): void {
    this.log.push({ who, turn, text });
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
  }

  private async run(): Promise<void> {
    const { runtime, staticResources } = buildBenchRuntime({
      p1Deck: this.me.deck,
      p2Deck: this.meta.deck,
      seed: this.seed,
    });

    const human: Seat = {
      name: "you",
      decide: (ctx) => {
        this.currentTurn = ctx.turnNumber;
        const concede = ctx.candidates.filter((c) => c.family === "concede");
        if (this.concedeWhenAsked) return Promise.resolve(concede);

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
        if (options.length === 1 && isPass(options[0]!.c)) return Promise.resolve([options[0]!.c]);

        this.board = describeBoard(ctx);
        this.images = cardImages(ctx);
        this.options = options;
        this.concedeCandidates = concede;
        this.status = "your-move";
        return new Promise((resolve) => {
          this.resolveMove = resolve;
        });
      },
    };

    const botSeat: Seat = {
      name: this.pilot.name,
      decide: (ctx) => {
        this.currentTurn = ctx.turnNumber;
        this.status = "bot-thinking";
        return this.pilot.decide(ctx);
      },
    };

    this.push("system", 0, `You (${this.me.name}) vs Jev pilot (${this.meta.name}) · ${this.client.name}`);
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
          this.pilot.observe(`Turn ${e.turn}: ${botActed ? "I" : "Opponent"} ${e.text}`);
          this.push(botActed ? "bot" : "you", e.turn, e.text);
        },
      },
    );
    this.finish(result);
  }

  private finish(result: AsyncMatchResult): void {
    const youWon = result.winner === String(HUMAN);
    const reason = result.winReason ?? result.termination;
    this.result = { youWon, winner: result.winner, reason, turns: result.turns };
    this.status = "over";
    this.push(
      "system",
      result.turns,
      `${youWon ? "You win" : result.winner ? "Bot wins" : "Game ended"} on turn ${result.turns} (${reason}).`,
    );
    this.review = buildReview({
      myDeck: this.me.name,
      metaDeck: this.meta.name,
      seed: this.seed,
      result,
      pilot: this.pilot,
      decisions: this.decisions,
    });
  }
}

/** Post-game review: the bot's plan per turn and its lowest-confidence decisions. */
export function buildReview(input: {
  myDeck: string;
  metaDeck: string;
  seed: string;
  result: AsyncMatchResult;
  pilot: JevPilot;
  decisions: readonly PilotDecisionLog[];
}): string {
  const { result, pilot } = input;
  const youWon = result.winner === String(HUMAN);
  return [
    `# Game review: you (${input.myDeck}) vs ${input.metaDeck}`,
    "",
    `Result: ${youWon ? "you won" : result.winner ? "bot won" : "no winner"} on turn ${result.turns} (${result.winReason ?? result.termination}). Seed: \`${input.seed}\``,
    "",
    "## What the bot was planning",
    ...pilot.planHistory.map(
      (p) =>
        `- Turn ${p.turn}: **${p.plan}** (${(p.confidence * 100).toFixed(0)}%) · ${Object.entries(p.probabilities)
          .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`)
          .join(", ")}`,
    ),
    "",
    "## Its closest calls (lowest confidence)",
    ...[...input.decisions]
      .sort((a, b) => a.confidence - b.confidence)
      .slice(0, 8)
      .map(
        (d) =>
          `- Turn ${d.turn} [${d.plan}] chose: ${d.chosen} (${(d.confidence * 100).toFixed(0)}%)\n` +
          d.alternatives.map((a) => `  - vs ${a.action} (${(a.p * 100).toFixed(0)}%)`).join("\n"),
      ),
    "",
    `Jev calls: ${pilot.stats.jevCalls}, fallbacks to the built-in bot: ${pilot.stats.fallbacks}${pilot.stats.lastError ? ` (last error: ${pilot.stats.lastError})` : ""}`,
  ].join("\n");
}
