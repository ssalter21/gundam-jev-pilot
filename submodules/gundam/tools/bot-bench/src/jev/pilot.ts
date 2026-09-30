/**
 * JevPilot: a Gundam bot whose every decision is a Jev Choice.
 *
 * Multi-turn memory lives here, not in Jev (Jev is stateless):
 *   - At the start of each of its turns the pilot asks Jev which of the
 *     deck's named game plans applies. The answer is stored and sent back
 *     with every later decision until the next turn's check.
 *   - A rolling log of recent events (both players' actions) is sent too,
 *     so Jev can see what just happened.
 *
 * Each in-turn decision is one Choice over the legal actions, each described
 * in plain English with outcomes pre-computed (see describe.ts).
 */

import { appendFileSync } from "node:fs";

import type {
  CandidateStrategy,
  CandidateStrategyContext,
  GundamBotCandidate,
} from "@tcg/gundam-engine";

import { MockJevClient, type JevClient, type JsonValue } from "./client.ts";
import type { DeckNotes } from "./deck-notes.ts";
import { candidateKey, describeBoard, describeCandidate, opponentOf } from "./describe.ts";

export interface PilotDecisionLog {
  readonly turn: number;
  readonly plan: string | null;
  readonly chosen: string;
  readonly confidence: number;
  readonly alternatives: readonly { action: string; p: number }[];
  readonly latencyMs: number;
}

export interface PlanLog {
  readonly turn: number;
  readonly plan: string;
  readonly confidence: number;
  readonly probabilities: Record<string, number>;
}

export interface JevPilotOptions {
  /** Used when Jev errors, and to order any leftover candidates. */
  readonly fallback: CandidateStrategy;
  /** Append every Jev request/response pair to this JSONL file. */
  readonly dumpPath?: string;
  /** Max recent events sent to Jev. Default 14. */
  readonly historySize?: number;
  readonly onDecision?: (log: PilotDecisionLog) => void;
  readonly onPlan?: (log: PlanLog) => void;
}

export interface PilotStats {
  jevCalls: number;
  fallbacks: number;
  trivialSkips: number;
  totalLatencyMs: number;
  inputTokens: number;
  lastError?: string;
}

const ACTION_INSTRUCTIONS =
  "You are piloting the deck described in this state in the Gundam Card Game. " +
  "Pick the single best legal action to take right now. Follow the current game plan, the deck's rules, " +
  "key plays and card notes; use the playstyle guide and game guide for anything they don't cover. All numbers and combat results in the state and in the options are already " +
  "calculated by the game engine and are correct: trust them rather than re-deriving them. " +
  "Never throw away a winning attack; never leave yourself dead on board if an option prevents it.";

const PLAN_INSTRUCTIONS =
  "It is the start of my turn. Which of the deck's game plans should guide my play for this turn and the next " +
  "couple of turns? Read each plan's 'when' conditions against the board. Keep the current plan unless the " +
  "board has clearly moved into another plan's conditions.";

export class JevPilot {
  readonly stats: PilotStats = {
    jevCalls: 0,
    fallbacks: 0,
    trivialSkips: 0,
    totalLatencyMs: 0,
    inputTokens: 0,
  };
  currentPlan: { id: string; sinceTurn: number } | null = null;
  readonly planHistory: PlanLog[] = [];
  private lastPlanTurn = -1;
  private readonly events: string[] = [];

  constructor(
    readonly notes: DeckNotes,
    private readonly client: JevClient,
    private readonly options: JevPilotOptions,
  ) {}

  get name(): string {
    return `jev-pilot[${this.notes.name}] via ${this.client.name}`;
  }

  /** Record something that happened (called by the match loop for both seats). */
  observe(event: string): void {
    this.events.push(event);
    const max = this.options.historySize ?? 14;
    if (this.events.length > max) this.events.splice(0, this.events.length - max);
  }

  /** Returns candidates in the order the planner should try them. */
  async decide(ctx: CandidateStrategyContext): Promise<readonly GundamBotCandidate[]> {
    const fallbackOrder = this.options.fallback.selectCandidates(ctx);

    // Build labelled options; drop concede etc. and exact-duplicate descriptions.
    const options: { label: string; text: string; candidate: GundamBotCandidate }[] = [];
    const seen = new Set<string>();
    for (const candidate of ctx.candidates) {
      const text = describeCandidate(ctx, candidate);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      options.push({ label: `option_${options.length + 1}`, text, candidate });
    }
    if (options.length === 0) return fallbackOrder;
    if (options.length === 1) {
      this.stats.trivialSkips++;
      return this.withLeftovers([options[0]!.candidate], fallbackOrder);
    }

    try {
      await this.maybeChoosePlan(ctx);
      const board = describeBoard(ctx);
      const state = this.buildState(ctx, board as unknown as JsonValue);

      if (this.client instanceof MockJevClient) {
        const rank = new Map(fallbackOrder.map((c, i) => [candidateKey(c), i]));
        this.client.oracle.action = [...options]
          .sort(
            (a, b) =>
              (rank.get(candidateKey(a.candidate)) ?? 999) -
              (rank.get(candidateKey(b.candidate)) ?? 999),
          )
          .map((o) => o.label);
      }

      const request = {
        state,
        questions: {
          action: {
            type: "choice" as const,
            instructions: ACTION_INSTRUCTIONS,
            criteria: Object.fromEntries(options.map((o) => [o.label, o.text])),
          },
        },
      };
      const started = Date.now();
      const response = await this.client.systemOne(request);
      const latencyMs = Date.now() - started;
      this.record(request, response, latencyMs);

      const answer = response.answers.action;
      if (!answer) throw new Error("Jev response had no 'action' answer");
      const ranked = [...options].sort(
        (a, b) => (answer.probabilities[b.label] ?? 0) - (answer.probabilities[a.label] ?? 0),
      );
      const top = ranked[0]!;
      this.options.onDecision?.({
        turn: ctx.turnNumber,
        plan: this.currentPlan?.id ?? null,
        chosen: top.text,
        confidence: answer.confidence,
        alternatives: ranked
          .slice(1, 4)
          .map((o) => ({ action: o.text, p: round(answer.probabilities[o.label] ?? 0) })),
        latencyMs,
      });
      return this.withLeftovers(
        ranked.map((o) => o.candidate),
        fallbackOrder,
      );
    } catch (err) {
      this.stats.fallbacks++;
      this.stats.lastError = err instanceof Error ? err.message : String(err);
      return fallbackOrder;
    }
  }

