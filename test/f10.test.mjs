import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { ORG_COLUMNS, lookupCompany, mapCompany, normalizeCode, normalizeQuery } from "../lib/f10.mjs";
import { createServer } from "../server.mjs";

const companyRow = {
  SECURITY_CODE: "600519",
  SECURITY_NAME_ABBR: "贵州茅台",
  ORG_NAME: "贵州茅台酒股份有限公司",
  EM2016: "食品饮料-饮料-白酒",
  INDUSTRYCSRC1: "制造业-酒、饮料和精制茶制造业",
  LISTING_DATE: "2001-08-27 00:00:00",
  MAIN_BUSINESS: "茅台酒及系列酒的生产与销售",
  ORG_PROFILE: "  贵州茅台酒股份有限公司成立于1999年。",
  REG_ADDRESS: "贵州省仁怀市茅台镇",
  LEGAL_PERSON: "陈华",
  ORG_TEL: "0851-22386002",
  ORG_EMAIL: "mtdm@moutaichina.com",
  ORG_FAX: "--",
  ORG_WEB: "www.moutaichina.com",
  SECURITY_TYPE: "上交所主板A股",
};

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function mockFetch(handler) {
  return async (input) => {
    const url = new URL(input);
    return jsonResponse(handler(url));
  };
}

test("normalizes codes and fullwidth input", () => {
  assert.equal(normalizeCode("600519"), "600519");
  assert.equal(normalizeCode(" sh600519 "), "600519");
  assert.equal(normalizeCode("000001.SZ"), "000001");
  assert.equal(normalizeCode("BJ920799"), "920799");
  assert.equal(normalizeCode("６００５１９"), "600519");
  assert.equal(normalizeCode("贵州茅台"), null);
  assert.equal(normalizeQuery("中国平安保险（集团）股份有限公司"), "中国平安保险(集团)股份有限公司");
});

test("maps an F10 row onto the page fields", () => {
  const company = mapCompany(companyRow);
  assert.equal(company.code, "600519");
  assert.equal(company.name, "贵州茅台");
  assert.equal(company.fullName, "贵州茅台酒股份有限公司");
  assert.equal(company.industry, "食品饮料-饮料-白酒");
  assert.equal(company.listingDate, "2001-08-27");
  assert.equal(company.mainBusiness, "茅台酒及系列酒的生产与销售");
  assert.equal(company.profile, "贵州茅台酒股份有限公司成立于1999年。");
  assert.equal(company.registeredAddress, "贵州省仁怀市茅台镇");
  assert.equal(company.legalPerson, "陈华");
  assert.deepEqual(company.contact, {
    phone: "0851-22386002",
    fax: "",
    email: "mtdm@moutaichina.com",
  });
  assert.equal(company.website, "www.moutaichina.com");
  assert.ok(ORG_COLUMNS.includes("MAIN_BUSINESS"));
  assert.ok(ORG_COLUMNS.includes("ORG_PROFILE"));
});

test("falls back to the CSRC industry when East Money industry is empty", () => {
  const company = mapCompany({ ...companyRow, EM2016: "  " });
  assert.equal(company.industry, "制造业-酒、饮料和精制茶制造业");
});

test("looks up a code and keeps the code inside a quoted filter", async () => {
  const filters = [];
  const fetchImpl = mockFetch((url) => {
    filters.push(url.searchParams.get("filter"));
    return { success: true, result: { data: [companyRow] } };
  });
  const result = await lookupCompany("SH600519", fetchImpl);
  assert.equal(result.kind, "company");
  assert.equal(result.company.name, "贵州茅台");
  assert.deepEqual(filters, ['(SECURITY_CODE="600519")']);
});

test("rejects a B-share code", async () => {
  const fetchImpl = mockFetch(() => ({
    success: true,
    result: {
      data: [{ ...companyRow, SECURITY_CODE: "200725", SECURITY_NAME_ABBR: "京东方B", SECURITY_TYPE: "深交所主板B股" }],
    },
  }));
  const result = await lookupCompany("200725", fetchImpl);
  assert.equal(result.kind, "not-a-share");
  assert.match(result.message, /B股/);
});

