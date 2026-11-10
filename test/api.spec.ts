import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "https://quiz.jett.io";
const TOKEN = "test-api-token";

function dispatch(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`${BASE}${path}`, { redirect: "manual", ...init }));
}

function api(method: string, path: string, body?: unknown, token = TOKEN): Promise<Response> {
  return dispatch(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: `Bearer ${token}`, "X-Published-By": "vitest" },
  });
}

const SAMPLE = {
  title: "NZ geography",
  description: "Mostly rivers",
  questions: [
    {
      text: "Which river is New Zealand's longest?",
      timeLimit: 15,
      points: 1000,
      answers: [
        { text: "Waikato", correct: true },
        { text: "Clutha", correct: false },
        { text: "Whanganui", correct: false },
      ],
    },
    { type: "boolean", text: "Aoraki is the highest peak.", answer: true },
  ],
};

async function createQuiz(body: unknown = SAMPLE): Promise<{ id: string; title: string }> {
  const res = await api("POST", "/api/quizzes", body);
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; title: string };
}

describe("quiz API auth", () => {
  it("rejects a request with no token", async () => {
    const res = await dispatch("/api/quizzes");
    expect(res.status).toBe(401);
  });

  it("rejects a request with the wrong token", async () => {
    const res = await api("GET", "/api/quizzes", undefined, "not-the-token");
    expect(res.status).toBe(401);
  });

  it("accepts the configured token", async () => {
    const res = await api("GET", "/api/quizzes");
    expect(res.status).toBe(200);
  });
});

describe("quiz CRUD", () => {
  it("creates, reads, lists, replaces and deletes a quiz", async () => {
    const created = await createQuiz();
    expect(created.id).toMatch(/^q_[a-z0-9]+$/);

    const read = await api("GET", `/api/quizzes/${created.id}`);
    expect(read.status).toBe(200);
    const quiz = (await read.json()) as Record<string, any>;
    expect(quiz.title).toBe("NZ geography");
    expect(quiz.questions).toHaveLength(2);
    expect(quiz.createdBy).toBe("vitest");
    // The boolean shorthand expands into two answers.
    expect(quiz.questions[1].answers).toEqual([
      { text: "True", correct: true },
      { text: "False", correct: false },
    ]);

    const list = await api("GET", "/api/quizzes");
    const { quizzes } = (await list.json()) as { quizzes: { id: string }[] };
    expect(quizzes.some((q) => q.id === created.id)).toBe(true);

    const replaced = await api("PUT", `/api/quizzes/${created.id}`, {
      ...SAMPLE,
      title: "NZ geography, harder",
    });
    expect(replaced.status).toBe(200);
    const after = (await (await api("GET", `/api/quizzes/${created.id}`)).json()) as any;
    expect(after.title).toBe("NZ geography, harder");
    expect(after.createdAt).toBe(quiz.createdAt); // creation stamp survives a PUT

    expect((await api("DELETE", `/api/quizzes/${created.id}`)).status).toBe(200);
    expect((await api("GET", `/api/quizzes/${created.id}`)).status).toBe(404);
  });

  it("rejects an unknown quiz id shape before touching storage", async () => {
    expect((await api("GET", "/api/quizzes/not-a-real-id")).status).toBe(400);
  });
});

