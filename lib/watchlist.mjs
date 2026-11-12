import { CACHE_LIMIT, sharedCache, throughCache } from "./cache.mjs";
import { normalizeCode } from "./f10.mjs";
import { publicMessage, shanghaiYmd, shiftYmd, toTsCode, tushareQuery } from "./tushare.mjs";

const FLOW_SESSIONS = 5;
const EVENT_SESSIONS = 7;
const POSITION_SESSIONS = 20;
const SLOW_TTL_MS = 6 * 60 * 60 * 1000;
const FAST_TTL_MS = 10 * 60 * 1000;

const PERIOD_NAMES = {
  "0331": "一季报",
  "0630": "中报",
  "0930": "三季报",
  "1231": "年报",
};

const defaultCache = sharedCache;
const TOP_FIELDS = "trade_date,ts_code,pct_change,net_amount,reason";

export function readWatchQuery(searchParams) {
  const code = normalizeCode(searchParams.get("code") ?? "");
  if (!code) return null;
  return {
    code,
    name: clip(searchParams.get("name"), 30),
    securityType: clip(searchParams.get("securityType"), 40),
  };
}

export function industryChoices(rows) {
  const row = currentMembers(rows)[0];
  if (!row) return [];
  const levels = [
    ["二级", row.l2_name, row.l2_code],
    ["一级", row.l1_name, row.l1_code],
    ["三级", row.l3_name, row.l3_code],
  ];
  const choices = [];
  const seen = new Set();
  for (const [level, name, code] of levels) {
    const indexCode = toIndexCode(code);
    if (!indexCode || seen.has(indexCode)) continue;
    seen.add(indexCode);
    choices.push({ level, name: cleanText(name), code: indexCode });
  }
  return choices;
}

export function buildPerformance({ forecasts = [], expresses = [], indicators = [] } = {}) {
  const forecast = latestReport(forecasts);
  const express = latestReport(expresses);
  const picked = pickPreview(forecast, express);
  const preview = picked ? previewView(picked.kind, picked.row) : null;
  const indicatorRows = preferLatest(indicators);
  const revenueYoy = choosePart([
    numberPart(express, "yoy_sales", "快报"),
    firstNumber(indicatorRows, "or_yoy"),
  ]);
  const roeYoy = choosePart([
    numberPart(express, "yoy_roe", "快报", "point"),
    roeFromIndicators(indicatorRows),
  ]);
  const forecastProfitMetric = picked?.kind === "forecast" ? forecastProfit(picked.row) : null;
  const profitYoy = forecastProfitMetric ?? choosePart([
    numberPart(express, "yoy_dedu_np", "快报"),
    firstNumber(indicatorRows, "netprofit_yoy"),
  ]);
  const hasMetrics = Boolean(revenueYoy || profitYoy || roeYoy);
  return {
    preview,
    revenueYoy,
    profitYoy,
    roeYoy,
    hint: !preview && hasMetrics ? "近期没有业绩预告或快报，同比来自最近一期财报。" : "",
    error: "",
  };
}

export function buildCapital({
  moneyflows = [],
  margins = [],
  topList = [],
  blockTrades = [],
  flowSessions = FLOW_SESSIONS,
} = {}) {
  return {
    mainForce: summarizeFlow(moneyflows, flowSessions),
    margin: summarizeMargin(margins, flowSessions),
    dragonTiger: summarizeTop(topList),
    blockTrade: summarizeBlock(blockTrades),
    eventSessions: EVENT_SESSIONS,
    errors: { flow: "", margin: "", topList: "", block: "" },
  };
}

