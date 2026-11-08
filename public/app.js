const form = document.querySelector("#search-form");
const input = document.querySelector("#q");
const submitButton = form.querySelector("button[type='submit']");
const statusNode = document.querySelector("#status");
const resultNode = document.querySelector("#result");
const companyNode = document.querySelector("#company");
const choicesNode = document.querySelector("#choices");
const choiceList = document.querySelector("#choice-list");
const marketNode = document.querySelector("#market");
const marketStatus = document.querySelector("#market-status");
const marketBody = document.querySelector("#market-body");
const klineError = document.querySelector("#kline-error");
const quoteNode = document.querySelector("#quote");
const klineNode = document.querySelector("#kline");
const klineRange = document.querySelector("#kline-range");
const allBars = document.querySelector("#all-bars");
const barsTable = document.querySelector("#bars-table");
const importantDays = document.querySelector("#important-days");
const boardsError = document.querySelector("#boards-error");
const boardsNote = document.querySelector("#boards-note");
const boardsNode = document.querySelector("#boards");
const newsError = document.querySelector("#news-error");
const newsNode = document.querySelector("#sector-news");

let marketRequest = 0;

const fields = {
  securityType: document.querySelector("#security-type"),
  title: document.querySelector("#company-name"),
  subtitle: document.querySelector("#company-full"),
  code: document.querySelector("#field-code"),
  name: document.querySelector("#field-name"),
  fullName: document.querySelector("#field-full-name"),
  industry: document.querySelector("#field-industry"),
  listingDate: document.querySelector("#field-listing-date"),
  address: document.querySelector("#field-address"),
  legalPerson: document.querySelector("#field-legal-person"),
  website: document.querySelector("#field-website"),
  contact: document.querySelector("#field-contact"),
  business: document.querySelector("#field-business"),
  profile: document.querySelector("#field-profile"),
};

function textOrEmpty(value) {
  return value ? value : "暂无";
}

