/**
 * jahoot — https://quiz.jett.io
 *
 * One Worker, three planes:
 *
 *   /api/*     Bearer API_TOKEN. The quiz CRUD surface AI tools talk to (see
 *              skills/jahoot-quiz-manager). Deliberately NOT behind Cloudflare
 *              Access, so a plain curl with a token works.
 *   /admin/*   Cloudflare Access. The browser quiz builder, same CRUD handlers.
 *   everything else — public. Hosting a game and playing one need no account;
 *              a 6-digit passcode is the only thing a player holds.
 */

import { Game } from "./game";
import {
  accessConfigured,
  adminOpenForDev,
  hasApiToken,
  verifyAccess,
} from "./auth";
import { commitReservation, isCode, lookupCode, reserveCode } from "./codes";
import {
  ValidationError,
  deleteQuiz,
  getQuiz,
  isQuizId,
  listQuizzes,
  putQuiz,
  summarise,
  validateQuiz,
} from "./quizzes";
import { getResult, isGameId } from "./results";

export { Game };

const json = (body: unknown, status = 200, extra: HeadersInit = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extra,
    },
  });

const err = (message: string, status: number) => json({ error: message }, status);

/** The whole site is private-ish and never cacheable. */
const PAGE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path.startsWith("/ws/")) return websocket(request, env, path);
    if (path === "/api" || path.startsWith("/api/")) return api(request, env, url, path);
    if (path === "/admin" || path.startsWith("/admin/")) return admin(request, env, url, path);

    return page(request, env, path);
  },
} satisfies ExportedHandler<Env>;

// ---- pages ----

/**
 * Clean URLs are mapped onto literal asset files here rather than by the asset
 * layer's html_handling (which is off). Each page fetches its own data from the
 * API on load, so the HTML itself is static.
 */
async function page(request: Request, env: Env, path: string): Promise<Response> {
  const file =
    path === "/"
      ? "/index.html"
      : path === "/play"
        ? "/play.html"
        : path.startsWith("/host/")
          ? "/host.html"
          : path.startsWith("/results/")
            ? "/results.html"
            : path;

  const res = await asset(request, env, file);
  if (res.status === 404 && file.endsWith(".html")) {
    return new Response("Not found", { status: 404, headers: PAGE_HEADERS });
  }
  if (!file.endsWith(".html")) return res;
  return new Response(res.body, {
    status: res.status,
    headers: { ...Object.fromEntries(res.headers), ...PAGE_HEADERS },
  });
}

function asset(request: Request, env: Env, file: string): Promise<Response> {
  const target = new URL(request.url);
  target.pathname = file;
  target.search = "";
  return env.ASSETS.fetch(new Request(target, { headers: request.headers }));
}

// ---- /admin : Cloudflare Access ----

async function admin(request: Request, env: Env, url: URL, path: string): Promise<Response> {
  const identity = accessConfigured(env) ? await verifyAccess(request, env) : null;

  if (!identity) {
    // Refuse to serve the builder unprotected. In production Access answers
    // first and we never get here; if ACCESS_* is unset, that is a
    // misconfiguration, not an invitation.
    if (!adminOpenForDev(env)) {
      const why = accessConfigured(env)
        ? "Cloudflare Access did not authenticate this request."
        : "ACCESS_AUD / ACCESS_TEAM_DOMAIN are not configured on this Worker.";
      return json({ error: `Admin is locked. ${why}` }, 403);
    }
  }
  const who = identity?.email ?? "local-dev";

  if (path === "/admin/api/quizzes" || path.startsWith("/admin/api/quizzes/")) {
    return quizApi(request, env, url, path.replace("/admin/api", "/api"), who);
  }
  if (path === "/admin/api/whoami") return json({ email: who });

  const file = path === "/admin" ? "/admin/index.html" : path;
  const res = await asset(request, env, file);
  if (!file.endsWith(".html")) return res;
  return new Response(res.body, {
    status: res.status,
    headers: { ...Object.fromEntries(res.headers), ...PAGE_HEADERS },
  });
}

// ---- /api ----