test("returns candidates for an ambiguous name and drops non-A shares", async () => {
  const fetchImpl = mockFetch((url) => {
    if (url.hostname.includes("searchadapter")) {
      return {
        QuotationCodeTable: {
          Data: [
            { Code: "000001", Name: "平安银行", SecurityTypeName: "深A" },
            { Code: "601318", Name: "中国平安", SecurityTypeName: "沪A" },
            { Code: "02318", Name: "中国平安", SecurityTypeName: "港股" },
            { Code: "000001", Name: "上证指数", SecurityTypeName: "指数" },
          ],
        },
      };
    }
    return { success: false, code: 9201, message: "返回数据为空" };
  });
  const result = await lookupCompany("平安", fetchImpl);
  assert.equal(result.kind, "candidates");
  assert.deepEqual(
    result.candidates.map((item) => item.code),
    ["000001", "601318"],
  );
});

test("resolves a full legal name from the org info report", async () => {
  const fetchImpl = mockFetch((url) => {
    const filter = url.searchParams.get("filter");
    if (url.hostname.includes("searchadapter")) return { QuotationCodeTable: { Data: [] } };
    if (filter?.startsWith("(ORG_NAME=")) {
      return { success: true, result: { data: [companyRow] } };
    }
    if (filter === '(SECURITY_CODE="600519")') {
      return { success: true, result: { data: [companyRow] } };
    }
    return { success: false, code: 9201, message: "返回数据为空" };
  });
  const result = await lookupCompany("贵州茅台酒股份有限公司", fetchImpl);
  assert.equal(result.kind, "company");
  assert.equal(result.company.code, "600519");
});

test("treats an unknown code as empty instead of an upstream error", async () => {
  const fetchImpl = mockFetch(() => ({ success: false, code: 9201, message: "返回数据为空" }));
  const result = await lookupCompany("999999", fetchImpl);
  assert.equal(result.kind, "empty");
});

test("rejects filter-breaking names", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error("should not fetch");
  };
  const result = await lookupCompany('茅台" OR ', fetchImpl);
  assert.equal(result.kind, "invalid");
  assert.equal(called, false);
});

test("serves the page and the lookup API", async () => {
  const server = createServer({
    lookup: async () => ({ kind: "company", company: mapCompany(companyRow) }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /股票代码或公司名称/);
    assert.match(html, /主营业务/);

    const api = await fetch(`http://127.0.0.1:${port}/api/company?q=600519`);
    const body = await api.json();
    assert.equal(body.company.legalPerson, "陈华");

    const missing = await fetch(`http://127.0.0.1:${port}/..%2fpackage.json`);
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});

test("hides upstream failures behind a short error", async () => {
  const server = createServer({
    lookup: async () => {
      throw new Error("secret upstream detail");
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/company?q=600519`);
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.kind, "error");
    assert.doesNotMatch(body.message, /secret/);
  } finally {
    server.close();
  }
});

test("live East Money F10 for 600519", { skip: !process.env.LIVE_F10 }, async () => {
  const result = await lookupCompany("600519");
  assert.equal(result.kind, "company");
  assert.equal(result.company.code, "600519");
  assert.equal(result.company.name, "贵州茅台");
  assert.match(result.company.fullName, /贵州茅台酒/);
  assert.ok(result.company.industry);
  assert.match(result.company.listingDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(result.company.mainBusiness);
  assert.ok(result.company.profile.length > 20);
  assert.ok(result.company.registeredAddress);
  assert.ok(result.company.legalPerson);
  assert.ok(result.company.contact.phone);
  assert.match(result.company.website, /moutai/i);

  const ambiguous = await lookupCompany("平安");
  assert.equal(ambiguous.kind, "candidates");
  assert.ok(ambiguous.candidates.some((item) => item.code === "000001"));
  assert.ok(ambiguous.candidates.some((item) => item.code === "601318"));
});
