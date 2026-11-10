/**
 * Final scoreboards, kept for 30 days so a game link still works the next
 * morning. Written once by the Game object when it reaches the final phase.
 */

export interface GameResult {
  gameId: string;
  quizId: string;
  title: string;
  code: string;
  finishedAt: number;
  playerCount: number;
  standings: { rank: number; name: string; score: number }[];
  perQuestion: { text: string; correct: number; wrong: number }[];
}

const PREFIX = "result:";
const TTL_SECONDS = 30 * 24 * 60 * 60;

export function isGameId(id: string): boolean {
  return /^g_[a-z0-9]{6,20}$/.test(id);
}

export async function saveResult(kv: KVNamespace, result: GameResult): Promise<void> {
  await kv.put(PREFIX + result.gameId, JSON.stringify(result), {
    expirationTtl: TTL_SECONDS,
  });
}

export async function getResult(kv: KVNamespace, gameId: string): Promise<GameResult | null> {
  if (!isGameId(gameId)) return null;
  return await kv.get<GameResult>(PREFIX + gameId, "json");
}
