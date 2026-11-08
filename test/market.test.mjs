import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadDotEnv } from "../lib/env.mjs";
import { createServer } from "../server.mjs";
import {
  buildKline,
  industryBoards,
  limitPct,
  loadMarketSnapshot,
  pickImportantDays,
  publicMessage,
  readMarketQuery,
  selectSectorNews,
  shanghaiYmd,
  shiftYmd,
  toTsCode,
} from "../lib/tushare.mjs";

test("maps exchanges and skips generic calendar shifts", () => {
  assert.equal(toTsCode("600519", "上交所主板A股"), "600519.SH");
  assert.equal(toTsCode("000001", "深交所主板A股"), "000001.SZ");
  assert.equal(toTsCode("300750", "深交所创业板A股"), "300750.SZ");
  assert.equal(toTsCode("688981", "上交所科创板A股"), "688981.SH");
  assert.equal(toTsCode("920799", "北京证券交易所A股"), "920799.BJ");
  assert.equal(limitPct("300750.SZ"), 19.5);
  assert.equal(limitPct("600519.SH", "*ST测试"), 4.8);
  assert.equal(shanghaiYmd(new Date("2026-11-08T16:30:00Z")), "20261109");
  assert.equal(shiftYmd("20260301", -1), "20260228");
  assert.equal(shiftYmd("20261108", -180).length, 8);
});

test("picks limit-up, volume spike, and extremes from daily bars", () => {
  const bars = [
    { tradeDate: "2026-11-01", open: 10, high: 11, low: 9.5, close: 10.2, pctChg: 1, amount: 100, vol: 10 },
    { tradeDate: "2026-11-02", open: 10, high: 12, low: 10, close: 11.2, pctChg: 10, amount: 100, vol: 10 },
    { tradeDate: "2026-11-03", open: 11, high: 11.2, low: 8, close: 8.5, pctChg: -6, amount: 500, vol: 10 },
  ];
  const important = pickImportantDays(bars, 9.5);
  const byDate = Object.fromEntries(important.map((day) => [day.tradeDate, day.tags]));
  assert.deepEqual(byDate["2026-11-02"], ["涨停", "阶段新高"]);
  assert.deepEqual(byDate["2026-11-03"], ["大跌", "放量", "阶段新低"]);
  assert.equal(byDate["2026-11-01"], undefined);

  const kline = buildKline([
    { trade_date: "20261103", open: 11, high: 11.2, low: 8, close: 8.5, pct_chg: -6, vol: 10, amount: 500 },
    { trade_date: "20261102", open: 10, high: 12, low: 10, close: 11.2, pct_chg: 10, vol: 10, amount: 100 },
  ], { tsCode: "600519.SH", name: "贵州茅台" });
  assert.equal(kline.latest.tradeDate, "2026-11-03");
  assert.equal(kline.bars[0].tradeDate, "2026-11-02");
});

test("matches sector headlines and drops generic boards", () => {
  assert.deepEqual(industryBoards("食品饮料-饮料-白酒").map((board) => board.name), ["食品饮料", "白酒"]);
  const news = selectSectorNews([
    { datetime: "2026-11-08 09:30:00", title: "白酒板块走强", content: "贵州茅台领涨", src: "cls" },
    { datetime: "2026-11-08 10:00:00", title: "央行开展逆回购", content: "与板块无关", src: "cls" },
    { datetime: "2026-11-08 09:30:00", title: "白酒板块走强", content: "重复", src: "eastmoney" },
  ], [
    { name: "白酒", type: "概念" },
    { name: "沪股通", type: "概念" },
  ]);
  assert.equal(news.length, 1);
  assert.equal(news[0].title, "白酒板块走强");
  assert.equal(news[0].source, "财联社");
  assert.deepEqual(news[0].boards, ["白酒"]);
  assert.equal(news[0].summary, "贵州茅台领涨");
});