export function buildFunds(rows = []) {
  const periods = new Map();
  for (const row of rows ?? []) {
    const end = compactDate(row.end_date);
    const fund = String(row.ts_code ?? "").toUpperCase();
    if (!end || !fund) continue;
    const bucket = periods.get(end) ?? new Map();
    const announced = compactDate(row.ann_date) || "0";
    const previous = bucket.get(fund);
    if (!previous || announced >= (compactDate(previous.ann_date) || "0")) bucket.set(fund, row);
    periods.set(end, bucket);
  }
  const ordered = [...periods.keys()].sort().reverse();
  if (!ordered.length) {
    return { latest: null, previous: null, countChange: null, floatChange: null, hint: "没有查到公募持仓。", error: "" };
  }
  const latest = fundPeriodView(ordered[0], periods.get(ordered[0]));
  const previous = ordered[1] ? fundPeriodView(ordered[1], periods.get(ordered[1])) : null;
  return {
    latest,
    previous,
    countChange: previous ? latest.count - previous.count : null,
    floatChange: previous && latest.floatPct != null && previous.floatPct != null ? round2(latest.floatPct - previous.floatPct) : null,
    hint: previous ? "" : "只有一期公募持仓，暂时不能比较增减。",
    error: "",
  };
}

export function buildSurveys(rows = [], { start = "", end = "" } = {}) {
  const dates = new Set();
  const orgs = new Set();
  for (const row of rows ?? []) {
    const date = compactDate(row.surv_date ?? row.trade_date);
    if (!date) continue;
    if (start && date < start) continue;
    if (end && date > end) continue;
    dates.add(date);
    const org = cleanText(row.rece_org);
    if (org) orgs.add(org);
  }
  const latest = [...dates].sort().at(-1) || "";
  return {
    count: dates.size,
    orgCount: orgs.size,
    latestDate: displayDate(latest),
    hint: dates.size ? "" : "近1年没有机构调研。",
    error: "",
  };
}

export function buildHolders(rows = []) {
  const ordered = preferLatest(rows).filter((row) => asInt(row.holder_num) != null);
  if (ordered.length === 0) {
    return { latest: null, previous: null, change: null, changePct: null, hint: "", error: "" };
  }
  const latest = holderView(ordered[0]);
  if (ordered.length === 1) {
    return {
      latest,
      previous: null,
      change: null,
      changePct: null,
      hint: "只有一期股东户数，暂时不能比较增减。",
      error: "",
    };
  }
  const previous = holderView(ordered[1]);
  const change = latest.count - previous.count;
  return {
    latest,
    previous,
    change,
    changePct: previous.count === 0 ? null : round2((change / previous.count) * 100),
    hint: "",
    error: "",
  };
}

export function buildPosition({
  stockBars = [],
  indexBars = [],
  industry = null,
  sessions = POSITION_SESSIONS,
} = {}) {
  const stock = windowReturn(stockBars, sessions);
  const result = {
    sessions: stock?.sessions ?? 0,
    start: stock ? displayDate(stock.start) : "",
    end: stock ? displayDate(stock.end) : "",
    stockReturn: stock ? round2(stock.value) : null,
    industryName: industry?.name ?? "",
    industryLevel: industry?.level ?? "",
    industryCode: industry?.code ?? "",
    industryReturn: null,
    excess: null,
    hint: "",
    error: "",
    industryError: "",
  };
  if (!stock || !industry?.code) return result;
  const index = normalizeBars(indexBars);
  if (index.length === 0) {
    result.hint = "没有查到申万行业指数行情。";
    return result;
  }
  const startBar = alignedClose(index, stock.start);
  const endBar = alignedClose(index, stock.end);
  if (!startBar || !endBar || startBar.tradeDate === endBar.tradeDate || startBar.close === 0) {
    result.hint = "申万行业指数没有对齐到这段行情。";
    return result;
  }
  const industryReturn = (endBar.close / startBar.close - 1) * 100;
  result.industryReturn = round2(industryReturn);
  result.excess = round2(stock.value - industryReturn);
  return result;
}

