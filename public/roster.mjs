export const ROSTER_LIMIT = 40;
export const BATCH_LIMIT = 12;
export const GROUP_LIMIT = 12;
export const STORE_KEY = "compass.watchlist.v2";
export const LEGACY_KEY = "compass.watchlist.v1";
export const UNGROUPED_ID = "ungrouped";

export function emptyStore() {
  return {
    groups: [{ id: UNGROUPED_ID, name: "未分组" }],
    entries: [],
    selected: [],
  };
}

export function parseStore(rawV2, rawV1) {
  const v2 = asObject(rawV2);
  if (v2) return sanitizeStore(v2);
  const v1 = asArray(rawV1);
  if (v1) {
    const entries = uniqueEntries(v1.map((item) => sanitizeEntry(item, UNGROUPED_ID)).filter(Boolean));
    return sanitizeStore({
      groups: [{ id: UNGROUPED_ID, name: "未分组" }],
      entries,
      selected: entries.map((item) => item.code).slice(0, BATCH_LIMIT),
    });
  }
  return emptyStore();
}

export function addEntry(store, company, groupId) {
  const current = sanitizeStore(store);
  const entry = sanitizeEntry(company, pickGroupId(current, groupId));
  if (!entry) return { store: current, error: "请提供 6 位 A 股代码。" };
  if (current.entries.some((item) => item.code === entry.code)) {
    return { store: current, error: `${entry.name} 已在自选` };
  }
  if (current.entries.length >= ROSTER_LIMIT) {
    return { store: current, error: `自选最多 ${ROSTER_LIMIT} 只，请先移除一只` };
  }
  const entries = [entry, ...current.entries];
  const selected = current.selected.length < BATCH_LIMIT
    ? [entry.code, ...current.selected]
    : current.selected;
  return { store: { ...current, entries, selected }, error: "" };
}

export function removeEntry(store, code) {
  const current = sanitizeStore(store);
  const target = String(code ?? "");
  return {
    ...current,
    entries: current.entries.filter((item) => item.code !== target),
    selected: current.selected.filter((item) => item !== target),
  };
}

export function addGroup(store, rawName, id = "") {
  const current = sanitizeStore(store);
  const name = clipName(rawName);
  if (!name) return { store: current, error: "请填写分组名称" };
  if (current.groups.some((group) => group.name === name)) {
    return { store: current, error: "已有同名分组" };
  }
  if (current.groups.length >= GROUP_LIMIT) {
    return { store: current, error: `分组最多 ${GROUP_LIMIT} 个` };
  }
  const group = { id: sanitizeGroupId(id) || makeGroupId(), name };
  if (current.groups.some((item) => item.id === group.id)) {
    group.id = makeGroupId();
  }
  return { store: { ...current, groups: [...current.groups, group] }, error: "", group };
}

export function renameGroup(store, id, rawName) {
  const current = sanitizeStore(store);
  const name = clipName(rawName);
  if (!name) return { store: current, error: "请填写分组名称" };
  if (!current.groups.some((group) => group.id === id)) return { store: current, error: "没有这个分组" };
  if (current.groups.some((group) => group.name === name && group.id !== id)) {
    return { store: current, error: "已有同名分组" };
  }
  return {
    store: {
      ...current,
      groups: current.groups.map((group) => (group.id === id ? { ...group, name } : group)),
    },
    error: "",
  };
}

export function removeGroup(store, id) {
  const current = sanitizeStore(store);
  if (current.groups.length < 2) return { store: current, error: "至少保留一个分组" };
  if (!current.groups.some((group) => group.id === id)) return { store: current, error: "没有这个分组" };
  const groups = current.groups.filter((group) => group.id !== id);
  const fallback = groups[0].id;
  return {
    store: {
      ...current,
      groups,
      entries: current.entries.map((item) => (item.groupId === id ? { ...item, groupId: fallback } : item)),
    },
    error: "",
  };
}

export function moveEntry(store, code, groupId) {
  const current = sanitizeStore(store);
  const nextGroup = pickGroupId(current, groupId);
  return {
    ...current,
    entries: current.entries.map((item) => (item.code === code ? { ...item, groupId: nextGroup } : item)),
  };
}

