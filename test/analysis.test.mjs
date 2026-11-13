import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import {
  assembleMidterm,
  buildCapitalSpan,
  buildDragon,
  buildLevels,
  buildLimits,
  buildUnlock,
  buildValuation,
  judgeCheapness,
  loadAnalysis,
} from "../lib/analysis.mjs";
import { createServer } from "../server.mjs";
import { shiftYmd } from "../lib/tushare.mjs";

const BANNED = ["dc_member", "cyq_perf", "cyq_chips"];

test("says a low PE is truly cheap only when profit and revenue agree", () => {
  const real = judgeCheapness({
    valuation: { peTtm: 9.8, pb: 1.5, pePercentile: 1, pbPercentile: 30, dvTtm: 2.8, totalMv: 29330000 },
    relative: { industryPe: 15.4 },
    earnings: { profitYoy: 20, previousProfitYoy: 18, revenueYoy: 15 },
    price: { rebound: 12 },
    forward: { pe: 10.5 },
    valueStyle: "pe",
  });
  assert.equal(real.verdict, "真便宜");
  assert.match(real.reasons.join(""), /两者同向/);

  const oneOff = judgeCheapness({
    valuation: { peTtm: 9.8, pePercentile: 1, pbPercentile: 40, totalMv: 100000 },
    relative: { industryPe: 15 },
    earnings: { profitYoy: 40, previousProfitYoy: 30, revenueYoy: -5 },
    price: { rebound: 10 },
    valueStyle: "pe",
  });
  assert.equal(oneOff.verdict, "看起来便宜");
  assert.match(oneOff.reasons.join(""), /不同向/);

  const thinRevenue = judgeCheapness({
    valuation: { peTtm: 9.8, pePercentile: 1 },
    relative: { industryPe: 15 },
    earnings: { profitYoy: 20, previousProfitYoy: 18, revenueYoy: 3 },
    price: { rebound: 10 },
    valueStyle: "pe",
  });
  assert.equal(thinRevenue.verdict, "看起来便宜");
  assert.match(thinRevenue.reasons.join(""), /收入没有跟上利润/);

  const slowing = judgeCheapness({
    valuation: { peTtm: 9.8, pePercentile: 1, totalMv: 100000 },
    relative: {},
    earnings: { profitYoy: 20, previousProfitYoy: 80, revenueYoy: 18 },
    price: { rebound: 188 },
    valueStyle: "pe",
  });
  assert.equal(slowing.verdict, "看起来便宜");
  assert.match(slowing.reasons.join(""), /增速在放缓/);
  assert.match(slowing.reasons.join(""), /利润变厚/);

  const dear = judgeCheapness({
    valuation: { peTtm: 30, pePercentile: 70 },
    relative: { industryPe: 15 },
    earnings: { profitYoy: 10, previousProfitYoy: 8, revenueYoy: 9 },
    valueStyle: "pe",
  });
  assert.equal(dear.verdict, "不便宜");
});

test("reads weekly support, resistance, and the level that ends the bottom view", () => {
  const bars = Array.from({ length: 40 }, (_, index) => ({
    trade_date: `2025${String(index + 1).padStart(4, "0")}`.slice(0, 8),
    open: 12,
    high: 12.4,
    low: 11.6,
    close: 12,
  }));
  // pad dates properly
  for (let index = 0; index < bars.length; index += 1) {
    bars[index].trade_date = shiftYmd("20250106", index * 7);
  }
  bars[10].low = 10;
  bars[10].high = 11;
  bars[10].close = 10.4;
  bars[20].high = 16;
  bars[20].low = 14.5;
  bars[20].close = 15.2;
  bars[39].close = 10.8;
  bars[39].low = 10.5;
  bars[39].high = 11.2;
  const levels = buildLevels(bars, 10.8);
  assert.ok(levels.support);
  assert.ok(levels.support.low <= 10.2);
  assert.ok(levels.resistance);
  assert.ok(levels.resistance.low > 10.8);
  assert.ok(levels.room > 0);
  assert.equal(levels.invalidation, levels.support.low);
  assert.equal(levels.reclaimed, false);
});

test("keeps the year's swings and ignores older weekly bars", () => {
  const bars = Array.from({ length: 70 }, (_, index) => ({
    trade_date: shiftYmd("20240101", index * 7),
    open: 12,
    high: 12.2,
    low: 11.8,
    close: 12,
  }));
  bars[2].high = 40;
  bars[2].low = 30;
  bars[2].close = 35;
  bars[60].low = 9;
  bars[60].high = 9.4;
  bars[60].close = 9.2;
  bars[69].close = 11;
  bars[69].high = 11.2;
  bars[69].low = 10.6;
  const levels = buildLevels(bars, 11);
  assert.ok(levels.support);
  assert.ok(levels.support.low < 12);
  assert.ok(levels.resistance == null || levels.resistance.high < 20);
  assert.ok(levels.ma != null);
});