export async function loadWatchCard(query, dependencies = {}) {
  const token = String(dependencies.token ?? process.env.TUSHARE_TOKEN ?? "").trim();
  if (!token) {
    return {
      configured: false,
      message: "未配置 Tushare Token。在项目根目录创建 .env，写入 TUSHARE_TOKEN 后重启服务。",
    };
  }

  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const now = dependencies.now ?? new Date();
  const cache = dependencies.cache ?? defaultCache;
  const tsCode = toTsCode(query.code, query.securityType);
  if (!tsCode) {
    return { configured: false, message: "请提供 6 位 A 股代码。" };
  }

  const end = shanghaiYmd(now);
  const reportStart = shiftYmd(end, -800);
  const historyStart = shiftYmd(end, -420);
  const flowStart = shiftYmd(end, -140);
  const fetched = {};
  const failed = {};

  async function take(key, loader) {
    try {
      fetched[key] = await loader();
    } catch (error) {
      fetched[key] = [];
      failed[key] = publicMessage(error, token);
    }
  }

  const context = { token, fetchImpl };
  await Promise.all([
    take("forecast", () => cached(cache, `forecast:${tsCode}:${end}`, SLOW_TTL_MS, () => queryFlexible({
      ...context,
      apiName: "forecast",
      params: { ts_code: tsCode, start_date: reportStart, end_date: end },
      fields: "ts_code,ann_date,end_date,type,p_change_min,p_change_max,summary,change_reason",
    }))),
    take("express", () => cached(cache, `express:${tsCode}:${end}`, SLOW_TTL_MS, () => queryFlexible({
      ...context,
      apiName: "express",
      params: { ts_code: tsCode, start_date: reportStart, end_date: end },
      fields: "ts_code,ann_date,end_date,revenue,n_income,yoy_sales,yoy_dedu_np,yoy_roe,perf_summary",
    }))),
    take("fina", () => cached(cache, `fina:${tsCode}:${end}`, SLOW_TTL_MS, () => queryFlexible({
      ...context,
      apiName: "fina_indicator",
      params: { ts_code: tsCode, start_date: reportStart, end_date: end },
      fields: "ts_code,ann_date,end_date,roe,roe_waa,roe_yoy,or_yoy,netprofit_yoy,update_flag",
    }))),
    take("money", () => cached(cache, `flow:${tsCode}:${end}`, FAST_TTL_MS, () => queryFlexible({
      ...context,
      apiName: "moneyflow",
      params: { ts_code: tsCode, start_date: flowStart, end_date: end },
      fields: "ts_code,trade_date,buy_lg_amount,sell_lg_amount,buy_elg_amount,sell_elg_amount",
    }))),
    take("margin", () => cached(cache, `margin:${tsCode}:${end}`, FAST_TTL_MS, () => queryFlexible({
      ...context,
      apiName: "margin_detail",
      params: { ts_code: tsCode, start_date: flowStart, end_date: end },
      fields: "trade_date,ts_code,rzye",
    }))),
    take("holders", () => cached(cache, `holders:${tsCode}:${end}`, SLOW_TTL_MS, () => queryFlexible({
      ...context,
      apiName: "stk_holdernumber",
      params: { ts_code: tsCode, start_date: reportStart, end_date: end },
      fields: "ts_code,ann_date,end_date,holder_num",
    }))),
    take("daily", () => cached(cache, `daily-close:${tsCode}:${end}`, FAST_TTL_MS, () => queryFlexible({
      ...context,
      apiName: "daily",
      params: { ts_code: tsCode, start_date: historyStart, end_date: end },
      fields: "ts_code,trade_date,close",
    }))),
    take("member", () => cached(cache, `sw-member:${tsCode}`, SLOW_TTL_MS, () => queryFlexible({
      ...context,
      apiName: "index_member_all",
      params: { ts_code: tsCode, is_new: "Y" },
      fields: "l1_code,l1_name,l2_code,l2_name,l3_code,l3_name,ts_code,name,is_new",
    }))),
    take("funds", () => loadFundHoldings({ ...context, cache, tsCode, end })),
    take("surveys", () => loadSurveys({ ...context, cache, tsCode, end })),
  ]);

  const dailyRows = owned(fetched.daily, tsCode);
  const tradeDates = eventDatesFrom(dailyRows, EVENT_SESSIONS);
  const dates = tradeDates.length > 0 ? tradeDates : recentWeekdays(end, EVENT_SESSIONS);
  const blockStart = dates[0] || shiftYmd(end, -30);
  const memberRows = owned(fetched.member, tsCode);

  await Promise.all([
    take("block", () => cached(cache, `block:${tsCode}:${end}`, FAST_TTL_MS, () => queryFlexible({
      ...context,
      apiName: "block_trade",
      params: { ts_code: tsCode, start_date: shiftYmd(end, -120), end_date: end },
      fields: "ts_code,trade_date,price,vol,amount",
    }))),
    take("top", () => loadTopList({ ...context, cache, tsCode, dates })),
    loadIndustryBars(memberRows, { ...context, cache, end, historyStart }).then((value) => {
      fetched.industry = value;
    }),
  ]);

  const performance = buildPerformance({
    forecasts: owned(fetched.forecast, tsCode),
    expresses: owned(fetched.express, tsCode),
    indicators: owned(fetched.fina, tsCode),
  });
  if (!performance.preview && !performance.revenueYoy && !performance.profitYoy && !performance.roeYoy) {
    performance.hint = "";
    performance.error = [failed.forecast, failed.express, failed.fina].find(Boolean) || "";
    if (!performance.error) performance.hint = "没有查到业绩预告、快报或财务指标。";
  }

  const capital = buildCapital({
    moneyflows: owned(fetched.money, tsCode),
    margins: owned(fetched.margin, tsCode),
    topList: owned(fetched.top, tsCode).filter((row) => dates.includes(compactDate(row.trade_date))),
    blockTrades: within(owned(fetched.block, tsCode), blockStart, end),
  });
  capital.eventSessions = dates.length;
  if (!capital.mainForce && failed.money) capital.errors.flow = failed.money;
  if (!capital.margin && failed.margin) capital.errors.margin = failed.margin;
  if (!capital.dragonTiger && failed.top) capital.errors.topList = failed.top;
  if (!capital.blockTrade && failed.block) capital.errors.block = failed.block;

  const holders = buildHolders(owned(fetched.holders, tsCode));
  if (!holders.latest && failed.holders) {
    holders.error = failed.holders;
    holders.hint = "";
  } else if (!holders.latest) {
    holders.hint = "没有查到股东户数。";
  }
  holders.funds = attachSection(buildFunds(forStock(fetched.funds, tsCode)), failed.funds, "没有查到公募持仓。");
  holders.surveys = attachSection(buildSurveys(owned(fetched.surveys, tsCode), { start: shiftYmd(end, -370), end }), failed.surveys, "近1年没有机构调研。");

  const industryResult = fetched.industry || { industry: null, bars: [], error: failed.member || "" };
  const position = buildPosition({
    stockBars: dailyRows,
    indexBars: industryResult.bars,
    industry: industryResult.industry,
  });
  if (failed.daily) {
    position.error = failed.daily;
    position.hint = "";
  }
  if (!industryResult.industry && (failed.member || industryResult.error)) {
    position.industryError = failed.member || industryResult.error;
    position.hint = "";
  } else if (industryResult.error) {
    position.industryError = industryResult.error;
    position.hint = "";
  } else if (!position.industryCode) {
    position.hint = "没有查到申万行业。";
  }

  const reportedName = cleanText(currentMembers(memberRows)[0]?.name);
  const name = query.name && query.name !== query.code ? query.name : (reportedName || query.name || "");
  return { configured: true, code: query.code, name, tsCode, performance, capital, holders, position };
}

