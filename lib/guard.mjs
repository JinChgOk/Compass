const WINDOW_MS = 10 * 60 * 1000;

const DEFAULT_CLIENT = { market: 30, watch: 60, analysis: 40 };
const DEFAULT_GLOBAL = { market: 60, watch: 80, analysis: 50 };

function busy() {
  const error = new Error("查询太密，请过一会儿再看。");
  error.status = 429;
  return error;
}

export function clientKey(request) {
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  const ip = forwarded.split(",")[0].trim() || request.headers.get("x-real-ip") || "";
  return ip.replace(/[\u0000-\u001f]/g, "").slice(0, 80) || "local";
}

export function createPaidGuard({
  windowMs = WINDOW_MS,
  clientLimits = {},
  globalLimits = {},
  activeLimit = 3,
  queueLimit = 12,
  waitMs = 25_000,
  cacheLimit = 80,
  now = Date.now,
} = {}) {
  const perClient = { ...DEFAULT_CLIENT, ...clientLimits };
  const perGlobal = { ...DEFAULT_GLOBAL, ...globalLimits };
  const clients = new Map();
  const globals = new Map();
  const responses = new Map();
  const flights = new Map();
  const waiters = [];
  let active = 0;

  function bucket(map, key) {
    let list = map.get(key);
    if (!list) {
      list = [];
      map.set(key, list);
    }
    return list;
  }

  function allow(route, client) {
    const nowMs = now();
    const lists = [bucket(globals, route), bucket(clients, `${client}|${route}`)];
    const caps = [perGlobal[route], perClient[route]];
    for (const list of lists) {
      while (list.length && list[0] <= nowMs - windowMs) list.shift();
    }
    if (lists.some((list, index) => list.length >= caps[index])) return busy();
    for (const list of lists) list.push(nowMs);
    while (clients.size > 500) {
      const oldest = clients.keys().next().value;
      clients.delete(oldest);
    }
    return null;
  }

  function release() {
    const next = waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
      return;
    }
    active -= 1;
  }

  function acquire() {
    if (active < activeLimit) {
      active += 1;
      return Promise.resolve(release);
    }
    if (waiters.length >= queueLimit) return Promise.reject(busy());
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = waiters.indexOf(entry);
          if (index >= 0) waiters.splice(index, 1);
          reject(busy());
        }, waitMs),
      };
      waiters.push(entry);
    }).then(() => release);
  }

  function readResponse(key) {
    const hit = responses.get(key);
    if (!hit) return undefined;
    if (hit.expires <= now()) {
      responses.delete(key);
      return undefined;
    }
    responses.delete(key);
    responses.set(key, hit);
    return hit.value;
  }

  function writeResponse(key, ttlMs, value) {
    if (responses.has(key)) responses.delete(key);
    responses.set(key, { expires: now() + ttlMs, value });
    while (responses.size > cacheLimit) {
      const oldest = responses.keys().next().value;
      responses.delete(oldest);
    }
  }

  return {
    async run({ route, client, cacheKey = null, ttlMs = 0, task }) {
      if (cacheKey) {
        const hit = readResponse(cacheKey);
        if (hit !== undefined) return hit;
        const pending = flights.get(cacheKey);
        if (pending) return pending;
      }
      const flight = execute();
      if (cacheKey) flights.set(cacheKey, flight);
      return flight;

      async function execute() {
        try {
          const denied = allow(route, client);
          if (denied) throw denied;
          const releaseSlot = await acquire();
          try {
            const value = await task();
            if (cacheKey && value && value.configured !== false) writeResponse(cacheKey, ttlMs, value);
            return value;
          } finally {
            releaseSlot();
          }
        } finally {
          if (cacheKey && flights.get(cacheKey) === flight) flights.delete(cacheKey);
        }
      }
    },
  };
}

export const paidGuard = createPaidGuard();
