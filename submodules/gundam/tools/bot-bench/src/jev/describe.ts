/**
 * Turn engine state into plain-English facts, with all arithmetic done here.
 *
 * Jev's own docs say it is weak at counting and maths, so every number the
 * decision depends on (effective AP, HP left, combat results, shields left,
 * resources) is computed by the engine and written out as a fact. Jev only
 * has to judge, never calculate.
 *
 * The same text is shown to a human in `jev-play`, so you see exactly what
 * the bot sees (minus its hidden hand).
 */

import {
  combatOutcome,
  combatUnitValue,
  type CandidateStrategyContext,
  type GundamBotCandidate,
} from "@tcg/gundam-engine";

/** The handful of GundamG fields we read (GundamG itself isn't exported). */
interface GView {
  readonly damage: Record<string, number>;
  readonly exhausted: Record<string, boolean>;
  readonly pilotAssignments: Record<string, string>;
  readonly turnMetadata?: {
    readonly pendingCombat?: { attackerId: string; attackerPlayerId: string; target: string };
  };
}

const g = (ctx: CandidateStrategyContext) => ctx.state.G as unknown as GView;

export function opponentOf(ctx: CandidateStrategyContext): string {
  const me = String(ctx.playerId);
  return ctx.state.ctx.playerIds.map(String).find((id) => id !== me) ?? "";
}

function zone(ctx: CandidateStrategyContext, name: string, pid: string) {
  return ctx.view.zones.zones[`${name}:${pid}`];
}

export function cardName(ctx: CandidateStrategyContext, id: string): string {
  return ctx.cards.getDefinition(id)?.name ?? "a hidden card";
}

function cardText(ctx: CandidateStrategyContext, id: string): string | undefined {
  const def = ctx.cards.getDefinition(id);
  const text = cleanText(def?.effect ?? def?.rulesText ?? "");
  return text && text !== "-" ? text : undefined;
}

