const ORGINFO_URL = "https://datacenter.eastmoney.com/securities/api/data/v1/get";
const SUGGEST_URL = "https://searchadapter.eastmoney.com/api/suggest/get";

// 东方财富网页搜索框使用的公开 token，不是账号密钥。
const PUBLIC_SUGGEST_TOKEN = "D43BF722C8E33BDC906FB84D85E326E8";

const REQUEST_TIMEOUT_MS = 12_000;

export const ORG_COLUMNS = [
  "SECURITY_CODE",
  "SECURITY_NAME_ABBR",
  "ORG_NAME",
  "EM2016",
  "INDUSTRYCSRC1",
  "LISTING_DATE",
  "MAIN_BUSINESS",
  "ORG_PROFILE",
  "REG_ADDRESS",
  "LEGAL_PERSON",
  "ORG_TEL",
  "ORG_EMAIL",
  "ORG_FAX",
  "ORG_WEB",
  "SECURITY_TYPE",
];

const SUGGEST_A_SHARE_MARKETS = new Set(["沪A", "深A", "科创板", "京A", "创业板"]);
const EMPTY_MARKERS = new Set(["", "--", "-", "—", "无", "暂无", "null"]);

export function cleanText(value) {
  if (value == null) return "";
  return String(value).replace(/\u00a0/g, " ").replace(/\r\n/g, "\n").trim();
}

export function meaningful(value) {
  const text = cleanText(value);
  return EMPTY_MARKERS.has(text) ? "" : text;
}

export function formatDate(value) {
  const text = meaningful(value);
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : text;
}

export function normalizeQuery(input) {
  return String(input ?? "")
    .replace(/\u3000/g, " ")
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[Ａ-Ｚａ-ｚ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .trim()
    .replace(/\s+/g, "");
}

export function normalizeCode(input) {
  const query = normalizeQuery(input);
  const match = query.match(/^(?:sh|sz|bj)?(\d{6})(?:\.(?:sh|sz|bj))?$/i);
  return match ? match[1] : null;
}

export function isAShareSecurityType(securityType) {
  const text = cleanText(securityType);
  return text.includes("A股") && !text.includes("B股");
}

export function marketLabel(securityTypeOrMarket) {
  const text = cleanText(securityTypeOrMarket);
  if (SUGGEST_A_SHARE_MARKETS.has(text)) return text;
  if (text.includes("科创板")) return "科创板";
  if (text.includes("创业板")) return "创业板";
  if (text.includes("北京")) return "京A";
  if (text.includes("上交所") && text.includes("A股")) return "沪A";
  if (text.includes("深交所") && text.includes("A股")) return "深A";
  return text;
}

export function mapCompany(row) {
  return {
    code: meaningful(row.SECURITY_CODE),
    name: meaningful(row.SECURITY_NAME_ABBR),
    fullName: meaningful(row.ORG_NAME),
    industry: meaningful(row.EM2016) || meaningful(row.INDUSTRYCSRC1),
    listingDate: formatDate(row.LISTING_DATE),
    mainBusiness: meaningful(row.MAIN_BUSINESS),
    profile: meaningful(row.ORG_PROFILE),
    registeredAddress: meaningful(row.REG_ADDRESS),
    legalPerson: meaningful(row.LEGAL_PERSON),
    contact: {
      phone: meaningful(row.ORG_TEL),
      fax: meaningful(row.ORG_FAX),
      email: meaningful(row.ORG_EMAIL),
    },
    website: meaningful(row.ORG_WEB),
    securityType: meaningful(row.SECURITY_TYPE),
  };
}

function assertFilterText(value) {
  if (!value || value.length > 80 || /["\\\u0000-\u001f\uFF02]/.test(value)) {
    const error = new Error("invalid query");
    error.statusCode = 400;
    throw error;
  }
}

async function readJson(response) {
  if (!response.ok) {
    throw new Error(`eastmoney http ${response.status}`);
  }
  return response.json();
}

async function fetchOrgRows(filter, fetchImpl) {
  const url = new URL(ORGINFO_URL);
  url.searchParams.set("reportName", "RPT_F10_BASIC_ORGINFO");
  url.searchParams.set("columns", ORG_COLUMNS.join(","));
  url.searchParams.set("filter", filter);
  url.searchParams.set("pageNumber", "1");
  url.searchParams.set("pageSize", "20");
  url.searchParams.set("source", "HSF10");
  url.searchParams.set("client", "PC");

  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/json",
      Referer: "https://emweb.securities.eastmoney.com/",
      "User-Agent": "Mozilla/5.0 (compatible; Compass/0.1)",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await readJson(response);
  if (body.success === false) {
    if (body.code === 9201 || body.message === "返回数据为空") return [];
    throw new Error(body.message || "eastmoney orginfo failed");
  }
  return body.result?.data ?? [];
}

async function suggestCompanies(query, fetchImpl) {
  const url = new URL(SUGGEST_URL);
  url.searchParams.set("input", query);
  url.searchParams.set("type", "14");
  url.searchParams.set("token", PUBLIC_SUGGEST_TOKEN);
  url.searchParams.set("count", "10");

  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/json",
      Referer: "https://www.eastmoney.com/",
      "User-Agent": "Mozilla/5.0 (compatible; Compass/0.1)",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await readJson(response);
  const rows = body?.QuotationCodeTable?.Data ?? [];
  return rows
    .filter((row) => SUGGEST_A_SHARE_MARKETS.has(row.SecurityTypeName) && /^\d{6}$/.test(row.Code ?? ""))
    .map((row) => ({
      code: row.Code,
      name: cleanText(row.Name),
      market: row.SecurityTypeName,
    }));
}

function dedupeCandidates(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!item?.code || seen.has(item.code)) continue;
    seen.add(item.code);
    result.push(item);
  }
  return result.sort((left, right) => left.code.localeCompare(right.code));
}

