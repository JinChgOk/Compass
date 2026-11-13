import {
  BATCH_LIMIT,
  LEGACY_KEY,
  STORE_KEY,
  addEntry as addToStore,
  addGroup as addGroupToStore,
  moveEntry as moveInStore,
  parseStore,
  removeEntry as removeFromStore,
  removeGroup as removeGroupFromStore,
  renameGroup as renameGroupInStore,
  selectGroup as selectGroupInStore,
  selectedEntries,
  toggleSelected,
} from "./roster.mjs";

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
const watchForm = document.querySelector("#watch-form");
const watchInput = document.querySelector("#watch-q");
const watchGroup = document.querySelector("#watch-group");
const watchSubmit = watchForm.querySelector("button[type='submit']");
const groupForm = document.querySelector("#group-form");
const groupNameInput = document.querySelector("#group-name");
const watchStatus = document.querySelector("#watch-status");
const watchChoices = document.querySelector("#watch-choices");
const watchChoiceList = document.querySelector("#watch-choice-list");
const watchRoster = document.querySelector("#watch-roster");
const watchEmpty = document.querySelector("#watch-empty");
const watchToolbar = document.querySelector("#watch-toolbar");
const watchPickCount = document.querySelector("#watch-pick-count");
const watchAnalyze = document.querySelector("#watch-analyze");
const watchCards = document.querySelector("#watch-cards");
const addWatchButton = document.querySelector("#add-watch");
let currentCompany = null;
const watchRequests = new Map();
let watchQueue = Promise.resolve();
let memoryStore = null;

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

async function paidFetch(url) {
  const response = await fetch(url);
  const raw = response.headers.get("x-tushare-calls");
  if (raw == null || raw === "") return response;
  const count = Number(raw);
  if (!Number.isFinite(count)) return response;
  const meter = document.querySelector("#call-meter");
  if (!meter) return response;
  meter.hidden = false;
  meter.textContent = `近 1 分钟 ${count} 次`;
  return response;
}

function hideResults() {
  marketRequest += 1;
  currentCompany = null;
  syncAddButton();
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
  currentCompany = company;
  syncAddButton();
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

watchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  addQuery(watchInput.value);
});

groupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const result = addGroupToStore(loadStore(), groupNameInput.value);
  if (result.error) {
    setWatchStatus(result.error);
    return;
  }
  saveStore(result.store);
  groupNameInput.value = "";
  watchGroup.value = result.group.id;
  renderRoster();
  setWatchStatus(`已新建 ${result.group.name}`, true);
});

watchChoiceList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-code]");
  if (!button) return;
  addQuery(button.dataset.code);
});

watchRoster.addEventListener("change", (event) => {
  const target = event.target;
  if (target.dataset.code) {
    const result = toggleSelected(loadStore(), target.dataset.code, target.checked);
    saveStore(result.store);
    renderRoster();
    if (result.error) setWatchStatus(result.error);
    return;
  }
  if (target.dataset.groupSelect) {
    const result = selectGroupInStore(loadStore(), target.dataset.groupSelect, target.checked);
    saveStore(result.store);
    renderRoster();
    if (result.error) setWatchStatus(result.error);
    return;
  }
  if (target.dataset.move) {
    saveStore(moveInStore(loadStore(), target.dataset.move, target.value));
    renderRoster();
    return;
  }
  if (target.dataset.renameGroup) {
    const result = renameGroupInStore(loadStore(), target.dataset.renameGroup, target.value);
    if (result.error) {
      setWatchStatus(result.error);
      renderRoster();
      return;
    }
    saveStore(result.store);
    renderRoster();
  }
});

watchRoster.addEventListener("click", (event) => {
  const removeStock = event.target.closest("button[data-remove]");
  if (removeStock) {
    removeEntry(removeStock.dataset.remove);
    return;
  }
  const removeGroup = event.target.closest("button[data-remove-group]");
  if (!removeGroup) return;
  const result = removeGroupFromStore(loadStore(), removeGroup.dataset.removeGroup);
  if (result.error) {
    setWatchStatus(result.error);
    return;
  }
  saveStore(result.store);
  renderRoster();
});

watchAnalyze.addEventListener("click", () => {
  analyzeSelected();
});

watchCards.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-remove]");
  if (!button) return;
  removeEntry(button.dataset.remove);
});

addWatchButton.addEventListener("click", () => {
  if (!currentCompany) return;
  addEntry(currentCompany);
});

