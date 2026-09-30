/**
 * Guides: shared plain-English knowledge sent to Jev alongside a deck's own notes.
 *
 *   jev-guides/how-to-play.md   the game's rules and fundamentals (sent for every deck)
 *   jev-guides/<playstyle>.md   how to play aggro / midrange / control, plus default game plans
 *                               used by any deck of that playstyle that has none of its own
 *
 * Format: "# Title", free text, then optionally "## Game plans" with "### plan_id" sections
 * (same format as deck files). Everything before "## Game plans" is the guide text.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PLAYSTYLES = ["aggro", "midrange", "control"] as const;
export type Playstyle = (typeof PLAYSTYLES)[number];

export const GUIDE_IDS = ["how-to-play", ...PLAYSTYLES] as const;
export type GuideId = (typeof GUIDE_IDS)[number];

export const GUIDES_DIR = fileURLToPath(new URL("../../jev-guides/", import.meta.url));

export interface Guide {
  readonly title: string;
  /** Guide text without the title line and without the game plans. */
  readonly text: string;
  /** Default plans (plan id → description). Empty for how-to-play. */
  readonly plans: Readonly<Record<string, string>>;
}

export function isPlaystyle(value: string): value is Playstyle {
  return (PLAYSTYLES as readonly string[]).includes(value);
}

export function isGuideId(value: string): value is GuideId {
  return (GUIDE_IDS as readonly string[]).includes(value);
}

export function guidePath(id: GuideId): string {
  return `${GUIDES_DIR}${id}.md`;
}

export function readGuideMarkdown(id: GuideId): string {
  return readFileSync(guidePath(id), "utf8");
}

export function writeGuideMarkdown(id: GuideId, markdown: string): void {
  parseGuide(markdown, id); // refuse to save something the pilot can't read
  writeFileSync(guidePath(id), markdown.replace(/\r\n/g, "\n"));
}

export function planIdFromHeading(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

export function parseGuide(markdown: string, source = "guide"): Guide {
  const lines = markdown.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  const titleIdx = lines.findIndex((l) => /^#\s+/.test(l));
  const title = titleIdx >= 0 ? lines[titleIdx]!.replace(/^#\s+/, "").trim() : source;
  const plansIdx = lines.findIndex((l) => /^##\s+game plans\s*$/i.test(l.trim()));
  const textLines = lines.slice(titleIdx + 1, plansIdx >= 0 ? plansIdx : undefined);

  const plans: Record<string, string> = {};
  if (plansIdx >= 0) {
    let current: string | null = null;
    let buffer: string[] = [];
    const flush = () => {
      if (current) plans[current] = buffer.join(" ").replace(/\s+/g, " ").trim();
    };
    for (const line of lines.slice(plansIdx + 1)) {
      if (/^##\s/.test(line)) break; // next top-level section ends the plans
      const heading = /^###\s+(.+)$/.exec(line);
      if (heading) {
        flush();
        current = planIdFromHeading(heading[1]!);
        buffer = [];
      } else if (current) buffer.push(line);
    }
    flush();
  }
  return { title, text: textLines.join("\n").trim(), plans };
}

export function loadGuide(id: GuideId): Guide {
  return parseGuide(readGuideMarkdown(id), id);
}
