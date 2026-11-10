import { publicMessage, shanghaiYmd, shiftYmd, toTsCode, tushareQuery } from "./tushare.mjs";
import { industryChoices } from "./watchlist.mjs";

const DRAGON_SESSIONS = 60;
const RETURN_SESSIONS = 120;
const FLOW_SHORT = 20;
const FLOW_LONG = 60;
const FAST_TTL_MS = 10 * 60 * 1000;
const SLOW_TTL_MS = 6 * 60 * 60 * 1000;
const DRAGON_BUDGET_MS = 18_000;

const defaultCache = new Map();

export function buildLevels(bars, closePrice) {
  const ordered = normalizeBars(bars);
  const close = closePrice ?? ordered.at(-1)?.close ?? null;
  const ma60 = movingAverage(ordered.map((bar) => bar.close), 60);
  if (ordered.length < 8 || close == null) {
    return { support: null, resistance: null, ma60, reclaimed: false, room: null, invalidation: null };
  }
  const points = swingPoints(ordered);
  const zones = clusterPoints(points, 0.03).sort((left, right) => left.mid - right.mid);
  const support = [...zones].reverse().find((zone) => zone.mid <= close * 1.01) ?? null;
  const resistance = zones.find((zone) => zone.mid > close * 1.005 && zone !== support) ?? null;
  const lastHigh = points.filter((point) => point.kind === "high").sort((left, right) => left.date.localeCompare(right.date)).at(-1);
  const reclaimed = Boolean(lastHigh && ma60 != null && close > lastHigh.price && close >= ma60);
  const bandRoom = resistance ? (resistance.low / close - 1) * 100 : null;
  const maRoom = ma60 != null && ma60 > close ? (ma60 / close - 1) * 100 : null;
  const room = [bandRoom, maRoom].filter((value) => value != null && value > 0).sort((left, right) => left - right)[0] ?? null;
  const low3y = Math.min(...ordered.slice(-156).map((bar) => bar.low));
  return {
    support,
    resistance,
    ma60,
    reclaimed,
    room,
    nearerMa: maRoom != null && (bandRoom == null || maRoom <= bandRoom),
    invalidation: support ? support.low : low3y,
  };
}

export function buildValuation(rows) {
  const ordered = [...(rows ?? [])].map(normalizeBasic).filter((row) => row.date).sort((left, right) => left.date.localeCompare(right.date));
  const latest = ordered.at(-1) ?? null;
  if (!latest) return null;
  return {
    peTtm: latest.peTtm,
    pb: latest.pb,
    psTtm: latest.psTtm,
    dvTtm: latest.dvTtm,
    totalMv: latest.totalMv,
    circMv: latest.circMv,
    pePercentile: percentile(latest.peTtm, ordered.map((row) => row.peTtm)),
    pbPercentile: percentile(latest.pb, ordered.map((row) => row.pb)),
  };
}

export function buildCapitalSpan(moneyRows, marginRows) {
  const flow = summarizeFlow(moneyRows);
  const margin = summarizeMargin(marginRows);
  return {
    flow20: flow.short,
    flow60: flow.long,
    margin: margin.direction,
    marginSessions: margin.sessions,
  };
}

export function buildDragon(rows, sessions) {
  const grouped = new Map();
  for (const row of rows ?? []) {
    const date = compactDate(row.trade_date);
    if (!date) continue;
    const item = grouped.get(date) ?? { reasons: [], net: 0, hasNet: false };
    const reason = clean(row.reason);
    if (reason && !item.reasons.includes(reason)) item.reasons.push(reason);
    const net = asNumber(row.net_amount);
    if (net != null) {
      item.net += net;
      item.hasNet = true;
    }
    grouped.set(date, item);
  }
  const dates = [...grouped.keys()].sort();
  const net = dates.reduce((sum, date) => sum + (grouped.get(date).hasNet ? grouped.get(date).net : 0), 0);
  const reasons = [...new Set(dates.flatMap((date) => grouped.get(date).reasons))].slice(0, 3);
  return { count: dates.length, net, reasons, sessions: sessions ?? DRAGON_SESSIONS };
}

export function buildSeats(rows) {
  let institution = 0;
  let hot = 0;
  let hasInstitution = false;
  let hasHot = false;
  for (const row of rows ?? []) {
    const net = asNumber(row.net_buy ?? row.net_amount);
    if (net == null) continue;
    if (isInstitution(row.exalter)) {
      institution += net;
      hasInstitution = true;
    } else {
      hot += net;
      hasHot = true;
    }
  }
  return {
    institution: hasInstitution ? institution : null,
    hot: hasHot ? hot : null,
  };
}

