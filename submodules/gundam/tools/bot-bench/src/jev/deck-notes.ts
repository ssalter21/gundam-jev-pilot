/**
 * Deck notes: one Markdown file per meta deck, written in plain English.
 *
 * Format (see jev-decks/TEMPLATE.md):
 *
 *   # Deck name
 *
 *   ## Decklist
 *   4 GD01-008          (also accepts "4x GD01-008", "GD01-008 x4", "GD01-008x4")
 *   resource 10 R-001   (optional; defaults to 10x R-001)
 *
 *   ## Overview
 *   Free text.
 *
 *   ## Game plans
 *   ### plan_id
 *   Free text: when this plan applies and what it does.
 *
 *   ## Rules
 *   - One decision rule per bullet.
 *
 *   ## Card notes
 *   - GD01-008: how to use this card.   (card number or card name before the colon)
 */

import { readFileSync } from "node:fs";

import type { DeckList } from "@tcg/gundam-engine";

export interface DeckNotes {
  readonly name: string;
  readonly deck: DeckList;
  readonly overview: string;
  /** plan id → plain-English description. Order preserved. */
  readonly plans: Readonly<Record<string, string>>;
  readonly rules: readonly string[];
  /** Card number or card name (case-insensitive key) → note. */
  readonly cardNotes: Readonly<Record<string, string>>;
}

const DECK_LINE = [
  /^(\d+)\s*x?\s+([A-Z0-9]+-[A-Z0-9]+)$/i, // "4 GD01-008", "4x GD01-008"
  /^([A-Z0-9]+-[A-Z0-9]+)\s*x\s*(\d+)$/i, // "GD01-008 x4", "GD01-008x4"
];

function parseDeckLine(line: string): { cardNumber: string; count: number } | null {
  const trimmed = line.replace(/^[-*]\s*/, "").replace(/\s*#.*$/, "").trim();
  if (!trimmed) return null;
  const a = DECK_LINE[0]!.exec(trimmed);
  if (a) return { cardNumber: a[2]!.toUpperCase(), count: Number(a[1]) };
  const b = DECK_LINE[1]!.exec(trimmed);
  if (b) return { cardNumber: b[1]!.toUpperCase(), count: Number(b[2]) };
  return null;
}

function splitSections(markdown: string, level: "##" | "###"): Map<string, string> {
  const out = new Map<string, string>();
  const marker = `${level} `;
  let current: string | null = null;
  let buffer: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const isHeading = line.startsWith(marker) && !line.startsWith(`${marker}#`);
    if (isHeading) {
      if (current !== null) out.set(current, buffer.join("\n").trim());
      current = line.slice(marker.length).trim();
      buffer = [];
    } else if (current !== null) {
      buffer.push(line);
    }
  }
  if (current !== null) out.set(current, buffer.join("\n").trim());
  return out;
}

function bullets(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, "").trim());
}

function toPlanId(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

export function parseDeckNotes(
  markdown: string,
  source = "deck notes",
  options: { requirePlans?: boolean } = {},
): DeckNotes {
  markdown = markdown.replace(/<!--[\s\S]*?-->/g, "");
  const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? "Unnamed deck";
  const sections = splitSections(markdown, "##");
  const get = (name: string): string => {
    for (const [key, value] of sections) if (key.toLowerCase() === name) return value;
    return "";
  };

  // Decklist
  const cards: { cardNumber: string; count: number }[] = [];
  let resource = { cardNumber: "R-001", count: 10 };
  const problems: string[] = [];
  for (const raw of get("decklist").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const res = /^[-*]?\s*resources?\s+(\d+)\s*x?\s*([A-Z0-9]+-[A-Z0-9]+)?/i.exec(line);
    if (res) {
      resource = { cardNumber: (res[2] ?? "R-001").toUpperCase(), count: Number(res[1]) };
      continue;
    }
    const parsed = parseDeckLine(line);
    if (parsed) cards.push(parsed);
    else problems.push(line);
  }
  if (problems.length > 0) {
    throw new Error(`${source}: could not read decklist lines: ${problems.join(" | ")}`);
  }
  const total = cards.reduce((n, c) => n + c.count, 0);
  if (total !== 50) {
    throw new Error(`${source}: decklist has ${total} cards; a Gundam deck needs exactly 50.`);
  }

  // Plans
  const plans: Record<string, string> = {};
  for (const [heading, body] of splitSections(get("game plans"), "###")) {
    const id = toPlanId(heading);
    if (id) plans[id] = body.replace(/\s+/g, " ").trim();
  }
  if (Object.keys(plans).length === 0 && options.requirePlans !== false) {
    throw new Error(`${source}: add at least one plan under "## Game plans" as "### plan_name".`);
  }

  // Card notes
  const cardNotes: Record<string, string> = {};
  for (const b of bullets(get("card notes"))) {
    const idx = b.indexOf(":");
    if (idx <= 0) continue;
    cardNotes[b.slice(0, idx).trim().toLowerCase()] = b.slice(idx + 1).trim();
  }

  return {
    name: title,
    deck: { name: title, description: `Loaded from ${source}`, cards, resource },
    overview: get("overview").replace(/\s+/g, " ").trim(),
    plans,
    rules: bullets(get("rules")),
    cardNotes,
  };
}

export function loadDeckNotes(path: string): DeckNotes {
  return parseDeckNotes(readFileSync(path, "utf8"), path);
}

/** A plain decklist (.txt, one "4 GD01-008" per line) with no strategy notes. */
export function loadDecklistOnly(path: string): DeckList {
  const name = path.split("/").pop()!.replace(/\.[^.]+$/, "");
  const md = `# ${name}\n\n## Decklist\n${readFileSync(path, "utf8")}`;
  return parseDeckNotes(md, path, { requirePlans: false }).deck;
}
