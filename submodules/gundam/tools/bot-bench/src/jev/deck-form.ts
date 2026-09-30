/**
 * Deck form: the structured shape the Jev studio edits, converted to and from the deck
 * Markdown files that the pilot reads (deck-notes.ts). The Markdown file stays the source of
 * truth; this only reads and writes it.
 */

import * as GundamCards from "@tcg/gundam-cards";
import type { Card } from "@tcg/gundam-types";

import { planIdFromHeading, type Playstyle } from "./guides.ts";
import { parseDeckLine, splitSections } from "./deck-notes.ts";

export interface DeckFormPlan {
  name: string;
  when: string;
  do: string;
}

export interface DeckForm {
  name: string;
  playstyle: Playstyle | "";
  /** Raw decklist text, one "4x GD01-008" per line. */
  decklist: string;
  overview: string;
  keyPlays: string[];
  plans: DeckFormPlan[];
  rules: string[];
  cardNotes: { card: string; note: string }[];
}

export interface CheckedCard {
  count: number;
  cardNumber: string;
  name: string | null;
  type: string | null;
  color: string | null;
  level: number | null;
  cost: number | null;
  ap: number | null;
  hp: number | null;
  imageUrl: string | null;
  text: string | null;
  link: string | null;
}

export interface DecklistCheck {
  cards: CheckedCard[];
  total: number;
  colors: string[];
  resource: { cardNumber: string; count: number };
  errors: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Card catalog

let catalog: Map<string, Card> | null = null;

export function cardCatalog(): Map<string, Card> {
  if (catalog) return catalog;
  catalog = new Map();
  for (const value of Object.values(GundamCards)) {
    if (value && typeof value === "object" && "cardNumber" in value) {
      const card = value as Card;
      if (typeof card.cardNumber === "string") catalog.set(card.cardNumber.toUpperCase(), card);
    }
  }
  return catalog;
}

function num(card: Card, key: string): number | null {
  const v = (card as unknown as Record<string, unknown>)[key];
  return typeof v === "number" ? v : null;
}

function str(card: Card, key: string): string | null {
  const v = (card as unknown as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
}

// ---------------------------------------------------------------------------
// Decklist check

const RESOURCE_LINE = /^[-*]?\s*resources?\s+(\d+)\s*x?\s*([A-Z0-9]+-[A-Z0-9]+)?/i;

export function checkDecklist(text: string): DecklistCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const counts = new Map<string, number>();
  let resource = { cardNumber: "R-001", count: 10 };

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) return;
    const res = RESOURCE_LINE.exec(line);
    if (res) {
      resource = { cardNumber: (res[2] ?? "R-001").toUpperCase(), count: Number(res[1]) };
      return;
    }
    const parsed = parseDeckLine(line);
    if (!parsed) {
      errors.push(`Line ${i + 1}: can't read "${line}". Use "4x GD01-008".`);
      return;
    }
    counts.set(parsed.cardNumber, (counts.get(parsed.cardNumber) ?? 0) + parsed.count);
  });

  const cat = cardCatalog();
  const cards: CheckedCard[] = [];
  const colors = new Set<string>();
  for (const [cardNumber, count] of counts) {
    const card = cat.get(cardNumber);
    if (!card) {
      errors.push(`${cardNumber}: not a known card number.`);
      cards.push({
        count,
        cardNumber,
        name: null,
        type: null,
        color: null,
        level: null,
        cost: null,
        ap: null,
        hp: null,
        imageUrl: null,
        text: null,
        link: null,
      });
      continue;
    }
    const type = str(card, "type");
    const color = str(card, "color");
    if (type === "resource" || type === "token") {
      errors.push(`${cardNumber} (${card.name}) is a ${type} and can't go in the main deck.`);
    }
    if (count > 4) errors.push(`${cardNumber} (${card.name}): ${count} copies; the limit is 4.`);
    if (color) colors.add(color);
    cards.push({
      count,
      cardNumber,
      name: card.name,
      type,
      color,
      level: num(card, "level"),
      cost: num(card, "cost"),
      ap: num(card, "ap"),
      hp: num(card, "hp"),
      imageUrl: str(card, "imageUrl"),
      text: str(card, "rulesText") ?? str(card, "effect"),
      link: str(card, "linkCondition"),
    });
  }

  const total = cards.reduce((n, c) => n + c.count, 0);
  if (total !== 50) errors.push(`${total} cards; a deck needs exactly 50.`);
  if (colors.size > 2) errors.push(`${colors.size} colours (${[...colors].join(", ")}); a deck can use at most 2.`);
  if (!cat.has(resource.cardNumber)) warnings.push(`Resource ${resource.cardNumber} is not a known card.`);
  if (resource.count !== 10) warnings.push(`Resource deck has ${resource.count} cards; normally 10.`);

  return { cards, total, colors: [...colors], resource, errors, warnings };
}

