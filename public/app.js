const form = document.querySelector("#search-form");
const input = document.querySelector("#q");
const submitButton = form.querySelector("button[type='submit']");
const statusNode = document.querySelector("#status");
const resultNode = document.querySelector("#result");
const companyNode = document.querySelector("#company");
const choicesNode = document.querySelector("#choices");
const choiceList = document.querySelector("#choice-list");

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
  resultNode.hidden = true;
  companyNode.hidden = true;
  choicesNode.hidden = true;
  choiceList.replaceChildren();
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
