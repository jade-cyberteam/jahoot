/**
 * Quiz storage and validation.
 *
 * KV layout (binding DATA):
 *   quiz:<id>      -> JSON Quiz, with {title, questionCount, updatedAt, createdBy}
 *                     mirrored into KV metadata so the listing needs no reads.
 *   game:<code>    -> JSON {quizId, gameId}, short TTL, reserves a live passcode.
 *   result:<id>    -> JSON GameResult, 30-day TTL.
 */

export type QuestionType = "multiple" | "boolean";

export interface Answer {
  text: string;
  correct: boolean;
}

export interface Question {
  id: string;
  type: QuestionType;
  text: string;
  /** Seconds players get to answer. */
  timeLimit: number;
  /** Points a maximally fast correct answer is worth. */
  points: number;
  answers: Answer[];
}

export interface Quiz {
  id: string;
  title: string;
  description: string;
  questions: Question[];
  createdAt: number;
  updatedAt: number;
  createdBy: string;
}

export interface QuizSummary {
  id: string;
  title: string;
  questionCount: number;
  updatedAt: number;
  createdBy: string;
  /** Where to open this quiz to run a game. Unlisted, not secret. */
  hostUrl: string;
}

export const LIMITS = {
  title: 120,
  description: 500,
  questionText: 300,
  answerText: 120,
  questions: 50,
  answersPerQuestion: 6,
  minTimeLimit: 5,
  maxTimeLimit: 120,
  maxPoints: 2000,
} as const;

export const DEFAULT_TIME_LIMIT = 20;
export const DEFAULT_POINTS = 1000;

/** Thrown for anything the caller could fix by sending different JSON. */
export class ValidationError extends Error {}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return `${prefix}_${out}`;
}