export function buildUnlock(rows, today) {
  const start = compactDate(today);
  const end = shiftYmd(start, 180);
  let ratio = 0;
  let count = 0;
  for (const row of rows ?? []) {
    const date = compactDate(row.float_date);
    const part = asNumber(row.float_ratio);
    if (!date || date < start || date > end || part == null) continue;
    ratio += part;
    count += 1;
  }
  return { ratio, count };
}

export function assembleMidterm(input) {
  const price = input.price ?? {};
  const valuation = input.valuation ?? null;
  const levels = input.levels ?? {};
  const relative = input.relative ?? {};
  const earnings = input.earnings ?? { positive: false, negative: false, summary: "" };
  const capital = input.capital ?? {};
  const dragon = input.dragon ?? { count: 0, net: 0, reasons: [], sessions: DRAGON_SESSIONS };
  const seats = input.seats ?? {};
  const unlock = input.unlock ?? { ratio: 0, count: 0 };
  const style = input.valueStyle === "pb" ? "pb" : "pe";
  const priceLow = isPriceLow(price);
  const valueLow = isValueLow(valuation, style);
  const grade = priceLow && valueLow && earnings.positive ? "高" : priceLow && earnings.negative ? "低" : "中";
  const path = earnings.positive && levels.reclaimed ? "反转" : (earnings.positive || earnings.negative || priceLow) ? "反弹" : "观察";
  const bottomCount = [priceLow, valueLow, relative.excess != null && relative.excess < 0].filter(Boolean).length;
  const bottomWord = bottomCount >= 3 ? "可以看作底部" : bottomCount === 2 ? "接近底部" : "还不是底部";

  return {
    bottom: joinParts([
      price.drawdown == null ? "" : `距3年高点 ${signed(price.drawdown)}%，距低点 ${signed(price.rebound)}%`,
      valuationLine(valuation, style),
      relative.excess == null ? "" : `近120日${relative.excess < 0 ? "弱于" : "强于"}${relative.name || "行业"} ${signed(relative.excess)}%`,
      bottomWord,
    ]),
    stance: `${grade}。${pathLabel(path, earnings, levels)}`,
    value: valueSentence(valuation, relative, earnings, style),
    levels: levelsSentence(levels, price.close),
    invalidation: levels.invalidation == null ? "" : `周线收盘跌破 ${priceText(levels.invalidation)}，底部判断结束。`,
    capital: capitalSentence(capital, dragon, seats, input.discount, input.seatNote),
    counter: counterSentence(unlock, earnings, input.target),
    facts: {
      grade,
      path,
      priceLow,
      valueLow,
      bottomCount,
      drawdown: price.drawdown ?? null,
      rebound: price.rebound ?? null,
      pePercentile: valuation?.pePercentile ?? null,
      pbPercentile: valuation?.pbPercentile ?? null,
      room: levels.room ?? null,
      invalidation: levels.invalidation ?? null,
      dragonCount: dragon.count,
      unlockRatio: unlock.ratio,
    },
  };
}

