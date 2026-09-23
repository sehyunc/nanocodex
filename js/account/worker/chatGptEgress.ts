import { Container } from "@cloudflare/containers";

export class ChatGptEgress extends Container {
  defaultPort = 8080;
  enableInternet = true;
  sleepAfter = "1h";
  #claudeAuthLoaded = false;

  /** Only the account-authorized broker may import this user's Claude OAuth file. */
  async importClaudeAuth(auth: string): Promise<void> {
    if (new TextEncoder().encode(auth).byteLength > 16_384) throw new TypeError("Claude auth is too large");
    let value: Record<string, unknown>;
    try { value = JSON.parse(auth) as Record<string, unknown>; } catch { throw new TypeError("invalid Claude auth"); }
    if (value?.type !== "claude" || typeof value.access_token !== "string"
      || typeof value.refresh_token !== "string" || !value.access_token || !value.refresh_token) {
      throw new TypeError("invalid Claude auth");
    }
    await this.ctx.storage.put("claude-oauth-v1", auth);
    this.#claudeAuthLoaded = false;
    await this.#restoreClaudeAuth(true);
  }

  async claudeAuthStatus(): Promise<{ connected: boolean }> {
    return { connected: (await this.ctx.storage.get<string>("claude-oauth-v1")) !== undefined };
  }

  async #restoreClaudeAuth(force = false): Promise<void> {
    const auth = await this.ctx.storage.get<string>("claude-oauth-v1");
    if (auth === undefined) return;
    if (!this.ctx.container?.running) this.#claudeAuthLoaded = false;
    if (this.#claudeAuthLoaded) return;
    if (!force && this.ctx.container?.running) {
      const current = await super.fetch(new Request("https://chatgpt-egress.internal/internal/claude-auth"));
      if (current.ok) {
        const live = await current.text();
        if (new TextEncoder().encode(live).byteLength <= 16_384) {
          if (live !== auth) await this.ctx.storage.put("claude-oauth-v1", live);
          this.#claudeAuthLoaded = true;
          return;
        }
      } else await current.body?.cancel();
    }
    const response = await super.fetch(new Request("https://chatgpt-egress.internal/internal/claude-auth", {
      method: "PUT", headers: { "content-type": "application/json" }, body: auth,
    }));
    await response.body?.cancel();
    if (!response.ok) throw new Error("Claude auth restore failed");
    this.#claudeAuthLoaded = true;
  }

  async #captureClaudeAuth(): Promise<void> {
    if (!this.#claudeAuthLoaded) return;
    const response = await super.fetch(new Request("https://chatgpt-egress.internal/internal/claude-auth"));
    if (!response.ok) { await response.body?.cancel(); return; }
    const auth = await response.text();
    if (new TextEncoder().encode(auth).byteLength > 16_384) throw new Error("Claude auth capture too large");
    const saved = await this.ctx.storage.get<string>("claude-oauth-v1");
    if (auth !== saved) await this.ctx.storage.put("claude-oauth-v1", auth);
  }

  override async onActivityExpired(): Promise<void> {
    if (this.ctx.container?.running) {
      await this.#restoreClaudeAuth();
      await this.#captureClaudeAuth();
    }
    await super.onActivityExpired();
  }

  /** Private egress binding: transfer the small SDP exchange in one RPC reply. */
  async createRealtimeCall(body: string, headers: Record<string, string>, search: string): Promise<{
    status: number; headers: Record<string, string>; body: string;
  }> {
    const target = new URL("https://chatgpt-egress.internal/backend-api/codex/realtime/calls");
    target.search = search;
    const response = await this.fetch(new Request(target, {
      method: "POST", headers, body,
    }));
    const began = performance.now();
    const answer = await response.text();
    const sessionId = headers["x-session-id"];
    console.info({ type: "voice.relay.body", transport: "rpc", duration_ms: performance.now() - began,
      ...(sessionId && /^[0-9a-f-]{36}$/.test(sessionId) ? { voice_session_id: sessionId } : {}) });
    return { status: response.status, headers: Object.fromEntries(response.headers), body: answer };
  }

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/internal/claude-auth") return new Response(null, { status: 404 });
    const claude = request.headers.get("x-nanocodex-cliproxy-provider") === "claude";
    if (claude) await this.#restoreClaudeAuth();
    if (new URL(request.url).pathname !== "/backend-api/codex/realtime/calls") {
      const response = await super.fetch(request);
      if (claude) await this.#captureClaudeAuth();
      return response;
    }
    const began = performance.now();
    const wasRunning = this.ctx.container?.running;
    const response = await super.fetch(request);
    let timing: Record<string, unknown> = {};
    try { timing = JSON.parse(response.headers.get("x-nanocodex-relay-timing") ?? "{}"); } catch { /* Older relay image. */ }
    const sessionId = request.headers.get("x-session-id");
    console.info({
      type: "voice.relay",
      ...(sessionId && /^[0-9a-f-]{36}$/.test(sessionId) ? { voice_session_id: sessionId } : {}),
      was_running: wasRunning,
      duration_ms: performance.now() - began,
      status: response.status,
      ...Object.fromEntries(["process_age_ms", "fetch_ms", "socket_wait_ms", "upload_ms", "response_wait_ms"]
        .flatMap((key) => typeof timing?.[key] === "number" && Number.isFinite(timing[key]) && timing[key] >= 0
          ? [[key, timing[key]]] : [])),
      ...(typeof timing?.socket_reused === "boolean" ? { socket_reused: timing.socket_reused } : {}),
    });
    const headers = new Headers(response.headers);
    headers.delete("x-nanocodex-relay-timing");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}
