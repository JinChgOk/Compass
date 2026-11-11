import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { GET } from "../lib/handle.mjs";
import { createServer } from "../server.mjs";
import { shiftYmd } from "../lib/tushare.mjs";
import {
  buildCapital,
  buildHolders,
  buildPerformance,
  buildPosition,
  industryChoices,
  loadWatchCard,
  readWatchQuery,
} from "../lib/watchlist.mjs";

const BANNED = ["fund_portfolio", "stk_surv", "limit_list_d", "ths_member", "dc_member", "cyq_perf", "cyq_chips"];

test("prefers an express over the same period and a newer forecast for profit", () => {
  const samePeriod = buildPerformance({
    forecasts: [{ ts_code: "600519.SH", ann_date: "20251101", end_date: "20250930", type: "预增", p_change_min: 30, p_change_max: 50, summary: "需求回暖" }],
    expresses: [{ ts_code: "600519.SH", ann_date: "20251028", end_date: "20250930", yoy_sales: 12.5, yoy_dedu_np: 8.25, yoy_roe: 1.4, perf_summary: "第三季度营收增长。" }],
  });
  assert.equal(samePeriod.preview.kind, "express");
  assert.equal(samePeriod.preview.summary, "第三季度营收增长。");
  assert.equal(samePeriod.profitYoy.value, 8.25);
  assert.equal(samePeriod.profitYoy.source, "快报");

  const newerForecast = buildPerformance({
    forecasts: [{ ann_date: "20260120", end_date: "20251231", type: "预增", p_change_min: 50, p_change_max: 30, summary: "需求回暖" }],
    expresses: [{ ann_date: "20251028", end_date: "20250930", yoy_sales: 12.5, yoy_dedu_np: 8, yoy_roe: 1.5 }],
  });
  assert.equal(newerForecast.preview.kind, "forecast");
  assert.equal(newerForecast.preview.periodLabel, "2025年报");
  assert.equal(newerForecast.preview.type, "预增");
  assert.equal(newerForecast.preview.summary, "需求回暖");
  assert.equal(newerForecast.profitYoy.value, null);
  assert.equal(newerForecast.profitYoy.min, 30);
  assert.equal(newerForecast.profitYoy.max, 50);
  assert.equal(newerForecast.profitYoy.source, "预告");
  assert.equal(newerForecast.revenueYoy.value, 12.5);
  assert.equal(newerForecast.revenueYoy.source, "快报");
  assert.equal(newerForecast.roeYoy.value, 1.5);
  assert.equal(newerForecast.roeYoy.unit, "point");
});

test("uses the revised financials when no forecast or express exists", () => {
  const result = buildPerformance({
    indicators: [
      { end_date: "20250930", ann_date: "20251030", or_yoy: 9, netprofit_yoy: 8, roe_waa: 21, roe_yoy: 50, update_flag: "1" },
      { end_date: "20250930", ann_date: "20251001", or_yoy: 1, netprofit_yoy: 1, roe_waa: 10, update_flag: "0" },
      { end_date: "20240930", ann_date: "20241030", roe_waa: 19, update_flag: "1" },
    ],
  });
  assert.equal(result.preview, null);
  assert.match(result.hint, /财报/);
  assert.equal(result.revenueYoy.value, 9);
  assert.equal(result.revenueYoy.source, "财报");
  assert.equal(result.profitYoy.value, 8);
  assert.equal(result.roeYoy.value, 2);
  assert.equal(result.roeYoy.unit, "point");
  assert.deepEqual(buildPerformance(), {
    preview: null,
    revenueYoy: null,
    profitYoy: null,
    roeYoy: null,
    hint: "",
    error: "",
  });
});