test("loads daily bars, boards, and sector news from Tushare", async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    assert.equal(body.token, "test-token");
    if (body.api_name === "daily") {
      return json({
        code: 0,
        data: {
          fields: ["trade_date", "open", "high", "low", "close", "pct_chg", "vol", "amount"],
          items: [["20261106", 10, 11, 9, 10.5, 2, 12000, 30000]],
        },
      });
    }
    if (body.api_name === "concept_detail") {
      return json({
        code: 0,
        data: { fields: ["concept_name"], items: [["白酒"], ["沪股通"]] },
      });
    }
    if (body.api_name === "news") {
      const title = body.params.src === "cls" ? "白酒企业提价" : "市场综述";
      return json({
        code: 0,
        data: { fields: ["datetime", "title", "content"], items: [["2026-11-08 09:00:00", title, "正文"]] },
      });
    }
    throw new Error(`unexpected ${body.api_name}`);
  };

  const result = await loadMarketSnapshot({
    code: "600519",
    name: "贵州茅台",
    securityType: "上交所主板A股",
    industry: "食品饮料-饮料-白酒",
  }, {
    token: "test-token",
    fetchImpl,
    cache: new Map(),
    now: new Date("2026-11-08T07:00:00Z"),
  });

  assert.equal(result.configured, true);
  assert.equal(result.tsCode, "600519.SH");
  assert.equal(result.kline.latest.close, 10.5);
  assert.deepEqual(result.boards.map((board) => board.name), ["白酒"]);
  assert.equal(result.news.length, 1);
  assert.equal(result.news[0].title, "白酒企业提价");
  assert.equal(calls.find((call) => call.api_name === "daily").params.end_date, "20261108");
  assert.equal(JSON.stringify(result).includes("test-token"), false);
});

test("falls back to the F10 industry and hides the token when Tushare refuses", async () => {
  const token = "secret-token-value";
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.api_name === "daily") {
      return json({ code: 0, data: { fields: ["trade_date", "close"], items: [] } });
    }
    return json({ code: 2002, msg: `没有接口访问权限 ${token}` });
  };
  const result = await loadMarketSnapshot({
    code: "600519",
    name: "贵州茅台",
    securityType: "上交所主板A股",
    industry: "食品饮料-饮料-白酒",
  }, { token, fetchImpl, cache: new Map(), now: new Date("2026-11-08T07:00:00Z") });

  assert.deepEqual(result.boards.map((board) => board.name), ["食品饮料", "白酒"]);
  assert.match(result.boardsNote, /F10 行业/);
  assert.match(result.newsError, /新闻资讯/);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(publicMessage(new Error(`timeout ${token}`), token), "暂时无法连接 Tushare");
});

test("reports a missing token without calling Tushare", async () => {
  let called = false;
  const result = await loadMarketSnapshot({ code: "600519" }, {
    token: "",
    fetchImpl: async () => {
      called = true;
      throw new Error("should not fetch");
    },
  });
  assert.equal(result.configured, false);
  assert.match(result.message, /TUSHARE_TOKEN/);
  assert.equal(called, false);
});

test("reads .env without overriding existing variables", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "compass-env-"));
  const file = path.join(directory, ".env");
  await writeFile(file, "# comment\nexport TUSHARE_TOKEN=\"abc\"\nKEEP_ME=new\n");
  const previous = process.env.KEEP_ME;
  process.env.KEEP_ME = "old";
  delete process.env.TUSHARE_TOKEN;
  try {
    loadDotEnv(file);
    assert.equal(process.env.TUSHARE_TOKEN, "abc");
    assert.equal(process.env.KEEP_ME, "old");
  } finally {
    delete process.env.TUSHARE_TOKEN;
    if (previous === undefined) delete process.env.KEEP_ME;
    else process.env.KEEP_ME = previous;
  }
});

test("serves the market API", async () => {
  const server = createServer({
    market: async (query) => ({ configured: true, tsCode: `${query.code}.SH`, boards: [], news: [] }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    const missing = await fetch(`http://127.0.0.1:${port}/api/market`);
    assert.equal(missing.status, 400);
    const params = new URLSearchParams({ code: "６００５１９", name: "贵州茅台", securityType: "上交所主板A股" });
    const response = await fetch(`http://127.0.0.1:${port}/api/market?${params}`);
    const body = await response.json();
    assert.equal(body.tsCode, "600519.SH");
    const page = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
    assert.match(page, /重要交易日/);
    assert.match(page, /板块资讯/);
    const query = readMarketQuery(new URLSearchParams("code=sh600519"));
    assert.equal(query.code, "600519");
  } finally {
    server.close();
  }
});

function json(body) {
  return { ok: true, status: 200, async json() { return body; } };
}
