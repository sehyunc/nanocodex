import { describe, expect, it } from "vitest";
import { ownerAccess, type OwnerAccessEnv } from "../src/owner-access";
import { routeCredentialRequest } from "../src/credentials";

const origin = "https://nanocodex-v2.example";
const userId = "11111111-1111-4111-8111-111111111111";
const secret = "o".repeat(43);

async function fixture(): Promise<OwnerAccessEnv & { NANOCODEX: Fetcher }> {
  const values = new Map<string, unknown>();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const auth = {
    idFromName: (name: string) => name,
    get: () => ({
      async fetch(input: RequestInfo | URL, init?: RequestInit) {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const key = url.searchParams.get("key")!;
        if (url.pathname === "/get") return Response.json({ value: values.get(key) });
        if (url.pathname === "/set") {
          values.set(key, (await request.json() as { value: unknown }).value);
          return Response.json({ ok: true });
        }
        if (url.pathname === "/delete") {
          values.delete(key);
          return Response.json({ ok: true });
        }
        return new Response(null, { status: 404 });
      },
    }),
  } as unknown as DurableObjectNamespace;
  const account = {
    getByName: () => ({
      async fetch(input: RequestInfo | URL, init?: RequestInit) {
        if (new URL(new Request(input, init).url).pathname === "/authorization") {
          return Response.json({ userId, grant: { organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", teamId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", role: "owner", authorizationEpoch: 1, capabilities: ["agents:read", "agents:write", "api_keys:read", "api_keys:write", "tools:use"] } });
        }
        return Response.json({ id: userId, organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", persistent: true, createdAt: 1, lastAuthenticatedAt: 1 });
      },
    }),
  } as unknown as DurableObjectNamespace;
  const organizations = {
    getByName: () => ({
      async fetch() {
        return Response.json({ organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", teamId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", role: "owner", authorizationEpoch: 1, capabilities: ["agents:read", "agents:write", "api_keys:read", "api_keys:write", "tools:use"] });
      },
    }),
  } as unknown as DurableObjectNamespace;
  return {
    NANOCODEX_OWNER_ID: userId,
    NANOCODEX_OWNER_ORIGIN: origin,
    NANOCODEX_OWNER_LOGIN_SHA256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join(""),
    OWNER_LOGIN_LIMIT: { limit: async () => ({ success: true }) },
    NANOCODEX_AUTH: auth,
    NANOCODEX_USERS: account,
    NANOCODEX_ORGANIZATIONS: organizations,
    NANOCODEX: { fetch: async () => Response.json({ address: "0x1111111111111111111111111111111111111111", created_at: 1 }) } as unknown as Fetcher,
  } as unknown as OwnerAccessEnv & { NANOCODEX: Fetcher };
}

function login(token: string, requestOrigin = origin) {
  return new Request(`${origin}/v1/auth/owner`, { method: "POST", headers: { origin: requestOrigin }, body: JSON.stringify({ token }) });
}

describe("owner-only account boundary", () => {
  it("issues a persistent session with a server-side wallet and fences it to the owner", async () => {
    const env = await fixture();
    const response = await ownerAccess(login(secret), env);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ user: { id: userId, persistent: true, address: "0x1111111111111111111111111111111111111111" } });
    const cookie = response!.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    const request = new Request(`${origin}/v1/agents`, { headers: { cookie: cookie.split(";")[0]! } });
    expect(await ownerAccess(request, env)).toBeUndefined();
    env.NANOCODEX_OWNER_ID = "22222222-2222-4222-8222-222222222222";
    expect((await ownerAccess(request, env))?.status).toBe(401);
  });

  it("rejects missing configuration, wrong secrets, SMS, and cross-origin requests", async () => {
    const env = await fixture();
    expect((await ownerAccess(login(secret), { ...env, NANOCODEX_OWNER_LOGIN_SHA256: undefined }))?.status).toBe(503);
    expect((await ownerAccess(login("x".repeat(43)), env))?.status).toBe(401);
    expect((await ownerAccess(login(secret, "https://evil.example"), env))?.status).toBe(403);
    expect((await ownerAccess(new Request(`${origin}/v1/auth/sms/start`), env))?.status).toBe(404);
    expect((await ownerAccess(new Request(`${origin}/v1/me`), env))?.status).toBe(401);
  });

  it("limits native Claude authorization to the owner session and same origin", async () => {
    const env = await fixture();
    const cookie = (await ownerAccess(login(secret), env))!.headers.get("set-cookie")!.split(";")[0]!;
    let forwarded = false;
    env.NANOCODEX = { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      forwarded = request.method === "POST"
        && request.url.endsWith(`/users/${userId}/credentials/claude/login/complete`)
        && (await request.text()) === '{"code":"synthetic-code#synthetic-state"}';
      return new Response(null, { status: 204 });
    } } as unknown as Fetcher;
    const url = new URL(`${origin}/v1/credentials/claude/login/complete`);
    const request = (headers: Record<string, string>) => new Request(url, {
      method: "POST", headers: { "content-type": "application/json", ...headers },
      body: '{"code":"synthetic-code#synthetic-state"}',
    });
    expect((await routeCredentialRequest(request({}), env, url))?.status).toBe(401);
    expect((await routeCredentialRequest(request({ cookie }), env, url))?.status).toBe(403);
    expect((await routeCredentialRequest(request({ cookie, origin }), env, url))?.status).toBe(204);
    expect(forwarded).toBe(true);
  });
});