test("sums main-force flow, margin balance, dragon-tiger and block trades", () => {
  const capital = buildCapital({
    moneyflows: [
      { trade_date: "20261101", buy_lg_amount: 1000, sell_lg_amount: 0, buy_elg_amount: 0, sell_elg_amount: 0 },
      { trade_date: "20261102", buy_lg_amount: 80, sell_lg_amount: 10, buy_elg_amount: 5, sell_elg_amount: 10 },
      { trade_date: "20261103", buy_lg_amount: 65 },
      { trade_date: "20261104", buy_lg_amount: 65 },
      { trade_date: "20261105", buy_lg_amount: 65 },
      { trade_date: "20261106", buy_lg_amount: 65 },
    ],
    margins: [1, 2, 3, 4, 5, 6].map((step, index) => ({
      trade_date: `2026110${index + 1}`,
      rzye: step * 1e8,
    })),
    topList: [
      { trade_date: "20261101", reason: "更早", net_amount: 1 },
      { trade_date: "20261106", reason: "日涨幅偏离值达到7%的前五只证券", net_amount: 1_000_000, pct_change: 10 },
      { trade_date: "20261106", reason: "连续三个交易日内，涨幅偏离值累计达到20%的证券", net_amount: 500_000, pct_change: 10 },
    ],
    blockTrades: [
      { trade_date: "20261101", amount: 999, vol: 9 },
      { trade_date: "20261103", amount: 100, vol: 1 },
      { trade_date: "20261103", amount: 50.5, vol: 2 },
    ],
  });
  assert.equal(capital.mainForce.sessions, 5);
  assert.equal(capital.mainForce.netWan, 325);
  assert.equal(capital.mainForce.start, "2026-11-02");
  assert.equal(capital.margin.latestYuan, 600_000_000);
  assert.equal(capital.margin.changeYuan, 500_000_000);
  assert.equal(capital.margin.previousDate, "2026-11-01");
  assert.deepEqual(capital.dragonTiger.reasons, [
    "日涨幅偏离值达到7%的前五只证券",
    "连续三个交易日内，涨幅偏离值累计达到20%的证券",
  ]);
  assert.equal(capital.dragonTiger.netYuan, 1_500_000);
  assert.equal(capital.blockTrade.tradeDate, "2026-11-03");
  assert.equal(capital.blockTrade.count, 2);
  assert.equal(capital.blockTrade.amountWan, 150.5);
  assert.equal(capital.blockTrade.volWan, 3);
  assert.equal(buildCapital({ margins: [{ trade_date: "20261106", rzye: 10 }] }).margin.changeYuan, null);
});

test("compares holder count with the previous period", () => {
  const change = buildHolders([
    { end_date: "20250630", ann_date: "20250701", holder_num: 99999 },
    { end_date: "20250930", ann_date: "20251025", holder_num: 12000 },
    { end_date: "20250630", ann_date: "20250720", holder_num: 15000 },
  ]);
  assert.equal(change.latest.count, 12000);
  assert.equal(change.previous.count, 15000);
  assert.equal(change.change, -3000);
  assert.equal(change.changePct, -20);
  const single = buildHolders([{ end_date: "20250930", ann_date: "20251025", holder_num: 10 }]);
  assert.equal(single.previous, null);
  assert.match(single.hint, /只有一期/);
});

test("measures the stock against its Shenwan industry", () => {
  const stock = Array.from({ length: 21 }, (_, index) => ({
    trade_date: `202601${String(index + 1).padStart(2, "0")}`,
    close: index === 20 ? 110 : 100,
  }));
  const index = stock.map((bar, index) => ({ ...bar, close: index === 20 ? 105 : 100 }));
  const position = buildPosition({
    stockBars: stock,
    indexBars: index,
    industry: { name: "白酒", level: "二级", code: "801125.SI" },
  });
  assert.equal(position.sessions, 20);
  assert.equal(position.start, "2026-01-01");
  assert.equal(position.end, "2026-01-21");
  assert.equal(position.stockReturn, 10);
  assert.equal(position.industryReturn, 5);
  assert.equal(position.excess, 5);

  const short = buildPosition({
    stockBars: Array.from({ length: 10 }, (_, index) => ({ trade_date: `202602${String(index + 1).padStart(2, "0")}`, close: index === 0 ? 100 : 120 })),
    industry: { name: "白酒", code: "801125.SI", level: "二级" },
    indexBars: [],
  });
  assert.equal(short.sessions, 9);
  assert.equal(short.stockReturn, 20);
  assert.match(short.hint, /没有查到申万行业指数/);

  const stale = buildPosition({
    stockBars: stock,
    indexBars: [{ trade_date: "20250101", close: 100 }, { trade_date: "20250121", close: 110 }],
    industry: { name: "白酒", code: "801125.SI", level: "二级" },
  });
  assert.equal(stale.industryReturn, null);
  assert.match(stale.hint, /没有对齐/);
});

test("normalizes Shenwan index codes and keeps the current industry", () => {
  assert.deepEqual(industryChoices([
    { is_new: "N", l2_name: "旧行业", l2_code: "801000.SI" },
    { is_new: "Y", l2_name: "白酒", l2_code: "801125", l1_name: "食品饮料", l1_code: "801120.SI", l3_name: "白酒", l3_code: "851251.SI" },
  ]), [
    { level: "二级", name: "白酒", code: "801125.SI" },
    { level: "一级", name: "食品饮料", code: "801120.SI" },
    { level: "三级", name: "白酒", code: "851251.SI" },
  ]);
  assert.equal(readWatchQuery(new URLSearchParams("code=sh600519&name=贵州茅台")).code, "600519");
  assert.equal(readWatchQuery(new URLSearchParams("code=茅台")), null);
});

