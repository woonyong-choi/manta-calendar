import { createServer, type ServerResponse } from "node:http";
import { setTimeout as scheduleTimeout, clearTimeout as cancelTimeout } from "node:timers";

const CALLBACK_PATH = "/oauth/callback";
const AUTHORIZATION_TIMEOUT = 10 * 60 * 1000;

export async function listenForGoogleAuthorization(state: string, locale: string) {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // A listener can be cancelled before its caller starts awaiting the code.
  void code.catch(() => {});
  let origin = "";
  let received = false;
  let finished = false;
  let timer: ReturnType<typeof scheduleTimeout> | undefined;
  const close = (error: Error = new DOMException("Google connection cancelled.", "AbortError")) => {
    if (!finished) { finished = true; rejectCode(error); }
    cancelTimeout(timer);
    timer = undefined;
    server.close();
    server.closeAllConnections();
  };
  const server = createServer((request, response) => {
    let url: URL;
    try { url = new URL(request.url ?? "/", origin); }
    catch { respond(response, 400, "Invalid callback address."); return; }
    if (request.method !== "GET") { respond(response, 405, "Method not allowed."); return; }
    if (url.origin !== origin || request.headers.host !== new URL(origin).host) {
      respond(response, 400, "Invalid callback address."); return;
    }
    if (url.pathname !== CALLBACK_PATH || received || finished) { respond(response, 404, "Not found."); return; }
    const parameters = url.searchParams;
    if (["state", "code", "error"].some(key => parameters.getAll(key).length > 1)
      || parameters.get("state") !== state
      || Boolean(parameters.get("code")) === Boolean(parameters.get("error"))) {
      respond(response, 400, "This response does not match the pending Google connection."); return;
    }
    received = true;
    const denied = parameters.has("error");
    response.once("finish", () => {
      if (finished) return;
      finished = true;
      if (denied) rejectCode(new DOMException("Google authorization was cancelled. Start again from settings.", "AbortError"));
      else resolveCode(parameters.get("code") ?? "");
      close();
    });
    response.once("close", () => { if (!finished) close(new Error("The browser closed the Google callback before completion. Try connecting again.")); });
    respond(response, 200, locale === "ko"
      ? (denied ? "Google 연결을 취소했습니다. Obsidian으로 돌아가세요." : "Google 승인을 받았습니다. Obsidian으로 돌아가 연결 결과를 확인하세요.")
      : (denied ? "Google connection cancelled. Return to Obsidian." : "Google approval received. Return to Obsidian to check the connection."));
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  server.on("error", error => { close(error); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") { close(); throw new Error("Could not open the local Google callback."); }
  origin = `http://127.0.0.1:${String(address.port)}`;
  timer = scheduleTimeout(() => { close(new DOMException("Google connection expired after 10 minutes. Start again.", "TimeoutError")); }, AUTHORIZATION_TIMEOUT);
  return { redirectUri: `${origin}${CALLBACK_PATH}`, code, close };
}

function respond(response: ServerResponse, status: number, message: string) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Connection": "close",
  });
  // Only fixed application text is rendered; callback parameters never enter HTML.
  response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Manta Calendar</title><style>:root{color-scheme:light dark;font-family:system-ui}body{max-width:36rem;margin:15vh auto;padding:1.5rem;line-height:1.6}h1{font-size:1.5rem}a{display:inline-block;margin-top:1rem}</style></head><body><h1>Manta Calendar</h1><p>${message}</p><a href="obsidian://open">Open Obsidian</a></body></html>`);
}
