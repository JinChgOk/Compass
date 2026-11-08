# Compass

查询 A 股公司的 F10 基本信息、近期日线行情，以及关联板块的重要资讯。输入股票代码或公司名称，页面展示代码、简称、全称、行业、上市日期、主营业务、公司简介、注册地、法人、联系方式、公司网站，并给出近 60 个交易日 K 线、重要交易日、关联板块和近 3 日板块快讯。

## 运行

需要 Node.js 20 或更新版本。

```bash
cp .env.example .env
```

在 `.env` 里填写 `TUSHARE_TOKEN`。Token 从 [Tushare Pro](https://tushare.pro) 个人主页获取。没有 Token 时，F10 资料仍然可以查询。

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

日线、关联板块和板块资讯来自 [Tushare Pro](https://tushare.pro) HTTP 接口 `https://api.tushare.pro`：

- 日线：`daily`，未复权。页面保留近 60 个交易日，并标出涨停、跌停、大涨大跌、放量和阶段新高、新低。
- 关联板块：优先 `concept_detail`。取不到时用 `ths_member` 和 `ths_index`。
- 板块资讯：`news`，来源为财联社和东方财富，按板块名称匹配近 3 日标题。

`daily` 大约需要 120 积分。同花顺板块接口积分更高。`news` 需要单独开通「新闻资讯」权限。接口不可用时，页面会保留已经取到的部分，并说明原因。

资料仅供查阅，不构成投资建议。