renderRoster();
if (loadStore().selected.length) analyzeSelected();

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
    const response = await paidFetch(`/api/market?${params}`);
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

function setWatchStatus(message, ok) {
  watchStatus.textContent = message || "";
  watchStatus.classList.toggle("ok", Boolean(ok));
}

function localCode(input) {
  const text = String(input ?? "")
    .replace(/\u3000/g, " ")
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, "");
  const match = text.match(/^(?:sh|sz|bj)?(\d{6})(?:\.(?:sh|sz|bj))?$/i);
  return match ? match[1] : "";
}

function loadStore() {
  if (memoryStore) return cloneStore(memoryStore);
  let rawV2 = null;
  let rawV1 = null;
  try { rawV2 = localStorage.getItem(STORE_KEY); } catch { rawV2 = null; }
  try { rawV1 = localStorage.getItem(LEGACY_KEY); } catch { rawV1 = null; }
  memoryStore = parseStore(rawV2, rawV1);
  return cloneStore(memoryStore);
}

function saveStore(next) {
  memoryStore = parseStore(next, null);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(memoryStore));
  } catch {
    // 隐私模式写不进本地存储时，这次打开仍然保留列表。
  }
  return cloneStore(memoryStore);
}

function cloneStore(store) {
  return parseStore(store, null);
}

function syncAddButton() {
  if (!currentCompany) {
    addWatchButton.hidden = true;
    return;
  }
  addWatchButton.hidden = false;
  const saved = loadStore().entries.some((item) => item.code === currentCompany.code);
  addWatchButton.disabled = saved;
  addWatchButton.textContent = saved ? "已在自选" : "加入自选";
}

function hideWatchChoices() {
  watchChoices.hidden = true;
  watchChoiceList.replaceChildren();
}

function showWatchChoices(candidates) {
  watchChoices.hidden = false;
  watchChoiceList.replaceChildren();
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
    watchChoiceList.append(item);
  }
}

async function addQuery(raw) {
  const query = String(raw ?? "").trim();
  if (!query) return;
  watchSubmit.disabled = true;
  setWatchStatus("正在查找公司…");
  hideWatchChoices();
  try {
    const response = await fetch(`/api/company?q=${encodeURIComponent(query)}`);
    const result = await response.json();
    if (result.kind === "company") {
      addEntry(result.company);
      return;
    }
    if (result.kind === "candidates") {
      setWatchStatus(result.message || "请选择一家公司。");
      showWatchChoices(result.candidates || []);
      return;
    }
    if (result.kind === "not-a-share") {
      setWatchStatus(result.message || "当前只加入 A 股。");
      return;
    }
    const code = localCode(query);
    if (response.status >= 500 && code) {
      addEntry({ code, name: code, securityType: "" });
      return;
    }
    setWatchStatus(result.message || "没有找到对应的 A 股公司。");
  } catch {
    const code = localCode(query);
    if (code) addEntry({ code, name: code, securityType: "" });
    else setWatchStatus("暂时无法加入，请稍后再试");
  } finally {
    watchSubmit.disabled = false;
  }
}

function addEntry(company) {
  const result = addToStore(loadStore(), {
    code: company.code,
    name: company.name || company.code,
    securityType: company.securityType || "",
  }, watchGroup.value);
  if (result.error && !result.store.entries.some((item) => item.code === company.code)) {
    setWatchStatus(result.error);
    return;
  }
  saveStore(result.store);
  const entry = result.store.entries.find((item) => item.code === company.code);
  const name = entry?.name || company.name || company.code;
  if (result.error) setWatchStatus(result.error, true);
  else setWatchStatus(`已加入 ${name}，勾选后点「分析所选」`, true);
  watchInput.value = "";
  hideWatchChoices();
  renderRoster();
  syncAddButton();
}

function removeEntry(code) {
  saveStore(removeFromStore(loadStore(), code));
  watchRequests.set(code, (watchRequests.get(code) ?? 0) + 1);
  document.querySelector(`[data-card="${CSS.escape(code)}"]`)?.remove();
  renderRoster();
  syncAddButton();
}

