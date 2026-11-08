# Compass

查询 A 股公司的 F10 基本信息。输入股票代码或公司名称，页面展示代码、简称、全称、行业、上市日期、主营业务、公司简介、注册地、法人、联系方式、公司网站。

## 运行

需要 Node.js 20 或更新版本。

```bash
npm start
```

浏览器打开 <http://localhost:3000>，输入 `600519`。

名称不唯一时会先列出候选公司。例如输入「平安」，再选择「中国平安」或「平安银行」。

```bash
npm test
```

## 数据来源

公司资料来自东方财富数据中心公开接口 `RPT_F10_BASIC_ORGINFO`（`https://datacenter.eastmoney.com/securities/api/data/v1/get`，`source=HSF10`）。

按简称或全称检索时，会同时查询该接口的精确名称，并用东方财富搜索建议接口（`https://searchadapter.eastmoney.com/api/suggest/get`）补全简称。行业优先用东方财富行业分类，没有时用证监会行业。

资料仅供查阅，不构成投资建议。