export async function loadAnalysis(query, dependencies = {}) {
  const token = String(dependencies.token ?? process.env.TUSHARE_TOKEN ?? "").trim();
  if (!token) {
    return {
      configured: false,
      message: "未配置 Tushare Token。在项目根目录创建 .env，写入 TUSHARE_TOKEN 后重启服务。",
    };
  }
  const tsCode = toTsCode(query.code, query.securityType);
  if (!tsCode) return { configured: false, message: "请提供 6 位 A 股代码。" };

  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const now = dependencies.now ?? new Date();
  const cache = dependencies.cache ?? defaultCache;
  const end = shanghaiYmd(now);
  const context = { token, fetchImpl, cache, end };
  const failed = {};
  const fetched = {};

  async function take(key, loader) {
    try {
      fetched[key] = await loader();
    } catch (error) {
      fetched[key] = [];
      failed[key] = publicMessage(error, token);
    }
  }

  await Promise.all([
    take("weekly", () => cachedQuery(context, `weekly:${tsCode}:${end}`, SLOW_TTL_MS, "weekly", { ts_code: tsCode, start_date: shiftYmd(end, -1500), end_date: end }, "ts_code,trade_date,open,high,low,close,amount")),
    take("daily", () => cachedQuery(context, `ana-daily:${tsCode}:${end}`, FAST_TTL_MS, "daily", { ts_code: tsCode, start_date: shiftYmd(end, -420), end_date: end }, "ts_code,trade_date,close")),
    take("basic", () => cachedQuery(context, `basic:${tsCode}:${end}`, FAST_TTL_MS, "daily_basic", { ts_code: tsCode, start_date: shiftYmd(end, -1200), end_date: end }, "ts_code,trade_date,close,pe_ttm,pb,ps_ttm,dv_ttm,total_mv,circ_mv")),
    take("forecast", () => cachedQuery(context, `ana-forecast:${tsCode}`, SLOW_TTL_MS, "forecast", { ts_code: tsCode, start_date: shiftYmd(end, -800), end_date: end }, "ts_code,ann_date,end_date,type,p_change_min,p_change_max")),
    take("express", () => cachedQuery(context, `ana-express:${tsCode}`, SLOW_TTL_MS, "express", { ts_code: tsCode, start_date: shiftYmd(end, -800), end_date: end }, "ts_code,ann_date,end_date,yoy_sales,yoy_dedu_np,yoy_roe")),
    take("fina", () => cachedQuery(context, `ana-fina:${tsCode}`, SLOW_TTL_MS, "fina_indicator", { ts_code: tsCode, start_date: shiftYmd(end, -800), end_date: end }, "ts_code,ann_date,end_date,netprofit_yoy,or_yoy,roe_waa,update_flag")),
    take("money", () => cachedQuery(context, `ana-flow:${tsCode}:${end}`, FAST_TTL_MS, "moneyflow", { ts_code: tsCode, start_date: shiftYmd(end, -140), end_date: end }, "ts_code,trade_date,buy_lg_amount,sell_lg_amount,buy_elg_amount,sell_elg_amount")),
    take("margin", () => cachedQuery(context, `ana-margin:${tsCode}:${end}`, FAST_TTL_MS, "margin_detail", { ts_code: tsCode, start_date: shiftYmd(end, -140), end_date: end }, "ts_code,trade_date,rzye")),
    take("holders", () => cachedQuery(context, `ana-holders:${tsCode}`, SLOW_TTL_MS, "stk_holdernumber", { ts_code: tsCode, start_date: shiftYmd(end, -500), end_date: end }, "ts_code,ann_date,end_date,holder_num")),
    take("member", () => cachedQuery(context, `ana-member:${tsCode}`, SLOW_TTL_MS, "index_member_all", { ts_code: tsCode, is_new: "Y" }, "l1_code,l1_name,l2_code,l2_name,l3_code,l3_name,ts_code,name,is_new")),
    take("unlock", () => cachedQuery(context, `float:${tsCode}:${end}`, SLOW_TTL_MS, "share_float", { ts_code: tsCode, start_date: end, end_date: shiftYmd(end, 180) }, "ts_code,float_date,float_share,float_ratio")),
    take("block", () => cachedQuery(context, `ana-block:${tsCode}:${end}`, FAST_TTL_MS, "block_trade", { ts_code: tsCode, start_date: shiftYmd(end, -120), end_date: end }, "ts_code,trade_date,price,vol,amount")),
  ]);

  const weekly = owned(fetched.weekly, tsCode);
  const daily = owned(fetched.daily, tsCode);
  const basic = owned(fetched.basic, tsCode);
  const price = priceView(weekly);
  const levels = buildLevels(weekly, price?.close);
  const valuation = buildValuation(basic);
  const industry = industryChoices(owned(fetched.member, tsCode))[0] ?? null;
  const tradeDates = barDates(daily).slice(-DRAGON_SESSIONS);
  const latestDate = tradeDates.at(-1) || end;

  await Promise.all([
    take("index", () => industry?.code
      ? cachedQuery(context, `ana-index:${industry.code}:${end}`, FAST_TTL_MS, "index_daily", { ts_code: industry.code, start_date: shiftYmd(end, -420), end_date: end }, "ts_code,trade_date,close")
      : []),
    take("market", () => cachedQuery(context, `market-basic:${latestDate}`, FAST_TTL_MS, "daily_basic", { trade_date: latestDate }, "ts_code,pe_ttm,pb")),
    take("peers", () => industry?.code
      ? cachedQuery(context, `peers:${industry.code}`, SLOW_TTL_MS, "index_member_all", industry.level === "一级" ? { l1_code: industry.code, is_new: "Y" } : { l2_code: industry.code, is_new: "Y" }, "ts_code,is_new")
      : []),
    loadDragons(context, tradeDates, failed).then((rows) => { fetched.dragons = rows; }),
    loadReports(context, failed).then((rows) => { fetched.reports = rows; }),
  ]);

  const relative = relativeView(daily, fetched.index, industry, fetched.market, fetched.peers, tsCode, valuation);
  const earnings = earningsView(owned(fetched.forecast, tsCode), owned(fetched.express, tsCode), owned(fetched.fina, tsCode));
  const dragonRows = (fetched.dragons ?? []).filter((row) => sameCode(row.ts_code, tsCode));
  const dragon = buildDragon(dragonRows, tradeDates.length || DRAGON_SESSIONS);
  let seats = { institution: null, hot: null };
  let seatNote = failed.dragons || "";
  if (dragon.count > 0) {
    const hitDates = [...new Set(dragonRows.map((row) => compactDate(row.trade_date)).filter(Boolean))].sort().slice(-8);
    try {
      const seatRows = await loadSeats(context, hitDates);
      seats = buildSeats(seatRows.filter((row) => sameCode(row.ts_code, tsCode)));
    } catch (error) {
      seatNote = publicMessage(error, token);
    }
  }
  const reports = (fetched.reports ?? []).filter((row) => sameCode(row.ts_code, tsCode));
  const target = targetView(reports, price?.close);
  const result = assembleMidterm({
    price,
    valuation,
    levels,
    relative,
    earnings,
    capital: {
      ...buildCapitalSpan(owned(fetched.money, tsCode), owned(fetched.margin, tsCode)),
      holders: holderDirection(owned(fetched.holders, tsCode)),
    },
    dragon,
    seats,
    unlock: buildUnlock(owned(fetched.unlock, tsCode), end),
    discount: blockDiscount(owned(fetched.block, tsCode), daily),
    target,
    valueStyle: /银行|证券|保险|房地产/.test(industry?.name ?? "") ? "pb" : "pe",
    seatNote,
  });
  if (failed.weekly && !price) result.bottom = failed.weekly;
  if (failed.reports) result.counter = joinParts([result.counter, "卖方预测暂时取不到"]);
  result.configured = true;
  result.error = "";
  return result;
}

