import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { validateQuiz } from "../src/quizzes";

/** A fresh passcode per test so each one gets its own Durable Object. */
let seq = 100000;
const nextCode = () => String(++seq);

const QUIZ = validateQuiz(
  {
    title: "Game loop",
    questions: [
      {
        text: "Pick A",
        timeLimit: 10,
        points: 1000,
        answers: [
          { text: "A", correct: true },
          { text: "B", correct: false },
          { text: "C", correct: false },
        ],
      },
      { type: "boolean", text: "True please", answer: true, timeLimit: 10, points: 1000 },
    ],
  },
  { createdBy: "vitest" },
);

type View = Record<string, any>;

function game(code: string) {
  return env.GAME.getByName(code);
}

describe("game lifecycle", () => {
  let code: string;
  let stub: ReturnType<typeof game>;

  beforeEach(async () => {
    code = nextCode();
    stub = game(code);
    await stub.init(QUIZ, code);
  });

  it("starts in a lobby with no players", async () => {
    const view = (await stub.hostView()) as View;
    expect(view.phase).toBe("lobby");
    expect(view.code).toBe(code);
    expect(view.title).toBe("Game loop");
    expect(view.questionCount).toBe(2);
    expect(view.players).toEqual([]);
  });

  it("is idempotent, so a reloaded host tab does not start a second game", async () => {
    const first = await stub.init(QUIZ, code);
    const second = await stub.init(QUIZ, code);
    expect(second.gameId).toBe(first.gameId);
    expect(second.hostToken).toBe(first.hostToken);
  });

  it("admits players, and rejects duplicate nicknames and blank names", async () => {
    const ana = await stub.playerJoin("Ana");
    expect(ana).toMatchObject({ ok: true, name: "Ana" });

    expect(await stub.playerJoin("ana")).toEqual({
      error: "Someone already took that nickname.",
    });
    expect(await stub.playerJoin("   ")).toEqual({ error: "Enter a nickname first." });

    const view = (await stub.hostView()) as View;
    expect(view.players.map((p: View) => p.name)).toEqual(["Ana"]);
  });

  it("lets a player rejoin with their token and keep their score", async () => {
    const ana = (await stub.playerJoin("Ana")) as View;
    await stub.hostAction("start");
    await stub.playerAnswer(ana.playerId, 0, 0);

    const again = (await stub.playerJoin("ignored", ana.playerToken)) as View;
    expect(again.playerId).toBe(ana.playerId);
    expect(again.name).toBe("Ana");
  });

  it("closes the lobby once the game has started", async () => {
    await stub.playerJoin("Ana");
    await stub.hostAction("start");
    expect(await stub.playerJoin("Late")).toEqual({
      error: "That game has already started.",
    });
  });

  it("guards the host token", async () => {
    const { hostToken } = await stub.init(QUIZ, code);
    expect(await stub.checkHostToken(hostToken)).toBe(true);
    expect(await stub.checkHostToken("guessed")).toBe(false);
  });
});

describe("answering and scoring", () => {
  let code: string;
  let stub: ReturnType<typeof game>;
  let ana: View;
  let ben: View;

  beforeEach(async () => {
    code = nextCode();
    stub = game(code);
    await stub.init(QUIZ, code);
    ana = (await stub.playerJoin("Ana")) as View;
    ben = (await stub.playerJoin("Ben")) as View;
  });

  it("scores a correct answer and leaves a wrong one at zero", async () => {
    await stub.hostAction("start");
    expect(await stub.playerAnswer(ana.playerId, 0, 0)).toEqual({ ok: true });
    expect(await stub.playerAnswer(ben.playerId, 0, 1)).toEqual({ ok: true });

    // Both players answered, so the question closed itself.
    const view = (await stub.hostView()) as View;
    expect(view.phase).toBe("reveal");

    const board = view.leaderboard as View[];
    expect(board[0].name).toBe("Ana");
    // Answered within the window, so worth more than the floor and at most full.
    expect(board[0].score).toBeGreaterThan(500);
    expect(board[0].score).toBeLessThanOrEqual(1000);
    expect(board[1]).toMatchObject({ name: "Ben", score: 0 });
  });

  it("rejects a second answer from the same player", async () => {
    await stub.hostAction("start");
    await stub.playerAnswer(ana.playerId, 0, 0);
    expect(await stub.playerAnswer(ana.playerId, 0, 1)).toEqual({
      ok: false,
      error: "You already answered.",
    });
  });

  it("rejects an answer for a question that has moved on", async () => {
    await stub.hostAction("start");
    expect(await stub.playerAnswer(ana.playerId, 5, 0)).toEqual({
      ok: false,
      error: "That question has moved on.",
    });
  });

  it("rejects an answer index that is not on the question", async () => {
    await stub.hostAction("start");
    expect(await stub.playerAnswer(ana.playerId, 0, 99)).toEqual({
      ok: false,
      error: "Unknown answer.",
    });
  });

  it("rejects answers outside the question phase", async () => {
    expect(await stub.playerAnswer(ana.playerId, 0, 0)).toEqual({
      ok: false,
      error: "Not accepting answers.",
    });
  });

  it("rejects an answer from someone who never joined", async () => {
    await stub.hostAction("start");
    expect(await stub.playerAnswer("p_nobody", 0, 0)).toEqual({
      ok: false,
      error: "You are not in this game.",
    });
  });

  it("tracks streaks and resets them on a miss", async () => {
    await stub.hostAction("start");
    await stub.playerAnswer(ana.playerId, 0, 0);
    await stub.playerAnswer(ben.playerId, 0, 1);
    await stub.hostAction("next"); // reveal -> scoreboard
    await stub.hostAction("next"); // -> question 2
    await stub.playerAnswer(ana.playerId, 1, 0); // correct
    await stub.playerAnswer(ben.playerId, 1, 1); // wrong

    const view = (await stub.playerView(ana.playerId)) as View;
    expect(view.me.streak).toBe(2);
    const benView = (await stub.playerView(ben.playerId)) as View;
    expect(benView.me.streak).toBe(0);
  });

  it("closes the question when the alarm fires, with no answers in", async () => {
    await stub.hostAction("start");
    expect(((await stub.hostView()) as View).phase).toBe("question");

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(((await stub.hostView()) as View).phase).toBe("reveal");

    // Nobody answered, so nobody scored.
    const view = (await stub.hostView()) as View;
    expect((view.leaderboard as View[]).every((p) => p.score === 0)).toBe(true);
  });
});

