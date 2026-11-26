const unknown = "Unknown";
const labelText = {
  "plan-allowance": "Plan allowance",
  measured: "Measured tokens",
  "estimated-api-value": "Estimated API value",
};
const freshnessText = {
  fresh: "Fresh",
  stale: "Stale",
  conflict: "Conflicting readings",
  unavailable: "Quota unavailable",
  unsupported: "Quota unsupported",
  loading: "Loading quota…",
};
const scopeText = { request: "Request scope", turn: "Turn scope", session: "Session scope", account: "Account-wide scope" };
const tierText = { input: "Input", cacheRead: "Cache read", cacheWrite: "Cache write", output: "Output", reasoning: "Reasoning" };
const coverageLimits = {
  "observed-scope": "Figures cover observed scopes only. Handoff attribution is unavailable.",
  "handoff-coverage": "Handoff attribution covers observed scopes only",
};
const exclusion = "Quarantined counter reading (excluded, unverified).";
const integer = new Intl.NumberFormat("en-US");
const tokenCount = (decimal) => integer.format(BigInt(decimal));

export function formatMicros(decimal) {
  const micros = BigInt(decimal);
  const units = integer.format(micros / 1_000_000n);
  return `${units}.${(micros % 1_000_000n).toString().padStart(6, "0")}`;
}

function utc(value, dateOnly = false) {
  if (value === null) return unknown;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return unknown;
  const iso = date.toISOString();
  return dateOnly ? iso.split("T")[0] : iso.replace("T", " ").replace(/(?:\.000)?Z$/, " UTC");
}

function windowDuration(seconds) {
  if (seconds === null) return unknown;
  for (const [unit, length] of [["day", 86400], ["hour", 3600], ["minute", 60], ["second", 1]]) {
    if (seconds >= length && seconds % length === 0) {
      const count = seconds / length;
      return `${count} ${unit}${count === 1 ? "" : "s"}`;
    }
  }
  return "0 seconds";
}

function allowanceEntry(entry) {
  const freshness = entry.state === "ok" ? entry.freshness : entry.state;
  const remaining = freshness === "fresh" ? entry.remaining : null;
  return {
    bucket: entry.bucket,
    window: windowDuration(entry.windowSeconds),
    freshness,
    status: freshnessText[freshness],
    remaining: remaining === null ? unknown : [remaining, entry.units].filter(value => value !== null).join(" "),
    percent: remaining === null ? null : entry.remainingPercent,
    source: entry.sources.join(", "),
    account: entry.account,
    plan: entry.plan,
    reset: utc(entry.resetAt),
    observed: utc(entry.observedAt),
    credits: entry.credits,
    earnedResets: entry.earnedResets,
  };
}

export function usageCardModel(harness, { usage, manage, loading = false, excludedUnverified = false } = {}) {
  const invalid = usage != null && (usage.schema !== 1 || usage.harness !== harness || usage.totals?.label !== "measured" ||
      usage.estimate?.label !== "estimated-api-value" || !Array.isArray(usage.quota?.entries) ||
      !usage.quota.entries.every(entry => entry?.label === "plan-allowance" &&
        Array.isArray(entry.harnesses) && entry.harnesses.includes(harness)));
  if (invalid) {
    usage = undefined;
    manage = undefined;
    loading = false;
    excludedUnverified = false;
  }
  const entries = loading ? [] : (usage?.quota.entries ?? []).map(allowanceEntry);
  const measured = Object.entries(usage?.totals.byScope ?? {}).map(([scope, models]) => ({
    scope: scopeText[scope],
    source: [...new Set(usage.totals.rows.filter(row => row.scope === scope).map(row => row.source))].join(", "),
    models: models.map(({ model, usage: counts }) => ({
      model, tiers: Object.entries(tierText).map(([tier, name]) => [name, tokenCount(counts[tier])]),
    })),
  }));
  const estimates = (usage?.estimate.scopes ?? []).map(({ scope, coverage, currencies }) => {
    const known = currencies.length > 0 && coverage.pricedTokens === coverage.totalTokens;
    return {
      scope: scopeText[scope],
      coverage: `${tokenCount(coverage.pricedTokens)} priced of ${tokenCount(coverage.totalTokens)} total tokens`,
      coverageLimit: coverageLimits[coverage.kind] ?? null,
      known,
      currencies: currencies.map(({ currency, value, rates }) => ({
        currency,
        amount: known ? formatMicros(value) : null,
        rates: rates.map(({ source, effectiveFrom }) => `${source} · ${utc(effectiveFrom, true)}`),
      })),
    };
  });
  const status = invalid ? unknown : loading ? freshnessText.loading : freshnessText.unavailable;
  const allowanceNotices = entries.length
    ? [...new Set(entries.filter(entry => entry.freshness !== "fresh").map(entry => entry.status))]
    : [status];
  if (entries.some(entry => entry.freshness === "fresh" && entry.remaining === unknown)) {
    allowanceNotices.push("Some remaining allowances are unknown");
  }
  return {
    allowance: { label: labelText["plan-allowance"], entries, status, manage },
    measured: { label: labelText.measured, groups: measured, exclusion: excludedUnverified ? exclusion : null },
    estimate: { label: labelText["estimated-api-value"], groups: estimates },
    allowanceNotices,
    announcement: [allowanceNotices.length && allowanceNotices.join(". ") + (loading ? "" : "."), excludedUnverified && exclusion,
      (!estimates.length || estimates.some(group => !group.known)) && "Estimated API value is unknown."].filter(Boolean).join(" "),
  };
}