test("builds the 600519 card from the 2000-point interfaces", async () => {
  const end = "20261106";
  const dates = Array.from({ length: 25 }, (_, index) => shiftYmd(end, index - 24));
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    assert.equal(body.token, "test-token");
    if (body.api_name === "forecast") {
      return table(
        ["ts_code", "ann_date", "end_date", "type", "p_change_min", "p_change_max", "summary"],
        [["600519.SH", "20251101", "20250930", "预增", 30, 50, "需求回暖"]],
      );
    }
    if (body.api_name === "express") {
      return table(
        ["ts_code", "ann_date", "end_date", "yoy_sales", "yoy_dedu_np", "yoy_roe", "perf_summary"],
        [["600519.SH", "20251028", "20250930", 12.5, 8.25, 1.4, "第三季度营收增长。"]],
      );
    }
    if (body.api_name === "fina_indicator") {
      return table(
        ["ts_code", "ann_date", "end_date", "or_yoy", "netprofit_yoy", "roe_waa", "roe_yoy", "update_flag"],
        [
          ["600519.SH", "20251030", "20250930", 99, 99, 30, 10, "1"],
          ["600519.SH", "20241030", "20240930", 1, 1, 10, 1, "1"],
        ],
      );
    }
    if (body.api_name === "moneyflow") {
      return table(
        ["ts_code", "trade_date", "buy_lg_amount", "sell_lg_amount", "buy_elg_amount", "sell_elg_amount"],
        dates.slice(-6).map((tradeDate, index) => ["600519.SH", tradeDate, index === 0 ? 1000 : 65, 0, 0, 0]),
      );
    }
    if (body.api_name === "margin_detail") {
      return table(
        ["ts_code", "trade_date", "rzye"],
        dates.slice(-6).map((tradeDate, index) => ["600519.SH", tradeDate, (index + 1) * 1e8]),
      );
    }
    if (body.api_name === "stk_holdernumber") {
      return table(
        ["ts_code", "ann_date", "end_date", "holder_num"],
        [
          ["600519.SH", "20250701", "20250630", 99999],
          ["600519.SH", "20251025", "20250930", 12000],
          ["600519.SH", "20250720", "20250630", 15000],
        ],
      );
    }
    if (body.api_name === "daily") {
      return table(
        ["ts_code", "trade_date", "close"],
        dates.map((tradeDate, index) => ["600519.SH", tradeDate, 100 + index]),
      );
    }
    if (body.api_name === "index_member_all") {
      return table(
        ["l1_code", "l1_name", "l2_code", "l2_name", "l3_code", "l3_name", "ts_code", "name", "is_new"],
        [["801120.SI", "食品饮料", "801125.SI", "白酒", "851251.SI", "白酒", "600519.SH", "贵州茅台", "Y"]],
      );
    }
    if (body.api_name === "index_daily") {
      return table(
        ["ts_code", "trade_date", "close"],
        dates.map((tradeDate, index) => ["801125.SI", tradeDate, 200 + index]),
      );
    }
    if (body.api_name === "block_trade") {
      return table(
        ["ts_code", "trade_date", "price", "vol", "amount"],
        [
          ["000001.SZ", "20261031", 1, 1, 999],
          ["600519.SH", "20261031", 10, 1.5, 12.34],
          ["600519.SH", "20261001", 10, 9, 100],
        ],
      );
    }
    if (body.api_name === "top_list") {
      if (body.params.trade_date !== end) return table(["trade_date"], []);
      return table(
        ["trade_date", "ts_code", "pct_change", "net_amount", "reason"],
        [
          [end, "600519.SH", 3.2, 2_500_000, "日换手率达到20%的前五只证券"],
          [end, "000001.SZ", 10, 99_999_999, "其他股票"],
        ],
      );
    }
    throw new Error(`unexpected ${body.api_name}`);
  };

  const result = await loadWatchCard({
    code: "600519",
    name: "贵州茅台",
    securityType: "上交所主板A股",
  }, {
    token: "test-token",
    fetchImpl,
    cache: new Map(),
    now: new Date("2026-11-06T04:00:00Z"),
  });

  assert.equal(result.configured, true);
  assert.equal(result.tsCode, "600519.SH");
  assert.equal(result.name, "贵州茅台");
  assert.equal(result.performance.preview.kind, "express");
  assert.equal(result.performance.preview.periodLabel, "2025三季报");
  assert.equal(result.performance.preview.annDate, "2025-10-28");
  assert.equal(result.performance.revenueYoy.value, 12.5);
  assert.equal(result.performance.revenueYoy.source, "快报");
  assert.equal(result.performance.profitYoy.value, 8.25);
  assert.equal(result.performance.profitYoy.source, "快报");
  assert.equal(result.performance.roeYoy.value, 1.4);
  assert.equal(result.performance.roeYoy.unit, "point");
  assert.equal(result.capital.mainForce.netWan, 325);
  assert.equal(result.capital.mainForce.sessions, 5);
  assert.equal(result.capital.mainForce.start, "2026-11-02");
  assert.equal(result.capital.margin.changeYuan, 500_000_000);
  assert.equal(result.capital.margin.latestYuan, 600_000_000);
  assert.equal(result.capital.margin.previousDate, "2026-11-01");
  assert.equal(result.capital.dragonTiger.netYuan, 2_500_000);
  assert.deepEqual(result.capital.dragonTiger.reasons, ["日换手率达到20%的前五只证券"]);
  assert.equal(result.capital.blockTrade.amountWan, 12.34);
  assert.equal(result.capital.blockTrade.tradeDate, "2026-10-31");
  assert.equal(result.capital.blockTrade.count, 1);
  assert.equal(result.holders.change, -3000);
  assert.equal(result.holders.changePct, -20);
  assert.equal(result.holders.previous.count, 15000);
  const stockBase = 100 + 4;
  const stockEnd = 100 + 24;
  const indexBase = 200 + 4;
  const indexEnd = 200 + 24;
  const stockValue = (stockEnd / stockBase - 1) * 100;
  const indexValue = (indexEnd / indexBase - 1) * 100;
  assert.equal(result.position.start, "2026-10-17");
  assert.equal(result.position.end, "2026-11-06");
  assert.equal(result.position.sessions, 20);
  assert.equal(result.position.industryName, "白酒");
  assert.equal(result.position.industryLevel, "二级");
  assert.equal(result.position.industryCode, "801125.SI");
  assert.equal(result.position.stockReturn, round2(stockValue));
  assert.equal(result.position.industryReturn, round2(indexValue));
  assert.equal(result.position.excess, round2(stockValue - indexValue));
  assert.deepEqual([...new Set(calls.map((call) => call.api_name))].sort(), [
    "block_trade",
    "daily",
    "express",
    "fina_indicator",
    "forecast",
    "index_daily",
    "index_member_all",
    "margin_detail",
    "moneyflow",
    "stk_holdernumber",
    "top_list",
  ]);
  assert.equal(calls.some((call) => BANNED.includes(call.api_name)), false);
  assert.equal(calls.filter((call) => call.api_name === "top_list").length, 7);
  assert.equal(calls.find((call) => call.api_name === "index_daily").params.ts_code, "801125.SI");
  assert.equal(calls.find((call) => call.api_name === "index_member_all").params.is_new, "Y");
  assert.equal(calls.find((call) => call.api_name === "daily").params.end_date, end);
  assert.equal(JSON.stringify(result).includes("test-token"), false);
});