test("places the current PE in the supplied one-year range", () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    trade_date: shiftYmd("20250101", index),
    pe_ttm: 10 + index,
    pb: 1 + index / 10,
    total_mv: 200000,
    dv_ttm: 2.5,
  }));
  rows[29].pe_ttm = 12;
  const valuation = buildValuation(rows);
  assert.equal(valuation.peTtm, 12);
  assert.equal(valuation.pePercentile, Math.round((2 / 30) * 100));
  assert.equal(valuation.totalMv, 200000);
});

test("sums medium-term flow and dragon-tiger appearances", () => {
  const capital = buildCapitalSpan([
    { trade_date: "20261101", buy_lg_amount: 100, sell_lg_amount: 40, buy_elg_amount: 0, sell_elg_amount: 0 },
    { trade_date: "20261106", buy_lg_amount: 10, sell_lg_amount: 30, buy_elg_amount: 0, sell_elg_amount: 0 },
  ], [
    { trade_date: "20261001", rzye: 100 },
    { trade_date: "20261106", rzye: 140 },
  ]);
  assert.equal(capital.flow20, 40);
  assert.equal(capital.margin, "回升");
  const dragon = buildDragon([
    { trade_date: "20261020", net_amount: 1000000, reason: "日跌幅偏离值达到7%的前五只证券" },
    { trade_date: "20261106", net_amount: -200000, reason: "日换手率达到20%的前五只证券" },
  ], 60);
  assert.equal(dragon.count, 2);
  assert.equal(dragon.net, 800000);
  const unlock = buildUnlock([
    { float_date: "20261201", float_ratio: 3 },
    { float_date: "20270115", float_ratio: 2.5 },
    { float_date: "20280101", float_ratio: 9 },
  ], "20261106");
  assert.equal(unlock.ratio, 5.5);
  assert.equal(unlock.count, 2);
});

test("treats frequent limit-ups as thematic counter-evidence", () => {
  const quiet = buildLimits([
    { trade_date: "20260301", limit: "U", limit_times: 1 },
    { trade_date: "20260408", limit: "Z", limit_times: 0 },
    { trade_date: "20240101", limit: "U", limit_times: 4 },
  ], { start: "20241107", end: "20261106" });
  assert.equal(quiet.upCount, 1);
  assert.equal(quiet.zhaCount, 1);
  assert.equal(quiet.thematic, false);
  const hot = buildLimits(Array.from({ length: 8 }, (_, index) => ({
    trade_date: `2026${String(index + 1).padStart(2, "0")}01`,
    limit: "U",
    limit_times: index === 7 ? 3 : 1,
  })));
  assert.equal(hot.upCount, 8);
  assert.equal(hot.maxStreak, 3);
  assert.equal(hot.thematic, true);
});

test("grades a cheap stock with worsening earnings as a low-conviction bounce", () => {
  const result = assembleMidterm({
    price: { close: 10.8, drawdown: -40, rebound: 8, ma60: 14 },
    valuation: { peTtm: 12, pb: 1.4, dvTtm: 1, totalMv: 200000, pePercentile: 15, pbPercentile: 18 },
    levels: { support: { low: 10, high: 10.4, touches: 2, fromLow: true, fromHigh: false }, resistance: { low: 15, high: 16, touches: 1, fromLow: false, fromHigh: true }, ma: 14, reclaimed: false, room: 30, nearerMa: false, invalidation: 10 },
    relative: { name: "白酒", excess: -12, industryPe: 25, industryPb: 3 },
    earnings: { positive: false, negative: true, summary: "最新预告续亏", growth: null },
    capital: {
      flow20: 100,
      flow60: -500,
      margin: "回升",
      holders: "股东户数下降",
      funds: { latest: { periodLabel: "2025三季报", count: 2, floatPct: 2 }, previous: { count: 3 }, countChange: -1 },
      surveys: { count: 2, latestDate: "2026-03-01", orgCount: 2, highlights: [{ date: "2026-03-01", text: "订单饱满，产能利用率回升" }] },
    },
    dragon: { count: 2, net: 800000, reasons: ["日跌幅偏离值达到7%的前五只证券"], sessions: 60 },
    seats: { institution: 500000, hot: null },
    unlock: { ratio: 6, count: 2 },
    limits: { upCount: 9, zhaCount: 2, maxStreak: 3, thematic: true },
    discount: false,
    valueStyle: "pe",
  });
  assert.equal(result.facts.grade, "低");
  assert.equal(result.facts.path, "反弹");
  assert.match(result.bottom, /可以看作底部|接近底部/);
  assert.match(result.stance, /超跌反弹/);
  assert.match(result.levels, /支撑 10.00/);
  assert.match(result.levels, /压力 15.00/);
  assert.match(result.invalidation, /10.00/);
  assert.match(result.capital, /龙虎榜 2 次/);
  assert.match(result.capital, /机构席位/);
  assert.match(result.capital, /2025三季报公募 2 只持仓/);
  assert.match(result.capital, /近1年机构调研 2 次/);
  assert.match(result.capital, /订单饱满/);
  assert.match(result.counter, /解禁合计 6.0%/);
  assert.match(result.counter, /近1年涨停 9 次/);
  assert.match(result.counter, /更像题材票/);
  assert.match(result.value, /总市值 20.0 亿/);
});

