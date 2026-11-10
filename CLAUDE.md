# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single Cloudflare Worker (`jahoot`) running Kahoot-style live quizzes at
https://quiz.jett.io. A host opens a quiz, the Worker puts a 6-digit passcode on
screen, players join on their phones with a nickname, and questions are scored on
speed. **Quiz content never lives in this repo** — only the Worker, the static
front end, and tests.

There is no model on the server. "AI-generated quizzes" means Claude Code writes
the questions and POSTs them to the quiz API, driven by `skills/jahoot-quiz-manager`.

## Commands

```sh
npm test                  # vitest run (in-Workers-runtime tests)
npx vitest run -t "name"  # single test by name
npm run check             # tsc --noEmit
npm run dev               # wrangler dev, secrets from .dev.vars
npm run deploy            # wrangler deploy -> quiz.jett.io
npm run types             # regenerate worker-configuration.d.ts after wrangler.jsonc changes
```

If `npm install` fails with an arborist `edgesOut` TypeError, retry with
`--legacy-peer-deps` (known npm bug with vitest 4's peer-dependency cycle).

## Architecture

`src/index.ts` routes requests into three planes:

- **Token plane** (`/api/quizzes*`): `Authorization: Bearer <API_TOKEN>`. Quiz
  CRUD for AI tools. Deliberately **not** behind Cloudflare Access so a plain
  curl works. `X-Published-By` is recorded as the quiz's author.
- **Access plane** (`/admin/*`): the browser quiz builder, gated on a Cloudflare
  Access JWT. `/admin/api/*` re-enters the *same* CRUD handlers as `/api`, so a
  quiz written in the builder and one written by Claude Code are one record.
- **Public**: hosting and playing. `POST /api/games`, `GET /api/games/<code>`,
  `GET /api/results/<id>` and the `/ws/*` upgrades need no credentials — holding
  the host link is the authority to run a game, and a passcode is all a player has.

`src/game.ts` is the `Game` Durable Object, one per live passcode (the passcode
*is* the object's name). It snapshots the quiz at `init()` so editing a quiz
can't change a game in flight, drives the clock with a storage alarm, and keeps
players/answers/scores in its SQLite storage. Its RPC methods (`init`,
`playerJoin`, `playerAnswer`, `hostAction`, `hostView`, `playerView`) are the
real API; the WebSocket handler is a thin shell over them, which is also how
most tests drive it.

KV (binding `DATA`) holds three prefixes: `quiz:<id>`, `game:<code>` (a live
passcode reservation, 6h TTL) and `result:<gameId>` (final scoreboard, 30d TTL).

## Constraints and gotchas

- **`ctx.access` does not work here.** This Worker serves Static Assets, and the
  internal assets router does not propagate `ctx.access` to the user Worker. The
  Access JWT is verified by hand in `src/auth.ts` with `jose` against
  `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD`. Don't "simplify" it to `ctx.access`.
- The admin plane **fails closed**: with `ACCESS_*` unset it returns 403 rather
  than serving the builder. `ALLOW_INSECURE_ADMIN=1` opens it for local dev only.
- Asset routing is explicit: `run_worker_first: true`, `html_handling: "none"`,
  and the Worker maps clean URLs onto literal asset files. This avoids the
  `/x.html` → `/x` redirect loop; don't turn `html_handling` back on.
- **Role-aware broadcasts.** `hostView()` and `playerView()` omit `correct`
  flags until a question closes. Any new field on those views must not leak the
  answer key mid-question — there are tests asserting the serialised payload
  contains no `"correct"` while a question is open.
- One player can hold several sockets (a reconnect racing the old socket's
  close). `webSocketClose` only marks them away when the last one goes, or
  `connectedPlayerCount()` undercounts and questions end early.
- Secrets (`API_TOKEN`) exist only as Worker secrets and in untracked
  `.dev.vars`. Tests inject fixed values via `miniflare.bindings` in
  `vitest.config.ts`.
- `Env` is generated (`worker-configuration.d.ts`, via `npm run types`) — never
  hand-write it. Secrets only appear in it if they are in `.dev.vars`.
- `compatibility_date` can be at most the date baked into the installed
  `workerd` (`1.YYYYMMDD.N`), or tests fail with `ERR_FUTURE_COMPATIBILITY_DATE`.
- Everything is sent `no-store` + noindex. The whole site is private; don't
  introduce cacheable responses.
- Front end is plain ES modules in `public/` with no build step. The design
  system lives in `public/styles.css` ("stadium scoreboard": ink navy, sodium
  amber, enamel answer tiles). Answer tiles carry a **shape as well as a
  colour** so colourblind players can call an answer out loud — keep the glyphs.