test("falls back to Shenwan level 1 when level 2 has no bars", async () => {
  const dates = Array.from({ length: 21 }, (_, index) => shiftYmd("20261106", index - 20));
  const indexCalls = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.api_name === "index_daily") {
      indexCalls.push(body.params.ts_code);
      if (body.params.ts_code === "801125.SI") return table(["ts_code", "trade_date", "close"], []);
      return table(
        ["ts_code", "trade_date", "close"],
        dates.map((tradeDate, index) => [body.params.ts_code, tradeDate, index === 20 ? 105 : 100]),
      );
    }
    if (body.api_name === "daily") {
      return table(
        ["ts_code", "trade_date", "close"],
        dates.map((tradeDate, index) => ["600519.SH", tradeDate, index === 20 ? 110 : 100]),
      );
    }
    if (body.api_name === "index_member_all") {
      return table(
        ["l1_code", "l1_name", "l2_code", "l2_name", "ts_code", "name", "is_new"],
        [["801120.SI", "食品饮料", "801125.SI", "白酒", "600519.SH", "贵州茅台", "Y"]],
      );
    }
    if (body.api_name === "express" && body.fields) return json({ code: 1, msg: "字段不存在" });
    if (body.api_name === "express") {
      return table(["end_date", "ann_date", "yoy_sales"], [["20250930", "20251028", 4]]);
    }
    return table(["ts_code"], []);
  };

  const result = await loadWatchCard({ code: "600519", name: "600519" }, {
    token: "test-token",
    fetchImpl,
    cache: new Map(),
    now: new Date("2026-11-06T04:00:00Z"),
  });
  assert.deepEqual(indexCalls, ["801125.SI", "801120.SI"]);
  assert.equal(result.position.industryLevel, "一级");
  assert.equal(result.position.industryName, "食品饮料");
  assert.equal(result.position.stockReturn, 10);
  assert.equal(result.position.industryReturn, 5);
  assert.equal(result.position.excess, 5);
  assert.equal(result.name, "贵州茅台");
  assert.equal(result.performance.revenueYoy.value, 4);
  assert.equal(result.performance.revenueYoy.source, "快报");
});

