import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lookupCompany } from "./lib/f10.mjs";

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

export function createServer({ lookup = lookupCompany, publicDir = defaultPublicDir } = {}) {
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
  const port = Number(process.env.PORT) || 3000;
  const server = createServer();
  server.listen(port, "0.0.0.0", () => {
    console.log(`Compass 已启动：http://127.0.0.1:${port}`);
  });
}