export function cleanText(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/･/g, " · ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Units ────────────────────────────────────────────────────────────────────

interface UnitFacts {
  readonly name: string;
  readonly ap: number;
  readonly hp_left: number;
  readonly status: "active" | "rested";
  readonly pilot?: string;
  readonly keywords?: string;
  readonly deployed_this_turn?: true;
  readonly text?: string;
}

function unitFacts(ctx: CandidateStrategyContext, id: string): UnitFacts {
  const v = combatUnitValue(ctx, id);
  const G = g(ctx);
  const pilotId = G.pilotAssignments[id];
  const meta = ctx.cards.getMeta(id) as { deployedThisTurn?: boolean } | undefined;
  const text = cardText(ctx, id);
  return {
    name: cardName(ctx, id),
    ap: v.ap,
    hp_left: v.remainingHp,
    status: G.exhausted[id] ? "rested" : "active",
    ...(pilotId ? { pilot: cardName(ctx, pilotId) } : {}),
    ...(v.keywords.length ? { keywords: v.keywords.join(", ") } : {}),
    ...(meta?.deployedThisTurn ? { deployed_this_turn: true as const } : {}),
    ...(text ? { text } : {}),
  };
}

function unitShort(ctx: CandidateStrategyContext, id: string): string {
  const v = combatUnitValue(ctx, id);
  return `${cardName(ctx, id)} (AP ${v.ap}, HP ${v.remainingHp} left)`;
}

// ── Defences ─────────────────────────────────────────────────────────────────

interface Defences {
  readonly shields: number;
  readonly base: { name: string; hp_left: number } | null;
}

function defences(ctx: CandidateStrategyContext, pid: string): Defences {
  const shields = zone(ctx, "shieldArea", pid)?.count ?? 0;
  const baseCard = zone(ctx, "baseSection", pid)?.cards[0];
  if (!baseCard) return { shields, base: null };
  const def = ctx.cards.getDefinition(baseCard.instanceId);
  const hp = def && "hp" in def ? (def.hp as number) : 0;
  return {
    shields,
    base: {
      name: def?.name ?? "Base",
      hp_left: Math.max(0, hp - (g(ctx).damage[baseCard.instanceId] ?? 0)),
    },
  };
}

function defenceText(d: Defences): string {
  const base = d.base ? `base ${d.base.name} with ${d.base.hp_left} HP left` : "no base";
  return `${d.shields} shield${d.shields === 1 ? "" : "s"}, ${base}`;
}

/** What a direct hit of `ap` does to a player with defences `d`. */
function directHitResult(ap: number, d: Defences, keywords: readonly string[]): string {
  if (d.base) {
    return ap >= d.base.hp_left
      ? `destroys their base ${d.base.name}`
      : `damages their base ${d.base.name} to ${d.base.hp_left - ap} HP`;
  }
  if (d.shields === 0) return "hits the player with no shields left: THIS WINS THE GAME";
  const extra = keywords.some((k) => k.startsWith("Suppression"))
    ? " (Suppression may break more than one)"
    : "";
  return `breaks 1 shield, leaving ${d.shields - 1}${extra}`;
}

/** Units only: attached pilots and commands-as-pilots share the battle area zone. */
function unitIds(ctx: CandidateStrategyContext, pid: string): string[] {
  return (zone(ctx, "battleArea", pid)?.cards ?? [])
    .map((c) => c.instanceId)
    .filter((id) => ctx.cards.getDefinition(id)?.type === "unit");
}

// ── Board summary ────────────────────────────────────────────────────────────

export interface BoardFacts {
  readonly turn: number;
  readonly whose_turn: "mine" | "opponent's";
  readonly phase: string;
  readonly me: {
    readonly level: number;
    readonly resources_active: number;
    readonly defences: string;
    readonly units: readonly UnitFacts[];
    readonly hand: readonly {
      name: string;
      copies: number;
      type: string;
      cost: number;
      level: number;
      stats?: string;
      text?: string;
    }[];
    readonly cards_in_deck: number;
  };
  readonly opponent: {
    readonly level: number;
    readonly resources_active: number;
    readonly defences: string;
    readonly units: readonly UnitFacts[];
    readonly cards_in_hand: number;
    readonly cards_in_deck: number;
  };
  readonly key_facts: readonly string[];
  readonly pending_prompt?: string;
}

function resources(ctx: CandidateStrategyContext, pid: string) {
  const cards = zone(ctx, "resourceArea", pid)?.cards ?? [];
  const G = g(ctx);
  return { level: cards.length, active: cards.filter((c) => !G.exhausted[c.instanceId]).length };
}

export function describeBoard(ctx: CandidateStrategyContext): BoardFacts {
  const me = String(ctx.playerId);
  const opp = opponentOf(ctx);
  const G = g(ctx);
  const myUnitIds = unitIds(ctx, me);
  const oppUnitIds = unitIds(ctx, opp);
  const myDef = defences(ctx, me);
  const oppDef = defences(ctx, opp);
  const myRes = resources(ctx, me);
  const oppRes = resources(ctx, opp);

  const handCounts = new Map<string, number>();
  for (const c of zone(ctx, "hand", me)?.cards ?? []) {
    if (c.definition) handCounts.set(c.definition.name, (handCounts.get(c.definition.name) ?? 0) + 1);
  }
  const handSeen = new Set<string>();
  const hand = (zone(ctx, "hand", me)?.cards ?? []).flatMap((c) => {
    if (!c.definition || handSeen.has(c.definition.name)) return [];
    handSeen.add(c.definition.name);
    const def = c.definition;
    if (!def) return [];
    const stats =
      def.type === "unit"
        ? `AP ${def.ap} / HP ${def.hp}`
        : def.type === "pilot"
          ? `+${def.apBonus} AP / +${def.hpBonus} HP when paired`
          : def.type === "base"
            ? `HP ${def.hp}`
            : undefined;
    const text = cardText(ctx, c.instanceId);
    return [
      {
        name: def.name,
        copies: handCounts.get(def.name) ?? 1,
        type: def.type,
        cost: def.cost,
        level: def.level,
        ...(stats ? { stats } : {}),
        ...(text ? { text } : {}),
      },
    ];
  });

  // Pre-computed facts Jev should not have to derive.
  const facts: string[] = [];
  const myReady = myUnitIds.filter((id) => !G.exhausted[id]);
  const readyAp = myReady.reduce((n, id) => n + combatUnitValue(ctx, id).ap, 0);
  facts.push(
    `I have ${myReady.length} active unit(s) with ${readyAp} total AP; the opponent has ${oppDef.shields} shield(s)${oppDef.base ? ` and a base with ${oppDef.base.hp_left} HP` : " and no base"}.`,
  );
  const oppBlockers = oppUnitIds.filter(
    (id) => !G.exhausted[id] && combatUnitValue(ctx, id).keywords.includes("Blocker"),
  );
  facts.push(
    oppBlockers.length
      ? `Opponent has active Blocker unit(s) that can redirect attacks: ${oppBlockers.map((id) => cardName(ctx, id)).join(", ")}.`
      : "Opponent has no active Blocker units.",
  );
  if (!oppDef.base && oppDef.shields === 0) {
    facts.push("The opponent has no shields and no base: any direct hit that connects wins the game.");
  }
  if (!myDef.base && myDef.shields === 0) {
    facts.push("I have no shields and no base: any direct hit on me that connects loses me the game.");
  }
  const oppReadyAp = oppUnitIds
    .filter((id) => !G.exhausted[id])
    .reduce((n, id) => n + combatUnitValue(ctx, id).ap, 0);
  facts.push(`Opponent's currently active units have ${oppReadyAp} total AP.`);

  const status = ctx.state.ctx.status;
  return {
    turn: status.turn,
    whose_turn: String(status.turnPlayer) === me ? "mine" : "opponent's",
    phase: [status.phase, status.step].filter(Boolean).join(" / ") || "setup",
    me: {
      level: myRes.level,
      resources_active: myRes.active,
      defences: defenceText(myDef),
      units: myUnitIds.map((id) => unitFacts(ctx, id)),
      hand,
      cards_in_deck: zone(ctx, "deck", me)?.count ?? 0,
    },
    opponent: {
      level: oppRes.level,
      resources_active: oppRes.active,
      defences: defenceText(oppDef),
      units: oppUnitIds.map((id) => unitFacts(ctx, id)),
      cards_in_hand: zone(ctx, "hand", opp)?.count ?? 0,
      cards_in_deck: zone(ctx, "deck", opp)?.count ?? 0,
    },
    key_facts: facts,
    ...(ctx.pendingChoice ? { pending_prompt: ctx.pendingChoice.prompt } : {}),
  };
}

// ── Candidates ───────────────────────────────────────────────────────────────

function names(ctx: CandidateStrategyContext, ids: readonly string[] | undefined): string {
  if (!ids || ids.length === 0) return "";
  return ids.map((id) => (id === "direct" ? "the opponent" : cardName(ctx, id))).join(", ");
}

function costPart(ctx: CandidateStrategyContext, id: string): string {
  const def = ctx.cards.getDefinition(id);
  return def ? `cost ${def.cost}` : "";
}

/**
 * Plain-English description of one legal action, with consequences
 * pre-computed. Returns null for actions the bot should never consider.
 */
export function describeCandidate(
  ctx: CandidateStrategyContext,
  c: GundamBotCandidate,
): string | null {
  const me = String(ctx.playerId);
  const opp = opponentOf(ctx);
  switch (c.family) {
    case "concede":
    case "skipOpponentTurn":
    case "dropOpponent":
      return null;
    case "passTurn":
      return "End my turn.";
    case "passActionStep":
    case "passBattleAction":
      return "Pass: do nothing more in this step.";
    case "chooseFirstPlayer":
      return c.playerId === me ? "Choose to go first." : "Choose to go second.";
    case "alterHand":
      return c.wantsRedraw
        ? "Mulligan: shuffle this hand away and draw a new one."
        : "Keep this opening hand.";
    case "discardToHandLimit":
      return `Discard to hand limit: ${names(ctx, c.cardIds)}.`;
    case "deployUnit": {
      const def = ctx.cards.getDefinition(c.cardId);
      const stats = def?.type === "unit" ? `, AP ${def.ap} / HP ${def.hp}` : "";
      const tgt = c.targets?.length ? `, targeting ${names(ctx, c.targets)}` : "";
      const mode = c.mode ? ` (${String(c.mode)})` : "";
      return `Deploy unit ${cardName(ctx, c.cardId)}${mode} (${costPart(ctx, c.cardId)}${stats})${tgt}.`;
    }
    case "deployBase": {
      const tgt = c.targets?.length ? `, targeting ${names(ctx, c.targets)}` : "";
      return `Deploy base ${cardName(ctx, c.cardId)} (${costPart(ctx, c.cardId)})${tgt}. My current defences: ${defenceText(defences(ctx, me))}.`;
    }
    case "playCommand": {
      const tgt = c.targets?.length ? ` targeting ${names(ctx, c.targets)}` : "";
      return `Play command ${cardName(ctx, c.cardId)} (${costPart(ctx, c.cardId)})${tgt}.`;
    }
    case "assignPilot": {
      const def = ctx.cards.getDefinition(c.pilotId);
      const bonus = def?.type === "pilot" ? ` (+${def.apBonus} AP / +${def.hpBonus} HP)` : "";
      return `Pair pilot ${cardName(ctx, c.pilotId)}${bonus} with my unit ${unitShort(ctx, c.unitId)}, ${costPart(ctx, c.pilotId)}.`;
    }
    case "playCommandAsPilot":
      return `Play ${cardName(ctx, c.cardId)} as a pilot on my unit ${unitShort(ctx, c.unitId)}, ${costPart(ctx, c.cardId)}.`;
    case "activateAbility": {
      const tgt = c.targets?.length ? ` targeting ${names(ctx, c.targets)}` : "";
      return `Activate an ability of ${cardName(ctx, c.cardId)}${tgt}.`;
    }
    case "enterBattle": {
      const attacker = combatUnitValue(ctx, c.attackerId);
      const who = unitShort(ctx, c.attackerId);
      if (c.target === "direct") {
        const unblockable = attacker.keywords.includes("HighManeuver") ? " It cannot be blocked." : "";
        return `Attack the opponent directly with ${who}: if unblocked it ${directHitResult(attacker.ap, defences(ctx, opp), attacker.keywords)}.${unblockable}`;
      }
      const defender = combatUnitValue(ctx, c.target);
      const o = combatOutcome(attacker, defender);
      return `Attack enemy ${unitShort(ctx, c.target)} with ${who}: enemy ${o.defenderDestroyed ? "is destroyed" : "survives"}, mine ${o.attackerDestroyed ? "is destroyed" : "survives"}.`;
    }
    case "declareBlock": {
      const combat = g(ctx).turnMetadata?.pendingCombat;
      if (!combat) return `Block with ${unitShort(ctx, c.blockerId)}.`;
      const attacker = combatUnitValue(ctx, combat.attackerId);
      const blocker = combatUnitValue(ctx, c.blockerId);
      const o = combatOutcome(attacker, blocker);
      return `Block ${unitShort(ctx, combat.attackerId)} with my ${unitShort(ctx, c.blockerId)}: attacker ${o.defenderDestroyed ? "is destroyed" : "survives"}, my blocker ${o.attackerDestroyed ? "is destroyed" : "survives"}.`;
    }
    case "passBlock": {
      const combat = g(ctx).turnMetadata?.pendingCombat;
      if (!combat) return "Don't block.";
      const attacker = combatUnitValue(ctx, combat.attackerId);
      const hit =
        combat.target === "direct"
          ? `it ${directHitResult(attacker.ap, defences(ctx, me), attacker.keywords).replace("their", "my").replace("THIS WINS THE GAME", "THIS LOSES ME THE GAME")}`
          : `it fights my ${unitShort(ctx, combat.target)}`;
      return `Don't block ${unitShort(ctx, combat.attackerId)}: ${hit}.`;
    }
    case "resolveEffect": {
      const p = ctx.pendingChoice;
      const src = p && "sourceCardId" in p ? `${cardName(ctx, p.sourceCardId)}: ` : "";
      const parts: string[] = [];
      if (c.targets?.length) parts.push(`choose ${names(ctx, c.targets)}`);
      if (c.optionalAnswers) {
        const yes = Object.values(c.optionalAnswers).some(Boolean);
        parts.push(yes ? "use the optional effect" : "decline the optional effect");
      }
      if (c.chooseOneAnswers && p?.kind === "chooseOne") {
        for (const idx of Object.values(c.chooseOneAnswers)) {
          const label = p.options.find((o) => o.index === idx)?.label;
          parts.push(`pick option "${label ?? idx}"`);
        }
      }
      if (c.deckLookAnswers) parts.push(`deck look: ${JSON.stringify(Object.values(c.deckLookAnswers))}`);
      if (parts.length === 0) parts.push("resolve it");
      return `Resolve effect ${src}${parts.join("; ")}.`;
    }
    default:
      return JSON.stringify(c);
  }
}

/** Stable identity for a candidate (used to map rankings across re-enumeration). */
export function candidateKey(c: GundamBotCandidate): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(stable(c));
}