function pickPreview(forecast, express) {
  if (!forecast && !express) return null;
  if (!forecast) return { kind: "express", row: express };
  if (!express) return { kind: "forecast", row: forecast };
  // 同一报告期以快报为准；更新的报告期仍用预告。
  if (compactDate(forecast.end_date) > compactDate(express.end_date)) return { kind: "forecast", row: forecast };
  return { kind: "express", row: express };
}

function previewView(kind, row) {
  const summary = kind === "forecast" ? (row.summary || row.change_reason) : row.perf_summary;
  return {
    kind,
    period: displayDate(row.end_date),
    periodLabel: periodLabel(row.end_date),
    annDate: displayDate(row.ann_date),
    type: kind === "forecast" ? cleanText(row.type) : "",
    summary: clipText(summary, 80),
  };
}

function forecastProfit(row) {
  const low = asNumber(row.p_change_min);
  const high = asNumber(row.p_change_max);
  if (low == null && high == null) return null;
  const metric = {
    value: null,
    min: null,
    max: null,
    period: displayDate(row.end_date),
    periodLabel: periodLabel(row.end_date),
    source: "预告",
  };
  if (low != null && high != null && low !== high) {
    metric.min = round2(Math.min(low, high));
    metric.max = round2(Math.max(low, high));
    return metric;
  }
  metric.value = round2(low ?? high);
  return metric;
}

