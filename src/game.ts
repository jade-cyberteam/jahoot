/**
 * One Durable Object per live game, addressed by its 6-digit passcode.
 *
 * The object owns the whole run: the quiz snapshot (so editing the quiz
 * mid-game can't change it underneath the players), the roster, the answers and
 * the scores. It drives the clock with a storage alarm, so a question still
 * closes when every phone has gone to sleep.
 *
 * The WebSocket layer is a thin shell over the RPC methods below — init,
 * playerJoin, playerAnswer, hostAction — which is also how the tests drive it.
 */

import { DurableObject } from "cloudflare:workers";
import type { Question, Quiz } from "./quizzes";
import { newId } from "./quizzes";
import { saveResult } from "./results";

export type Phase = "lobby" | "question" | "reveal" | "scoreboard" | "final";
export type Role = "host" | "player";

const MAX_NAME = 20;
const MAX_PLAYERS = 300;
/** Grace added to the alarm so a client's last packet still lands in time. */
const ALARM_GRACE_MS = 600;
/** Fraction of the question's points still on offer at the very last second. */
const SLOWEST_ANSWER_MULTIPLIER = 0.5;

interface Attachment {
  role: Role;
  playerId?: string;
}

export interface PlayerRow {
  id: string;
  name: string;
  score: number;
  streak: number;
  connected: number;
  /** sql.exec<T> requires rows to be indexable. */
  [key: string]: SqlStorageValue;
}

export interface InitResult {
  code: string;
  gameId: string;
  hostToken: string;
  title: string;
}

export interface JoinResult {
  ok: true;
  playerId: string;
  playerToken: string;
  name: string;
}

