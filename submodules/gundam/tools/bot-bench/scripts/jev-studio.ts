/**
 * Jev studio: a local web UI for writing meta deck files and editing the guides.
 *
 *   pnpm jev:studio [--port 4747]
 *
 * Serves studio/index.html and a small JSON API on 127.0.0.1 only. Reads and writes
 * jev-decks/*.md and jev-guides/*.md; those Markdown files stay the source of truth.
 */

import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import {
  checkDecklist,
  formToMarkdown,
  markdownToForm,
  type DeckForm,
} from "../src/jev/deck-form.ts";
import { loadDeckNotes } from "../src/jev/deck-notes.ts";
import {
  GUIDE_IDS,
  isGuideId,
  loadGuide,
  PLAYSTYLES,
  readGuideMarkdown,
  writeGuideMarkdown,
} from "../src/jev/guides.ts";
import { parseArgs } from "../src/jev/setup.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DECKS_DIR = `${ROOT}jev-decks/`;
const PAGE = `${ROOT}studio/index.html`;
const FILE_RE = /^[a-z0-9][a-z0-9_-]*\.md$/;
const HIDDEN = new Set(["TEMPLATE.md"]);

const args = parseArgs(process.argv.slice(2));
const port = Number(args.port ?? 4747);

interface DeckStatus {
  ready: boolean;
  problems: string[];
  warnings: string[];
  plansFromGuide: boolean;
  total: number;
}

function deckStatus(file: string, form: DeckForm): DeckStatus {
  const check = checkDecklist(form.decklist);
  const problems = [...check.errors];
  let plansFromGuide = false;
  try {
    const notes = loadDeckNotes(`${DECKS_DIR}${file}`);
    plansFromGuide = notes.plansFromGuide === true;
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).replace(/^[^:]*\.md: /, "");
    if (!problems.some((p) => msg.includes(p))) problems.push(msg);
  }
  return {
    ready: problems.length === 0,
    problems: [...new Set(problems)],
    warnings: check.warnings,
    plansFromGuide,
    total: check.total,
  };
}

function listDecks() {
  return readdirSync(DECKS_DIR)
    .filter((f) => f.endsWith(".md") && !HIDDEN.has(f))
    .sort()
    .map((file) => {
      const form = markdownToForm(readFileSync(`${DECKS_DIR}${file}`, "utf8"));
      const status = deckStatus(file, form);
      return { file, name: form.name || file, playstyle: form.playstyle, ready: status.ready };
    });
}

function slugFor(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "deck";
  let file = `${base}.md`;
  for (let i = 2; existsSync(`${DECKS_DIR}${file}`) || HIDDEN.has(file); i++) file = `${base}-${i}.md`;
  return file;
}

// ---------------------------------------------------------------------------

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function deckFile(name: string): string {
  const file = decodeURIComponent(name);
  if (!FILE_RE.test(file) || HIDDEN.has(file)) throw new HttpError(400, `Bad deck file name "${file}".`);
  return file;
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Only answer requests addressed to this machine (blocks DNS-rebinding from other sites).
  const host = (req.headers.host ?? "").split(":")[0];
  if (host !== "127.0.0.1" && host !== "localhost") throw new HttpError(403, "Forbidden host");

  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && (path === "/" || path === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(readFileSync(PAGE));
    return;
  }

  if (!path.startsWith("/api/")) throw new HttpError(404, "Not found");
  if (method !== "GET" && req.headers["content-type"] !== "application/json") {
    throw new HttpError(415, "Send JSON");
  }

  if (method === "GET" && path === "/api/meta") {
    const playstyles = Object.fromEntries(
      PLAYSTYLES.map((p) => {
        const g = loadGuide(p);
        return [p, { title: g.title, plans: g.plans }];
      }),
    );
    return send(res, 200, {
      guides: GUIDE_IDS.map((id) => ({ id, title: loadGuide(id).title })),
      playstyles,
    });
  }

  if (method === "GET" && path === "/api/decks") return send(res, 200, listDecks());

  if (method === "POST" && path === "/api/check-decklist") {
    const { decklist } = (await body(req)) as { decklist?: string };
    return send(res, 200, checkDecklist(String(decklist ?? "")));
  }

  if (method === "POST" && path === "/api/decks") {
    const form = (await body(req)) as DeckForm;
    const file = slugFor(form.name ?? "");
    writeFileSync(`${DECKS_DIR}${file}`, formToMarkdown(form));
    return send(res, 201, { file, form, status: deckStatus(file, form) });
  }

  const deckMatch = /^\/api\/decks\/([^/]+)$/.exec(path);
  if (deckMatch) {
    const file = deckFile(deckMatch[1]!);
    const full = `${DECKS_DIR}${file}`;
    if (method === "GET") {
      if (!existsSync(full)) throw new HttpError(404, "No such deck");
      const markdown = readFileSync(full, "utf8");
      const form = markdownToForm(markdown);
      return send(res, 200, { file, form, markdown, status: deckStatus(file, form) });
    }
    if (method === "PUT") {
      const form = (await body(req)) as DeckForm;
      const markdown = formToMarkdown(form);
      writeFileSync(full, markdown);
      const saved = markdownToForm(markdown);
      return send(res, 200, { file, form: saved, markdown, status: deckStatus(file, saved) });
    }
    if (method === "DELETE") {
      if (existsSync(full)) unlinkSync(full);
      return send(res, 200, { ok: true });
    }
  }

  const guideMatch = /^\/api\/guides\/([^/]+)$/.exec(path);
  if (guideMatch) {
    const id = guideMatch[1]!;
    if (!isGuideId(id)) throw new HttpError(404, "No such guide");
    if (method === "GET") return send(res, 200, { id, markdown: readGuideMarkdown(id) });
    if (method === "PUT") {
      const { markdown } = (await body(req)) as { markdown?: string };
      try {
        writeGuideMarkdown(id, String(markdown ?? ""));
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
      return send(res, 200, { id, markdown: readGuideMarkdown(id), guide: loadGuide(id) });
    }
  }

  throw new HttpError(404, "Not found");
}

const server = createServer((req, res) => {
  route(req, res).catch((err: unknown) => {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    if (status === 500) console.error(err);
    if (!res.headersSent) send(res, status, { error: message });
    else res.end();
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Jev studio: http://localhost:${port}`);
  console.log(`Decks:  ${DECKS_DIR}`);
  console.log("Ctrl+C to stop.");
});