async function api(request: Request, env: Env, url: URL, path: string): Promise<Response> {
  // Public game endpoints: anyone holding a share link can host, anyone with a
  // passcode can play.
  if (path === "/api/games" && request.method === "POST") return createGame(request, env, url);
  if (path.startsWith("/api/games/") && request.method === "GET") {
    return gameInfo(env, path.slice("/api/games/".length));
  }
  if (path.startsWith("/api/results/") && request.method === "GET") {
    const result = await getResult(env.DATA, path.slice("/api/results/".length));
    return result ? json(result) : err("No such game result.", 404);
  }

  // Everything else is quiz CRUD and needs the API token.
  if (!env.API_TOKEN) {
    return err("API_TOKEN is not set on this Worker; the quiz API is disabled.", 503);
  }
  if (!(await hasApiToken(request, env))) {
    return err("Unauthorized. Send Authorization: Bearer <API_TOKEN>.", 401);
  }
  const who = request.headers.get("X-Published-By")?.slice(0, 40) || "api";
  return quizApi(request, env, url, path, who);
}

/** Shared by the token plane (/api) and the Access plane (/admin/api). */
async function quizApi(
  request: Request,
  env: Env,
  url: URL,
  path: string,
  who: string,
): Promise<Response> {
  const origin = url.origin;

  if (path === "/api/quizzes") {
    if (request.method === "GET") {
      return json({ quizzes: await listQuizzes(env.DATA, origin) });
    }
    if (request.method === "POST") {
      return saveQuiz(request, env, origin, who, null);
    }
    return err("Method not allowed.", 405);
  }

  if (path.startsWith("/api/quizzes/")) {
    const id = path.slice("/api/quizzes/".length);
    if (!isQuizId(id)) return err("Invalid quiz id.", 400);

    if (request.method === "GET") {
      const quiz = await getQuiz(env.DATA, id);
      return quiz ? json(quiz) : err("No such quiz.", 404);
    }
    if (request.method === "PUT") {
      return saveQuiz(request, env, origin, who, id);
    }
    if (request.method === "DELETE") {
      const quiz = await getQuiz(env.DATA, id);
      if (!quiz) return err("No such quiz.", 404);
      await deleteQuiz(env.DATA, id);
      return json({ deleted: id });
    }
    return err("Method not allowed.", 405);
  }

  return err("No such endpoint.", 404);
}

async function saveQuiz(
  request: Request,
  env: Env,
  origin: string,
  who: string,
  id: string | null,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err("Body must be valid JSON.", 400);
  }

  // PUT onto an existing id keeps its creation stamp and author.
  const existing = id ? await getQuiz(env.DATA, id) : null;
  try {
    const quiz = validateQuiz(body, {
      id: id ?? undefined,
      createdBy: existing?.createdBy ?? who,
      createdAt: existing?.createdAt,
    });
    await putQuiz(env.DATA, quiz);
    return json(
      { ...summarise(quiz, origin), questions: quiz.questions.length },
      existing || !id ? (id ? 200 : 201) : 201,
    );
  } catch (e) {
    if (e instanceof ValidationError) return err(e.message, 400);
    throw e;
  }
}

// ---- games ----

async function createGame(request: Request, env: Env, url: URL): Promise<Response> {
  let body: { quizId?: string };
  try {
    body = (await request.json()) as { quizId?: string };
  } catch {
    return err("Body must be valid JSON.", 400);
  }
  const quizId = String(body.quizId ?? "");
  const quiz = await getQuiz(env.DATA, quizId);
  if (!quiz) return err("No such quiz.", 404);

  const code = await reserveCode(env.DATA);
  if (!code) return err("Could not allocate a passcode; try again.", 503);

  const stub = env.GAME.getByName(code);
  const game = await stub.init(quiz, code);
  await commitReservation(env.DATA, code, { quizId: quiz.id, gameId: game.gameId });

  return json({
    code: game.code,
    gameId: game.gameId,
    hostToken: game.hostToken,
    title: game.title,
    joinUrl: `${url.origin}/play?code=${game.code}`,
  });
}

/** Used by the join screen to tell "wrong code" from "game not started yet". */
async function gameInfo(env: Env, code: string): Promise<Response> {
  if (!isCode(code)) return err("A passcode is 6 digits.", 400);
  const reservation = await lookupCode(env.DATA, code);
  if (!reservation) return err("No game with that passcode.", 404);
  const info = await env.GAME.getByName(code).info();
  if (!info) return err("No game with that passcode.", 404);
  return json({ code, ...info });
}

// ---- websockets ----

async function websocket(request: Request, env: Env, path: string): Promise<Response> {
  const match = /^\/ws\/(host|play)\/([0-9]{6})$/.exec(path);
  if (!match) return new Response("Not found", { status: 404 });
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }
  const code = match[2]!;

  const stub = env.GAME.getByName(code);
  if (!(await stub.exists())) return new Response("No such game", { status: 404 });
  return stub.fetch(request);
}