function priceView(rows) {
  const ordered = normalizeBars(rows);
  const window = ordered.slice(-156);
  const close = ordered.at(-1)?.close ?? null;
  if (!window.length || close == null) return null;
  const high = Math.max(...window.map((bar) => bar.high));
  const low = Math.min(...window.map((bar) => bar.low));
  const ma60 = movingAverage(ordered.map((bar) => bar.close), 60);
  return {
    close,
    drawdown: (close / high - 1) * 100,
    rebound: (close / low - 1) * 100,
    ma60,
    aboveMa60: ma60 != null && close >= ma60,
  };
}

function relativeView(daily, indexRows, industry, marketRows, peerRows, tsCode, valuation) {
  const stock = windowReturn(daily, RETURN_SESSIONS);
  const industryReturn = stock ? alignedReturn(indexRows, stock.start, stock.end) : null;
  const peerCodes = new Set((peerRows ?? []).map((row) => String(row.ts_code ?? "").toUpperCase()).filter(Boolean));
  if (industry?.code) peerCodes.add(tsCode.toUpperCase());
  const peers = (marketRows ?? []).filter((row) => peerCodes.has(String(row.ts_code ?? "").toUpperCase()));
  return {
    name: industry?.name || "",
    excess: stock && industryReturn != null ? stock.value - industryReturn : null,
    industryPe: median(peers.map((row) => asNumber(row.pe_ttm))),
    industryPb: median(peers.map((row) => asNumber(row.pb))),
    stockPe: valuation?.peTtm ?? null,
    stockPb: valuation?.pb ?? null,
  };
}

function earningsView(forecasts, expresses, indicators) {
  const quarters = dedupeReports(indicators).filter((row) => /0331|0630|0930|1231$/.test(compactDate(row.end_date)));
  const latest = quarters[0] ?? null;
  const previous = quarters[1] ?? null;
  const latestYoy = asNumber(latest?.netprofit_yoy);
  const previousYoy = asNumber(previous?.netprofit_yoy);
  const forecast = dedupeReports(forecasts)[0] ?? null;
  const express = dedupeReports(expresses)[0] ?? null;
  const forecastType = clean(forecast?.type);
  const forecastNewer = forecast && (!latest || compactDate(forecast.end_date) >= compactDate(latest.end_date));
  const positiveType = /预增|扭亏|略增/.test(forecastType);
  const negativeType = /首亏|续亏|预减/.test(forecastType);
  const expressYoy = asNumber(express?.yoy_dedu_np);
  const positive = (forecastNewer && positiveType) || (latestYoy != null && latestYoy > 0 && (previousYoy == null || latestYoy >= previousYoy)) || (expressYoy != null && expressYoy > 0);
  const negative = (forecastNewer && negativeType) || (latestYoy != null && previousYoy != null && latestYoy < 0 && latestYoy < previousYoy);
  const summary = forecastNewer && forecastType ? `最新预告${forecastType}` : latestYoy == null ? "" : `最新净利同比 ${signed(latestYoy)}%`;
  return {
    positive: Boolean(positive && !negativeType),
    negative: Boolean(negative && !positiveType),
    summary,
    growth: latestYoy != null && latestYoy > 0 ? latestYoy : null,
  };
}