  private async maybeChoosePlan(ctx: CandidateStrategyContext): Promise<void> {
    const status = ctx.state.ctx.status;
    const myTurn = String(status.turnPlayer) === String(ctx.playerId);
    const turnStart = myTurn && status.phase === "main-phase" && status.turn !== this.lastPlanTurn;
    if (this.currentPlan && !turnStart) return;

    const planIds = Object.keys(this.notes.plans);
    if (planIds.length === 1) {
      this.setPlan(status.turn, planIds[0]!, 1, { [planIds[0]!]: 1 });
      return;
    }
    if (this.client instanceof MockJevClient) this.client.oracle.plan = planIds;

    const request = {
      state: this.buildState(ctx, describeBoard(ctx) as unknown as JsonValue),
      questions: {
        plan: {
          type: "choice" as const,
          instructions: PLAN_INSTRUCTIONS,
          criteria: { ...this.notes.plans },
        },
      },
    };
    const started = Date.now();
    const response = await this.client.systemOne(request);
    this.record(request, response, Date.now() - started);
    const answer = response.answers.plan;
    if (!answer || !(answer.choice in this.notes.plans)) {
      throw new Error("Jev response had no valid 'plan' answer");
    }
    this.setPlan(status.turn, answer.choice, answer.confidence, answer.probabilities);
  }

  private setPlan(turn: number, id: string, confidence: number, probabilities: Record<string, number>) {
    this.lastPlanTurn = turn;
    if (this.currentPlan?.id !== id) this.currentPlan = { id, sinceTurn: turn };
    const log: PlanLog = {
      turn,
      plan: id,
      confidence: round(confidence),
      probabilities: Object.fromEntries(Object.entries(probabilities).map(([k, v]) => [k, round(v)])),
    };
    this.planHistory.push(log);
    this.options.onPlan?.(log);
  }

  private buildState(ctx: CandidateStrategyContext, board: JsonValue): JsonValue {
    const plan = this.currentPlan;
    const n = this.notes;
    return {
      deck: n.name,
      ...(n.playstyle ? { playstyle: n.playstyle } : {}),
      deck_overview: n.overview,
      ...(n.keyPlays.length > 0 ? { key_plays: [...n.keyPlays] } : {}),
      current_game_plan: plan
        ? {
            name: plan.id,
            description: this.notes.plans[plan.id] ?? "",
            following_since_turn: plan.sinceTurn,
          }
        : "none chosen yet",
      all_game_plans: { ...this.notes.plans },
      deck_rules: [...this.notes.rules],
      card_notes: this.relevantCardNotes(ctx),
      recent_events: [...this.events],
      board,
      ...(n.playstyleGuide ? { playstyle_guide: n.playstyleGuide } : {}),
      ...(n.gameGuide ? { game_guide: n.gameGuide } : {}),
    };
  }

  /** Only send notes for cards currently visible (my hand, both boards, bases). */
  private relevantCardNotes(ctx: CandidateStrategyContext): Record<string, string> {
    const me = String(ctx.playerId);
    const opp = opponentOf(ctx);
    const zones = ctx.view.zones.zones;
    const ids = [
      `hand:${me}`,
      `battleArea:${me}`,
      `battleArea:${opp}`,
      `baseSection:${me}`,
      `baseSection:${opp}`,
    ].flatMap((z) => zones[z]?.cards.map((c) => c.instanceId) ?? []);
    const out: Record<string, string> = {};
    for (const id of ids) {
      const def = ctx.cards.getDefinition(id);
      if (!def) continue;
      const note =
        this.notes.cardNotes[def.cardNumber.toLowerCase()] ??
        this.notes.cardNotes[def.name.toLowerCase()];
      if (note) out[def.name] = note;
    }
    return out;
  }

  private withLeftovers(
    first: readonly GundamBotCandidate[],
    fallbackOrder: readonly GundamBotCandidate[],
  ): GundamBotCandidate[] {
    const used = new Set(first.map(candidateKey));
    return [
      ...first,
      ...fallbackOrder.filter((c) => c.family !== "concede" && !used.has(candidateKey(c))),
    ];
  }

  private record(request: unknown, response: { usage?: { input_tokens: number } }, ms: number) {
    this.stats.jevCalls++;
    this.stats.totalLatencyMs += ms;
    this.stats.inputTokens += response.usage?.input_tokens ?? 0;
    if (this.options.dumpPath) {
      appendFileSync(this.options.dumpPath, `${JSON.stringify({ request, response, ms })}\n`);
    }
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
