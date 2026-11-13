export const CACHE_LIMIT = 300;

export const sharedCache = new Map();

const flights = new WeakMap();

function flightMap(cache) {
  let pending = flights.get(cache);
  if (!pending) {
    pending = new Map();
    flights.set(cache, pending);
  }
  return pending;
}

function readFresh(cache, key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

function writeEntry(cache, key, ttlMs, value, limit) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, { expires: Date.now() + ttlMs, value });
  const now = Date.now();
  for (const [name, entry] of cache) {
    if (entry.expires <= now) cache.delete(name);
  }
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined || (oldest === key && cache.size === 1)) break;
    cache.delete(oldest);
  }
}

export function throughCache(cache, key, ttlMs, loader, limit = CACHE_LIMIT) {
  const fresh = readFresh(cache, key);
  if (fresh !== undefined) return Promise.resolve(fresh);
  const pending = flightMap(cache);
  const existing = pending.get(key);
  if (existing) return existing;
  const flight = Promise.resolve()
    .then(loader)
    .then((value) => {
      writeEntry(cache, key, ttlMs, value, limit);
      return value;
    })
    .finally(() => {
      if (pending.get(key) === flight) pending.delete(key);
    });
  pending.set(key, flight);
  return flight;
}
