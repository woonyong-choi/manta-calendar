import {
  GOOGLE_SCOPES,
  createRelayState,
  oauthCallbackUrl,
  pluginRedirect,
  readRelayState,
  validChallenge,
  validClientState,
  verifierMatchesChallenge,
} from "./protocol.mjs";

const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";

export default {
  async fetch(request, env) {
    try {
      validateEnvironment(env);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/") {
        return html(homePage());
      }
      if (request.method === "GET" && url.pathname === "/privacy") {
        return html(privacyPage());
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ origin: publicBaseUrl(env.PUBLIC_BASE_URL).origin, protocol: 1, status: "ok" });
      }
      if (request.method === "GET" && url.pathname === "/oauth/authorize") {
        return await authorize(url, env);
      }
      if (request.method === "GET" && url.pathname === "/oauth/callback") {
        return await callback(url, env);
      }
      if (request.method === "POST" && url.pathname === "/oauth/token") {
        return await exchange(request, env);
      }
      if (request.method === "POST" && url.pathname === "/oauth/refresh") {
        return await refresh(request, env);
      }
      if (request.method === "POST" && url.pathname === "/oauth/revoke") {
        return await revoke(request);
      }
      return json({ error: "not_found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unexpected_error";
      return json({ error: publicError(message) }, message === "invalid_server_configuration" ? 500 : 400);
    }
  },
};

async function authorize(url, env) {
  const clientState = url.searchParams.get("client_state") ?? "";
  const challenge = url.searchParams.get("code_challenge") ?? "";
  const locale = url.searchParams.get("locale") === "ko" ? "ko" : "en";
  if (!validClientState(clientState) || !validChallenge(challenge)) {
    return json({ error: "invalid_request" }, 400);
  }
  const relayState = await createRelayState(env.STATE_SECRET, {
    challenge,
    clientState,
    expiresAt: Date.now() + 10 * 60 * 1_000,
    locale,
    nonce: crypto.randomUUID(),
  });
  const target = new URL(GOOGLE_AUTHORIZE);
  target.searchParams.set("access_type", "offline");
  target.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  target.searchParams.set("code_challenge", challenge);
  target.searchParams.set("code_challenge_method", "S256");
  target.searchParams.set("hl", locale);
  target.searchParams.set("prompt", "consent");
  target.searchParams.set("redirect_uri", oauthCallbackUrl(env.PUBLIC_BASE_URL));
  target.searchParams.set("response_type", "code");
  target.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  target.searchParams.set("state", relayState);
  return redirect(target.toString());
}

async function callback(url, env) {
  const relayState = url.searchParams.get("state") ?? "";
  const state = await readRelayState(env.STATE_SECRET, relayState);
  const error = url.searchParams.get("error") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (!error && !code) throw new Error("invalid_callback");
  return oauthCompletion(pluginRedirect(env.PLUGIN_REDIRECT_URI, {
    code,
    error,
    relay_state: relayState,
    state: state.clientState,
  }), state.locale === "ko" ? "ko" : "en");
}

async function exchange(request, env) {
  const body = await readJson(request);
  const code = stringValue(body.code);
  const relayState = stringValue(body.relayState);
  const verifier = stringValue(body.verifier);
  const state = await readRelayState(env.STATE_SECRET, relayState);
  if (!code || !await verifierMatchesChallenge(verifier, state.challenge)) {
    return json({ error: "invalid_grant" }, 400);
  }
  const token = await googleToken({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: oauthCallbackUrl(env.PUBLIC_BASE_URL),
  });
  return tokenResponse(token, true);
}