function renderRoster() {
  const store = loadStore();
  fillGroupSelect(store);
  watchRoster.replaceChildren();
  if (store.entries.length === 0 && store.groups.length <= 1) {
    watchRoster.hidden = true;
    watchToolbar.hidden = true;
    watchEmpty.hidden = false;
    return;
  }
  watchEmpty.hidden = true;
  watchRoster.hidden = false;
  watchToolbar.hidden = store.entries.length === 0;
  for (const group of store.groups) {
    const members = store.entries.filter((item) => item.groupId === group.id);
    watchRoster.append(renderGroup(store, group, members));
  }
  updatePickCount(store);
}

function fillGroupSelect(store) {
  const current = watchGroup.value;
  watchGroup.replaceChildren();
  for (const group of store.groups) {
    const option = document.createElement("option");
    option.value = group.id;
    option.textContent = group.name;
    watchGroup.append(option);
  }
  if ([...watchGroup.options].some((option) => option.value === current)) watchGroup.value = current;
}

function renderGroup(store, group, members) {
  const section = document.createElement("section");
  section.className = "roster-group";
  const head = document.createElement("div");
  head.className = "roster-head";
  const pick = document.createElement("input");
  pick.type = "checkbox";
  pick.dataset.groupSelect = group.id;
  const selectedCount = members.filter((item) => store.selected.includes(item.code)).length;
  pick.checked = members.length > 0 && selectedCount === members.length;
  pick.indeterminate = selectedCount > 0 && selectedCount < members.length;
  pick.disabled = members.length === 0;
  pick.setAttribute("aria-label", `全选 ${group.name}`);
  const name = document.createElement("input");
  name.className = "group-name";
  name.value = group.name;
  name.maxLength = 12;
  name.dataset.renameGroup = group.id;
  name.setAttribute("aria-label", "分组名称");
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "quiet";
  remove.dataset.removeGroup = group.id;
  remove.textContent = "删除分组";
  remove.hidden = store.groups.length < 2;
  head.append(pick, name, remove);
  const list = document.createElement("ul");
  list.className = "roster-list";
  if (members.length === 0) {
    const empty = document.createElement("li");
    empty.className = "roster-empty";
    empty.textContent = "这组还是空的。";
    list.append(empty);
  }
  for (const entry of members) list.append(renderRosterRow(store, entry));
  section.append(head, list);
  return section;
}

