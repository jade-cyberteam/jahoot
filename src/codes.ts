/**
 * Game passcodes.
 *
 * A code is a 6-digit string, which is also the Durable Object's name — so the
 * code *is* the address of the game. Codes have to be unique only among live
 * games, so each one is reserved in KV with a TTL a little longer than any
 * plausible quiz session; once it lapses the code can be handed out again.
 */

const PREFIX = "game:";
/** Long enough that no sane game outlives its own passcode. */
const RESERVATION_TTL_SECONDS = 6 * 60 * 60;
const ATTEMPTS = 12;

export interface Reservation {
  quizId: string;
  gameId: string;
}

export function isCode(value: string): boolean {
  return /^[0-9]{6}$/.test(value);
}

function randomCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 900000;
  return String(100000 + n);
}

/**
 * Finds a code nobody is using. Returns null in the (vanishingly unlikely)
 * case that every attempt collided, rather than looping forever.
 */
export async function reserveCode(kv: KVNamespace): Promise<string | null> {
  for (let i = 0; i < ATTEMPTS; i++) {
    const code = randomCode();
    if ((await kv.get(PREFIX + code)) === null) return code;
  }
  return null;
}

export async function commitReservation(
  kv: KVNamespace,
  code: string,
  reservation: Reservation,
): Promise<void> {
  await kv.put(PREFIX + code, JSON.stringify(reservation), {
    expirationTtl: RESERVATION_TTL_SECONDS,
  });
}

export async function lookupCode(kv: KVNamespace, code: string): Promise<Reservation | null> {
  if (!isCode(code)) return null;
  return await kv.get<Reservation>(PREFIX + code, "json");
}