function numberPart(row, field, source, unit) {
  if (!row) return null;
  const value = asNumber(row[field]);
  if (value == null || !compactDate(row.end_date)) return null;
  return baseMetric(value, row.end_date, source, unit);
}

function firstNumber(rows, field) {
  for (const row of rows) {
    const part = numberPart(row, field, "财报");
    if (part) return part;
  }
  return null;
}

function roeFromIndicators(rows) {
  for (const current of rows) {
    const currentRoe = asNumber(current.roe_waa) ?? asNumber(current.roe);
    const priorEnd = shiftYear(compactDate(current.end_date), -1);
    const prior = rows.find((row) => compactDate(row.end_date) === priorEnd);
    const priorRoe = prior ? (asNumber(prior.roe_waa) ?? asNumber(prior.roe)) : null;
    if (currentRoe != null && priorRoe != null) return baseMetric(currentRoe - priorRoe, current.end_date, "财报", "point");
  }
  for (const current of rows) {
    const rate = asNumber(current.roe_yoy);
    if (rate != null) return baseMetric(rate, current.end_date, "财报", "percent");
  }
  return null;
}

function baseMetric(value, period, source, unit) {
  const metric = {
    value: round2(value),
    min: null,
    max: null,
    period: displayDate(period),
    periodLabel: periodLabel(period),
    source,
  };
  if (unit) metric.unit = unit;
  return metric;
}

function choosePart(parts) {
  const usable = parts.filter(Boolean);
  usable.sort((left, right) => {
    if (left.period !== right.period) return left.period < right.period ? 1 : -1;
    return sourceRank(left.source) - sourceRank(right.source);
  });
  return usable[0] ?? null;
}

function sourceRank(source) {
  if (source === "快报") return 0;
  if (source === "财报") return 1;
  return 2;
}

function latestReport(rows) {
  return preferLatest(rows)[0] ?? null;
}

function preferLatest(rows) {
  const byEnd = new Map();
  for (const row of rows ?? []) {
    const end = compactDate(row.end_date);
    if (!end) continue;
    const previous = byEnd.get(end);
    if (!previous || reportRank(row) >= reportRank(previous)) byEnd.set(end, row);
  }
  return [...byEnd.values()].sort((left, right) => compactDate(right.end_date).localeCompare(compactDate(left.end_date)));
}

function reportRank(row) {
  const flag = String(row.update_flag ?? "") === "1" ? 1 : 0;
  return flag * 10_000_000_000 + (Number(compactDate(row.ann_date)) || 0);
}

function summarizeFlow(rows, sessions) {
  const byDate = new Map();
  for (const row of rows ?? []) {
    const tradeDate = compactDate(row.trade_date);
    const net = mainForceNet(row);
    if (!tradeDate || net == null) continue;
    byDate.set(tradeDate, net);
  }
  const ordered = [...byDate.entries()].sort((left, right) => left[0].localeCompare(right[0]));
  if (ordered.length === 0) return null;
  const slice = ordered.slice(-sessions);
  return {
    sessions: slice.length,
    start: displayDate(slice[0][0]),
    end: displayDate(slice.at(-1)[0]),
    netWan: round2(slice.reduce((sum, item) => sum + item[1], 0)),
  };
}

function mainForceNet(row) {
  const parts = [row.buy_lg_amount, row.sell_lg_amount, row.buy_elg_amount, row.sell_elg_amount].map(asNumber);
  if (parts.every((value) => value == null)) return null;
  const [buyLarge, sellLarge, buyExtra, sellExtra] = parts.map((value) => value ?? 0);
  return buyLarge + buyExtra - sellLarge - sellExtra;
}