function safeHttpUrl(raw) {
  try {
    const url = new URL(String(raw).includes("://") ? raw : `https://${raw}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.href;
  } catch {
    return "";
  }
}

function safeMail(raw) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : "";
}

function setStatus(message) {
  statusNode.textContent = message;
}

function hideResults() {
  marketRequest += 1;
  resultNode.hidden = true;
  companyNode.hidden = true;
  choicesNode.hidden = true;
  choiceList.replaceChildren();
  marketNode.hidden = true;
  marketBody.hidden = true;
}

function rememberQuery(query) {
  const next = new URL(window.location.href);
  next.searchParams.set("q", query);
  window.history.replaceState(null, "", next);
}

function renderContact(contact) {
  const rows = [
    ["电话", contact.phone],
    ["传真", contact.fax],
    ["邮箱", contact.email],
  ].filter(([, value]) => value);
  fields.contact.replaceChildren();
  if (rows.length === 0) {
    fields.contact.textContent = "暂无";
    return;
  }
  const list = document.createElement("ul");
  list.className = "contact";
  for (const [label, value] of rows) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = label;
    item.append(name, document.createTextNode(label === "邮箱" ? "" : value));
    if (label === "邮箱") {
      const mail = safeMail(value);
      if (!mail) item.append(document.createTextNode(value));
      else {
        const link = document.createElement("a");
        link.href = `mailto:${mail}`;
        link.textContent = value;
        item.append(link);
      }
    }
    list.append(item);
  }
  fields.contact.append(list);
}

function renderWebsite(website) {
  fields.website.replaceChildren();
  if (!website) {
    fields.website.textContent = "暂无";
    return;
  }
  const href = safeHttpUrl(website);
  if (!href) {
    fields.website.textContent = website;
    return;
  }
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = website;
  fields.website.append(link);
}

function renderCompany(company) {
  choicesNode.hidden = true;
  companyNode.hidden = false;
  resultNode.hidden = false;
  fields.securityType.textContent = company.securityType || "A股";
  fields.title.textContent = company.name || company.fullName || "公司资料";
  fields.subtitle.textContent = company.fullName || "";
  fields.code.textContent = textOrEmpty(company.code);
  fields.name.textContent = textOrEmpty(company.name);
  fields.fullName.textContent = textOrEmpty(company.fullName);
  fields.industry.textContent = textOrEmpty(company.industry);
  fields.listingDate.textContent = textOrEmpty(company.listingDate);
  fields.address.textContent = textOrEmpty(company.registeredAddress);
  fields.legalPerson.textContent = textOrEmpty(company.legalPerson);
  fields.business.textContent = textOrEmpty(company.mainBusiness);
  fields.profile.textContent = textOrEmpty(company.profile);
  renderWebsite(company.website);
  renderContact(company.contact || {});
  loadMarket(company);
}

function renderCandidates(candidates) {
  companyNode.hidden = true;
  choicesNode.hidden = false;
  resultNode.hidden = false;
  choiceList.replaceChildren();
  for (const candidate of candidates) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.code = candidate.code;
    const code = document.createElement("span");
    code.className = "code";
    code.textContent = candidate.code;
    const name = document.createElement("span");
    name.textContent = candidate.name;
    const market = document.createElement("span");
    market.className = "market";
    market.textContent = candidate.market || "";
    button.append(code, name, market);
    item.append(button);
    choiceList.append(item);
  }
}

async function search(rawQuery) {
  const query = rawQuery.trim();
  if (!query) return;
  input.value = query;
  submitButton.disabled = true;
  submitButton.textContent = "查询中";
  setStatus("正在获取 F10 资料…");
  hideResults();
  try {
    const response = await fetch(`/api/company?q=${encodeURIComponent(query)}`);
    const result = await response.json();
    rememberQuery(query);
    if (result.kind === "company") {
      setStatus("");
      renderCompany(result.company);
      return;
    }
    if (result.kind === "candidates") {
      setStatus(result.message || "请选择一家公司。");
      renderCandidates(result.candidates || []);
      return;
    }
    setStatus(result.message || "没有找到对应的 A 股公司。");
  } catch {
    setStatus("暂时无法获取 F10 资料，请稍后再试");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "查询";
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  search(input.value);
});

document.querySelector(".examples").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-query]");
  if (!button) return;
  search(button.dataset.query);
});

choiceList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-code]");
  if (!button) return;
  search(button.dataset.code);
});

const initialQuery = new URLSearchParams(window.location.search).get("q");
if (initialQuery) search(initialQuery);

function formatPrice(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return Number(value).toFixed(2);
}

function formatPct(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  const number = Number(value);
  return `${number > 0 ? "+" : ""}${number.toFixed(2)}%`;
}

function pctClass(value) {
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "";
}

function formatAmount(amount) {
  if (amount == null || Number.isNaN(Number(amount))) return "—";
  const yuan = Number(amount) * 1000;
  if (Math.abs(yuan) >= 1e8) return `${(yuan / 1e8).toFixed(2)} 亿元`;
  if (Math.abs(yuan) >= 1e4) return `${(yuan / 1e4).toFixed(2)} 万元`;
  return `${yuan.toFixed(0)} 元`;
}

function formatVol(vol) {
  if (vol == null || Number.isNaN(Number(vol))) return "—";
  const hands = Number(vol);
  if (Math.abs(hands) >= 10000) return `${(hands / 10000).toFixed(2)} 万手`;
  return `${hands.toFixed(0)} 手`;
}

function showNote(node, message) {
  node.hidden = !message;
  node.textContent = message || "";
}

async function loadMarket(company) {
  const requestId = ++marketRequest;
  marketNode.hidden = false;
  marketBody.hidden = true;
  marketStatus.textContent = "正在获取日线和板块资讯…";
  const params = new URLSearchParams({
    code: company.code || "",
    name: company.name || "",
    securityType: company.securityType || "",
    industry: company.industry || "",
  });
  try {
    const response = await fetch(`/api/market?${params}`);
    const data = await response.json();
    if (requestId !== marketRequest) return;
    renderMarket(data);
  } catch {
    if (requestId !== marketRequest) return;
    marketStatus.textContent = "暂时无法获取行情和资讯";
  }
}

function renderMarket(data) {
  if (data.configured === false || (data.message && data.kline == null && data.boards == null)) {
    marketBody.hidden = true;
    marketStatus.textContent = data.message || "暂时无法获取行情和资讯";
    return;
  }
  marketStatus.textContent = "";
  marketBody.hidden = false;
  showNote(klineError, data.klineError);
  showNote(boardsError, data.boardsError);
  showNote(boardsNote, data.boardsNote);
  showNote(newsError, data.newsError);
  renderQuote(data.kline?.latest);
  renderCandles(data.kline?.bars || []);
  renderAllBars(data.kline?.bars || []);
  renderImportant(data.kline?.important || [], Boolean(data.kline?.bars?.length));
  renderBoards(data.boards || []);
  renderNews(data.news || [], data.newsError);
}

function renderQuote(latest) {
  quoteNode.replaceChildren();
  if (!latest) {
    if (!klineError.textContent) quoteNode.textContent = "没有查到近期日线。";
    return;
  }
  const price = document.createElement("p");
  price.className = "price";
  price.append(document.createTextNode(formatPrice(latest.close)), " ");
  const pct = document.createElement("span");
  pct.className = pctClass(latest.pctChg);
  pct.textContent = formatPct(latest.pctChg);
  price.append(pct);
  const meta = document.createElement("p");
  meta.className = "meta";
  const date = document.createElement("span");
  date.className = "pair";
  date.textContent = latest.tradeDate;
  meta.append(date);
  for (const [label, value] of [
    ["开", formatPrice(latest.open)],
    ["高", formatPrice(latest.high)],
    ["低", formatPrice(latest.low)],
    ["量", formatVol(latest.vol)],
    ["额", formatAmount(latest.amount)],
  ]) {
    const pair = document.createElement("span");
    pair.className = "pair";
    const name = document.createElement("span");
    name.textContent = label;
    pair.append(name, document.createTextNode(` ${value}`));
    meta.append(pair);
  }
  quoteNode.append(price, meta);
}

function renderCandles(bars) {
  klineNode.replaceChildren();
  if (bars.length === 0) {
    klineNode.hidden = true;
    klineRange.hidden = true;
    return;
  }
  klineNode.hidden = false;
  klineRange.hidden = false;
  klineRange.textContent = `${bars[0].tradeDate} 至 ${bars.at(-1).tradeDate} · ${bars.length} 个交易日 · 未复权`;
  const slot = 10;
  const plotWidth = bars.length * slot;
  const width = Math.max(plotWidth, 280);
  const height = 180;
  const pad = 8;
  const offset = width - plotWidth;
  klineNode.setAttribute("viewBox", `0 0 ${width} ${height}`);
  klineNode.setAttribute("role", "img");
  klineNode.setAttribute("aria-label", "日线K线");
  const min = Math.min(...bars.map((bar) => bar.low));
  const max = Math.max(...bars.map((bar) => bar.high));
  const span = max - min || 1;
  const y = (value) => pad + ((max - value) / span) * (height - pad * 2);
  const ns = "http://www.w3.org/2000/svg";
  for (const [index, bar] of bars.entries()) {
    const group = document.createElementNS(ns, "g");
    const x = offset + index * slot + slot / 2;
    const rising = bar.close >= bar.open;
    const color = rising ? "#9e2a2b" : "#1f6b45";
    const wick = document.createElementNS(ns, "line");
    wick.setAttribute("x1", String(x));
    wick.setAttribute("x2", String(x));
    wick.setAttribute("y1", String(y(bar.high)));
    wick.setAttribute("y2", String(y(bar.low)));
    wick.setAttribute("stroke", color);
    wick.setAttribute("stroke-width", "1");
    const body = document.createElementNS(ns, "rect");
    const top = y(Math.max(bar.open, bar.close));
    const bottom = y(Math.min(bar.open, bar.close));
    body.setAttribute("x", String(x - 3));
    body.setAttribute("y", String(top));
    body.setAttribute("width", "6");
    body.setAttribute("height", String(Math.max(bottom - top, 1)));
    body.setAttribute("fill", color);
    const title = document.createElementNS(ns, "title");
    title.textContent = `${bar.tradeDate} 开${formatPrice(bar.open)} 高${formatPrice(bar.high)} 低${formatPrice(bar.low)} 收${formatPrice(bar.close)} ${formatPct(bar.pctChg)}`;
    group.append(wick, body, title);
    klineNode.append(group);
  }
}

function renderAllBars(bars) {
  barsTable.replaceChildren();
  allBars.hidden = bars.length === 0;
  if (bars.length === 0) return;
  const table = document.createElement("table");
  table.className = "bars";
  const head = document.createElement("tr");
  for (const label of ["日期", "开盘", "最高", "最低", "收盘", "涨跌幅", "成交额"]) {
    const cell = document.createElement("th");
    cell.textContent = label;
    head.append(cell);
  }
  table.append(head);
  for (const bar of [...bars].reverse()) {
    const row = document.createElement("tr");
    const values = [
      bar.tradeDate,
      formatPrice(bar.open),
      formatPrice(bar.high),
      formatPrice(bar.low),
      formatPrice(bar.close),
      formatPct(bar.pctChg),
      formatAmount(bar.amount),
    ];
    for (const [index, value] of values.entries()) {
      const cell = document.createElement("td");
      cell.textContent = value;
      if (index === 5) cell.className = pctClass(bar.pctChg);
      row.append(cell);
    }
    table.append(row);
  }
  barsTable.append(table);
}

function renderImportant(days, hasBars) {
  importantDays.replaceChildren();
  importantDays.className = "sessions";
  if (!hasBars) {
    importantDays.textContent = klineError.textContent ? "" : "没有可展示的交易日。";
    return;
  }
  if (days.length === 0) {
    importantDays.textContent = "这段行情没有特别突出的交易日。";
    return;
  }
  for (const day of days) {
    const item = document.createElement("li");
    const date = document.createElement("span");
    date.className = "num";
    date.textContent = day.tradeDate;
    const pct = document.createElement("strong");
    pct.className = pctClass(day.pctChg);
    pct.textContent = formatPct(day.pctChg);
    const close = document.createElement("span");
    close.textContent = `收盘 ${formatPrice(day.close)}`;
    const amount = document.createElement("span");
    amount.textContent = `成交额 ${formatAmount(day.amount)}`;
    const tags = document.createElement("span");
    tags.textContent = (day.tags || []).join(" · ");
    item.append(date, pct, close, amount, tags);
    importantDays.append(item);
  }
}

function renderBoards(boards) {
  boardsNode.replaceChildren();
  if (boards.length === 0 && !boardsError.textContent && !boardsNote.textContent) {
    boardsNode.textContent = "没有查到关联板块。";
    return;
  }
  for (const board of boards) {
    const item = document.createElement("li");
    item.append(document.createTextNode(board.name));
    if (board.type) {
      const type = document.createElement("small");
      type.textContent = board.type;
      item.append(type);
    }
    boardsNode.append(item);
  }
}

function renderNews(items, error) {
  newsNode.replaceChildren();
  newsNode.className = "news";
  if (items.length === 0) {
    newsNode.textContent = error ? "" : "近 3 日没有匹配到这些板块的快讯。";
    return;
  }
  for (const item of items) {
    const article = document.createElement("li");
    const meta = document.createElement("div");
    const time = document.createElement("time");
    time.textContent = item.time || "";
    meta.append(time);
    if (item.source) {
      const source = document.createElement("span");
      source.className = "source";
      source.textContent = ` ${item.source}`;
      meta.append(source);
    }
    const title = document.createElement("h3");
    title.textContent = item.title;
    article.append(meta, title);
    if (item.summary) {
      const summary = document.createElement("p");
      summary.textContent = item.summary;
      article.append(summary);
    }
    if (item.boards?.length) {
      const matched = document.createElement("p");
      matched.className = "note";
      matched.textContent = item.boards.join(" · ");
      article.append(matched);
    }
    newsNode.append(article);
  }
}
