import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lookupCompany } from "./lib/f10.mjs";
import { loadDotEnv } from "./lib/env.mjs";
import { loadMarketSnapshot, publicMessage, readMarketQuery } from "./lib/tushare.mjs";
import { loadWatchCard, readWatchQuery } from "./lib/watchlist.mjs";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const defaultPublicDir = path.join(rootDir, "public");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function sendText(response, statusCode, message) {
  response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(message);
}

export function createServer({
  lookup = lookupCompany,
  market = loadMarketSnapshot,
  watch = loadWatchCard,
  publicDir = defaultPublicDir,
} = {}) {
  const root = path.resolve(publicDir);

  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/api/company") {
      if (request.method !== "GET") {
        sendText(response, 405, "只支持 GET");
        return;
      }
      try {
        const result = await lookup(url.searchParams.get("q") ?? "");
        const statusCode = result.kind === "invalid" ? 400 : 200;
        sendJson(response, statusCode, result);
      } catch (error) {
        console.error("F10 lookup failed", error);
        sendJson(response, 502, {
          kind: "error",
          message: "暂时无法获取 F10 资料，请稍后再试",
        });
      }
      return;
    }

    if (url.pathname === "/api/market") {
      if (request.method !== "GET") {
        sendText(response, 405, "只支持 GET");
        return;
      }
      const query = readMarketQuery(url.searchParams);
      if (!query) {
        sendJson(response, 400, { kind: "invalid", message: "请提供 6 位股票代码" });
        return;
      }
      try {
        sendJson(response, 200, await market(query));
      } catch (error) {
        console.error("market lookup failed", error);
        sendJson(response, 502, { configured: true, message: "暂时无法获取行情和资讯" });
      }
      return;
    }

    if (url.pathname === "/api/watch") {
      if (request.method !== "GET") {
        sendText(response, 405, "只支持 GET");
        return;
      }
      const query = readWatchQuery(url.searchParams);
      if (!query) {
        sendJson(response, 400, { kind: "invalid", message: "请提供 6 位股票代码" });
        return;
      }
      try {
        sendJson(response, 200, await watch(query));
      } catch (error) {
        console.error("watch lookup failed", publicMessage(error, process.env.TUSHARE_TOKEN ?? ""));
        sendJson(response, 502, { configured: true, message: "暂时无法获取自选资料" });
      }
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendText(response, 405, "只支持 GET");
      return;
    }

    const requested = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = path.resolve(root, `.${requested}`);
    if (!filePath.startsWith(`${root}${path.sep}`)) {
      sendText(response, 404, "未找到页面");
      return;
    }

    try {
      await access(filePath);
    } catch {
      sendText(response, 404, "未找到页面");
      return;
    }

    const type = CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream";
    response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(filePath).pipe(response);
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  loadDotEnv(path.join(rootDir, ".env"));
  const port = Number(process.env.PORT) || 3000;
  const server = createServer();
  server.listen(port, "0.0.0.0", () => {
    const tokenReady = Boolean(process.env.TUSHARE_TOKEN?.trim());
    console.log(`Compass 已启动：http://127.0.0.1:${port}`);
    console.log(tokenReady ? "Tushare Token 已配置" : "未配置 TUSHARE_TOKEN，日线、板块资讯和自选不会加载");
  });
}