function summarizeMargin(rows, sessions) {
  const byDate = new Map();
  for (const row of rows ?? []) {
    const tradeDate = compactDate(row.trade_date);
    const balance = asNumber(row.rzye);
    if (!tradeDate || balance == null) continue;
    byDate.set(tradeDate, balance);
  }
  const ordered = [...byDate.entries()].sort((left, right) => left[0].localeCompare(right[0]));
  if (ordered.length === 0) return null;
  const latestIndex = ordered.length - 1;
  const previousIndex = Math.max(0, latestIndex - sessions);
  const latest = ordered[latestIndex];
  const previous = previousIndex === latestIndex ? null : ordered[previousIndex];
  return {
    latestDate: displayDate(latest[0]),
    previousDate: previous ? displayDate(previous[0]) : "",
    latestYuan: round2(latest[1]),
    changeYuan: previous ? round2(latest[1] - previous[1]) : null,
    sessions: previous ? latestIndex - previousIndex : 0,
  };
}

function summarizeTop(rows) {
  const grouped = new Map();
  for (const row of rows ?? []) {
    const tradeDate = compactDate(row.trade_date);
    if (!tradeDate) continue;
    const item = grouped.get(tradeDate) ?? { reasons: [], net: 0, hasNet: false, pctChg: null };
    const reason = cleanText(row.reason);
    if (reason && !item.reasons.includes(reason)) item.reasons.push(reason);
    const net = asNumber(row.net_amount);
    if (net != null) {
      item.net += net;
      item.hasNet = true;
    }
    if (item.pctChg == null) item.pctChg = asNumber(row.pct_change ?? row.pct_chg);
    grouped.set(tradeDate, item);
  }
  const latest = [...grouped.keys()].sort().at(-1);
  if (!latest) return null;
  const item = grouped.get(latest);
  return {
    tradeDate: displayDate(latest),
    reasons: item.reasons,
    netYuan: item.hasNet ? round2(item.net) : null,
    pctChg: item.pctChg == null ? null : round2(item.pctChg),
  };
}

function summarizeBlock(rows) {
  const grouped = new Map();
  for (const row of rows ?? []) {
    const tradeDate = compactDate(row.trade_date);
    if (!tradeDate) continue;
    const item = grouped.get(tradeDate) ?? { count: 0, amount: 0, hasAmount: false, vol: 0, hasVol: false };
    item.count += 1;
    const amount = asNumber(row.amount);
    if (amount != null) {
      item.amount += amount;
      item.hasAmount = true;
    }
    const vol = asNumber(row.vol);
    if (vol != null) {
      item.vol += vol;
      item.hasVol = true;
    }
    grouped.set(tradeDate, item);
  }
  const latest = [...grouped.keys()].sort().at(-1);
  if (!latest) return null;
  const item = grouped.get(latest);
  return {
    tradeDate: displayDate(latest),
    count: item.count,
    amountWan: item.hasAmount ? round2(item.amount) : null,
    volWan: item.hasVol ? round2(item.vol) : null,
  };
}

function holderView(row) {
  return {
    endDate: displayDate(row.end_date),
    annDate: displayDate(row.ann_date),
    count: asInt(row.holder_num),
  };
}

function windowReturn(rows, sessions) {
  const bars = normalizeBars(rows);
  if (bars.length < 2) return null;
  const gap = Math.min(sessions, bars.length - 1);
  const end = bars.at(-1);
  const base = bars.at(-1 - gap);
  if (!base || !end || base.close === 0) return null;
  return {
    start: base.tradeDate,
    end: end.tradeDate,
    sessions: gap,
    value: (end.close / base.close - 1) * 100,
  };
}

function normalizeBars(rows) {
  const byDate = new Map();
  for (const row of rows ?? []) {
    const tradeDate = compactDate(row.trade_date ?? row.tradeDate);
    const close = asNumber(row.close);
    if (!tradeDate || close == null) continue;
    byDate.set(tradeDate, { tradeDate, close });
  }
  return [...byDate.values()].sort((left, right) => left.tradeDate.localeCompare(right.tradeDate));
}

function alignedClose(bars, ymd) {
  let found = null;
  for (const bar of bars) {
    if (bar.tradeDate <= ymd) found = bar;
    else break;
  }
  if (!found || found.tradeDate < shiftYmd(ymd, -7)) return null;
  return found;
}

