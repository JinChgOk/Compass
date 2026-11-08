import { normalizeCode } from "./f10.mjs";

const TUSHARE_URL = "https://api.tushare.pro";
const REQUEST_TIMEOUT_MS = 15_000;
const DAILY_BARS = 60;
const NEWS_DAYS = 3;

const SOURCE_LABELS = {
  sina: "新浪财经",
  wallstreetcn: "华尔街见闻",
  "10jqka": "同花顺",
  eastmoney: "东方财富",
  yuncaijing: "云财经",
  fenghuang: "凤凰新闻",
  jinrongjie: "金融界",
  cls: "财联社",
  yicai: "第一财经",
};

const BOARD_TYPE_LABELS = {
  N: "概念",
  I: "行业",
  R: "地域",
  S: "特色",
  ST: "风格",
  TH: "主题",
  BB: "宽基",
};

const GENERIC_BOARD = /沪股通|深股通|融资融券|转融券|证金|重仓|样本|成份|成分|昨日|连板|触板|填权|破净|低价股|高价股|微盘|百元股|MSCI|富时|标普|道琼斯|标准普尔/;

export function shanghaiParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const read = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

export function shanghaiYmd(date = new Date()) {
  const parts = shanghaiParts(date);
  return `${parts.year}${parts.month}${parts.day}`;
}

export function shanghaiDateTime(date = new Date()) {
  const parts = shanghaiParts(date);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function shiftYmd(ymd, days) {
  const date = new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))));
  date.setUTCDate(date.getUTCDate() + days);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

export function toTsCode(code, securityType = "") {
  if (!/^\d{6}$/.test(code)) return null;
  if (securityType.includes("北京")) return `${code}.BJ`;
  if (securityType.includes("上交所")) return `${code}.SH`;
  if (securityType.includes("深交所")) return `${code}.SZ`;
  if (code.startsWith("92") || code.startsWith("8") || code.startsWith("4")) return `${code}.BJ`;
  if (code.startsWith("6")) return `${code}.SH`;
  return `${code}.SZ`;
}

export function limitPct(tsCode, name = "") {
  if (/^\*?ST/i.test(name)) return 4.8;
  const code = tsCode.slice(0, 6);
  if (/^(300|301|688|689)/.test(code)) return 19.5;
  if (/^(8|4|92)/.test(code)) return 29.5;
  return 9.5;
}

