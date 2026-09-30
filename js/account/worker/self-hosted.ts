import worker from "./entry";

export * from "./entry";

export default {
  async fetch(...args: Parameters<typeof worker.fetch>): Promise<Response> {
    const [request, env] = args;
    const url = new URL(request.url);
    if (url.protocol !== "https:") {
      url.protocol = "https:";
      return Response.redirect(url, 308);
    }
    if (url.pathname === "/owner" && request.method === "GET") {
      const nonce = crypto.randomUUID();
      return new Response(`<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Nanocodex</title>
<style nonce="${nonce}">body{font:16px system-ui;background:#111;color:#eee;max-width:360px;margin:15vh auto;padding:24px}input,button{box-sizing:border-box;width:100%;padding:12px;margin-top:16px}p{line-height:1.5}</style>
<h1>Nanocodex</h1><p>Sign in with your owner login secret.</p>
<form><label>Owner login secret<input type="password" name="token" autocomplete="current-password" required></label><button>Sign in</button></form><p role="status"></p>
<script nonce="${nonce}">document.querySelector('form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget;const token=form.elements.token.value;form.reset();const status=document.querySelector('[role=status]');status.textContent='Signing in…';try{const response=await fetch('/v1/auth/owner',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})});if(response.ok)location.replace('/agent');else status.textContent=response.status===429?'Please wait a minute and try again.':'Sign-in failed.';}catch{status.textContent='Could not reach Nanocodex.';}});</script></html>`, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
        },
      });
    }
    if ((url.pathname === "/" || url.pathname === "/agent" || url.pathname.startsWith("/agent/")
      || url.pathname === "/connect" || url.pathname === "/connect/vault")
      && request.method === "GET") {
      const response = await env.NANOCODEX_BACKEND?.fetch(new Request(new URL("/v1/me", url), {
        headers: request.headers,
      }));
      const authenticated = response?.ok;
      await response?.body?.cancel();
      if (!authenticated) return Response.redirect(new URL("/owner", url), 302);
      if (url.pathname === "/") return Response.redirect(new URL("/agent", url), 302);
    }
    return worker.fetch(...args);
  },
};
