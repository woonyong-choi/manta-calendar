import { createServer, type ServerResponse } from "node:http";
import { setTimeout as scheduleTimeout, clearTimeout as cancelTimeout } from "node:timers";

const CALLBACK_PATH = "/oauth/callback";
const AUTHORIZATION_TIMEOUT = 10 * 60 * 1000;

export async function listenForGoogleAuthorization(
  state: string,
  locale: string,
  authorize: (code: string, redirectUri: string, signal: AbortSignal) => Promise<void>,
) {
  let resolveCompleted!: () => void;
  let rejectCompleted!: (error: Error) => void;
  const completed = new Promise<void>((resolve, reject) => { resolveCompleted = resolve; rejectCompleted = reject; });
  // A listener can be cancelled before its caller starts awaiting completion.
  void completed.catch(() => {});
  let origin = "";
  let received = false;
  let finished = false;
  const controller = new AbortController();
  let timer: ReturnType<typeof scheduleTimeout> | undefined;
  const close = (error: Error = new DOMException("Google connection cancelled.", "AbortError")) => {
    if (!finished) { finished = true; rejectCompleted(error); }
    controller.abort(error);
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
    void (async () => {
      let failure: Error | undefined;
      try {
        if (denied) throw new DOMException("Google authorization was cancelled. Start again from settings.", "AbortError");
        await authorize(parameters.get("code") ?? "", `${origin}${CALLBACK_PATH}`, controller.signal);
      } catch (error) {
        failure = error instanceof Error ? error : new Error("Google connection failed.");
      }
      if (controller.signal.aborted) return;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (failure) rejectCompleted(failure);
        else resolveCompleted();
        close();
      };
      // Approval remains valid if the user closes the browser during exchange.
      if (response.destroyed) { finish(); return; }
      response.once("finish", finish);
      response.once("close", finish);
      respond(response, failure && !denied ? 502 : 200, locale === "ko"
        ? (failure ? "Google 연결을 완료하지 못했습니다. Obsidian 설정에서 다시 연결하세요." : "Google Calendar 연결이 완료되었습니다. 이 창을 닫고 Obsidian으로 돌아가세요.")
        : (failure ? "Google connection could not be completed. Try connecting again in Obsidian settings." : "Google Calendar is connected. You can close this window and return to Obsidian."), locale);
    })();
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
  return { redirectUri: `${origin}${CALLBACK_PATH}`, completed, close };
}

function respond(response: ServerResponse, status: number, message: string, locale = "en") {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Connection": "close",
  });
  // Only fixed application text is rendered; callback parameters never enter HTML.
  response.end(`<!doctype html><html lang="${locale === "ko" ? "ko" : "en"}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Manta Calendar</title><style>:root{color-scheme:light dark;font-family:system-ui}body{max-width:36rem;margin:15vh auto;padding:1.5rem;line-height:1.6}h1{font-size:1.5rem}a{display:inline-block;margin-top:1rem}</style></head><body><h1>Manta Calendar</h1><p>${message}</p><a href="obsidian://open">${locale === "ko" ? "Obsidian 열기" : "Open Obsidian"}</a></body></html>`);
}