function holderDirection(rows) {
  const ordered = dedupeReports(rows).filter((row) => asNumber(row.holder_num) != null);
  if (ordered.length < 2) return "";
  const change = Number(ordered[0].holder_num) - Number(ordered[1].holder_num);
  if (change < 0) return "股东户数下降";
  if (change > 0) return "股东户数上升";
  return "股东户数持平";
}

function targetView(rows, close) {
  const ordered = [...(rows ?? [])].filter((row) => compactDate(row.report_date)).sort((left, right) => compactDate(right.report_date).localeCompare(compactDate(left.report_date)));
  const latestDate = ordered[0] ? compactDate(ordered[0].report_date) : "";
  const sameDay = ordered.filter((row) => compactDate(row.report_date) === latestDate);
  const prices = sameDay.flatMap((row) => [asNumber(row.max_price), asNumber(row.min_price)]).filter((value) => value != null && value > 0);
  if (!prices.length || close == null) return null;
  const price = prices.reduce((sum, value) => sum + value, 0) / prices.length;
  return { price, room: (price / close - 1) * 100 };
}

function blockDiscount(rows, daily) {
  const closes = new Map(normalizeBars(daily).map((bar) => [bar.tradeDate, bar.close]));
  let count = 0;
  for (const row of rows ?? []) {
    const close = closes.get(compactDate(row.trade_date));
    const price = asNumber(row.price);
    if (close == null || price == null) continue;
    if (price < close * 0.97) count += 1;
  }
  return count >= 2;
}

async function loadDragons(context, dates, failed) {
  const rows = [];
  let error = "";
  const deadline = Date.now() + DRAGON_BUDGET_MS;
  await mapPool([...dates].reverse(), 4, async (tradeDate) => {
    if (Date.now() > deadline) return;
    try {
      const batch = await cachedQuery(context, `topday:${tradeDate}`, FAST_TTL_MS, "top_list", { trade_date: tradeDate }, "trade_date,ts_code,net_amount,reason");
      rows.push(...batch);
    } catch (err) {
      error = publicMessage(err, context.token);
    }
  });
  if (error && rows.length === 0) failed.dragons = error;
  return rows;
}

async function loadSeats(context, dates) {
  const rows = [];
  for (const tradeDate of dates) {
    const batch = await cachedQuery(context, `topinst:${tradeDate}`, FAST_TTL_MS, "top_inst", { trade_date: tradeDate }, "trade_date,ts_code,exalter,buy,sell,net_buy,side");
    rows.push(...batch);
  }
  return rows;
}

async function loadReports(context, failed) {
  const rows = [];
  const dates = recentWeekdays(context.end, 5);
  for (const reportDate of dates) {
    try {
      const batch = await cachedQuery(context, `report:${reportDate}`, SLOW_TTL_MS, "report_rc", { report_date: reportDate }, "ts_code,report_date,np,eps,pe,rating,max_price,min_price");
      rows.push(...batch);
    } catch (error) {
      failed.reports = publicMessage(error, context.token);
      break;
    }
  }
  return rows;
}

async function cachedQuery(context, key, ttl, apiName, params, fields) {
  const hit = context.cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  let value;
  try {
    value = await tushareQuery({ token: context.token, fetchImpl: context.fetchImpl, apiName, params, fields });
  } catch (error) {
    if (!fields || !/字段|field/i.test(String(error?.message ?? ""))) throw error;
    value = await tushareQuery({ token: context.token, fetchImpl: context.fetchImpl, apiName, params });
  }
  context.cache.set(key, { expires: Date.now() + ttl, value });
  return value;
}

function swingPoints(bars) {
  const points = [];
  for (let index = 2; index < bars.length - 2; index += 1) {
    const window = bars.slice(index - 2, index + 3);
    if (bars[index].low <= Math.min(...window.map((bar) => bar.low))) {
      points.push({ price: bars[index].low, date: bars[index].tradeDate, kind: "low" });
    }
    if (bars[index].high >= Math.max(...window.map((bar) => bar.high))) {
      points.push({ price: bars[index].high, date: bars[index].tradeDate, kind: "high" });
    }
  }
  return points;
}

