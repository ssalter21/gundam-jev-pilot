/**
 * Jev studio: a local web UI to store your decks, write meta deck files, edit the guides,
 * and play against a meta deck in the browser.
 *
 *   pnpm jev:studio [--port 4747]
 *
 * Serves studio/index.html and a small JSON API on 127.0.0.1 only. Reads and writes
 * my-decks/*.md (name + decklist), jev-decks/*.md and jev-guides/*.md; those Markdown files
 * stay the source of truth.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { DeckList } from "@tcg/gundam-engine";
import { fileURLToPath } from "node:url";

import {
  checkDecklist,
  formToMarkdown,
  markdownToForm,
  type DeckForm,
} from "../src/jev/deck-form.ts";
import { loadDeckNotes, parseDeckNotes } from "../src/jev/deck-notes.ts";
import { PlaySession } from "../src/jev/play-session.ts";
import { REGISTERED_DECKS, type BenchDeckId } from "../src/runtime.ts";
import {
  GUIDE_IDS,
  isGuideId,
  loadGuide,
  PLAYSTYLES,
  readGuideMarkdown,
  writeGuideMarkdown,
} from "../src/jev/guides.ts";
import { makeClient, parseArgs } from "../src/jev/setup.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DECKS_DIR = `${ROOT}jev-decks/`;
const MY_DECKS_DIR = `${ROOT}my-decks/`;
mkdirSync(MY_DECKS_DIR, { recursive: true });
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

function listMyDecks() {
  return readdirSync(MY_DECKS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((file) => {
      const form = markdownToForm(readFileSync(`${MY_DECKS_DIR}${file}`, "utf8"));
      const check = checkDecklist(form.decklist);
      return { file, name: form.name || file, ready: check.errors.length === 0, total: check.total };
    });
}

/** A saved personal deck: just a name and a decklist. */
function myDeckForm(input: Partial<DeckForm>): DeckForm {
  return {
    name: String(input.name ?? ""),
    playstyle: "",
    decklist: String(input.decklist ?? ""),
    overview: "",
    keyPlays: [],
    plans: [],
    rules: [],
    cardNotes: [],
  };
}

// ---------------------------------------------------------------------------
// Games

const games = new Map<string, PlaySession>();

function startGame(input: { myDeck?: string; metaDeck?: string; showPlan?: boolean; seed?: string }) {
  const myArg = String(input.myDeck ?? "");
  let me: { name: string; deck: DeckList };
  if (myArg.startsWith("builtin:")) {
    const id = myArg.slice("builtin:".length) as BenchDeckId;
    const deck = REGISTERED_DECKS[id];
    if (!deck) throw new HttpError(400, `Unknown built-in deck "${id}".`);
    me = { name: `${id} (built-in)`, deck };
  } else {
    const file = deckFile(myArg);
    const path = `${MY_DECKS_DIR}${file}`;
    if (!existsSync(path)) throw new HttpError(404, "Pick one of your decks.");
    const problems = checkDecklist(markdownToForm(readFileSync(path, "utf8")).decklist).errors;
    if (problems.length) throw new HttpError(400, `Your deck isn't legal yet: ${problems.join(" ")}`);
    const notes = parseDeckNotes(readFileSync(path, "utf8"), file, { requirePlans: false });
    me = { name: notes.name, deck: notes.deck };
  }

  const metaFile = deckFile(String(input.metaDeck ?? ""));
  let meta;
  try {
    meta = loadDeckNotes(`${DECKS_DIR}${metaFile}`);
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }

  const seed = input.seed ? String(input.seed) : `studio-${Date.now()}`;
  const session = new PlaySession(randomUUID(), me, meta, makeClient({}), seed, input.showPlan === true);
  // Keep only a handful of games around.
  for (const [id, g] of games) if (games.size >= 5 && g.snapshot().status === "over") games.delete(id);
  games.set(session.id, session);
  session.start();
  return session;
}

function slugFor(name: string, dir = DECKS_DIR): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "deck";
  let file = `${base}.md`;
  for (let i = 2; existsSync(`${dir}${file}`) || HIDDEN.has(file); i++) file = `${base}-${i}.md`;
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
      builtinDecks: Object.keys(REGISTERED_DECKS),
      jev: process.env.TYPESAFE_API_KEY ? "real" : "mock",
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

  // My decks (name + decklist only)
  if (method === "GET" && path === "/api/my-decks") return send(res, 200, listMyDecks());
  if (method === "POST" && path === "/api/my-decks") {
    const form = myDeckForm((await body(req)) as Partial<DeckForm>);
    const file = slugFor(form.name, MY_DECKS_DIR);
    writeFileSync(`${MY_DECKS_DIR}${file}`, formToMarkdown(form));
    return send(res, 201, { file, form, check: checkDecklist(form.decklist) });
  }
  const myMatch = /^\/api\/my-decks\/([^/]+)$/.exec(path);
  if (myMatch) {
    const file = deckFile(myMatch[1]!);
    const full = `${MY_DECKS_DIR}${file}`;
    if (method === "GET") {
      if (!existsSync(full)) throw new HttpError(404, "No such deck");
      const form = markdownToForm(readFileSync(full, "utf8"));
      return send(res, 200, { file, form, check: checkDecklist(form.decklist) });
    }
    if (method === "PUT") {
      const form = myDeckForm((await body(req)) as Partial<DeckForm>);
      writeFileSync(full, formToMarkdown(form));
      return send(res, 200, { file, form, check: checkDecklist(form.decklist) });
    }
    if (method === "DELETE") {
      if (existsSync(full)) unlinkSync(full);
      return send(res, 200, { ok: true });
    }
  }

  // Games
  if (method === "POST" && path === "/api/games") {
    const session = startGame((await body(req)) as Parameters<typeof startGame>[0]);
    return send(res, 201, session.snapshot());
  }
  const gameMatch = /^\/api\/games\/([^/]+)(\/move|\/concede)?$/.exec(path);
  if (gameMatch) {
    const session = games.get(gameMatch[1]!);
    if (!session) throw new HttpError(404, "That game has ended or the studio was restarted.");
    if (method === "GET" && !gameMatch[2]) return send(res, 200, session.snapshot());
    if (method === "POST" && gameMatch[2] === "/move") {
      const { option } = (await body(req)) as { option?: number };
      try {
        session.choose(Number(option));
      } catch (err) {
        throw new HttpError(409, err instanceof Error ? err.message : String(err));
      }
      return send(res, 200, session.snapshot());
    }
    if (method === "POST" && gameMatch[2] === "/concede") {
      session.concede();
      return send(res, 200, session.snapshot());
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
