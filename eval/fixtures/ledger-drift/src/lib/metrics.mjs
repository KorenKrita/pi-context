// Metrics stub: records observations in memory so verification can inspect them.
const observations = [];
const counters = new Map();

export const metrics = {
  observe(name, value) { observations.push({ name, value }); },
  count(name) { counters.set(name, (counters.get(name) ?? 0) + 1); },
  snapshot() { return { observations: [...observations], counters: Object.fromEntries(counters) }; },
};
