import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lookupCompany } from "./f10.mjs";
import { clientKey, paidGuard } from "./guard.mjs";
import { loadMarketSnapshot, publicMessage, readMarketQuery } from "./tushare.mjs";
import { loadAnalysis } from "./analysis.mjs";
import { callsInWindow } from "./usage.mjs";
import { loadWatchCard, readWatchQuery } from "./watchlist.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function callHeaders() {
  return { "x-tushare-calls": String(callsInWindow()) };
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function text(status, message, contentType = "text/plain; charset=utf-8") {
  return new Response(message, { status, headers: { "content-type": contentType } });
}

async function publicDir(explicit) {
  if (explicit) return path.resolve(explicit);
  const candidates = [
    path.resolve(moduleDir, "../public"),
    path.resolve(process.cwd(), "public"),
  ];
  for (const dir of candidates) {
    try {
      await access(path.join(dir, "index.html"));
      return dir;
    } catch {
      // 换下一个候选目录。
    }
  }
  return candidates[0];
}

async function serveStatic(url, method, root) {
  if (method !== "GET" && method !== "HEAD") return text(405, "只支持 GET");
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.resolve(root, `.${requested}`);
  if (!filePath.startsWith(`${root}${path.sep}`)) return text(404, "未找到页面");
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch {
    return text(404, "未找到页面");
  }
  const type = CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream";
  return new Response(method === "HEAD" ? null : bytes, {
    status: 200,
    headers: { "content-type": type, "cache-control": "no-cache" },
  });
}

export async function handleRequest(request, dependencies = {}) {
  const url = new URL(request.url);
  const method = request.method;
  const lookup = dependencies.lookup ?? lookupCompany;

  if (url.pathname === "/api/company") {
    if (method !== "GET") return text(405, "只支持 GET");
    try {
      const result = await lookup(url.searchParams.get("q") ?? "");
      return json(result.kind === "invalid" ? 400 : 200, result);
    } catch (error) {
      console.error("F10 lookup failed", error);
      return json(502, { kind: "error", message: "暂时无法获取 F10 资料，请稍后再试" });
    }
  }

  if (url.pathname === "/api/market" || url.pathname === "/api/watch" || url.pathname === "/api/analysis") {
    return servePaid(url, method, request, dependencies);
  }

  return serveStatic(url, method, await publicDir(dependencies.publicDir));
}

const PAID = {
  "/api/market": {
    route: "market",
    ttlMs: 2 * 60 * 1000,
    invalid: "请提供 6 位股票代码",
    failure: "暂时无法获取行情和资讯",
    log: "market lookup failed",
    read: readMarketQuery,
    own: (dependencies) => dependencies.market,
    load: loadMarketSnapshot,
  },
  "/api/watch": {
    route: "watch",
    ttlMs: 2 * 60 * 1000,
    invalid: "请提供 6 位股票代码",
    failure: "暂时无法获取自选资料",
    log: "watch lookup failed",
    read: readWatchQuery,
    own: (dependencies) => dependencies.watch,
    load: loadWatchCard,
  },
  "/api/analysis": {
    route: "analysis",
    ttlMs: 3 * 60 * 1000,
    invalid: "请提供 6 位股票代码",
    failure: "暂时无法生成中线分析",
    log: "analysis failed",
    read: readWatchQuery,
    own: (dependencies) => dependencies.analysis,
    load: loadAnalysis,
  },
};

async function servePaid(url, method, request, dependencies) {
  const spec = PAID[url.pathname];
  if (method !== "GET") return text(405, "只支持 GET");
  const query = spec.read(url.searchParams);
  if (!query) return json(400, { kind: "invalid", message: spec.invalid });
  const guard = dependencies.guard ?? paidGuard;
  const custom = spec.own(dependencies);
  const cacheKey = custom ? null : `${spec.route}:${query.code}:${query.name || ""}:${query.securityType || ""}:${query.industry || ""}`;
  try {
    const body = await guard.run({
      route: spec.route,
      client: clientKey(request),
      cacheKey,
      ttlMs: spec.ttlMs,
      task: () => (custom ?? spec.load)(query),
    });
    return json(200, body, callHeaders());
  } catch (error) {
    if (error?.status === 429) {
      return json(429, { configured: true, message: error.message || "查询太密，请过一会儿再看。" }, { ...callHeaders(), "retry-after": "30" });
    }
    console.error(spec.log, publicMessage(error, process.env.TUSHARE_TOKEN ?? ""));
    return json(502, { configured: true, message: spec.failure }, callHeaders());
  }
}

async function dispatch(request) {
  try {
    return await handleRequest(request);
  } catch (error) {
    console.error("request failed", publicMessage(error, process.env.TUSHARE_TOKEN ?? ""));
    return text(500, "暂时无法打开页面");
  }
}

export function GET(request) {
  return dispatch(request);
}

export function HEAD(request) {
  return dispatch(request);
}

async function entry(request, response) {
  if (response && typeof response.writeHead === "function") {
    const webRequest = nodeToWeb(request);
    const result = await dispatch(webRequest);
    await writeNode(response, result, request.method);
    return;
  }
  return dispatch(request);
}

entry.fetch = (request) => dispatch(request);

export default entry;

export const runtime = "nodejs";

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
