import { authenticate, createOwnerAccountSession, isUserId, type AccountAuthEnv } from "./account-auth";

export interface OwnerAccessEnv extends AccountAuthEnv {
  NANOCODEX_OWNER_ID?: string;
  NANOCODEX_OWNER_ORIGIN?: string;
  NANOCODEX_OWNER_LOGIN_SHA256?: string;
  OWNER_LOGIN_LIMIT?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

const failure = (error: string, status: number) => Response.json({ error }, {
  status,
  headers: { "cache-control": "no-store" },
});

/** Fail closed before any upstream route can create an anonymous account. */
export async function ownerAccess(request: Request, env: OwnerAccessEnv): Promise<Response | undefined> {
  const url = new URL(request.url);
  const privateModelStatus = url.href === "https://broker.internal/.well-known/nanocodex/model-status"
    && request.method === "GET";
  if (!isUserId(env.NANOCODEX_OWNER_ID) || !env.NANOCODEX_OWNER_ORIGIN
    || !/^[a-f0-9]{64}$/.test(env.NANOCODEX_OWNER_LOGIN_SHA256 ?? "")
    || !env.OWNER_LOGIN_LIMIT) return failure("owner_auth_unavailable", 503);
  if ((!privateModelStatus && url.origin !== env.NANOCODEX_OWNER_ORIGIN) || url.protocol !== "https:") {
    return failure("forbidden_origin", 403);
  }
  if (url.pathname === "/v1/auth/owner") {
    if (request.method !== "POST") return failure("method_not_allowed", 405);
    if (request.headers.get("origin") !== url.origin) return failure("forbidden_origin", 403);
    if (!(await env.OWNER_LOGIN_LIMIT.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" })).success) {
      return failure("rate_limited", 429);
    }
    // Bound the body even when content-length is absent or dishonest.
    const reader = request.body?.getReader();
    if (!reader) return failure("invalid_login", 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024) {
          await reader.cancel();
          return failure("invalid_login", 400);
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const body = JSON.parse(new TextDecoder().decode(bytes));
      if (typeof body?.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.token)) {
        return failure("invalid_login", 401);
      }
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.token)));
      const expected = env.NANOCODEX_OWNER_LOGIN_SHA256!;
      let different = 0;
      for (let i = 0; i < digest.length; i++) different |= digest[i]! ^ parseInt(expected.slice(i * 2, i * 2 + 2), 16);
      if (different !== 0) return failure("invalid_login", 401);
    } catch {
      return failure("invalid_login", 400);
    } finally {
      reader.releaseLock();
    }
    return createOwnerAccountSession(env, env.NANOCODEX_OWNER_ID!);
  }
  if (url.pathname.startsWith("/v1/auth/sms/")) return failure("not_found", 404);
  // Existing owner passkeys may reauthenticate without an active session.
  if (url.pathname === "/webauthn/login/options" || url.pathname === "/webauthn/login") return;
  const principal = await authenticate(request, env, url);
  if (!principal || principal.userId !== env.NANOCODEX_OWNER_ID
    || (principal.kind !== "account_session" && principal.kind !== "api_key")) {
    return failure("unauthorized", 401);
  }
}