describe("what each screen is allowed to see", () => {
  let stub: ReturnType<typeof game>;
  let ana: View;

  beforeEach(async () => {
    const code = nextCode();
    stub = game(code);
    await stub.init(QUIZ, code);
    ana = (await stub.playerJoin("Ana")) as View;
    await stub.hostAction("start");
  });

  it("never tells a player which answer is correct while the question is open", async () => {
    const view = (await stub.playerView(ana.playerId)) as View;
    expect(view.phase).toBe("question");
    for (const answer of view.question.answers) {
      expect(answer.correct).toBeUndefined();
    }
    expect(view.leaderboard).toBeNull();
    // And the serialised payload carries no stray truth either.
    expect(JSON.stringify(view)).not.toContain('"correct"');
  });

  it("never shows the host the answer key while the question is open", async () => {
    const view = (await stub.hostView()) as View;
    for (const answer of view.question.answers) {
      expect(answer.correct).toBeUndefined();
    }
    expect(view.distribution).toBeNull();
  });

  it("reveals the key and the distribution once the question closes", async () => {
    await stub.playerAnswer(ana.playerId, 0, 2);

    const host = (await stub.hostView()) as View;
    expect(host.phase).toBe("reveal");
    expect(host.question.answers.map((a: View) => a.correct)).toEqual([true, false, false]);
    expect(host.distribution).toEqual([0, 0, 1]);

    const player = (await stub.playerView(ana.playerId)) as View;
    expect(player.myAnswer).toMatchObject({ answerIndex: 2, correct: false, points: 0 });
    expect(player.leaderboard).not.toBeNull();
  });
});

describe("finishing a game", () => {
  it("walks to the podium and writes a 30-day scoreboard", async () => {
    const code = nextCode();
    const stub = game(code);
    const { gameId } = await stub.init(QUIZ, code);
    const ana = (await stub.playerJoin("Ana")) as View;

    await stub.hostAction("start");
    await stub.playerAnswer(ana.playerId, 0, 0); // right
    await stub.hostAction("next"); // scoreboard
    await stub.hostAction("next"); // question 2
    await stub.playerAnswer(ana.playerId, 1, 1); // wrong
    await stub.hostAction("next"); // scoreboard
    await stub.hostAction("next"); // past the last question -> final

    const view = (await stub.hostView()) as View;
    expect(view.phase).toBe("final");

    const stored = await env.DATA.get(`result:${gameId}`, "json");
    expect(stored).toMatchObject({
      gameId,
      title: "Game loop",
      code,
      playerCount: 1,
      standings: [{ rank: 1, name: "Ana" }],
      perQuestion: [
        { text: "Pick A", correct: 1, wrong: 0 },
        { text: "True please", correct: 0, wrong: 1 },
      ],
    });
  });

  it("can be ended early by the host", async () => {
    const code = nextCode();
    const stub = game(code);
    await stub.init(QUIZ, code);
    await stub.playerJoin("Ana");
    await stub.hostAction("start");
    await stub.hostAction("end");
    expect(((await stub.hostView()) as View).phase).toBe("final");
  });

  it("ignores an unknown host action", async () => {
    const code = nextCode();
    const stub = game(code);
    await stub.init(QUIZ, code);
    expect(await stub.hostAction("destroy")).toEqual({ ok: false, error: "Unknown action." });
  });
});