async function refresh(request, env) {
  const body = await readJson(request);
  const refreshToken = stringValue(body.refreshToken);
  if (!refreshToken) return json({ error: "invalid_grant" }, 400);
  const token = await googleToken({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return tokenResponse(token, false);
}

async function revoke(request) {
  const body = await readJson(request);
  const refreshToken = stringValue(body.refreshToken);
  if (!refreshToken) return json({ error: "invalid_request" }, 400);
  const response = await fetch(GOOGLE_REVOKE, {
    body: new URLSearchParams({ token: refreshToken }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  if (!response.ok) return json({ error: "revocation_failed" }, response.status);
  return json({ revoked: true });
}

async function googleToken(parameters) {
  const response = await fetch(GOOGLE_TOKEN, {
    body: new URLSearchParams(parameters),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const body = await response.json();
  if (!response.ok) {
    const reason = typeof body.error === "string" ? body.error : "token_exchange_failed";
    throw new Error(reason);
  }
  return body;
}

function tokenResponse(token, includeRefreshToken) {
  const accessToken = stringValue(token.access_token);
  const expiresIn = Number(token.expires_in);
  const refreshToken = includeRefreshToken ? stringValue(token.refresh_token) : "";
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0 || (includeRefreshToken && !refreshToken)) {
    return json({ error: "invalid_token_response" }, 502);
  }
  const scopes = stringValue(token.scope).split(/\s+/).filter(Boolean);
  return json({
    accessToken,
    expiresIn,
    refreshToken,
    scopes: scopes.length ? scopes : GOOGLE_SCOPES,
  });
}

async function readJson(request) {
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") {
    throw new Error("invalid_content_type");
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 4_096) throw new Error("request_too_large");
  const text = await request.text();
  if (text.length > 4_096) throw new Error("request_too_large");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("invalid_request");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_request");
  return value;
}

function validateEnvironment(env) {
  if (!env
    || typeof env.GOOGLE_CLIENT_ID !== "string"
    || typeof env.GOOGLE_CLIENT_SECRET !== "string"
    || typeof env.STATE_SECRET !== "string"
    || env.STATE_SECRET.length < 32
    || env.PLUGIN_REDIRECT_URI !== "obsidian://link-calendar-google") {
    throw new Error("invalid_server_configuration");
  }
  publicBaseUrl(env.PUBLIC_BASE_URL);
}

function publicBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid_server_configuration");
  }
  if (url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash) {
    throw new Error("invalid_server_configuration");
  }
  return url;
}

function json(value, status = 200) {
  return Response.json(value, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
    status,
  });
}

function html(body, status = 200) {
  return new Response(body, {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
    status,
  });
}

function oauthCompletion(returnUri, locale) {
  const copy = locale === "ko"
    ? {
      action: "Obsidian 열기",
      fallback: "Obsidian이 자동으로 열리지 않으면 아래 버튼을 누르세요.",
      heading: "Google Calendar 연결을 계속하세요",
      lead: "Google 승인이 완료되었습니다. Link Calendar Navigator로 돌아가 연결을 마칩니다.",
      opening: "Obsidian을 여는 중입니다…",
    }
    : {
      action: "Open Obsidian",
      fallback: "If Obsidian did not open automatically, use the button below.",
      heading: "Continue your Google Calendar connection",
      lead: "Google authorization is complete. Return to Link Calendar Navigator to finish connecting.",
      opening: "Opening Obsidian…",
    };
  const nonce = crypto.randomUUID();
  const scriptUri = JSON.stringify(returnUri).replaceAll("<", "\\u003c");
  return new Response(`<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${copy.heading}</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --background: #f7f8fa; --foreground: #18202c; --muted: #5d6878; --lead: #303a49; --action: #246de8; --action-hover: #175ccc; }
    @media (prefers-color-scheme: dark) { :root { --background: #111318; --foreground: #eef0f4; --muted: #aeb6c4; --lead: #e1e5ec; --action: #6aa2ff; --action-hover: #8bb7ff; } }
    body { box-sizing: border-box; margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: var(--background); color: var(--foreground); }
    main { width: min(560px, 100%); }
    .eyebrow { color: var(--muted); font-size: .78rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: .5rem 0 1rem; font-size: clamp(2rem, 8vw, 3.5rem); line-height: 1.02; letter-spacing: -.04em; }
    p { color: var(--muted); line-height: 1.65; }
    .lead { color: var(--lead); font-size: 1.08rem; }
    .action { display: inline-flex; min-height: 44px; align-items: center; justify-content: center; margin-top: .75rem; padding: 0 1.1rem; border-radius: 8px; background: var(--action); color: #fff; font-weight: 750; text-decoration: none; }
    .action:hover { background: var(--action-hover); }
    .action:focus-visible { outline: 3px solid var(--action); outline-offset: 4px; }
    .status { margin-top: 1rem; font-size: .9rem; }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">Link Calendar Navigator</p>
    <h1>${copy.heading}</h1>
    <p class="lead">${copy.lead}</p>
    <a class="action" href="${escapeHtml(returnUri)}">${copy.action}</a>
    <p class="status" id="status" role="status" aria-live="polite">${copy.opening}</p>
  </main>
  <script nonce="${nonce}">
    const returnUri = ${scriptUri};
    window.location.assign(returnUri);
    window.setTimeout(() => {
      document.querySelector("#status").textContent = ${JSON.stringify(copy.fallback)};
    }, 1500);
  </script>
</body>
</html>`, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "Content-Type": "text/html; charset=utf-8",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
    status: 200,
  });
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function homePage() {
  return page("Link Calendar Navigator", `
    <p class="eyebrow">Obsidian Community Plugin</p>
    <h1>Link Calendar Navigator</h1>
    <p class="lead">See the dates you already wrote. Send only the folder sources you choose to a dedicated Google calendar.</p>
    <section>
      <h2>Private and local by default</h2>
      <p>Google Calendar integration is optional and disabled by default. Link Calendar requests only the <code>calendar.app.created</code> permission and cannot read your primary calendar or unrelated calendars.</p>
    </section>
    <section>
      <h2>What the connection does</h2>
      <p>An explicit sync creates or updates events from selected Obsidian folder sources in a secondary calendar named <strong>Link Calendar</strong>. Markdown remains the source of truth.</p>
    </section>
    <nav aria-label="Project links">
      <a href="https://github.com/woonyong-choi/obsidian-link-calendar-navigator">Source and documentation</a>
      <a href="/privacy">Privacy policy</a>
    </nav>
  `);
}

function privacyPage() {
  return page("Privacy policy · Link Calendar Navigator", `
    <p class="eyebrow">Last updated September 4, 2026</p>
    <h1>Privacy policy</h1>
    <p class="lead">Link Calendar Navigator is local-first. Google Calendar access is optional, narrow, and controlled by the user.</p>
    <section>
      <h2>Google data accessed</h2>
      <p>The plugin requests only <code>calendar.app.created</code>. This permits access to secondary calendars created by this application, not your primary calendar or unrelated calendars.</p>
    </section>
    <section>
      <h2>Data sent and stored</h2>
      <p>During an explicit sync, selected event titles and start/end values go directly from Obsidian to Google Calendar. Refresh tokens stay in Obsidian SecretStorage; access tokens stay in memory. The OAuth relay exchanges, refreshes, and revokes tokens without persisting tokens, notes, events, or analytics.</p>
    </section>
    <section>
      <h2>Sharing and retention</h2>
      <p>Google user data is not sold, used for advertising, shared with data brokers, or used to train AI models. Disconnecting revokes the grant and clears local authorization. Events already written to the dedicated calendar remain under the user's control.</p>
    </section>
    <section>
      <h2>Contact</h2>
      <p>For privacy questions, open a non-sensitive <a href="https://github.com/woonyong-choi/obsidian-link-calendar-navigator/discussions">GitHub Discussion</a>. Use <a href="https://github.com/woonyong-choi/obsidian-link-calendar-navigator/security">private vulnerability reporting</a> for security-sensitive reports.</p>
    </section>
    <nav aria-label="Project links">
      <a href="/">Link Calendar home</a>
      <a href="https://github.com/woonyong-choi/obsidian-link-calendar-navigator/blob/main/PRIVACY.md">Full privacy policy</a>
    </nav>
  `);
}

function page(title, content) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <meta name="description" content="Link Calendar Navigator privacy and Google Calendar connection information.">
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #111318; color: #eef0f4; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
    main { width: min(720px, calc(100% - 40px)); margin: 56px auto; }
    .eyebrow { color: #8f9bb3; font-size: .78rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: .4rem 0 1rem; font-size: clamp(2.25rem, 8vw, 4.5rem); line-height: .98; letter-spacing: -.045em; }
    h2 { margin: 0 0 .6rem; font-size: 1rem; }
    p { color: #b6bdc9; line-height: 1.7; }
    .lead { color: #e1e5ec; font-size: 1.15rem; }
    section { padding: 1.2rem 0; border-top: 1px solid #292e38; }
    section p { margin: 0; }
    code { color: #9fc5ff; }
    nav { display: flex; flex-wrap: wrap; gap: .75rem 1.2rem; padding-top: 1.25rem; border-top: 1px solid #292e38; }
    a { color: #69a7ff; text-underline-offset: .22em; }
    a:focus-visible { outline: 2px solid #69a7ff; outline-offset: 4px; border-radius: 2px; }
  </style>
</head>
<body><main>${content}</main></body>
</html>`;
}

function redirect(location) {
  return new Response(null, {
    headers: {
      "Cache-Control": "no-store",
      Location: location,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
    status: 302,
  });
}

function publicError(message) {
  const allowed = new Set([
    "access_denied",
    "expired_state",
    "invalid_callback",
    "invalid_content_type",
    "invalid_grant",
    "invalid_request",
    "invalid_server_configuration",
    "invalid_state",
    "request_too_large",
  ]);
  return allowed.has(message) ? message : "request_failed";
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}