function text(value: unknown, max: number, field: string, required = true): string {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${field} is required`);
    return "";
  }
  if (typeof value !== "string") throw new ValidationError(`${field} must be a string`);
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (required && !cleaned) throw new ValidationError(`${field} cannot be empty`);
  if (cleaned.length > max) {
    throw new ValidationError(`${field} must be ${max} characters or fewer`);
  }
  return cleaned;
}

function int(value: unknown, min: number, max: number, fallback: number, field: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new ValidationError(`${field} must be a number`);
  const rounded = Math.round(n);
  if (rounded < min || rounded > max) {
    throw new ValidationError(`${field} must be between ${min} and ${max}`);
  }
  return rounded;
}

/**
 * Normalises whatever the caller sent into a valid quiz, or throws
 * ValidationError. Accepts two spellings of the answer list so hand-written and
 * AI-written payloads both work:
 *
 *   answers: [{ text, correct }, ...]
 *   options: ["a", "b", ...] + correctIndex: 0
 *
 * For type "boolean", `answer: true|false` is also accepted in place of either.
 */
export function validateQuiz(
  input: unknown,
  meta: { id?: string; createdBy: string; createdAt?: number },
): Quiz {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ValidationError("Body must be a JSON object");
  }
  const raw = input as Record<string, unknown>;

  const title = text(raw.title, LIMITS.title, "title");
  const description = text(raw.description, LIMITS.description, "description", false);

  if (!Array.isArray(raw.questions) || raw.questions.length === 0) {
    throw new ValidationError("questions must be a non-empty array");
  }
  if (raw.questions.length > LIMITS.questions) {
    throw new ValidationError(`a quiz can have at most ${LIMITS.questions} questions`);
  }

  const questions = raw.questions.map((q, i) => validateQuestion(q, i));
  const now = Date.now();

  return {
    id: meta.id ?? newId("q"),
    title,
    description,
    questions,
    createdAt: meta.createdAt ?? now,
    updatedAt: now,
    createdBy: meta.createdBy,
  };
}

function validateQuestion(input: unknown, index: number): Question {
  const where = `questions[${index}]`;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ValidationError(`${where} must be an object`);
  }
  const raw = input as Record<string, unknown>;

  const type: QuestionType = raw.type === "boolean" ? "boolean" : "multiple";
  const questionText = text(raw.text ?? raw.question, LIMITS.questionText, `${where}.text`);
  const timeLimit = int(
    raw.timeLimit ?? raw.time_limit,
    LIMITS.minTimeLimit,
    LIMITS.maxTimeLimit,
    DEFAULT_TIME_LIMIT,
    `${where}.timeLimit`,
  );
  const points = int(raw.points, 0, LIMITS.maxPoints, DEFAULT_POINTS, `${where}.points`);

  const answers = validateAnswers(raw, type, where);

  return { id: newId("i"), type, text: questionText, timeLimit, points, answers };
}

function validateAnswers(
  raw: Record<string, unknown>,
  type: QuestionType,
  where: string,
): Answer[] {
  // true/false shorthand: { type: "boolean", answer: true }
  if (type === "boolean" && raw.answers === undefined && raw.options === undefined) {
    if (typeof raw.answer !== "boolean") {
      throw new ValidationError(
        `${where}.answer must be true or false for a boolean question`,
      );
    }
    return [
      { text: "True", correct: raw.answer === true },
      { text: "False", correct: raw.answer === false },
    ];
  }

  let answers: Answer[];

  if (Array.isArray(raw.answers)) {
    answers = raw.answers.map((a, j) => {
      if (typeof a === "object" && a !== null && !Array.isArray(a)) {
        const obj = a as Record<string, unknown>;
        return {
          text: text(obj.text ?? obj.answer, LIMITS.answerText, `${where}.answers[${j}].text`),
          correct: obj.correct === true || obj.isCorrect === true,
        };
      }
      return {
        text: text(a, LIMITS.answerText, `${where}.answers[${j}]`),
        correct: false,
      };
    });
    // Plain string list + correctIndex.
    const correctIndex = raw.correctIndex ?? raw.correct_index;
    if (correctIndex !== undefined && !answers.some((a) => a.correct)) {
      const idx = int(correctIndex, 0, answers.length - 1, -1, `${where}.correctIndex`);
      answers[idx]!.correct = true;
    }
  } else if (Array.isArray(raw.options)) {
    answers = raw.options.map((o, j) => ({
      text: text(o, LIMITS.answerText, `${where}.options[${j}]`),
      correct: false,
    }));
    const correctIndex = raw.correctIndex ?? raw.correct_index ?? raw.answer;
    const idx = int(correctIndex, 0, answers.length - 1, -1, `${where}.correctIndex`);
    if (idx < 0) throw new ValidationError(`${where}.correctIndex is required with options`);
    answers[idx]!.correct = true;
  } else {
    throw new ValidationError(`${where}.answers must be an array`);
  }

  if (answers.length < 2) throw new ValidationError(`${where} needs at least 2 answers`);
  if (answers.length > LIMITS.answersPerQuestion) {
    throw new ValidationError(
      `${where} can have at most ${LIMITS.answersPerQuestion} answers`,
    );
  }
  const correctCount = answers.filter((a) => a.correct).length;
  if (correctCount !== 1) {
    throw new ValidationError(
      `${where} must have exactly one correct answer (found ${correctCount})`,
    );
  }
  return answers;
}

// ---- storage ----

const QUIZ_PREFIX = "quiz:";

interface QuizMetadata {
  title: string;
  questionCount: number;
  updatedAt: number;
  createdBy: string;
}

export function isQuizId(id: string): boolean {
  return /^q_[a-z0-9]{6,20}$/.test(id);
}

export async function putQuiz(kv: KVNamespace, quiz: Quiz): Promise<void> {
  const metadata: QuizMetadata = {
    title: quiz.title,
    questionCount: quiz.questions.length,
    updatedAt: quiz.updatedAt,
    createdBy: quiz.createdBy,
  };
  await kv.put(QUIZ_PREFIX + quiz.id, JSON.stringify(quiz), { metadata });
}

export async function getQuiz(kv: KVNamespace, id: string): Promise<Quiz | null> {
  if (!isQuizId(id)) return null;
  return await kv.get<Quiz>(QUIZ_PREFIX + id, "json");
}

export async function deleteQuiz(kv: KVNamespace, id: string): Promise<void> {
  await kv.delete(QUIZ_PREFIX + id);
}

export async function listQuizzes(kv: KVNamespace, origin: string): Promise<QuizSummary[]> {
  const listed = await kv.list<QuizMetadata>({ prefix: QUIZ_PREFIX, limit: 1000 });
  return listed.keys
    .map((key) => {
      const id = key.name.slice(QUIZ_PREFIX.length);
      const m = key.metadata;
      return {
        id,
        title: m?.title ?? "(untitled)",
        questionCount: m?.questionCount ?? 0,
        updatedAt: m?.updatedAt ?? 0,
        createdBy: m?.createdBy ?? "unknown",
        hostUrl: `${origin}/host/${id}`,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function summarise(quiz: Quiz, origin: string): QuizSummary {
  return {
    id: quiz.id,
    title: quiz.title,
    questionCount: quiz.questions.length,
    updatedAt: quiz.updatedAt,
    createdBy: quiz.createdBy,
    hostUrl: `${origin}/host/${quiz.id}`,
  };
}
