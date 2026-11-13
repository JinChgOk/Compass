import assert from "node:assert/strict";
import test from "node:test";
import {
  BATCH_LIMIT,
  addEntry,
  addGroup,
  moveEntry,
  parseStore,
  removeEntry,
  removeGroup,
  renameGroup,
  selectGroup,
  selectedEntries,
  toggleSelected,
} from "../public/roster.mjs";

test("migrates the old watchlist into an ungrouped roster", () => {
  const store = parseStore(null, JSON.stringify([
    { code: "600519", name: "贵州茅台", securityType: "上交所主板A股" },
    { code: "000858", name: "五粮液" },
    { code: "bad" },
  ]));
  assert.equal(store.groups[0].name, "未分组");
  assert.equal(store.entries.map((item) => item.code).join(","), "600519,000858");
  assert.deepEqual(store.selected, ["600519", "000858"]);
});

test("adds, groups, and caps a batch for analysis", () => {
  let store = parseStore(null, "[]");
  const grouped = addGroup(store, "白酒", "baijiu");
  assert.equal(grouped.error, "");
  store = grouped.store;
  const maotai = addEntry(store, { code: "600519", name: "贵州茅台" }, "baijiu");
  store = maotai.store;
  const wuliang = addEntry(store, { code: "000858", name: "五粮液" }, "ungrouped");
  store = wuliang.store;
  assert.equal(store.entries[0].groupId, "ungrouped");
  store = moveEntry(store, "000858", "baijiu");
  assert.equal(store.entries.find((item) => item.code === "000858").groupId, "baijiu");
  store = toggleSelected(store, "000858", false).store;
  assert.deepEqual(store.selected, ["600519"]);
  const picked = selectGroup(store, "baijiu", true);
  assert.deepEqual(picked.store.selected.sort(), ["000858", "600519"]);
  const names = selectedEntries(picked.store).map((item) => item.name);
  assert.deepEqual(names, ["五粮液", "贵州茅台"]);
});

test("refuses a thirteenth checkbox and keeps the last group", () => {
  let store = parseStore({
    groups: [{ id: "ungrouped", name: "未分组" }],
    entries: Array.from({ length: BATCH_LIMIT }, (_, index) => ({
      code: String(600000 + index),
      name: `股${index}`,
      groupId: "ungrouped",
    })),
    selected: Array.from({ length: BATCH_LIMIT }, (_, index) => String(600000 + index)),
  });
  store = addEntry(store, { code: "300750", name: "宁德时代" }, "ungrouped").store;
  const blocked = toggleSelected(store, "300750", true);
  assert.match(blocked.error, /最多分析 12/);
  assert.equal(blocked.store.selected.includes("300750"), false);
  const extra = addGroup(store, "观察", "watch");
  store = extra.store;
  const removed = removeGroup(store, "watch");
  assert.equal(removed.error, "");
  const last = removeGroup(removed.store, "ungrouped");
  assert.match(last.error, /至少保留/);
  const renamed = renameGroup(removed.store, "ungrouped", "核心");
  assert.equal(renamed.store.groups[0].name, "核心");
  store = removeEntry(renamed.store, "600000");
  assert.equal(store.entries.some((item) => item.code === "600000"), false);
  assert.equal(store.selected.includes("600000"), false);
});