function toCandidate(row) {
  return {
    code: meaningful(row.SECURITY_CODE),
    name: meaningful(row.SECURITY_NAME_ABBR),
    fullName: meaningful(row.ORG_NAME),
    market: marketLabel(row.SECURITY_TYPE),
  };
}

export async function lookupCompany(rawQuery, fetchImpl = globalThis.fetch) {
  const query = normalizeQuery(rawQuery);
  if (!query) {
    return { kind: "invalid", message: "请输入股票代码或公司名称" };
  }

  const code = normalizeCode(query);
  if (code) {
    const rows = await fetchOrgRows(`(SECURITY_CODE="${code}")`, fetchImpl);
    const row = rows.find((item) => item.SECURITY_CODE === code) ?? rows[0];
    if (!row) return { kind: "empty", message: `没有找到 ${code} 的 A 股基本资料。` };
    if (!isAShareSecurityType(row.SECURITY_TYPE)) {
      return {
        kind: "not-a-share",
        message: `${meaningful(row.SECURITY_CODE)} ${meaningful(row.SECURITY_NAME_ABBR)} 属于${meaningful(row.SECURITY_TYPE)}，当前只展示 A 股。`,
      };
    }
    return { kind: "company", company: mapCompany(row) };
  }

  try {
    assertFilterText(query);
  } catch {
    return { kind: "invalid", message: "请换一个股票代码或公司名称" };
  }

  const [suggestedResult, abbrResult, orgResult] = await Promise.allSettled([
    suggestCompanies(query, fetchImpl),
    fetchOrgRows(`(SECURITY_NAME_ABBR="${query}")`, fetchImpl),
    fetchOrgRows(`(ORG_NAME="${query}")`, fetchImpl),
  ]);
  const failures = [suggestedResult, abbrResult, orgResult].filter((item) => item.status === "rejected");
  if (failures.length === 3) throw failures[0].reason;

  const exactRows = [abbrResult, orgResult]
    .filter((item) => item.status === "fulfilled")
    .flatMap((item) => item.value)
    .filter((row) => isAShareSecurityType(row.SECURITY_TYPE) && /^\d{6}$/.test(row.SECURITY_CODE ?? ""))
    .map(toCandidate);
  const suggested = suggestedResult.status === "fulfilled" ? suggestedResult.value : [];
  const candidates = dedupeCandidates([...exactRows, ...suggested]).slice(0, 8);

  if (candidates.length === 0) {
    if (failures.length > 0) throw failures[0].reason;
    return { kind: "empty", message: `没有找到「${query}」对应的 A 股公司。` };
  }

  const exact = candidates.filter((item) => item.name === query || item.fullName === query);
  const chosen = exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : null;
  if (!chosen || !/^\d{6}$/.test(chosen.code)) {
    return {
      kind: "candidates",
      message: "名称对应多家 A 股公司，请选择一家。",
      candidates: candidates.map(({ code: candidateCode, name, market }) => ({
        code: candidateCode,
        name,
        market,
      })),
    };
  }

  const rows = await fetchOrgRows(`(SECURITY_CODE="${chosen.code}")`, fetchImpl);
  const row = rows.find((item) => item.SECURITY_CODE === chosen.code) ?? rows[0];
  if (!row || !isAShareSecurityType(row.SECURITY_TYPE)) {
    return { kind: "empty", message: `没有找到「${query}」对应的 A 股公司。` };
  }
  return { kind: "company", company: mapCompany(row) };
}
