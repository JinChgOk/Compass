import assert from "node:assert/strict";
import test from "node:test";
import { throughCache } from "../lib/cache.mjs";
import { createPaidGuard } from "../lib/guard.mjs";
import { handleRequest } from "../lib/handle.mjs";
import { loadAnalysis } from "../lib/analysis.mjs";
import { loadWatchCard } from "../lib/watchlist.mjs";
import { shiftYmd, tushareQuery } from "../lib/tushare.mjs";
import { createCallMeter, resetCallMeter } from "../lib/usage.mjs";

test("drops expired entries and keeps the cache under its limit", async () => {
  const cache = new Map();
  await throughCache(cache, "old", -1, async () => "old", 2);
  await throughCache(cache, "b", 60_000, async () => "b", 2);
  await throughCache(cache, "c", 60_000, async () => "c", 2);
  await throughCache(cache, "d", 60_000, async () => "d", 2);
  assert.equal(cache.has("old"), false);
  assert.equal(cache.has("b"), false);
  assert.equal(cache.size, 2);
  assert.equal(await throughCache(cache, "d", 60_000, async () => {
    throw new Error("should reuse");
  }, 2), "d");
});

test("runs one loader when the same key is requested together", async () => {
  const cache = new Map();
  let calls = 0;
  const loader = () => new Promise((resolve) => {
    calls += 1;
    setTimeout(() => resolve("shared"), 20);
  });
  const [left, right] = await Promise.all([
    throughCache(cache, "k", 60_000, loader, 10),
    throughCache(cache, "k", 60_000, loader, 10),
  ]);
  assert.equal(calls, 1);
  assert.equal(left, "shared");
  assert.equal(right, "shared");
});

test("stops another analysis read after the limit", async () => {
  const guard = createPaidGuard({
    clientLimits: { analysis: 2 },
    globalLimits: { analysis: 2 },
    activeLimit: 4,
  });
  const analysis = async () => ({ configured: true, bottom: "ok" });
  const statuses = [];
  for (let index = 0; index < 3; index += 1) {
    const response = await handleRequest(new Request(`http://127.0.0.1/api/analysis?code=60051${index}`), { analysis, guard });
    statuses.push(response.status);
  }
  assert.deepEqual(statuses, [200, 200, 429]);
  const blocked = await handleRequest(new Request("http://127.0.0.1/api/analysis?code=600519"), { analysis, guard });
  const body = await blocked.json();
  assert.equal(blocked.status, 429);
  assert.match(body.message, /请过一会儿再看/);
  assert.equal(blocked.headers.get("retry-after"), "30");
});

test("shares one in-flight analysis and then reuses it", async () => {
  const guard = createPaidGuard({
    clientLimits: { analysis: 5 },
    globalLimits: { analysis: 5 },
  });
  let calls = 0;
  const task = () => new Promise((resolve) => {
    calls += 1;
    setTimeout(() => resolve({ configured: true, bottom: "x" }), 30);
  });
  const [left, right] = await Promise.all([
    guard.run({ route: "analysis", client: "local", cacheKey: "analysis:600519", ttlMs: 60_000, task }),
    guard.run({ route: "analysis", client: "local", cacheKey: "analysis:600519", ttlMs: 60_000, task }),
  ]);
  assert.equal(calls, 1);
  assert.equal(left.bottom, "x");
  assert.equal(right.bottom, "x");
  let again = 0;
  const cached = await guard.run({
    route: "analysis",
    client: "local",
    cacheKey: "analysis:600519",
    ttlMs: 60_000,
    task: async () => {
      again += 1;
      return { configured: true, bottom: "y" };
    },
  });
  assert.equal(again, 0);
  assert.equal(cached.bottom, "x");
});

test("keeps at most six Tushare calls in flight", async () => {
  let active = 0;
  let peak = 0;
  const fetchImpl = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 40));
    active -= 1;
    return { ok: true, status: 200, async json() { return { code: 0, data: { fields: ["x"], items: [] } }; } };
  };
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => tushareQuery({
    token: "test-token",
    apiName: "daily",
    params: { n: index },
    fetchImpl,
  })));
  assert.equal(results.length, 12);
  assert.equal(peak <= 6, true);
});

test("reuses the dragon list when the card and the mid-term view open together", async () => {
  const end = "20261106";
  const dates = Array.from({ length: 12 }, (_, index) => shiftYmd(end, index - 11));
  const calls = [];
  const cache = new Map();
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body.api_name);
    if (body.api_name === "daily") {
      return table(["trade_date", "close"], dates.map((tradeDate, index) => [tradeDate, 10 + index]));
    }
    return table(["trade_date", "ts_code"], []);
  };
  const query = { code: "600519", name: "贵州茅台", securityType: "上交所主板A股" };
  const dependencies = { token: "test-token", fetchImpl, cache, now: new Date("2026-11-06T04:00:00Z") };
  await loadWatchCard(query, dependencies);
  const listed = calls.filter((name) => name === "top_list").length;
  await loadAnalysis(query, dependencies);
  assert.equal(listed, 7);
  assert.equal(calls.filter((name) => name === "top_list").length, 7);
  assert.equal(calls.filter((name) => name === "daily").length, 1);
  assert.equal(calls.filter((name) => name === "moneyflow").length, 1);
  assert.equal(calls.filter((name) => name === "forecast").length, 1);
  assert.equal(calls.filter((name) => name === "fund_portfolio").length, 1);
  assert.equal(calls.filter((name) => name === "stk_surv").length, 1);
});

test("counts outbound Tushare calls in a one-minute window", () => {
  let now = 1_000;
  const meter = createCallMeter({ windowMs: 60_000, now: () => now });
  meter.note();
  meter.note();
  assert.equal(meter.count(), 2);
  now = 61_000;
  meter.note();
  assert.equal(meter.count(), 1);
});

test("puts the last-minute Tushare call count on paid responses", async () => {
  resetCallMeter();
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() { return { code: 0, data: { fields: ["ts_code"], items: [] } }; },
  });
  await tushareQuery({ token: "test-token", apiName: "daily", params: {}, fetchImpl });
  await tushareQuery({ token: "test-token", apiName: "weekly", params: {}, fetchImpl });
  const response = await handleRequest(new Request("http://127.0.0.1/api/watch?code=600519"), {
    watch: async () => ({ configured: true, code: "600519" }),
    guard: createPaidGuard({ cacheLimit: 0 }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-tushare-calls"), "2");
});

function table(fields, items) {
  return { ok: true, status: 200, async json() { return { code: 0, data: { fields, items } }; } };
}
