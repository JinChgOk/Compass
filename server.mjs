import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "./lib/env.mjs";
import { handleRequest } from "./lib/handle.mjs";

export { GET, HEAD, default, runtime } from "./lib/handle.mjs";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

function nodeToWeb(req) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value != null) headers.set(key, String(value));
  }
  return new Request(`http://${req.headers?.host || "127.0.0.1"}${req.url || "/"}`, {
    method: req.method,
    headers,
  });
}

async function writeNode(res, response, method) {
  const headers = Object.fromEntries(response.headers.entries());
  res.writeHead(response.status, headers);
  if (method === "HEAD" || response.body == null) {
    res.end();
    return;
  }
  res.end(Buffer.from(await response.arrayBuffer()));
}

export function createServer(dependencies = {}) {
  return http.createServer(async (req, res) => {
    try {
      const response = await handleRequest(nodeToWeb(req), dependencies);
      await writeNode(res, response, req.method);
    } catch (error) {
      console.error("request failed", error);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("暂时无法打开页面");
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const hosted = Boolean(process.env.CURSOR_APP_ID || process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
if (isMain && !hosted) {
  loadDotEnv(path.join(rootDir, ".env"));
  const port = Number(process.env.PORT) || 3000;
  const server = createServer();
  server.listen(port, "0.0.0.0", () => {
    const tokenReady = Boolean(process.env.TUSHARE_TOKEN?.trim());
    console.log(`Compass 已启动：http://127.0.0.1:${port}`);
    console.log(tokenReady ? "Tushare Token 已配置" : "未配置 TUSHARE_TOKEN，日线、板块资讯和自选不会加载");
  });
}