function renderRosterRow(store, entry) {
  const row = document.createElement("li");
  row.className = "roster-row";
  const label = document.createElement("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.dataset.code = entry.code;
  box.checked = store.selected.includes(entry.code);
  const text = document.createElement("span");
  text.textContent = `${entry.code}  ${entry.name || entry.code}`;
  label.append(box, text);
  const move = document.createElement("select");
  move.dataset.move = entry.code;
  move.setAttribute("aria-label", `把 ${entry.name || entry.code} 移到分组`);
  for (const group of store.groups) {
    const option = document.createElement("option");
    option.value = group.id;
    option.textContent = group.name;
    if (group.id === entry.groupId) option.selected = true;
    move.append(option);
  }
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "quiet";
  remove.dataset.remove = entry.code;
  remove.textContent = "移除";
  row.append(label, move, remove);
  return row;
}

function updatePickCount(store) {
  const count = store.selected.length;
  watchPickCount.textContent = count
    ? `已勾选 ${count} 只，同时最多分析 ${BATCH_LIMIT} 只。`
    : `勾选要看的公司，同时最多 ${BATCH_LIMIT} 只。`;
  watchAnalyze.disabled = count === 0;
}

function analyzeSelected() {
  const picked = selectedEntries(loadStore());
  if (!picked.length) {
    setWatchStatus("请先勾选要分析的公司");
    return;
  }
  watchCards.replaceChildren();
  for (const entry of picked) watchCards.append(createCard(entry));
  for (const entry of picked) enqueueRefresh(entry);
  setWatchStatus(`正在分析已勾选的 ${picked.length} 只…`, true);
}

function enqueueRefresh(entry) {
  watchQueue = watchQueue.then(() => refreshCard(entry)).catch(() => {});
}

function createCard(entry) {
  const article = document.createElement("article");
  article.className = "sheet watch-card";
  article.dataset.card = entry.code;
  article.setAttribute("aria-label", `${entry.name || entry.code} ${entry.code}`);

  const head = document.createElement("div");
  head.className = "card-head";
  const kicker = document.createElement("p");
  kicker.className = "kicker";
  kicker.textContent = entry.code;
  const title = document.createElement("h2");
  title.textContent = entry.name || entry.code;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "quiet";
  remove.dataset.remove = entry.code;
  remove.textContent = "移除";
  remove.setAttribute("aria-label", `移除 ${entry.name || entry.code}`);
  head.append(kicker, title, remove);

  const status = document.createElement("p");
  status.className = "status card-status";
  status.setAttribute("role", "status");
  status.textContent = "正在读取近期变化…";

  const blocks = document.createElement("div");
  blocks.className = "blocks";
  for (const [key, label] of [
    ["performance", "业绩"],
    ["capital", "资金"],
    ["holders", "股东"],
    ["position", "位置"],
  ]) {
    const block = document.createElement("section");
    block.className = "block";
    block.dataset.block = key;
    const heading = document.createElement("h3");
    heading.textContent = label;
    const body = document.createElement("div");
    body.className = "block-body";
    block.append(heading, body);
    blocks.append(block);
  }

  const midterm = document.createElement("section");
  midterm.className = "block midterm";
  midterm.dataset.block = "midterm";
  const midtermTitle = document.createElement("h3");
  midtermTitle.textContent = "中线";
  const midtermBody = document.createElement("div");
  midtermBody.className = "block-body";
  midterm.append(midtermTitle, midtermBody);

  article.append(head, status, blocks, midterm);
  return article;
}

async function refreshCard(entry) {
  const selector = `[data-card="${CSS.escape(entry.code)}"]`;
  const card = document.querySelector(selector);
  if (!card) return;
  const requestId = (watchRequests.get(entry.code) ?? 0) + 1;
  watchRequests.set(entry.code, requestId);
  const status = card.querySelector(".card-status");
  status.hidden = false;
  status.textContent = "正在读取近期变化…";
  const params = new URLSearchParams({
    code: entry.code,
    name: entry.name || "",
    securityType: entry.securityType || "",
  });
  try {
    const response = await paidFetch(`/api/watch?${params}`);
    const data = await response.json();
    if (watchRequests.get(entry.code) !== requestId) return;
    const current = document.querySelector(selector);
    if (!current) return;
    if (!response.ok) {
      showCardMessage(current, data.message || "暂时无法获取这张卡片");
      return;
    }
    renderCard(current, data);
    if (data.configured !== false) await loadMidterm(entry, current);
  } catch {
    if (watchRequests.get(entry.code) !== requestId) return;
    const current = document.querySelector(selector);
    if (!current) return;
    showCardMessage(current, "暂时无法获取这张卡片");
  }
}

function showCardMessage(card, message) {
  const status = card.querySelector(".card-status");
  status.hidden = false;
  status.textContent = message;
  const blocks = card.querySelector(".blocks");
  if (blocks) blocks.hidden = true;
  const midterm = card.querySelector(".midterm");
  if (midterm) midterm.hidden = true;
}

function renderCard(card, data) {
  const status = card.querySelector(".card-status");
  if (data.configured === false) {
    showCardMessage(card, data.message || "暂时无法获取这张卡片");
    if (/TUSHARE_TOKEN/.test(data.message || "")) setWatchStatus(data.message, false);
    return;
  }
  const blocks = card.querySelector(".blocks");
  if (blocks) blocks.hidden = false;
  status.hidden = true;
  status.textContent = "";
  const code = card.dataset.card;
  const name = rememberName(code, data.name);
  card.querySelector("h2").textContent = name;
  card.setAttribute("aria-label", `${name} ${code}`);
  const remove = card.querySelector("button[data-remove]");
  if (remove) remove.setAttribute("aria-label", `移除 ${name}`);
  const industry = data.position?.industryName;
  const level = data.position?.industryLevel;
  card.querySelector(".kicker").textContent = industry ? `${code} · 申万${level} ${industry}` : code;
  fillPerformance(card.querySelector('[data-block="performance"] .block-body'), data.performance || {});
  fillCapital(card.querySelector('[data-block="capital"] .block-body'), data.capital || {});
  fillHolders(card.querySelector('[data-block="holders"] .block-body'), data.holders || {});
  fillPosition(card.querySelector('[data-block="position"] .block-body'), data.position || {});
  const midterm = card.querySelector(".midterm");
  if (midterm) midterm.hidden = false;
}

async function loadMidterm(entry, card) {
  const body = card.querySelector("[data-block='midterm'] .block-body");
  if (!body) return;
  body.textContent = "正在看近一年的位置、估值和龙虎榜…";
  const params = new URLSearchParams({
    code: entry.code,
    name: entry.name || "",
    securityType: entry.securityType || "",
  });
  try {
    const response = await paidFetch(`/api/analysis?${params}`);
    const data = await response.json();
    if (!card.isConnected) return;
    fillAnalysis(body, response.ok ? data : { configured: true, error: data.message || "暂时无法生成中线分析" });
  } catch {
    if (!card.isConnected) return;
    body.textContent = "中线暂时取不到";
  }
}

function fillAnalysis(body, data) {
  body.replaceChildren();
  if (data.configured === false) {
    appendSub(body, data.message || "需要配置 TUSHARE_TOKEN");
    return;
  }
  if (data.error) appendError(body, data.error);
  for (const [label, text] of [
    ["底部", data.bottom],
    ["后续", data.stance],
    ["便宜", data.cheap],
    ["性价比", data.value],
    ["位置", data.levels],
    ["失效", data.invalidation],
    ["资金", data.capital],
    ["反证", data.counter],
  ]) {
    if (!text) continue;
    const row = document.createElement("p");
    row.className = "stack";
    const name = document.createElement("b");
    name.textContent = label;
    row.append(name, document.createTextNode(text));
    body.append(row);
  }
}

function rememberName(code, reported) {
  const store = loadStore();
  const entry = store.entries.find((item) => item.code === code);
  const current = entry?.name || "";
  const better = reported && (current === code || !current) ? reported : (current || reported || code);
  if (entry && better !== current) {
    saveStore({
      ...store,
      entries: store.entries.map((item) => (item.code === code ? { ...item, name: better } : item)),
    });
    renderRoster();
  }
  return better || code;
}

function fillPerformance(body, performance) {
  body.replaceChildren();
  if (performance.error) appendError(body, performance.error);
  const preview = performance.preview;
  if (preview) {
    const title = document.createElement("p");
    title.className = "lead";
    const kind = preview.kind === "forecast" ? "业绩预告" : "业绩快报";
    title.textContent = [preview.periodLabel || preview.period, kind, preview.type].filter(Boolean).join(" · ");
    body.append(title);
    if (preview.annDate) appendSub(body, `公告 ${preview.annDate}`);
    if (preview.summary) appendSub(body, preview.summary);
  }
  appendMetric(body, "营收同比", performance.revenueYoy);
  appendMetric(body, "净利同比", performance.profitYoy);
  appendMetric(body, "ROE同比", performance.roeYoy);
  if (performance.hint) appendSub(body, performance.hint);
}

function fillCapital(body, capital) {
  body.replaceChildren();
  const errors = capital.errors || {};
  const flow = capital.mainForce;
  if (errors.flow) appendError(body, errors.flow);
  else if (!flow) appendSub(body, "没有查到主力净流入。");
  else {
    appendPair(body, `近 ${flow.sessions} 个交易日主力净流入`, formatWan(flow.netWan, true), pctClass(flow.netWan));
    appendSub(body, `${flow.start} 至 ${flow.end} · 大单+特大单`);
  }

  const margin = capital.margin;
  if (errors.margin) appendError(body, errors.margin);
  else if (!margin) appendSub(body, "没有查到融资余额。");
  else if (margin.changeYuan == null) {
    appendPair(body, "融资余额", formatYuan(margin.latestYuan), "");
    appendSub(body, margin.latestDate ? `${margin.latestDate} · 还没有更早的余额可比较` : "还没有更早的余额可比较");
  } else {
    appendPair(body, "融资余额变化", formatYuan(margin.changeYuan, true), pctClass(margin.changeYuan));
    appendSub(body, `${margin.latestDate} 余额 ${formatYuan(margin.latestYuan)}，较 ${margin.previousDate}`);
  }

  if (errors.topList) appendError(body, `龙虎榜：${errors.topList}`);
  if (capital.dragonTiger) {
    const tiger = capital.dragonTiger;
    const pct = tiger.pctChg == null ? "" : formatPct(tiger.pctChg);
    appendPair(body, "龙虎榜", [tiger.tradeDate, pct].filter(Boolean).join(" "), pctClass(tiger.pctChg));
    const detail = [(tiger.reasons || []).join("；"), tiger.netYuan == null ? "" : `净买入 ${formatYuan(tiger.netYuan, true)}`].filter(Boolean).join(" · ");
    if (detail) appendSub(body, detail);
  }
  if (errors.block) appendError(body, `大宗交易：${errors.block}`);
  if (capital.blockTrade) {
    const block = capital.blockTrade;
    const detail = [
      block.count ? `${block.count} 笔` : "",
      block.volWan == null ? "" : `${Number(block.volWan).toFixed(2)} 万股`,
      block.amountWan == null ? "" : formatWan(block.amountWan),
    ].filter(Boolean).join(" · ");
    appendPair(body, "大宗", block.tradeDate, "");
    if (detail) appendSub(body, detail);
  }
  if (!capital.dragonTiger && !capital.blockTrade && !errors.topList && !errors.block) {
    appendSub(body, `近 ${capital.eventSessions || 10} 个交易日没有上龙虎榜，也没有大宗交易。`);
  } else if (!capital.blockTrade && !errors.block && !capital.dragonTiger && errors.topList) {
    appendSub(body, "没有大宗交易。");
  }
}

function fillHolders(body, holders) {
  body.replaceChildren();
  if (holders.error) appendError(body, holders.error);
  if (holders.latest) {
    appendPair(body, "股东户数", formatCount(holders.latest.count), "");
    if (holders.change != null) appendPair(body, "较上一期", holderChange(holders), "");
    const meta = [
      holders.latest.endDate ? `截至 ${holders.latest.endDate}` : "",
      holders.latest.annDate ? `公告 ${holders.latest.annDate}` : "",
      holders.previous?.endDate ? `上一期 ${holders.previous.endDate}` : "",
    ].filter(Boolean).join(" · ");
    if (meta) appendSub(body, meta);
  } else if (!holders.error) {
    appendSub(body, holders.hint || "没有查到股东户数。");
  }
  if (holders.hint && holders.latest) appendSub(body, holders.hint);
  fillFunds(body, holders.funds || {});
  fillSurveys(body, holders.surveys || {});
}

function fillFunds(body, funds) {
  if (funds.error) appendError(body, funds.error);
  if (!funds.latest) {
    if (!funds.error && funds.hint) appendSub(body, funds.hint);
    return;
  }
  const change = funds.countChange == null
    ? ""
    : funds.countChange === 0
      ? "只数与上期持平"
      : `较上期${funds.countChange > 0 ? "多" : "少"} ${Math.abs(funds.countChange).toLocaleString("zh-CN")} 只`;
  appendPair(body, "公募持仓", `${funds.latest.count} 只`, "");
  if (funds.latest.floatPct != null) appendPair(body, "占流通", `${funds.latest.floatPct.toFixed(2)}%`, "");
  if (change) appendPair(body, "持仓变化", change, "");
  const meta = [
    funds.latest.periodLabel || funds.latest.endDate || "",
    funds.previous?.periodLabel ? `上一期 ${funds.previous.periodLabel}` : "",
  ].filter(Boolean).join(" · ");
  if (meta) appendSub(body, meta);
  fillFundHoldings(body, funds.latest.holdings || [], funds.visibleCount || 6);
  if (funds.hint) appendSub(body, funds.hint);
}

function fillFundHoldings(body, holdings, visibleCount) {
  if (!holdings.length) return;
  const shown = holdings.slice(0, visibleCount);
  const rest = holdings.slice(visibleCount);
  body.append(fundHoldingList(shown));
  if (!rest.length) return;
  const extra = document.createElement("details");
  extra.className = "fund-more";
  const summary = document.createElement("summary");
  summary.textContent = `其余 ${rest.length} 只`;
  extra.append(summary, fundHoldingList(rest));
  body.append(extra);
}

function fundHoldingList(holdings) {
  const list = document.createElement("ul");
  list.className = "fund-list";
  for (const item of holdings) {
    const row = document.createElement("li");
    const name = document.createElement("span");
    name.className = "fund-name";
    name.textContent = item.name || item.code || "—";
    const meta = document.createElement("span");
    meta.className = "fund-meta";
    meta.textContent = fundHoldingMeta(item);
    row.append(name, meta);
    list.append(row);
  }
  return list;
}

function fundHoldingMeta(item) {
  return [
    item.floatPct != null ? `占流通 ${item.floatPct.toFixed(2)}%` : "",
    item.fundPct != null ? `占基金 ${item.fundPct.toFixed(2)}%` : "",
    item.mkvYuan != null ? formatYuan(item.mkvYuan) : "",
  ].filter(Boolean).join(" · ");
}

function fillSurveys(body, surveys) {
  if (surveys.error) appendError(body, surveys.error);
  if (!surveys.count) {
    if (!surveys.error && surveys.hint) appendSub(body, surveys.hint);
    return;
  }
  appendPair(body, "机构调研", `近1年 ${surveys.count} 次`, "");
  const meta = [
    surveys.latestDate ? `最近 ${surveys.latestDate}` : "",
    surveys.orgCount ? `${surveys.orgCount} 家机构` : "",
  ].filter(Boolean).join(" · ");
  if (meta) appendSub(body, meta);
  for (const item of surveys.highlights || []) {
    const who = [item.date, item.org].filter(Boolean).join(" ");
    appendSub(body, who ? `${who}：${item.text}` : item.text);
  }
}

function fillPosition(body, position) {
  body.replaceChildren();
  if (position.error) appendError(body, position.error);
  if (position.excess != null) appendPair(body, "相对申万", formatPct(position.excess), pctClass(position.excess));
  if (position.stockReturn != null) {
    appendPair(body, `近 ${position.sessions} 个交易日`, formatPct(position.stockReturn), pctClass(position.stockReturn));
  } else if (!position.error) appendSub(body, "没有查到这段涨跌。");
  if (position.industryError) appendError(body, position.industryError);
  else if (position.industryReturn != null) {
    const label = position.industryName || position.industryCode || "申万行业";
    appendPair(body, label, formatPct(position.industryReturn), pctClass(position.industryReturn));
  }
  if (position.start && position.end) appendSub(body, `${position.start} 收盘至 ${position.end} · 未复权`);
  if (position.hint) appendSub(body, position.hint);
}

function holderChange(holders) {
  if (holders.change == null) return "";
  if (holders.change === 0) return "与上期持平";
  const direction = holders.change > 0 ? "多" : "少";
  const pct = holders.changePct == null ? "" : `（${formatPct(holders.changePct)}）`;
  return `较上期${direction} ${Math.abs(holders.change).toLocaleString("zh-CN")} 户${pct}`;
}

function appendMetric(body, label, metric) {
  appendPair(body, label, formatYoy(metric), yoyClass(metric));
  const caption = metricCaption(metric, label);
  if (caption) appendSub(body, caption);
}

function formatYoy(metric) {
  if (!metric) return "—";
  if (metric.unit === "point") return formatPoint(metric.value);
  if (metric.min != null && metric.max != null && metric.min !== metric.max) return `${formatPct(metric.min)} ~ ${formatPct(metric.max)}`;
  return formatPct(metric.value ?? metric.min ?? metric.max);
}

function yoyClass(metric) {
  if (!metric) return "";
  if (metric.min != null && metric.max != null && metric.min < 0 && metric.max > 0) return "";
  return pctClass(metric.value ?? metric.min ?? metric.max);
}

function metricCaption(metric, label) {
  if (!metric) return "";
  const base = [metric.periodLabel || metric.period, metric.source].filter(Boolean).join("");
  if (label === "ROE同比" && metric.unit === "percent") return [base, "摊薄增长率"].filter(Boolean).join(" · ");
  return base;
}

function formatPoint(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  const number = Number(value);
  return `${number > 0 ? "+" : ""}${number.toFixed(2)} 个百分点`;
}

function formatWan(value, signed = false) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  const number = Number(value);
  const abs = Math.abs(number);
  const sign = number < 0 ? "-" : signed && number > 0 ? "+" : "";
  if (abs >= 10000) return `${sign}${(abs / 10000).toFixed(2)} 亿元`;
  return `${sign}${abs.toFixed(2)} 万元`;
}

function formatYuan(value, signed = false) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  const number = Number(value);
  const abs = Math.abs(number);
  const sign = number < 0 ? "-" : signed && number > 0 ? "+" : "";
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(2)} 亿元`;
  if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(2)} 万元`;
  return `${sign}${abs.toFixed(0)} 元`;
}

function formatCount(value) {
  return `${Number(value).toLocaleString("zh-CN")} 户`;
}

function appendPair(body, label, value, className) {
  const row = document.createElement("p");
  row.className = "metric";
  const name = document.createElement("span");
  name.textContent = label;
  const number = document.createElement("span");
  if (className) number.className = className;
  number.textContent = value;
  row.append(name, number);
  body.append(row);
}

function appendSub(body, text) {
  const node = document.createElement("p");
  node.className = "sub";
  node.textContent = text;
  body.append(node);
}

function appendError(body, text) {
  const node = document.createElement("p");
  node.className = "section-error";
  node.textContent = text;
  body.append(node);
}