test("loads the mid-term view for 600519 from the allowed interfaces", async () => {
  const end = "20261106";
  const dates = Array.from({ length: 30 }, (_, index) => shiftYmd(end, index - 29));
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body.api_name);
    assert.equal(body.token, "test-token");
    if (BANNED.includes(body.api_name)) throw new Error("banned");
    if (body.api_name === "weekly") {
      return table(["trade_date", "open", "high", "low", "close"], dates.map((tradeDate, index) => [tradeDate, 12, index === 20 ? 16 : 12.4, index === 10 ? 10 : 11.6, index === dates.length - 1 ? 10.8 : 12]));
    }
    if (body.api_name === "daily") {
      return table(["trade_date", "close"], dates.map((tradeDate, index) => [tradeDate, 10 + index * 0.1]));
    }
    if (body.api_name === "daily_basic" && body.params.ts_code) {
      return table(["trade_date", "pe_ttm", "pb", "dv_ttm", "total_mv"], Array.from({ length: 25 }, (_, index) => [shiftYmd("20251001", index), 20 + index, 2, 1, 500000]));
    }
    if (body.api_name === "daily_basic") {
      return table(["ts_code", "pe_ttm", "pb"], [["600519.SH", 30, 4], ["000001.SZ", 10, 1]]);
    }
    if (body.api_name === "index_member_all" && body.params.ts_code) {
      return table(["l1_code", "l1_name", "l2_code", "l2_name", "ts_code", "is_new"], [["801120.SI", "食品饮料", "801125.SI", "白酒", "600519.SH", "Y"]]);
    }
    if (body.api_name === "index_member_all") {
      return table(["ts_code"], [["600519.SH"], ["000001.SZ"]]);
    }
    if (body.api_name === "index_daily") {
      return table(["trade_date", "close"], dates.map((tradeDate) => [tradeDate, 100]));
    }
    if (body.api_name === "fina_indicator") {
      return table(["ann_date", "end_date", "netprofit_yoy", "or_yoy", "update_flag"], [
        ["20251030", "20250930", -20, -5, "1"],
        ["20250820", "20250630", -10, 2, "1"],
      ]);
    }
    if (body.api_name === "top_list" && body.params.trade_date === end) {
      return table(["trade_date", "ts_code", "net_amount", "reason"], [[end, "600519.SH", 2000000, "日跌幅偏离值达到7%的前五只证券"]]);
    }
    if (body.api_name === "top_inst") {
      return table(["trade_date", "ts_code", "exalter", "net_buy"], [[end, "600519.SH", "机构专用", 1500000]]);
    }
    if (body.api_name === "share_float") {
      return table(["float_date", "float_ratio"], [["20261220", 1.2]]);
    }
    if (body.api_name === "fund_portfolio") {
      return table(
        ["ts_code", "ann_date", "end_date", "symbol", "mkv", "stk_float_ratio", "stk_mkv_ratio"],
        [
          ["001001.OF", "20251025", "20250930", "600519.SH", 800000000, 1.5, 8.2],
          ["001002.OF", "20250720", "20250630", "600519.SH", 900000000, 2, 9],
        ],
      );
    }
    if (body.api_name === "fund_basic") {
      return table(["ts_code", "name"], [["001001.OF", "易方达蓝筹"]]);
    }
    if (body.api_name === "stk_surv") {
      return table(
        ["ts_code", "surv_date", "rece_org", "content"],
        [["600519.SH", "20260301", "易方达", "答：毛利率回升，订单饱满。"]],
      );
    }
    if (body.api_name === "limit_list_d") {
      return table(
        ["ts_code", "trade_date", "limit", "limit_times"],
        [
          ["600519.SH", "20260301", "U", 1],
          ["600519.SH", "20260408", "Z", 0],
        ],
      );
    }
    return table(["ts_code"], []);
  };

  const result = await loadAnalysis({
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
  assert.equal(result.facts.dragonCount, 1);
  assert.match(result.capital, /龙虎榜/);
  assert.match(result.capital, /机构席位/);
  assert.match(result.levels, /支撑|压力/);
  assert.match(result.value, /市值|市盈率|市净率/);
  assert.match(result.counter, /近1年涨停 1 次/);
  assert.match(result.counter, /炸板 1 次/);
  assert.equal(calls.includes("weekly"), true);
  assert.equal(calls.includes("daily_basic"), true);
  assert.equal(calls.filter((name) => name === "top_list").length, 7);
  assert.equal(calls.some((name) => BANNED.includes(name)), false);
  assert.equal(JSON.stringify(result).includes("test-token"), false);
});

test("serves the analysis API", async () => {
  const server = createServer({
    analysis: async (query) => ({ configured: true, bottom: `${query.code} 接近底部` }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    const missing = await fetch(`http://127.0.0.1:${port}/api/analysis`);
    assert.equal(missing.status, 400);
    const response = await fetch(`http://127.0.0.1:${port}/api/analysis?code=600519`);
    const body = await response.json();
    assert.match(body.bottom, /600519/);
  } finally {
    server.close();
  }
});

function table(fields, items) {
  return { ok: true, status: 200, async json() { return { code: 0, data: { fields, items } }; } };
}
