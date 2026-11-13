const WINDOW_MS = 60_000;
const KEEP = 4000;

export function createCallMeter({ windowMs = WINDOW_MS, now = Date.now } = {}) {
  const stamps = [];

  function prune(at) {
    const floor = at - windowMs;
    while (stamps.length && stamps[0] <= floor) stamps.shift();
    if (stamps.length > KEEP) stamps.splice(0, stamps.length - KEEP);
  }

  return {
    note(at = now()) {
      stamps.push(at);
      prune(at);
    },
    count(at = now()) {
      prune(at);
      return stamps.length;
    },
    reset() {
      stamps.length = 0;
    },
  };
}

const meter = createCallMeter();

export function noteOutboundCall(at) {
  meter.note(at);
}

export function callsInWindow(at) {
  return meter.count(at);
}

export function resetCallMeter() {
  meter.reset();
}