export function toggleSelected(store, code, on) {
  const current = sanitizeStore(store);
  const target = String(code ?? "");
  if (!current.entries.some((item) => item.code === target)) return { store: current, error: "" };
  const selected = current.selected.filter((item) => item !== target);
  if (!on) return { store: { ...current, selected }, error: "" };
  if (selected.length >= BATCH_LIMIT) {
    return { store: current, error: `同时最多分析 ${BATCH_LIMIT} 只` };
  }
  return { store: { ...current, selected: [...selected, target] }, error: "" };
}

export function selectGroup(store, groupId, on) {
  const current = sanitizeStore(store);
  const codes = current.entries.filter((item) => item.groupId === groupId).map((item) => item.code);
  if (!on) {
    const drop = new Set(codes);
    return { store: { ...current, selected: current.selected.filter((code) => !drop.has(code)) }, error: "" };
  }
  const selected = [...current.selected];
  let skipped = 0;
  for (const code of codes) {
    if (selected.includes(code)) continue;
    if (selected.length >= BATCH_LIMIT) {
      skipped += 1;
      continue;
    }
    selected.push(code);
  }
  const error = skipped ? `同时最多分析 ${BATCH_LIMIT} 只，这组还有 ${skipped} 只没勾上` : "";
  return { store: { ...current, selected }, error };
}

export function selectedEntries(store) {
  const current = sanitizeStore(store);
  const order = new Map(current.entries.map((item, index) => [item.code, index]));
  return current.selected
    .map((code) => current.entries.find((item) => item.code === code))
    .filter(Boolean)
    .sort((left, right) => (order.get(left.code) ?? 0) - (order.get(right.code) ?? 0));
}

function sanitizeStore(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const groups = uniqueGroups((source.groups ?? []).map(sanitizeGroup).filter(Boolean));
  if (groups.length === 0) groups.push({ id: UNGROUPED_ID, name: "未分组" });
  const known = new Set(groups.map((group) => group.id));
  const fallback = groups[0].id;
  const entries = uniqueEntries((source.entries ?? []).map((item) => {
    const entry = sanitizeEntry(item, known.has(item?.groupId) ? item.groupId : fallback);
    if (!entry) return null;
    if (!known.has(entry.groupId)) entry.groupId = fallback;
    return entry;
  }).filter(Boolean));
  const selected = [];
  for (const code of source.selected ?? []) {
    const text = String(code ?? "");
    if (!/^\d{6}$/.test(text)) continue;
    if (!entries.some((item) => item.code === text)) continue;
    if (selected.includes(text)) continue;
    selected.push(text);
    if (selected.length >= BATCH_LIMIT) break;
  }
  return { groups, entries, selected };
}

function sanitizeEntry(item, groupId = UNGROUPED_ID) {
  const code = String(item?.code ?? "");
  if (!/^\d{6}$/.test(code)) return null;
  return {
    code,
    name: clip(item?.name ?? "", 30) || code,
    securityType: clip(item?.securityType ?? "", 40),
    groupId: sanitizeGroupId(groupId) || UNGROUPED_ID,
  };
}

function sanitizeGroup(item) {
  const id = sanitizeGroupId(item?.id);
  const name = clipName(item?.name);
  if (!id || !name) return null;
  return { id, name };
}

function uniqueGroups(groups) {
  const seen = new Set();
  const names = new Set();
  const list = [];
  for (const group of groups) {
    if (seen.has(group.id) || names.has(group.name)) continue;
    seen.add(group.id);
    names.add(group.name);
    list.push(group);
    if (list.length >= GROUP_LIMIT) break;
  }
  return list;
}

function uniqueEntries(entries) {
  const seen = new Set();
  const list = [];
  for (const entry of entries) {
    if (seen.has(entry.code)) continue;
    seen.add(entry.code);
    list.push(entry);
    if (list.length >= ROSTER_LIMIT) break;
  }
  return list;
}

function pickGroupId(store, groupId) {
  const id = sanitizeGroupId(groupId);
  if (id && store.groups.some((group) => group.id === id)) return id;
  return store.groups[0]?.id || UNGROUPED_ID;
}

function sanitizeGroupId(value) {
  const text = String(value ?? "").trim();
  return /^[a-zA-Z0-9_-]{1,24}$/.test(text) ? text : "";
}

function clipName(value) {
  return clip(value, 12);
}

function clip(value, max) {
  return String(value ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, max);
}

function makeGroupId() {
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function asObject(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function asArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
