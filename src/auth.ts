/**
 * The two creator-facing auth planes.
 *
 *   /api/*    bearer API_TOKEN  — AI tools and the jahoot-quiz-manager skill.
 *   /admin/*  Cloudflare Access — the browser quiz builder.
 *
 * Playing a game needs neither: a passcode is the only thing a player holds.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

const encoder = new TextEncoder();

/**
 * Timing-safe secret comparison. Both sides are hashed first so the comparison
 * runs over fixed-length digests and leaks neither length nor content.
 */
export async function secretsMatch(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i]! ^ vb[i]!;
  return diff === 0;
}

export function bearerToken(request: Request): string {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : "";
}

/** True when the request carries the configured API_TOKEN. */
export async function hasApiToken(request: Request, env: Env): Promise<boolean> {
  if (!env.API_TOKEN) return false;
  const presented = bearerToken(request);
  if (!presented) return false;
  return await secretsMatch(presented, env.API_TOKEN);
}

// ---- Cloudflare Access ----

/**
 * Access puts a signed JWT on every authenticated request. We verify it
 * ourselves rather than using `ctx.access`: this Worker serves Static Assets,
 * and the internal assets router does not propagate `ctx.access` to the user
 * Worker (developers.cloudflare.com/workers/configuration/cloudflare-access/
 * #ctxaccess-limitations).
 */
export interface AccessIdentity {
  email: string;
  sub: string;
}

/** createRemoteJWKSet caches keys, so build it once per isolate per team. */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(teamDomain: string) {
  let set = jwksCache.get(teamDomain);
  if (!set) {
    set = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, set);
  }
  return set;
}

export function accessConfigured(env: Env): boolean {
  return Boolean(env.ACCESS_AUD && env.ACCESS_TEAM_DOMAIN);
}

export function adminOpenForDev(env: Env): boolean {
  return String(env.ALLOW_INSECURE_ADMIN) === "1";
}

/**
 * Verifies the Access assertion. Returns the identity, or null when the token
 * is absent, expired, signed by another team, or issued for another app.
 */
export async function verifyAccess(
  request: Request,
  env: Env,
): Promise<AccessIdentity | null> {
  const token =
    request.headers.get("Cf-Access-Jwt-Assertion") ?? cookie(request, "CF_Authorization");
  if (!token) return null;

  const teamDomain = env.ACCESS_TEAM_DOMAIN.replace(/\/+$/, "");
  try {
    const { payload } = await jwtVerify(token, jwks(teamDomain), {
      issuer: teamDomain,
      audience: env.ACCESS_AUD,
    });
    return identityFrom(payload);
  } catch {
    return null;
  }
}

function identityFrom(payload: JWTPayload): AccessIdentity {
  const email = typeof payload.email === "string" ? payload.email : "";
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  // Service tokens carry no email; fall back to the client id so the audit
  // trail still records who wrote a quiz.
  const common = payload.common_name;
  return {
    email: email || (typeof common === "string" ? `service:${common}` : "access-user"),
    sub,
  };
}

export function cookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