test("hides the token when a section fails and skips the network without one", async () => {
  const token = "secret-token-value";
  const failed = await loadWatchCard({ code: "600519", name: "贵州茅台" }, {
    token,
    cache: new Map(),
    now: new Date("2026-11-06T04:00:00Z"),
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.api_name === "moneyflow") return json({ code: 2002, msg: `没有接口访问权限 ${token}` });
      return table(["ts_code"], []);
    },
  });
  assert.match(failed.capital.errors.flow, /权限/);
  assert.equal(JSON.stringify(failed).includes(token), false);

  let called = false;
  const missing = await loadWatchCard({ code: "600519" }, {
    token: "",
    fetchImpl: async () => {
      called = true;
      throw new Error("should not fetch");
    },
  });
  assert.equal(called, false);
  assert.equal(missing.configured, false);
  assert.match(missing.message, /TUSHARE_TOKEN/);
});

test("serves the watch API and the card labels", async () => {
  const seen = [];
  const server = createServer({
    watch: async (query) => {
      seen.push(query);
      return { configured: true, code: query.code, name: query.name };
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    const missing = await fetch(`http://127.0.0.1:${port}/api/watch`);
    assert.equal(missing.status, 400);
    const method = await fetch(`http://127.0.0.1:${port}/api/watch?code=600519`, { method: "POST" });
    assert.equal(method.status, 405);
    const params = new URLSearchParams({ code: "ｓｈ６００５１９", name: "贵州茅台", securityType: "上交所主板A股" });
    const response = await fetch(`http://127.0.0.1:${port}/api/watch?${params}`);
    const body = await response.json();
    assert.equal(body.code, "600519");
    assert.equal(seen[0].name, "贵州茅台");
    assert.equal(seen[0].securityType, "上交所主板A股");

    const broken = createServer({
      watch: async () => {
        throw new Error("upstream exploded");
      },
    });
    broken.listen(0, "127.0.0.1");
    await once(broken, "listening");
    try {
      const error = await fetch(`http://127.0.0.1:${broken.address().port}/api/watch?code=600519`);
      const payload = await error.json();
      assert.equal(error.status, 502);
      assert.equal(payload.message, "暂时无法获取自选资料");
      assert.doesNotMatch(payload.message, /exploded/);
    } finally {
      broken.close();
    }

    const page = await fetch(`http://127.0.0.1:${port}/`);
    const html = await page.text();
    assert.match(html, /id="watch-form"/);
    assert.match(html, /加入自选/);
    assert.match(html, /近 5 个交易日/);
    assert.match(html, /近 7 个交易日/);
    assert.match(html, /近 20 个交易日/);
    const script = await (await fetch(`http://127.0.0.1:${port}/app.js`)).text();
    assert.match(script, /"业绩"/);
    assert.match(script, /"资金"/);
    assert.match(script, /"股东"/);
    assert.match(script, /"位置"/);
  } finally {
    server.close();
  }
});

test("web handler serves the home page without listening", async () => {
  const response = await GET(new Request("http://127.0.0.1/"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await response.text(), /自选/);
  const missing = await GET(new Request("http://127.0.0.1/api/watch"));
  assert.equal(missing.status, 400);
});

test("watchlist source stays on the allowed interfaces", async () => {
  const source = await readFile(new URL("../lib/watchlist.mjs", import.meta.url), "utf8");
  assert.equal(BANNED.some((name) => source.includes(name)), false);
});

function round2(value) {
  return Math.round(value * 100) / 100;
}

function table(fields, items) {
  return json({ code: 0, data: { fields, items } });
}

function json(body) {
  return { ok: true, status: 200, async json() { return body; } };
}