function eventDatesFrom(rows, count) {
  return normalizeBars(rows).slice(-count).map((bar) => bar.tradeDate);
}

function recentWeekdays(endYmd, count) {
  const dates = [];
  let cursor = endYmd;
  for (let guard = 0; dates.length < count && guard < 40; guard += 1) {
    const date = new Date(Date.UTC(Number(cursor.slice(0, 4)), Number(cursor.slice(4, 6)) - 1, Number(cursor.slice(6, 8))));
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) dates.push(cursor);
    cursor = shiftYmd(cursor, -1);
  }
  return dates.reverse();
}

export async function loadFundHoldings({ token, fetchImpl, cache, tsCode, end }) {
  const start = shiftYmd(end, -800);
  return cached(cache, `funds:${tsCode}:${end}`, SLOW_TTL_MS, async () => {
    try {
      return await queryFlexible({
        token,
        fetchImpl,
        apiName: "fund_portfolio",
        params: { symbol: tsCode, start_date: start, end_date: end },
        fields: "ts_code,ann_date,end_date,symbol,mkv,stk_float_ratio",
      });
    } catch (error) {
      if (!/至少|必选|period|ann_date/i.test(String(error?.message ?? ""))) throw error;
      const rows = [];
      const seen = new Set();
      for (const period of recentQuarterEnds(end, 4)) {
        const batch = await cached(cache, `funds:${tsCode}:${period}`, SLOW_TTL_MS, () => queryFlexible({
          token,
          fetchImpl,
          apiName: "fund_portfolio",
          params: { symbol: tsCode, period },
          fields: "ts_code,ann_date,end_date,symbol,mkv,stk_float_ratio",
        }));
        rows.push(...batch);
        for (const row of batch) {
          const date = compactDate(row.end_date);
          if (date) seen.add(date);
        }
        if (seen.size >= 2) break;
      }
      return rows;
    }
  });
}

export async function loadSurveys({ token, fetchImpl, cache, tsCode, end }) {
  const start = shiftYmd(end, -370);
  return cached(cache, `surv:${tsCode}:${end}`, SLOW_TTL_MS, () => queryFlexible({
    token,
    fetchImpl,
    apiName: "stk_surv",
    params: { ts_code: tsCode, start_date: start, end_date: end },
    fields: "ts_code,surv_date,rece_org,org_type,rece_mode",
  }));
}

function fundPeriodView(end, funds) {
  let floatPct = 0;
  let hasFloat = false;
  for (const row of funds.values()) {
    const part = asNumber(row.stk_float_ratio);
    if (part == null) continue;
    floatPct += part;
    hasFloat = true;
  }
  return {
    endDate: displayDate(end),
    periodLabel: periodLabel(end),
    count: funds.size,
    floatPct: hasFloat ? round2(floatPct) : null,
  };
}

function attachSection(section, error, emptyHint) {
  if (error && !section.latest && !section.count) {
    return { ...section, hint: "", error };
  }
  if (!section.latest && !section.count && emptyHint) {
    return { ...section, hint: section.hint || emptyHint, error: "" };
  }
  return { ...section, error: section.error || "" };
}

function forStock(rows, tsCode) {
  const code = String(tsCode ?? "").toUpperCase();
  const short = code.replace(/\.(SH|SZ|BJ)$/i, "");
  return (rows ?? []).filter((row) => {
    const symbol = String(row.symbol ?? "").toUpperCase();
    return !symbol || symbol === code || symbol === short || symbol.replace(/\.(SH|SZ|BJ)$/i, "") === short;
  });
}

function recentQuarterEnds(endYmd, count) {
  const stamps = ["0331", "0630", "0930", "1231"];
  let year = Number(endYmd.slice(0, 4));
  const month = Number(endYmd.slice(4, 6));
  let index = month >= 10 ? 2 : month >= 7 ? 1 : month >= 4 ? 0 : 3;
  if (index === 3) year -= 1;
  const dates = [];
  while (dates.length < count) {
    dates.push(`${year}${stamps[index]}`);
    index -= 1;
    if (index < 0) {
      index = 3;
      year -= 1;
    }
  }
  return dates;
}