function clusterPoints(points, tolerance) {
  const sorted = [...points].sort((left, right) => left.price - right.price);
  const groups = [];
  for (const point of sorted) {
    const last = groups.at(-1);
    const average = last ? last.reduce((sum, item) => sum + item.price, 0) / last.length : 0;
    if (last && Math.abs(point.price - average) / average <= tolerance) last.push(point);
    else groups.push([point]);
  }
  return groups.map((group) => {
    const prices = group.map((point) => point.price);
    const kinds = new Set(group.map((point) => point.kind));
    return {
      low: Math.min(...prices),
      high: Math.max(...prices),
      mid: prices.reduce((sum, price) => sum + price, 0) / prices.length,
      touches: group.length,
      fromLow: kinds.has("low"),
      fromHigh: kinds.has("high"),
    };
  });
}

function summarizeFlow(rows) {
  const byDate = new Map();
  for (const row of rows ?? []) {
    const date = compactDate(row.trade_date);
    const parts = [row.buy_lg_amount, row.sell_lg_amount, row.buy_elg_amount, row.sell_elg_amount].map(asNumber);
    if (!date || parts.every((value) => value == null)) continue;
    const [buyLarge, sellLarge, buyExtra, sellExtra] = parts.map((value) => value ?? 0);
    byDate.set(date, buyLarge + buyExtra - sellLarge - sellExtra);
  }
  const ordered = [...byDate.entries()].sort((left, right) => left[0].localeCompare(right[0]));
  const sum = (count) => ordered.slice(-count).reduce((total, item) => total + item[1], 0);
  return {
    short: ordered.length ? sum(Math.min(FLOW_SHORT, ordered.length)) : null,
    long: ordered.length ? sum(Math.min(FLOW_LONG, ordered.length)) : null,
  };
}

function summarizeMargin(rows) {
  const ordered = [...(rows ?? [])]
    .map((row) => ({ date: compactDate(row.trade_date), value: asNumber(row.rzye) }))
    .filter((row) => row.date && row.value != null)
    .sort((left, right) => left.date.localeCompare(right.date));
  if (ordered.length < 2) return { direction: "", sessions: 0 };
  const latest = ordered.at(-1).value;
  const previous = ordered[Math.max(0, ordered.length - 1 - FLOW_SHORT)].value;
  const delta = latest - previous;
  return { direction: delta > 0 ? "回升" : delta < 0 ? "下降" : "持平", sessions: Math.min(FLOW_SHORT, ordered.length - 1) };
}

function windowReturn(rows, sessions) {
  const ordered = normalizeBars(rows);
  if (ordered.length < 2) return null;
  const gap = Math.min(sessions, ordered.length - 1);
  const end = ordered.at(-1);
  const start = ordered.at(-1 - gap);
  if (!start || start.close === 0) return null;
  return { start: start.tradeDate, end: end.tradeDate, value: (end.close / start.close - 1) * 100 };
}

function alignedReturn(rows, start, end) {
  const ordered = normalizeBars(rows);
  const startBar = ordered.filter((bar) => bar.tradeDate <= start).at(-1);
  const endBar = ordered.filter((bar) => bar.tradeDate <= end).at(-1);
  if (!startBar || !endBar || startBar.tradeDate === endBar.tradeDate || startBar.close === 0) return null;
  return (endBar.close / startBar.close - 1) * 100;
}

function isPriceLow(price) {
  if (!price || price.drawdown == null || price.rebound == null) return false;
  return price.drawdown <= -25 && price.rebound <= 15;
}

function isValueLow(valuation, style) {
  if (!valuation) return false;
  const pct = style === "pb" ? valuation.pbPercentile : (valuation.pePercentile ?? valuation.pbPercentile);
  return pct != null && pct <= 20;
}

function valuationLine(valuation, style) {
  if (!valuation) return "";
  if (style === "pb" || valuation.peTtm == null) {
    return valuation.pbPercentile == null ? "" : `市净率 ${number(valuation.pb)}，处于近3年 ${valuation.pbPercentile}% 分位`;
  }
  return `市盈率 ${number(valuation.peTtm)}，处于近3年 ${valuation.pePercentile}% 分位`;
}

