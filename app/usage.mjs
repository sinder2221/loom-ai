export const tokenLabels = { input: "Input", output: "Output", cacheRead: "Cache read", cacheWrite: "Cache write" };
const tokenTypes = Object.keys(tokenLabels);

export const usageMessages = {
  loading: "Loading usage…",
  unavailable: "Usage is unavailable.",
  stale: "Showing the last available usage.",
};

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sum(values) {
  return values.includes(null) ? null : values.reduce((total, value) => total + value, 0);
}

export function measureRun(record) {
  const tokens = Object.fromEntries(tokenTypes.map((type) => [type, count(record.tokens?.[type])]));
  const rates = Object.fromEntries(tokenTypes.map((type) => {
    const value = record.rates?.[type];
    return [type, Number.isFinite(value) && value >= 0 ? value : null];
  }));
  const tokenTotal = sum(Object.values(tokens));
  const canPrice = tokenTotal !== null && Object.values(rates).some((rate) => rate !== null) &&
    tokenTypes.every((type) => tokens[type] === 0 || rates[type] !== null);
  const value = canPrice
    ? tokenTypes.reduce((total, type) => total + (tokens[type] === 0 ? 0 : tokens[type] * rates[type]), 0) / 1_000_000
    : null;
  const build = record.build;
  const buildState = ["queued", "running", "passed", "failed", "skipped"].includes(build?.state) ? build.state : "unknown";
  return {
    runId: record.runId, projectId: record.projectId, seconds: count(record.seconds), turns: count(record.turns),
    tokens, rates, tokenTotal, estimate: Number.isFinite(value) ? value : null,
    build: { state: buildState, completed: count(build?.completed), total: count(build?.total), detail: build?.detail },
  };
}

export function summarizeUsage(snapshots) {
  const known = snapshots.filter(({ records }) => records);
  const records = known.flatMap(({ records }) => records);
  const priced = records.filter(({ estimate }) => estimate !== null);
  const hasData = records.length > 0 || snapshots.length === known.length;
  const totalFor = (read) => hasData ? sum(records.map(read)) : null;
  const tokenTotal = totalFor((run) => run.tokenTotal);
  const seconds = totalFor((run) => run.seconds);
  const completedChecks = totalFor(({ build }) => build.completed);
  const plannedChecks = totalFor(({ build }) => build.total);
  return {
    hasData,
    knownProjects: known.length,
    runCount: records.length,
    tokenTotal, seconds, completedChecks, plannedChecks,
    tokens: Object.fromEntries(tokenTypes.map((type) => [type, totalFor(({ tokens }) => tokens[type])])),
    pricedCount: priced.length,
    unknownPrices: records.length - priced.length,
    estimate: priced.length ? sum(priced.map(({ estimate }) => estimate)) : null,
    unknownUsage: hasData && ([tokenTotal, seconds, completedChecks, plannedChecks].includes(null) ||
      records.some(({ build, turns }) => build.state === "unknown" || turns === null)),
  };
}