// ---------------------------------------------------------------------------
// Markdown → form

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^[-*]\s+/, ""));
}

function splitWhenDo(body: string): { when: string; do: string } {
  const flat = body.replace(/\s+/g, " ").trim();
  const m = /^when:\s*(.*?)\s*do:\s*(.*)$/i.exec(flat);
  if (m) return { when: m[1]!.trim(), do: m[2]!.trim() };
  return { when: "", do: flat };
}

export function markdownToForm(markdown: string): DeckForm {
  const clean = markdown.replace(/<!--[\s\S]*?-->/g, "");
  const name = /^#\s+(.+)$/m.exec(clean)?.[1]?.trim() ?? "";
  const sections = splitSections(clean, "##");
  const get = (key: string): string => {
    for (const [k, v] of sections) if (k.toLowerCase() === key) return v;
    return "";
  };

  const playstyleWord = get("playstyle").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const playstyle = (["aggro", "midrange", "control"].includes(playstyleWord)
    ? playstyleWord
    : "") as DeckForm["playstyle"];

  const decklist = get("decklist")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s*#.*$/, "").trim())
    .filter(Boolean)
    .join("\n");

  const plans = [...splitSections(get("game plans"), "###")].map(([heading, body]) => ({
    name: heading,
    ...splitWhenDo(body),
  }));

  const cardNotes = lines(get("card notes"))
    .map((b) => {
      const idx = b.indexOf(":");
      return idx > 0 ? { card: b.slice(0, idx).trim(), note: b.slice(idx + 1).trim() } : null;
    })
    .filter((x): x is { card: string; note: string } => x !== null);

  return {
    name,
    playstyle,
    decklist,
    overview: get("overview").trim(),
    keyPlays: lines(get("key plays")),
    plans,
    rules: lines(get("rules")),
    cardNotes,
  };
}

// ---------------------------------------------------------------------------
// Form → markdown

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function formToMarkdown(form: DeckForm): string {
  const cat = cardCatalog();
  const out: string[] = [`# ${oneLine(form.name) || "Untitled deck"}`, ""];

  if (form.playstyle) {
    out.push("## Playstyle", form.playstyle[0]!.toUpperCase() + form.playstyle.slice(1), "");
  }

  out.push("## Decklist");
  for (const raw of form.decklist.split(/\r?\n/)) {
    const line = raw.replace(/\s*#.*$/, "").trim();
    if (!line) continue;
    const res = RESOURCE_LINE.exec(line);
    if (res) {
      out.push(`resource ${res[1]} ${(res[2] ?? "R-001").toUpperCase()}`);
      continue;
    }
    const parsed = parseDeckLine(line);
    if (!parsed) {
      out.push(line); // keep it so the user sees the problem instead of losing it
      continue;
    }
    const name = cat.get(parsed.cardNumber)?.name;
    const entry = `${parsed.count}x ${parsed.cardNumber}`;
    out.push(name ? `${entry.padEnd(14)} # ${name}` : entry);
  }
  out.push("");

  if (form.overview.trim()) out.push("## Overview", form.overview.trim(), "");

  const keyPlays = form.keyPlays.map(oneLine).filter(Boolean);
  if (keyPlays.length) out.push("## Key plays", ...keyPlays.map((k) => `- ${k}`), "");

  const plans = form.plans.filter((p) => oneLine(p.name) && (oneLine(p.when) || oneLine(p.do)));
  if (plans.length) {
    out.push("## Game plans", "");
    for (const p of plans) {
      out.push(`### ${planIdFromHeading(p.name)}`);
      if (oneLine(p.when)) out.push(`When: ${oneLine(p.when)}`);
      if (oneLine(p.do)) out.push(`Do: ${oneLine(p.do)}`);
      out.push("");
    }
  }

  const rules = form.rules.map(oneLine).filter(Boolean);
  if (rules.length) out.push("## Rules", ...rules.map((r) => `- ${r}`), "");

  const notes = form.cardNotes.filter((n) => oneLine(n.card) && oneLine(n.note));
  if (notes.length) {
    out.push("## Card notes", ...notes.map((n) => `- ${oneLine(n.card)}: ${oneLine(n.note)}`), "");
  }

  return `${out.join("\n").trimEnd()}\n`;
}
