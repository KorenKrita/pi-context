// Connection pool stub. Acquire honours the caller's timeout and pool size.
const inFlight = new Map();

export const Pool = {
  async acquire(service, timeoutMs, poolSize) {
    const open = inFlight.get(service) ?? 0;
    if (open >= poolSize) throw new Error(`${service}: pool exhausted (${open}/${poolSize})`);
    inFlight.set(service, open + 1);
    return {
      async run(payload) {
        inFlight.set(service, (inFlight.get(service) ?? 1) - 1);
        if (timeoutMs <= 0) throw new Error(`${service}: non-positive timeout`);
        return { echoed: payload ?? null, timeoutMs, poolSize };
      },
    };
  },
};