function valueSentence(valuation, relative, earnings, style) {
  if (!valuation) return "估值暂时取不到。";
  const mv = valuation.totalMv == null ? "" : `总市值 ${yi(valuation.totalMv)} 亿`;
  const self = style === "pb" || valuation.peTtm == null
    ? `市净率 ${number(valuation.pb)}，自身分位 ${pctText(valuation.pbPercentile)}`
    : `市盈率 ${number(valuation.peTtm)}，自身分位 ${pctText(valuation.pePercentile)}`;
  const peer = style === "pb"
    ? (relative.industryPb == null ? "" : `同行中位数 ${number(relative.industryPb)}`)
    : (relative.industryPe == null ? "" : `同行中位数 ${number(relative.industryPe)}`);
  const growth = earnings.positive ? "增速为正" : "";
  const peg = valuation.peTtm != null && earnings.growth > 0 ? `市盈率相对增速 ${number(valuation.peTtm / earnings.growth)}` : "";
  const dv = valuation.dvTtm == null ? "" : `股息率 ${number(valuation.dvTtm)}%`;
  const cheap = isValueLow(valuation, style);
  const label = cheap && (valuation.dvTtm != null && valuation.dvTtm >= 3 || (valuation.peTtm != null && earnings.growth > 0 && valuation.peTtm / earnings.growth < 1))
    ? "性价比高"
    : (style === "pb" ? valuation.pbPercentile : valuation.pePercentile) >= 60
      ? "性价比低"
      : "性价比中等";
  return joinParts([mv, self, peer, peg, growth, dv, label]);
}

function levelsSentence(levels, close) {
  if (!levels?.support && !levels?.resistance && levels?.ma60 == null) return "周线还不够，画不出支撑和压力。";
  const support = zoneText("支撑", levels.support, levels.support?.fromHigh && !levels.support?.fromLow);
  const resistance = zoneText(levels.resistance?.fromLow && !levels.resistance?.fromHigh ? "前支撑转压力" : "压力", levels.resistance, false);
  const room = levels.room == null ? "" : `距最近压力 ${signed(levels.room)}%`;
  const ma = levels.ma60 == null ? "" : `60周均线 ${priceText(levels.ma60)}${levels.nearerMa ? "，是更近的压力" : ""}`;
  const now = close == null ? "" : `现价 ${priceText(close)}`;
  return joinParts([now, support, resistance, room, ma]);
}

function zoneText(label, zone, brokenHigh) {
  if (!zone) return "";
  const name = brokenHigh ? "前压力转支撑" : label;
  const span = Math.abs(zone.high - zone.low) < zone.low * 0.005 ? priceText(zone.low) : `${priceText(zone.low)}–${priceText(zone.high)}`;
  return `${name} ${span}（${zone.touches} 次）`;
}

function pathLabel(path, earnings, levels) {
  if (path === "反转") return `按反转观察。${earnings.summary}。周线已站回前高和60周均线。`;
  if (earnings.positive) return `按反弹观察，业绩已拐头。${earnings.summary}。周线还没站回前高。`;
  if (earnings.negative) return `按超跌反弹观察。${earnings.summary}。`;
  if (levels.reclaimed) return "周线已站回前高，业绩拐点还不清楚。";
  return "业绩拐点还不清楚。";
}

function capitalSentence(capital, dragon, seats, discount, seatNote) {
  const flow20 = capital.flow20 == null ? "" : `近20日主力${capital.flow20 >= 0 ? "净流入" : "净流出"} ${wan(Math.abs(capital.flow20))}`;
  const flow60 = capital.flow60 == null ? "" : `近60日主力${capital.flow60 >= 0 ? "净流入" : "净流出"} ${wan(Math.abs(capital.flow60))}`;
  const margin = capital.margin ? `融资余额${capital.margin}` : "";
  const holders = capital.holders || "";
  const board = dragon.count === 0
    ? `近${dragon.sessions}个交易日未上龙虎榜`
    : `近${dragon.sessions}个交易日龙虎榜 ${dragon.count} 次，合计净买入 ${wan(dragon.net / 10000)}${dragon.reasons.length ? `，${dragon.reasons.join("、")}` : ""}`;
  const attention = dragon.count >= 2 && dragon.net > 0 ? "低位有持续净买" : dragon.count === 1 ? "只上榜一天" : "";
  const seat = seats.institution == null ? "" : `机构席位净买入 ${wan(seats.institution / 10000)}`;
  const hot = seats.hot == null ? "" : `其余席位净买入 ${wan(seats.hot / 10000)}`;
  const block = discount ? "大宗有连续折价" : "";
  return joinParts([flow20, flow60, margin, holders, board, attention, seat, hot, block, seatNote]);
}

function counterSentence(unlock, earnings, target) {
  const supply = unlock.count ? `未来两季解禁合计 ${number(unlock.ratio)}%` : "未来两季没有解禁";
  const heavy = unlock.ratio >= 5 ? "解禁比例不低" : "";
  const forecast = earnings.negative ? earnings.summary : "";
  const seller = target ? `卖方目标价中位数 ${priceText(target.price)}，空间 ${signed(target.room)}%` : "";
  return joinParts([supply, heavy, forecast, seller]);
}