/**
 * Short, perspective-free description of an action for the event history
 * ("Opponent attacked directly with Loto (AP 3)"). Returns null for passes.
 */
export function describeEvent(ctx: CandidateStrategyContext, c: GundamBotCandidate): string | null {
  switch (c.family) {
    case "deployUnit":
      return `deployed unit ${cardName(ctx, c.cardId)}`;
    case "deployBase":
      return `deployed base ${cardName(ctx, c.cardId)}`;
    case "playCommand":
      return `played command ${cardName(ctx, c.cardId)}${c.targets?.length ? ` on ${names(ctx, c.targets)}` : ""}`;
    case "assignPilot":
      return `paired pilot ${cardName(ctx, c.pilotId)} with ${cardName(ctx, c.unitId)}`;
    case "playCommandAsPilot":
      return `played ${cardName(ctx, c.cardId)} as a pilot on ${cardName(ctx, c.unitId)}`;
    case "activateAbility":
      return `activated an ability of ${cardName(ctx, c.cardId)}`;
    case "enterBattle":
      return c.target === "direct"
        ? `attacked directly with ${unitShort(ctx, c.attackerId)}`
        : `attacked ${unitShort(ctx, c.target)} with ${unitShort(ctx, c.attackerId)}`;
    case "declareBlock":
      return `blocked with ${unitShort(ctx, c.blockerId)}`;
    case "passBlock":
      return g(ctx).turnMetadata?.pendingCombat ? "chose not to block" : null;
    case "resolveEffect":
      return c.targets?.length ? `resolved an effect choosing ${names(ctx, c.targets)}` : null;
    case "alterHand":
      return c.wantsRedraw ? "mulliganed" : "kept their opening hand";
    case "passTurn":
      return "ended the turn";
    default:
      return null;
  }
}