export class Game extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        name TEXT NOT NULL,
        score INTEGER NOT NULL DEFAULT 0,
        streak INTEGER NOT NULL DEFAULT 0,
        connected INTEGER NOT NULL DEFAULT 1,
        joined_at INTEGER NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS answers (
        question_index INTEGER NOT NULL,
        player_id TEXT NOT NULL,
        answer_index INTEGER NOT NULL,
        elapsed_ms INTEGER NOT NULL,
        correct INTEGER NOT NULL,
        points INTEGER NOT NULL,
        PRIMARY KEY (question_index, player_id))`);
    });
  }

  // ---- meta helpers ----

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private meta(key: string): string | null {
    const row = this.sql
      .exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key)
      .toArray()[0];
    return row ? row.value : null;
  }

  private setMeta(key: string, value: string | number): void {
    this.sql.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      String(value),
    );
  }

  private quiz(): Quiz | null {
    const raw = this.meta("quiz");
    return raw ? (JSON.parse(raw) as Quiz) : null;
  }

  private phase(): Phase {
    return (this.meta("phase") as Phase | null) ?? "lobby";
  }

  private questionIndex(): number {
    return Number(this.meta("questionIndex") ?? "-1");
  }

  // ---- lifecycle ----

  /**
   * Claims this object for a quiz. Returns the existing game untouched if it is
   * already running, so a double-submitted host page can't wipe a live lobby.
   */
  async init(quiz: Quiz, code: string): Promise<InitResult> {
    const existing = this.meta("gameId");
    if (existing) {
      return {
        code,
        gameId: existing,
        hostToken: this.meta("hostToken")!,
        title: this.quiz()?.title ?? quiz.title,
      };
    }
    const gameId = newId("g");
    const hostToken = newId("h") + newId("t");
    this.setMeta("quiz", JSON.stringify(quiz));
    this.setMeta("quizId", quiz.id);
    this.setMeta("gameId", gameId);
    this.setMeta("code", code);
    this.setMeta("hostToken", hostToken);
    this.setMeta("phase", "lobby");
    this.setMeta("questionIndex", -1);
    this.setMeta("startedAt", Date.now());
    return { code, gameId, hostToken, title: quiz.title };
  }

  /** True once init() has run — used to reject joins to an unknown passcode. */
  async exists(): Promise<boolean> {
    return this.meta("gameId") !== null;
  }

  async checkHostToken(token: string): Promise<boolean> {
    const expected = this.meta("hostToken");
    return Boolean(expected) && token === expected;
  }

  async info(): Promise<{ title: string; phase: Phase; players: number } | null> {
    const quiz = this.quiz();
    if (!quiz) return null;
    const [{ n }] = this.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM players`)
      .toArray();
    return { title: quiz.title, phase: this.phase(), players: n };
  }

  // ---- players ----

  async playerJoin(name: string, token?: string): Promise<JoinResult | { error: string }> {
    if (!this.meta("gameId")) return { error: "That game no longer exists." };

    // A refresh mid-game comes back with its token and keeps its score.
    if (token) {
      const row = this.sql
        .exec<{ id: string; name: string }>(`SELECT id, name FROM players WHERE token = ?`, token)
        .toArray()[0];
      if (row) {
        this.sql.exec(`UPDATE players SET connected = 1 WHERE id = ?`, row.id);
        this.broadcast();
        return { ok: true, playerId: row.id, playerToken: token, name: row.name };
      }
    }

    const clean = name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
    if (!clean) return { error: "Enter a nickname first." };
    if (this.phase() !== "lobby") return { error: "That game has already started." };

    const [{ n }] = this.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM players`)
      .toArray();
    if (n >= MAX_PLAYERS) return { error: "This game is full." };

    const taken = this.sql
      .exec<{ x: number }>(`SELECT 1 AS x FROM players WHERE lower(name) = lower(?)`, clean)
      .toArray().length;
    if (taken) return { error: "Someone already took that nickname." };

    const playerId = newId("p");
    const playerToken = newId("pt") + newId("k");
    this.sql.exec(
      `INSERT INTO players (id, token, name, score, streak, connected, joined_at)
       VALUES (?, ?, ?, 0, 0, 1, ?)`,
      playerId,
      playerToken,
      clean,
      Date.now(),
    );
    this.broadcast();
    return { ok: true, playerId, playerToken, name: clean };
  }

  async playerAnswer(
    playerId: string,
    questionIndex: number,
    answerIndex: number,
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.phase() !== "question") return { ok: false, error: "Not accepting answers." };
    if (questionIndex !== this.questionIndex()) {
      return { ok: false, error: "That question has moved on." };
    }
    const question = this.currentQuestion();
    if (!question) return { ok: false, error: "No question in play." };
    if (answerIndex < 0 || answerIndex >= question.answers.length) {
      return { ok: false, error: "Unknown answer." };
    }
    const player = this.sql
      .exec<{ id: string }>(`SELECT id FROM players WHERE id = ?`, playerId)
      .toArray()[0];
    if (!player) return { ok: false, error: "You are not in this game." };

    const already = this.sql
      .exec<{ x: number }>(
        `SELECT 1 AS x FROM answers WHERE question_index = ? AND player_id = ?`,
        questionIndex,
        playerId,
      )
      .toArray().length;
    if (already) return { ok: false, error: "You already answered." };

    const startedAt = Number(this.meta("questionStartedAt") ?? Date.now());
    const elapsed = Math.max(0, Date.now() - startedAt);
    const correct = question.answers[answerIndex]!.correct;
    const points = correct ? this.scoreFor(question, elapsed) : 0;

    this.sql.exec(
      `INSERT INTO answers (question_index, player_id, answer_index, elapsed_ms, correct, points)
       VALUES (?, ?, ?, ?, ?, ?)`,
      questionIndex,
      playerId,
      answerIndex,
      elapsed,
      correct ? 1 : 0,
      points,
    );

    this.broadcast();

    // Everyone in has answered — don't make the room wait out the clock.
    if (this.answeredCount() >= this.connectedPlayerCount()) {
      this.endQuestion();
    }
    return { ok: true };
  }

  /**
   * Kahoot-style speed scoring: a correct answer at t=0 is worth full points,
   * decaying linearly to SLOWEST_ANSWER_MULTIPLIER at the buzzer.
   */
  private scoreFor(question: Question, elapsedMs: number): number {
    const window = question.timeLimit * 1000;
    const ratio = window > 0 ? Math.min(1, Math.max(0, elapsedMs / window)) : 1;
    return Math.round(question.points * (1 - (1 - SLOWEST_ANSWER_MULTIPLIER) * ratio));
  }

  // ---- host actions ----

  async hostAction(action: string): Promise<{ ok: boolean; error?: string }> {
    switch (action) {
      case "start":
      case "next":
        this.advance();
        return { ok: true };
      case "skip":
        if (this.phase() === "question") this.endQuestion();
        else this.advance();
        return { ok: true };
      case "end":
        await this.finish();
        return { ok: true };
      default:
        return { ok: false, error: "Unknown action." };
    }
  }

  /** lobby|scoreboard -> next question, reveal -> scoreboard, last -> final. */
  private advance(): void {
    const quiz = this.quiz();
    if (!quiz) return;
    const phase = this.phase();

    if (phase === "question") return; // a question in play must close first
    if (phase === "final") return;

    if (phase === "reveal") {
      this.setMeta("phase", "scoreboard");
      this.broadcast();
      return;
    }

    const next = this.questionIndex() + 1;
    if (next >= quiz.questions.length) {
      void this.finish();
      return;
    }
    this.setMeta("questionIndex", next);
    this.setMeta("phase", "question");
    this.setMeta("questionStartedAt", Date.now());
    const question = quiz.questions[next]!;
    void this.ctx.storage.setAlarm(Date.now() + question.timeLimit * 1000 + ALARM_GRACE_MS);
    this.broadcast();
  }

  /** The clock ran out (or everyone answered): score the streaks and reveal. */
  private endQuestion(): void {
    if (this.phase() !== "question") return;
    const index = this.questionIndex();

    const answered = this.sql
      .exec<{ player_id: string; correct: number; points: number }>(
        `SELECT player_id, correct, points FROM answers WHERE question_index = ?`,
        index,
      )
      .toArray();
    const byPlayer = new Map(answered.map((a) => [a.player_id, a]));

    for (const p of this.sql.exec<{ id: string }>(`SELECT id FROM players`).toArray()) {
      const a = byPlayer.get(p.id);
      if (a && a.correct) {
        this.sql.exec(
          `UPDATE players SET score = score + ?, streak = streak + 1 WHERE id = ?`,
          a.points,
          p.id,
        );
      } else {
        this.sql.exec(`UPDATE players SET streak = 0 WHERE id = ?`, p.id);
      }
    }

    this.setMeta("phase", "reveal");
    void this.ctx.storage.deleteAlarm();
    this.broadcast();
  }

  private async finish(): Promise<void> {
    if (this.phase() === "final") return;
    this.setMeta("phase", "final");
    void this.ctx.storage.deleteAlarm();
    this.broadcast();
    await this.persistResult();
  }

  async alarm(): Promise<void> {
    if (this.phase() === "question") this.endQuestion();
  }

  // ---- persistence of the final scoreboard ----

  private async persistResult(): Promise<void> {
    const quiz = this.quiz();
    const gameId = this.meta("gameId");
    if (!quiz || !gameId) return;

    const standings = this.leaderboard().map((p, i) => ({
      rank: i + 1,
      name: p.name,
      score: p.score,
    }));
    const perQuestion = quiz.questions.map((q, i) => {
      const rows = this.sql
        .exec<{ correct: number; n: number }>(
          `SELECT correct, COUNT(*) AS n FROM answers WHERE question_index = ? GROUP BY correct`,
          i,
        )
        .toArray();
      const correct = rows.find((r) => r.correct === 1)?.n ?? 0;
      const wrong = rows.find((r) => r.correct === 0)?.n ?? 0;
      return { text: q.text, correct, wrong };
    });

    await saveResult(this.env.DATA, {
      gameId,
      quizId: quiz.id,
      title: quiz.title,
      code: this.meta("code") ?? "",
      finishedAt: Date.now(),
      playerCount: standings.length,
      standings,
      perQuestion,
    });
  }

  // ---- views ----

  private currentQuestion(): Question | null {
    const quiz = this.quiz();
    const index = this.questionIndex();
    if (!quiz || index < 0 || index >= quiz.questions.length) return null;
    return quiz.questions[index]!;
  }

  private players(): PlayerRow[] {
    return this.sql
      .exec<PlayerRow>(
        `SELECT id, name, score, streak, connected FROM players ORDER BY joined_at`,
      )
      .toArray();
  }

  private leaderboard(): PlayerRow[] {
    return this.sql
      .exec<PlayerRow>(
        `SELECT id, name, score, streak, connected FROM players
         ORDER BY score DESC, name COLLATE NOCASE ASC`,
      )
      .toArray();
  }

  private connectedPlayerCount(): number {
    const [{ n }] = this.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM players WHERE connected = 1`)
      .toArray();
    return n;
  }

  private answeredCount(): number {
    const [{ n }] = this.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM answers WHERE question_index = ?`,
        this.questionIndex(),
      )
      .toArray();
    return n;
  }

  private distribution(): number[] {
    const question = this.currentQuestion();
    if (!question) return [];
    const counts = new Array(question.answers.length).fill(0);
    for (const row of this.sql
      .exec<{ answer_index: number; n: number }>(
        `SELECT answer_index, COUNT(*) AS n FROM answers
         WHERE question_index = ? GROUP BY answer_index`,
        this.questionIndex(),
      )
      .toArray()) {
      if (row.answer_index >= 0 && row.answer_index < counts.length) {
        counts[row.answer_index] = row.n;
      }
    }
    return counts;
  }

  /** What the projector sees. Answer texts, but `correct` only once revealed. */
  async hostView(): Promise<unknown> {
    const quiz = this.quiz();
    if (!quiz) return { phase: "gone" };
    const phase = this.phase();
    const index = this.questionIndex();
    const question = this.currentQuestion();
    const revealed = phase === "reveal" || phase === "scoreboard" || phase === "final";

    return {
      role: "host",
      phase,
      code: this.meta("code"),
      gameId: this.meta("gameId"),
      title: quiz.title,
      questionCount: quiz.questions.length,
      questionIndex: index,
      players: this.players().map(({ id, name, score, connected }) => ({
        id,
        name,
        score,
        connected: connected === 1,
      })),
      answeredCount: phase === "question" || revealed ? this.answeredCount() : 0,
      question: question
        ? {
            text: question.text,
            type: question.type,
            timeLimit: question.timeLimit,
            endsAt: Number(this.meta("questionStartedAt") ?? 0) + question.timeLimit * 1000,
            answers: question.answers.map((a) => ({
              text: a.text,
              correct: revealed ? a.correct : undefined,
            })),
          }
        : null,
      distribution: revealed ? this.distribution() : null,
      leaderboard: this.leaderboard()
        .slice(0, 10)
        .map(({ name, score, streak }) => ({ name, score, streak })),
    };
  }

  /**
   * What one phone sees. Deliberately never carries `correct` flags or other
   * players' answers while a question is open.
   */
  async playerView(playerId: string): Promise<unknown> {
    const quiz = this.quiz();
    if (!quiz) return { phase: "gone" };
    const phase = this.phase();
    const index = this.questionIndex();
    const question = this.currentQuestion();
    const revealed = phase === "reveal" || phase === "scoreboard" || phase === "final";

    const board = this.leaderboard();
    const me = board.find((p) => p.id === playerId);
    const rank = me ? board.findIndex((p) => p.id === playerId) + 1 : 0;

    const myAnswer = this.sql
      .exec<{ answer_index: number; correct: number; points: number }>(
        `SELECT answer_index, correct, points FROM answers
         WHERE question_index = ? AND player_id = ?`,
        index,
        playerId,
      )
      .toArray()[0];

    return {
      role: "player",
      phase,
      code: this.meta("code"),
      title: quiz.title,
      questionCount: quiz.questions.length,
      questionIndex: index,
      playerCount: this.players().length,
      me: me
        ? { id: me.id, name: me.name, score: me.score, streak: me.streak, rank }
        : null,
      question: question
        ? {
            text: question.text,
            type: question.type,
            timeLimit: question.timeLimit,
            endsAt: Number(this.meta("questionStartedAt") ?? 0) + question.timeLimit * 1000,
            answers: question.answers.map((a) => ({
              text: a.text,
              correct: revealed ? a.correct : undefined,
            })),
          }
        : null,
      myAnswer: myAnswer
        ? {
            answerIndex: myAnswer.answer_index,
            correct: revealed ? myAnswer.correct === 1 : undefined,
            points: revealed ? myAnswer.points : undefined,
          }
        : null,
      answeredCount: this.answeredCount(),
      leaderboard: revealed
        ? board.slice(0, 10).map(({ name, score }) => ({ name, score }))
        : null,
    };
  }

  // ---- websockets ----

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const url = new URL(request.url);
    const role: Role = url.pathname.includes("/host/") ? "host" : "player";

    if (role === "host") {
      const token = url.searchParams.get("hostToken") ?? "";
      if (!(await this.checkHostToken(token))) {
        return new Response("forbidden", { status: 403 });
      }
    }

    const pair = new WebSocketPair();
    const server = pair[1]!;
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role } satisfies Attachment);
    await this.sendTo(server, { role });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private async sendTo(ws: WebSocket, attachment: Attachment): Promise<void> {
    const state =
      attachment.role === "host"
        ? await this.hostView()
        : await this.playerView(attachment.playerId ?? "");
    try {
      ws.send(JSON.stringify({ type: "state", state }));
    } catch {
      /* socket already gone; the runtime will clean it up */
    }
  }

  /** Pushes a fresh, role-appropriate view to every open socket. */
  private broadcast(): void {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = (ws.deserializeAttachment() ?? { role: "player" }) as Attachment;
      void this.sendTo(ws, attachment);
    }
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    const attachment = (ws.deserializeAttachment() ?? { role: "player" }) as Attachment;

    try {
      if (attachment.role === "host") {
        const result = await this.hostAction(String(msg.action ?? ""));
        if (!result.ok) ws.send(JSON.stringify({ type: "error", message: result.error }));
        return;
      }

      if (msg.action === "join") {
        const joined = await this.playerJoin(
          String(msg.name ?? ""),
          typeof msg.playerToken === "string" ? msg.playerToken : undefined,
        );
        if ("error" in joined) {
          ws.send(JSON.stringify({ type: "error", message: joined.error }));
          return;
        }
        ws.serializeAttachment({ role: "player", playerId: joined.playerId } satisfies Attachment);
        ws.send(JSON.stringify({ type: "joined", ...joined }));
        await this.sendTo(ws, { role: "player", playerId: joined.playerId });
        return;
      }

      if (msg.action === "answer") {
        if (!attachment.playerId) {
          ws.send(JSON.stringify({ type: "error", message: "Join first." }));
          return;
        }
        const result = await this.playerAnswer(
          attachment.playerId,
          Number(msg.questionIndex),
          Number(msg.answerIndex),
        );
        if (!result.ok) ws.send(JSON.stringify({ type: "error", message: result.error }));
        return;
      }
    } catch (err) {
      ws.send(
        JSON.stringify({ type: "error", message: err instanceof Error ? err.message : "Error" }),
      );
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = (ws.deserializeAttachment() ?? { role: "player" }) as Attachment;
    if (!attachment.playerId) return;

    // One player can hold several sockets at once — a reconnect that races the
    // old socket's close, or the same phone with two tabs open. Only mark them
    // away when the last one goes, or a live player shows as offline and
    // connectedPlayerCount() undercounts, closing questions early.
    const stillOpen = this.ctx.getWebSockets().some((other) => {
      if (other === ws) return false;
      const a = other.deserializeAttachment() as Attachment | null;
      return a?.playerId === attachment.playerId;
    });
    if (stillOpen) return;

    this.sql.exec(`UPDATE players SET connected = 0 WHERE id = ?`, attachment.playerId);
    this.broadcast();
  }
}