async function loadTopList({ token, fetchImpl, cache, tsCode, dates }) {
  if (dates.length === 0) return [];
  let success = 0;
  let failure = null;
  const rows = [];
  await mapPool(dates, 4, async (tradeDate) => {
    try {
      const batch = await cached(cache, `topday:${tradeDate}`, FAST_TTL_MS, () => queryFlexible({
        token,
        fetchImpl,
        apiName: "top_list",
        params: { trade_date: tradeDate },
        fields: TOP_FIELDS,
      }));
      success += 1;
      rows.push(...batch);
    } catch (error) {
      failure = error;
    }
  });
  if (success === 0 && failure) throw failure;
  return rows;
}

async function loadIndustryBars(rows, { token, fetchImpl, cache, end, historyStart }) {
  const choices = industryChoices(rows);
  if (choices.length === 0) return { industry: null, bars: [], error: "" };
  let sawSuccess = false;
  let error = "";
  for (const choice of choices) {
    try {
      const bars = await cached(cache, `index:${choice.code}:${end}`, FAST_TTL_MS, () => queryFlexible({
        token,
        fetchImpl,
        apiName: "index_daily",
        params: { ts_code: choice.code, start_date: historyStart, end_date: end },
        fields: "ts_code,trade_date,close",
      }));
      const matched = (bars ?? []).filter((row) => !row.ts_code || sameCode(row.ts_code, choice.code));
      sawSuccess = true;
      if (matched.length > 0) return { industry: choice, bars: matched, error: "" };
    } catch (err) {
      if (!error) error = publicMessage(err, token);
    }
  }
  // 成分不足 5 只的申万行业不发布指数，改用上一级。
  return { industry: choices[0], bars: [], error: sawSuccess ? "" : error };
}

async function queryFlexible({ token, fetchImpl, apiName, params, fields }) {
  try {
    return await tushareQuery({ token, apiName, params, fields, fetchImpl });
  } catch (error) {
    if (!fields || !/字段|field/i.test(String(error?.message ?? ""))) throw error;
    return tushareQuery({ token, apiName, params, fetchImpl });
  }
}

function cached(cache, key, ttl, loader) {
  return throughCache(cache, key, ttl, loader, CACHE_LIMIT);
}

async function mapPool(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(items[index], index);
    }
  }
  const workers = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

function currentMembers(rows) {
  const list = rows ?? [];
  const fresh = list.filter((row) => String(row.is_new ?? "Y").toUpperCase() !== "N");
  return fresh.length > 0 ? fresh : list;
}

function toIndexCode(code) {
  const text = cleanText(code).toUpperCase();
  if (!text) return "";
  if (/\.SI$/.test(text)) return text;
  if (/^\d{6}$/.test(text)) return `${text}.SI`;
  return "";
}

function owned(rows, tsCode) {
  return (rows ?? []).filter((row) => !row.ts_code || sameCode(row.ts_code, tsCode));
}

function within(rows, start, end) {
  return rows.filter((row) => {
    const date = compactDate(row.trade_date);
    return date && (!start || date >= start) && (!end || date <= end);
  });
}

function sameCode(left, right) {
  return String(left ?? "").toUpperCase() === String(right ?? "").toUpperCase();
}

function periodLabel(value) {
  const text = compactDate(value);
  if (!text) return "";
  const name = PERIOD_NAMES[text.slice(4)];
  return name ? `${text.slice(0, 4)}${name}` : displayDate(text);
}

function shiftYear(ymd, years) {
  if (!/^\d{8}$/.test(ymd)) return "";
  return `${Number(ymd.slice(0, 4)) + years}${ymd.slice(4)}`;
}

function compactDate(value) {
  const text = String(value ?? "").replaceAll("-", "");
  return /^\d{8}$/.test(text) ? text : "";
}

function displayDate(value) {
  const text = compactDate(value);
  return text ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : "";
}

function cleanText(value) {
  return String(value ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function clipText(value, max) {
  const text = cleanText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function clip(value, max) {
  return String(value ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, max);
}

function asNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asInt(value) {
  const number = asNumber(value);
  return number == null ? null : Math.round(number);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}