export function usageCardSummary({ allowance: { entries, status } }) {
  const first = entries[0];
  if (!first) return { text: status, percent: null };
  const remaining = first.percent === null ? first.remaining : `${first.percent}% left`;
  return {
    text: first.freshness === "fresh" ? `${remaining} · ${first.bucket}` : `${first.status} · ${remaining}`,
    percent: first.percent,
  };
}

export function renderUsageCard({ allowance, measured, estimate }, escapeText) {
  const data = (name, value) => `<div><dt>${escapeText(name)}</dt><dd>${escapeText(value)}</dd></div>`;
  const window = (entry) => `<div class="usage-group">
    <h4>${escapeText(entry.bucket)}</h4>
    <p class="usage-freshness">${escapeText(entry.status)}</p>
    <dl class="usage-facts">
      ${entry.window === entry.bucket ? "" : data("Window", entry.window)}
      ${data("Remaining", entry.remaining)}
      ${data("Reported reset", entry.reset)}
      ${data("Observed", entry.observed)}
      ${data("Source", entry.source)}
      ${data("Account", entry.account)}
      ${data("Plan", entry.plan)}
      ${entry.credits === null ? "" : data("Credits", entry.credits)}
      ${entry.earnedResets === null ? "" : data("Earned resets", entry.earnedResets)}
    </dl>
    ${entry.percent === null ? "" : `<p class="usage-percent">${escapeText(entry.percent)}% left</p>
      <progress max="100" value="${escapeText(entry.percent)}" aria-hidden="true"></progress>`}
  </div>`;
  const measuredGroup = ({ scope, source, models }) => `<div class="usage-group">
    <h4>${escapeText(scope)}</h4>
    ${source ? `<dl class="usage-facts">${data("Source", source)}</dl>` : ""}
    ${models.map(({ model, tiers }) => `<div><h5>${escapeText(model)}</h5>
      <dl class="usage-facts">${tiers.map(([name, value]) => data(name, value)).join("")}</dl></div>`).join("")}
  </div>`;
  const estimateGroup = ({ scope, coverage, coverageLimit, known, currencies }) => `<div class="usage-group">
    <h4>${escapeText(scope)}</h4>
    ${known ? "" : `<p>${unknown}</p>`}
    <p class="panel-note">${escapeText(coverage)}</p>
    ${currencies.map(({ currency, amount, rates }) => `<dl class="usage-facts">
      ${amount === null ? data("Currency", currency) : data(currency, amount)}
      ${data("Rate source and date", rates.join(", "))}
    </dl>`).join("")}
    ${coverageLimit ? `<p class="panel-note">${escapeText(coverageLimit)}</p>` : ""}
  </div>`;

  return `<div class="harness-usage" role="region" aria-label="Harness usage" tabindex="0">
    <section class="usage-block">
      <h3>${escapeText(allowance.label)}</h3>
      ${allowance.entries.length ? allowance.entries.map(window).join("") : `<p>${escapeText(allowance.status)}</p>`}
      ${allowance.manage ? `<dl class="usage-facts">${data("Manage plan", allowance.manage)}</dl>` : ""}
    </section>
    <section class="usage-block">
      <h3>${escapeText(measured.label)}</h3>
      ${measured.exclusion ? `<p class="notice">${escapeText(measured.exclusion)}</p>` : ""}
      ${measured.groups.length ? measured.groups.map(measuredGroup).join("") : `<p>${unknown}</p>`}
    </section>
    <section class="usage-block">
      <h3>${escapeText(estimate.label)}</h3>
      ${estimate.groups.length ? estimate.groups.map(estimateGroup).join("") : `<p>${unknown}</p>`}
    </section>
  </div>`;
}