describe("quiz validation", () => {
  const bad = async (body: unknown): Promise<string> => {
    const res = await api("POST", "/api/quizzes", body);
    expect(res.status).toBe(400);
    return ((await res.json()) as { error: string }).error;
  };

  it("requires a title", async () => {
    expect(await bad({ questions: SAMPLE.questions })).toMatch(/title is required/i);
  });

  it("requires at least one question", async () => {
    expect(await bad({ title: "Empty", questions: [] })).toMatch(/non-empty/i);
  });

  it("requires exactly one correct answer", async () => {
    const error = await bad({
      title: "Two right",
      questions: [
        {
          text: "Pick one",
          answers: [
            { text: "a", correct: true },
            { text: "b", correct: true },
          ],
        },
      ],
    });
    expect(error).toMatch(/exactly one correct answer \(found 2\)/);
  });

  it("requires at least two answers", async () => {
    expect(
      await bad({
        title: "Lonely",
        questions: [{ text: "Only one", answers: [{ text: "a", correct: true }] }],
      }),
    ).toMatch(/at least 2 answers/);
  });

  it("rejects a time limit outside the allowed range", async () => {
    expect(
      await bad({
        title: "Too slow",
        questions: [{ ...SAMPLE.questions[0], timeLimit: 600 }],
      }),
    ).toMatch(/between 5 and 120/);
  });

  it("accepts the options + correctIndex spelling AI tools tend to emit", async () => {
    const created = await createQuiz({
      title: "Options spelling",
      questions: [
        { question: "Capital of NZ?", options: ["Auckland", "Wellington"], correctIndex: 1 },
      ],
    });
    const quiz = (await (await api("GET", `/api/quizzes/${created.id}`)).json()) as any;
    expect(quiz.questions[0].text).toBe("Capital of NZ?");
    expect(quiz.questions[0].answers[1]).toEqual({ text: "Wellington", correct: true });
    // Unspecified timing falls back to the defaults.
    expect(quiz.questions[0].timeLimit).toBe(20);
    expect(quiz.questions[0].points).toBe(1000);
  });

  it("rejects malformed JSON", async () => {
    const res = await dispatch("/api/quizzes", {
      method: "POST",
      body: "{not json",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
  });
});

describe("admin plane", () => {
  it("fails closed when Cloudflare Access is not configured", async () => {
    const res = await dispatch("/admin");
    expect(res.status).toBe(403);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/ACCESS_AUD/);
  });

  it("does not expose quiz writes through the admin API without Access", async () => {
    const res = await dispatch("/admin/api/quizzes", {
      method: "POST",
      body: JSON.stringify(SAMPLE),
    });
    expect(res.status).toBe(403);
  });
});

describe("hosting a game", () => {
  it("issues a passcode and host token for a quiz anyone holds the link to", async () => {
    const quiz = await createQuiz();

    // Note: no Authorization header — hosting is deliberately public.
    const res = await dispatch("/api/games", {
      method: "POST",
      body: JSON.stringify({ quizId: quiz.id }),
    });
    expect(res.status).toBe(200);
    const game = (await res.json()) as Record<string, string>;
    expect(game.code).toMatch(/^[0-9]{6}$/);
    expect(game.gameId).toMatch(/^g_[a-z0-9]+$/);
    expect(game.hostToken).toBeTruthy();
    expect(game.joinUrl).toBe(`${BASE}/play?code=${game.code}`);

    const info = await dispatch(`/api/games/${game.code}`);
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({
      code: game.code,
      title: "NZ geography",
      phase: "lobby",
      players: 0,
    });
  });

  it("refuses to host a quiz that does not exist", async () => {
    const res = await dispatch("/api/games", {
      method: "POST",
      body: JSON.stringify({ quizId: "q_doesnotexist" }),
    });
    expect(res.status).toBe(404);
  });

  it("reports an unknown passcode as not found", async () => {
    expect((await dispatch("/api/games/000000")).status).toBe(404);
    expect((await dispatch("/api/games/12")).status).toBe(400);
  });

  it("rejects a websocket upgrade for a game that was never created", async () => {
    const res = await dispatch("/ws/play/999999", { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(404);
  });
});

describe("pages", () => {
  it("serves the join screen at the root", async () => {
    const res = await dispatch("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(await res.text()).toContain("Game passcode");
  });

  it("maps /host/<quizId> and /play onto their pages", async () => {
    expect((await dispatch("/host/q_whatever")).status).toBe(200);
    expect((await dispatch("/play")).status).toBe(200);
  });

  it("404s an unknown page", async () => {
    expect((await dispatch("/nope")).status).toBe(404);
  });
});