export function isGenericBoard(name) {
  return GENERIC_BOARD.test(name);
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function median(values) {
  const sorted = values.filter((value) => value != null).sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function formatTradeDate(ymd) {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

function normalizeBar(row) {
  const tradeDate = String(row.trade_date ?? row.tradeDate ?? "").replaceAll("-", "");
  if (!/^\d{8}$/.test(tradeDate)) return null;
  const close = asNumber(row.close);
  if (close == null) return null;
  return {
    tradeDate,
    open: asNumber(row.open) ?? close,
    high: asNumber(row.high) ?? close,
    low: asNumber(row.low) ?? close,
    close,
    pctChg: asNumber(row.pct_chg ?? row.pctChg),
    change: asNumber(row.change),
    vol: asNumber(row.vol),
    amount: asNumber(row.amount),
  };
}

export function buildKline(rows, { tsCode, name }) {
  const bars = rows
    .map(normalizeBar)
    .filter(Boolean)
    .sort((left, right) => left.tradeDate.localeCompare(right.tradeDate))
    .slice(-DAILY_BARS)
    .map((bar) => ({
      ...bar,
      tradeDate: formatTradeDate(bar.tradeDate),
    }));
  return {
    latest: bars.at(-1) ?? null,
    bars,
    important: pickImportantDays(bars, limitPct(tsCode, name)),
  };
}

export function pickImportantDays(bars, threshold) {
  if (bars.length === 0) return [];
  const amounts = bars.map((bar) => bar.amount).filter((amount) => amount != null);
  const typicalAmount = median(amounts);
  const maxHigh = Math.max(...bars.map((bar) => bar.high));
  const minLow = Math.min(...bars.map((bar) => bar.low));
  const highCount = bars.filter((bar) => bar.high === maxHigh).length;
  const lowCount = bars.filter((bar) => bar.low === minLow).length;

  const tagged = bars.map((bar) => {
    const tags = [];
    const pct = bar.pctChg;
    if (pct != null && pct >= threshold) tags.push("涨停");
    else if (pct != null && pct <= -threshold) tags.push("跌停");
    else if (pct != null && pct >= 5) tags.push("大涨");
    else if (pct != null && pct <= -5) tags.push("大跌");
    if (bar.amount != null && typicalAmount > 0 && bar.amount >= typicalAmount * 2) tags.push("放量");
    if (highCount <= 2 && bar.high === maxHigh) tags.push("阶段新高");
    if (lowCount <= 2 && bar.low === minLow) tags.push("阶段新低");
    return { ...bar, tags };
  }).filter((bar) => bar.tags.length > 0);

  const ranked = (tagged.length > 0 ? tagged : [fallbackDay(bars)]).map((bar) => ({
    ...bar,
    score: bar.tags.reduce((total, tag) => total + tagWeight(tag), 0),
  }));

  return ranked
    .sort((left, right) => right.score - left.score || right.tradeDate.localeCompare(left.tradeDate))
    .slice(0, 8)
    .sort((left, right) => right.tradeDate.localeCompare(left.tradeDate))
    .map(({ score: _score, ...bar }) => bar);
}

function fallbackDay(bars) {
  const day = bars.reduce((best, bar) => {
    if (!best) return bar;
    return Math.abs(bar.pctChg ?? 0) > Math.abs(best.pctChg ?? 0) ? bar : best;
  }, null);
  return { ...day, tags: ["波动较大"] };
}

function tagWeight(tag) {
  if (tag === "涨停" || tag === "跌停") return 5;
  if (tag === "大涨" || tag === "大跌") return 3;
  if (tag === "放量") return 2;
  return 1;
}

export function industryBoards(industry) {
  const parts = String(industry ?? "")
    .split(/[-—－/]/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && !isGenericBoard(part));
  const names = [];
  if (parts.length > 0) names.push(parts.at(-1));
  if (parts[0] && parts[0] !== names[0]) names.unshift(parts[0]);
  return names.map((name) => ({ name, code: "", type: "行业" }));
}

export function selectBoards(boards, limit = 12) {
  const seen = new Set();
  const selected = [];
  for (const board of boards) {
    const name = String(board.name ?? "").trim();
    if (name.length < 2 || isGenericBoard(name) || seen.has(name)) continue;
    if (board.type === "宽基" || board.type === "风格") continue;
    seen.add(name);
    selected.push({ name, code: board.code || "", type: board.type || "概念" });
  }
  selected.sort((left, right) => boardRank(left) - boardRank(right));
  return selected.slice(0, limit);
}

function boardRank(board) {
  if (board.type === "行业") return 0;
  if (board.type === "主题") return 1;
  if (board.type === "概念") return 2;
  return 3;
}

function stripTags(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function headlineOf(item) {
  const title = stripTags(item.title);
  if (title) return title;
  const content = stripTags(item.content);
  const sentence = content.split(/[。！？!?]/)[0] ?? "";
  return sentence.slice(0, 160);
}

export function selectSectorNews(items, boards) {
  const keywords = selectBoards(boards, 8).map((board) => board.name);
  const scored = [];
  const seen = new Set();
  for (const item of items) {
    const title = headlineOf(item);
    if (!title) continue;
    const matched = keywords.filter((keyword) => title.includes(keyword));
    if (matched.length === 0) continue;
    const key = title.replace(/\s+/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    const content = stripTags(item.content);
    let score = matched.length * 2;
    if (/政策|监管|涨停|跌停|涨价|提价|降价|业绩|重组|收购|订单|新高|减持|增持|回购|制裁|出口/.test(title)) {
      score += 2;
    }
    scored.push({
      title: title.slice(0, 80),
      time: String(item.datetime ?? item.pub_time ?? "").slice(0, 16),
      source: SOURCE_LABELS[item.src] || item.src || "",
      boards: matched.slice(0, 3),
      summary: content.startsWith(title) ? content.slice(title.length).trim().slice(0, 90) : content.slice(0, 90),
      score,
    });
  }
  return scored
    .sort((left, right) => right.score - left.score || right.time.localeCompare(left.time))
    .slice(0, 8)
    .map(({ score: _score, ...item }) => item);
}

export function readMarketQuery(searchParams) {
  const code = normalizeCode(searchParams.get("code") ?? "");
  if (!code) return null;
  return {
    code,
    name: clip(searchParams.get("name"), 30),
    securityType: clip(searchParams.get("securityType"), 40),
    industry: clip(searchParams.get("industry"), 80),
  };
}

function clip(value, max) {
  return String(value ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, max);
}

function rowsFrom(data) {
  if (!data?.fields || !Array.isArray(data.items)) return [];
  return data.items.map((item) => Object.fromEntries(data.fields.map((field, index) => [field, item[index]])));
}

export function publicMessage(error, token = "") {
  const raw = String(error?.message ?? "请求失败");
  const cleaned = (token ? raw.replaceAll(token, "") : raw)
    .replace(/[0-9a-f]{20,}/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  if (!cleaned) return "暂时无法连接 Tushare";
  if (/timeout|aborted|network|fetch|ECONN|ENOTFOUND|http \d+/i.test(cleaned)) return "暂时无法连接 Tushare";
  return cleaned;
}

async function tushareQuery({ token, apiName, params, fields, fetchImpl }) {
  const response = await fetchImpl(TUSHARE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      api_name: apiName,
      token,
      params,
      ...(fields ? { fields } : {}),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`tushare http ${response.status}`);
  const body = await response.json();
  if (Number(body.code) !== 0) {
    throw new Error(body.msg || "Tushare 请求失败");
  }
  return rowsFrom(body.data);
}

function remember(cache, key, ttlMs, value) {
  cache.set(key, { expires: Date.now() + ttlMs, value });
  return value;
}

function readCache(cache, key) {
  const hit = cache.get(key);
  if (!hit || hit.expires <= Date.now()) return null;
  return hit.value;
}

async function fetchDaily(tsCode, token, fetchImpl, now, cache) {
  const end = shanghaiYmd(now);
  const start = shiftYmd(end, -180);
  const key = `daily:${tsCode}:${end}`;
  const cached = readCache(cache, key);
  if (cached) return cached;
  const rows = await tushareQuery({
    token,
    apiName: "daily",
    params: { ts_code: tsCode, start_date: start, end_date: end },
    fields: "ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount",
    fetchImpl,
  });
  return remember(cache, key, 10 * 60 * 1000, rows);
}

async function fetchConceptBoards(tsCode, token, fetchImpl, cache) {
  const key = `concept:${tsCode}`;
  const cached = readCache(cache, key);
  if (cached) return cached;
  const rows = await tushareQuery({
    token,
    apiName: "concept_detail",
    params: { ts_code: tsCode },
    fields: "id,concept_name,ts_code,name",
    fetchImpl,
  });
  const boards = rows.map((row) => ({
    name: row.concept_name,
    code: row.id ? String(row.id) : "",
    type: "概念",
  }));
  return remember(cache, key, 6 * 60 * 60 * 1000, boards);
}

async function fetchIndexMap(token, fetchImpl, cache) {
  const key = "ths-index";
  const cached = readCache(cache, key);
  if (cached) return cached;
  const rows = await tushareQuery({
    token,
    apiName: "ths_index",
    params: { exchange: "A" },
    fields: "ts_code,name,type",
    fetchImpl,
  });
  const map = new Map(rows.map((row) => [row.ts_code, {
    name: row.name,
    type: BOARD_TYPE_LABELS[row.type] || "概念",
  }]));
  return remember(cache, key, 12 * 60 * 60 * 1000, map);
}

async function fetchThsBoards(tsCode, token, fetchImpl, cache) {
  const members = await tushareQuery({
    token,
    apiName: "ths_member",
    params: { con_code: tsCode },
    fields: "ts_code,con_code,con_name",
    fetchImpl,
  });
  const indexMap = await fetchIndexMap(token, fetchImpl, cache);
  return members.map((row) => {
    const known = indexMap.get(row.ts_code);
    return {
      name: known?.name || "",
      code: row.ts_code || "",
      type: known?.type || "概念",
    };
  }).filter((board) => board.name);
}

async function fetchNewsSource(src, token, fetchImpl, now, cache) {
  const end = shanghaiDateTime(now);
  const startYmd = shiftYmd(shanghaiYmd(now), -NEWS_DAYS);
  const start = `${startYmd.slice(0, 4)}-${startYmd.slice(4, 6)}-${startYmd.slice(6, 8)} 00:00:00`;
  const key = `news:${src}:${startYmd}`;
  const cached = readCache(cache, key);
  if (cached) return cached;
  let rows;
  try {
    rows = await tushareQuery({
      token,
      apiName: "news",
      params: { src, start_date: start, end_date: end },
      fields: "datetime,content,title",
      fetchImpl,
    });
  } catch (error) {
    if (!/字段|field/i.test(String(error?.message ?? ""))) throw error;
    rows = await tushareQuery({
      token,
      apiName: "news",
      params: { src, start_date: start, end_date: end },
      fetchImpl,
    });
  }
  const items = rows.map((row) => ({ ...row, src }));
  return remember(cache, key, 10 * 60 * 1000, items);
}

async function loadBoards(tsCode, industry, token, fetchImpl, cache) {
  const key = `boards:${tsCode}`;
  const cached = readCache(cache, key);
  if (cached) return cached;
  const resolved = await resolveBoards(tsCode, industry, token, fetchImpl, cache);
  const ttl = resolved.boards.length > 0 && !resolved.note ? 6 * 60 * 60 * 1000 : 10 * 60 * 1000;
  return remember(cache, key, ttl, resolved);
}

async function resolveBoards(tsCode, industry, token, fetchImpl, cache) {
  try {
    const concepts = selectBoards(await fetchConceptBoards(tsCode, token, fetchImpl, cache));
    if (concepts.length > 0) return { boards: concepts, note: "" };
  } catch {
    // 旧版概念接口不可用时，改查同花顺板块成分。
  }
  try {
    const thsBoards = selectBoards(await fetchThsBoards(tsCode, token, fetchImpl, cache));
    if (thsBoards.length > 0) return { boards: thsBoards, note: "" };
  } catch (error) {
    const fallback = selectBoards(industryBoards(industry));
    if (fallback.length > 0) {
      return {
        boards: fallback,
        note: `Tushare 板块成分暂时取不到（${publicMessage(error, token)}）。下面先按 F10 行业匹配资讯。`,
      };
    }
    throw error;
  }
  const fallback = selectBoards(industryBoards(industry));
  if (fallback.length > 0) {
    return { boards: fallback, note: "没有查到 Tushare 板块成分，下面先按 F10 行业匹配资讯。" };
  }
  return { boards: [], note: "" };
}

export async function loadMarketSnapshot(query, dependencies = {}) {
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
  const result = {
    configured: true,
    tsCode,
    kline: null,
    klineError: "",
    boards: [],
    boardsNote: "",
    boardsError: "",
    news: [],
    newsError: "",
  };

  const [dailyOutcome, boardOutcome] = await Promise.allSettled([
    fetchDaily(tsCode, token, fetchImpl, now, cache),
    loadBoards(tsCode, query.industry, token, fetchImpl, cache),
  ]);

  if (dailyOutcome.status === "fulfilled") {
    result.kline = buildKline(dailyOutcome.value, { tsCode, name: query.name });
  } else {
    result.klineError = `日线暂时取不到。${publicMessage(dailyOutcome.reason, token)}`;
  }

  if (boardOutcome.status === "fulfilled") {
    result.boards = boardOutcome.value.boards;
    result.boardsNote = boardOutcome.value.note;
  } else {
    result.boardsError = `关联板块暂时取不到。${publicMessage(boardOutcome.reason, token)}`;
    result.boards = selectBoards(industryBoards(query.industry));
    if (result.boards.length > 0) result.boardsNote = "下面先按 F10 行业匹配资讯。";
  }

  if (result.boards.length === 0) {
    if (!result.boardsError) result.boardsNote = result.boardsNote || "没有查到关联板块。";
    return result;
  }

  try {
    const outcomes = await Promise.allSettled(["cls", "eastmoney"].map((src) => fetchNewsSource(src, token, fetchImpl, now, cache)));
    const batches = outcomes.filter((item) => item.status === "fulfilled");
    if (batches.length === 0) throw outcomes[0].reason;
    result.news = selectSectorNews(batches.flatMap((item) => item.value), result.boards);
  } catch (error) {
    const detail = publicMessage(error, token);
    result.newsError = /权限|积分/.test(detail)
      ? `板块资讯需要在 Tushare 单独开通「新闻资讯」权限。${detail}`
      : `板块资讯暂时取不到。${detail}`;
  }

  return result;
}

const defaultCache = new Map();