function normalizeBars(rows) {
  const byDate = new Map();
  for (const row of rows ?? []) {
    const tradeDate = compactDate(row.trade_date ?? row.tradeDate);
    const close = asNumber(row.close);
    if (!tradeDate || close == null) continue;
    byDate.set(tradeDate, {
      tradeDate,
      open: asNumber(row.open) ?? close,
      high: asNumber(row.high) ?? close,
      low: asNumber(row.low) ?? close,
      close,
      amount: asNumber(row.amount),
    });
  }
  return [...byDate.values()].sort((left, right) => left.tradeDate.localeCompare(right.tradeDate));
}

function normalizeBasic(row) {
  return {
    date: compactDate(row.trade_date),
    peTtm: positive(row.pe_ttm),
    pb: positive(row.pb),
    psTtm: positive(row.ps_ttm),
    dvTtm: asNumber(row.dv_ttm),
    totalMv: asNumber(row.total_mv),
    circMv: asNumber(row.circ_mv),
  };
}

function dedupeReports(rows) {
  const byEnd = new Map();
  for (const row of rows ?? []) {
    const end = compactDate(row.end_date);
    if (!end) continue;
    const previous = byEnd.get(end);
    const rank = (String(row.update_flag ?? "") === "1" ? 1e12 : 0) + Number(compactDate(row.ann_date) || 0);
    const previousRank = previous ? (String(previous.update_flag ?? "") === "1" ? 1e12 : 0) + Number(compactDate(previous.ann_date) || 0) : -1;
    if (!previous || rank >= previousRank) byEnd.set(end, row);
  }
  return [...byEnd.values()].sort((left, right) => compactDate(right.end_date).localeCompare(compactDate(left.end_date)));
}

function barDates(rows) {
  return normalizeBars(rows).map((bar) => bar.tradeDate);
}

function movingAverage(values, size) {
  if (values.length < size) return null;
  const slice = values.slice(-size);
  return slice.reduce((sum, value) => sum + value, 0) / size;
}

function percentile(value, samples) {
  const valid = samples.filter((item) => item != null && item > 0);
  if (value == null || value <= 0 || valid.length < 20) return null;
  const below = valid.filter((item) => item < value).length;
  return Math.round((below / valid.length) * 100);
}

function median(values) {
  const sorted = values.filter((value) => value != null && value > 0).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function positive(value) {
  const number = asNumber(value);
  return number != null && number > 0 ? number : null;
}

function owned(rows, tsCode) {
  return (rows ?? []).filter((row) => !row.ts_code || sameCode(row.ts_code, tsCode));
}

function sameCode(left, right) {
  return String(left ?? "").toUpperCase() === String(right ?? "").toUpperCase();
}

function isInstitution(name) {
  return /机构/.test(String(name ?? ""));
}

function recentWeekdays(endYmd, count) {
  const dates = [];
  let cursor = endYmd;
  for (let guard = 0; dates.length < count && guard < 20; guard += 1) {
    const date = new Date(Date.UTC(Number(cursor.slice(0, 4)), Number(cursor.slice(4, 6)) - 1, Number(cursor.slice(6, 8))));
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) dates.push(cursor);
    cursor = shiftYmd(cursor, -1);
  }
  return dates;
}

async function mapPool(items, limit, task) {
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await task(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

function joinParts(parts) {
  return parts.map((part) => String(part ?? "").trim()).filter(Boolean).join("。").replace(/。+/g, "。").replace(/。$/, "") + (parts.some((part) => String(part ?? "").trim()) ? "。" : "");
}

function signed(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  const number = Number(value);
  return `${number > 0 ? "+" : ""}${number.toFixed(1)}`;
}

function number(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return Number(value).toFixed(1);
}

function pctText(value) {
  return value == null ? "—" : `${value}%`;
}

function priceText(value) {
  return Number(value).toFixed(2);
}

function yi(wan) {
  return (Number(wan) / 10000).toFixed(Number(wan) >= 1000000 ? 0 : 1);
}

function wan(value) {
  const number = Number(value);
  const abs = Math.abs(number);
  if (abs >= 10000) return `${(number / 10000).toFixed(2)} 亿元`;
  return `${number.toFixed(0)} 万元`;
}

function compactDate(value) {
  const text = String(value ?? "").replaceAll("-", "");
  return /^\d{8}$/.test(text) ? text : "";
}

function asNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
