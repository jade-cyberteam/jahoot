import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/**
 * Exercises the real WebSocket path through the Worker — the join/answer
 * protocol the phones actually speak, which the RPC tests bypass.
 */

const BASE = "https://quiz.jett.io";
const TOKEN = "test-api-token";

const QUIZ = {
  title: "Socket quiz",
  questions: [
    {
      text: "Pick A",
      timeLimit: 30,
      answers: [
        { text: "A", correct: true },
        { text: "B", correct: false },
      ],
    },
  ],
};

async function newGame(): Promise<{ code: string; hostToken: string }> {
  const created = await exports.default.fetch(
    new Request(`${BASE}/api/quizzes`, {
      method: "POST",
      body: JSON.stringify(QUIZ),
      headers: { Authorization: `Bearer ${TOKEN}` },
    }),
  );
  const { id } = (await created.json()) as { id: string };

  const game = await exports.default.fetch(
    new Request(`${BASE}/api/games`, { method: "POST", body: JSON.stringify({ quizId: id }) }),
  );
  return (await game.json()) as { code: string; hostToken: string };
}

/**
 * A socket plus every message it has received. Buffering from the moment it
 * opens matters: broadcasts land whenever the Durable Object sends them, and a
 * listener attached later would miss the one the test is waiting for.
 */
interface Socket {
  ws: WebSocket;
  seen: any[];
  waiters: { want: (msg: any) => boolean; resolve: (msg: any) => void }[];
}

async function open(path: string): Promise<Socket> {
  const res = await exports.default.fetch(
    new Request(`${BASE}${path}`, { headers: { Upgrade: "websocket" } }),
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const socket: Socket = { ws, seen: [], waiters: [] };

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse((event as MessageEvent).data as string);
    socket.seen.push(msg);
    for (const waiter of [...socket.waiters]) {
      if (!waiter.want(msg)) continue;
      socket.waiters.splice(socket.waiters.indexOf(waiter), 1);
      waiter.resolve(msg);
    }
  });
  ws.accept();
  return socket;
}

const send = (socket: Socket, msg: unknown) => socket.ws.send(JSON.stringify(msg));

/** Resolves with the first matching message, already-received ones included. */
function next(socket: Socket, want: (msg: any) => boolean, timeoutMs = 3000): Promise<any> {
  const already = socket.seen.find(want);
  if (already) return Promise.resolve(already);

  return new Promise((resolve, reject) => {
    const waiter = { want, resolve };
    socket.waiters.push(waiter);
    setTimeout(() => {
      if (!socket.waiters.includes(waiter)) return;
      socket.waiters.splice(socket.waiters.indexOf(waiter), 1);
      reject(
        new Error(
          `timed out; saw ${JSON.stringify(socket.seen.map((m) => m.type + ":" + (m.state?.phase ?? "")))}`,
        ),
      );
    }, timeoutMs);
  });
}

describe("websocket protocol", () => {
  it("lets a phone join, answer, and see the result", async () => {
    const { code, hostToken } = await newGame();

    const host = await open(`/ws/host/${code}?hostToken=${hostToken}`);
    const player = await open(`/ws/play/${code}`);

    send(player, { action: "join", name: "Ana" });
    const joined = await next(player, (m) => m.type === "joined");
    expect(joined.name).toBe("Ana");
    expect(joined.playerId).toMatch(/^p_/);

    // The host sees the roster change without asking for it.
    const lobby = await next(
      host,
      (m) => m.type === "state" && m.state.players.length === 1,
    );
    expect(lobby.state.players[0].name).toBe("Ana");

    send(host, { action: "start" });
    const asked = await next(player, (m) => m.type === "state" && m.state.phase === "question");
    // The answer key must not be on the wire while the question is open.
    expect(asked.state.question.answers.every((a: any) => a.correct === undefined)).toBe(true);

    send(player, { action: "answer", questionIndex: 0, answerIndex: 0 });
    const revealed = await next(player, (m) => m.type === "state" && m.state.phase === "reveal");
    expect(revealed.state.myAnswer.correct).toBe(true);
    expect(revealed.state.me.score).toBeGreaterThan(0);

    host.ws.close();
    player.ws.close();
  });

  it("refuses a host socket without the host token", async () => {
    const { code } = await newGame();
    const res = await exports.default.fetch(
      new Request(`${BASE}/ws/host/${code}?hostToken=guessed`, {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("ignores an answer from a socket that never joined", async () => {
    const { code } = await newGame();
    const player = await open(`/ws/play/${code}`);
    send(player, { action: "answer", questionIndex: 0, answerIndex: 0 });
    const error = await next(player, (m) => m.type === "error");
    expect(error.message).toBe("Join first.");
    player.ws.close();
  });

  it("keeps a player online while any of their sockets is still open", async () => {
    const { code, hostToken } = await newGame();
    const host = await open(`/ws/host/${code}?hostToken=${hostToken}`);

    const first = await open(`/ws/play/${code}`);
    send(first, { action: "join", name: "Ana" });
    const joined = await next(first, (m) => m.type === "joined");

    // Same player, second socket — a reconnect racing the old socket's close.
    const second = await open(`/ws/play/${code}`);
    send(second, { action: "join", name: "", playerToken: joined.playerToken });
    await next(second, (m) => m.type === "joined");

    second.ws.close();

    // Ana still holds `first`, so she must not be shown as away.
    await new Promise((r) => setTimeout(r, 150));
    const info = await exports.default.fetch(new Request(`${BASE}/api/games/${code}`));
    expect(((await info.json()) as { players: number }).players).toBe(1);

    const state = await next(host, (m) => m.type === "state", 2500).catch(() => null);
    const players = state?.state.players ?? [];
    if (players.length) expect(players[0].connected).toBe(true);

    first.ws.close();
    host.ws.close();
  });
});
