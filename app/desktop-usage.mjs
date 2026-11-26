import { formatMicros } from "./usage-card.mjs";

const periods = [["today", "Today"], ["last7", "Last 7 days"], ["last30", "Last 30 days"]];
const providers = [["claude", "Claude"], ["codex", "Codex"]];
const integer = new Intl.NumberFormat("en-US");
const time = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const tokens = (value) => value == null ? "Unknown" : integer.format(BigInt(value));
const money = (value) => value == null ? "Unknown" : `USD ${formatMicros(value)}`;
const maxAge = 15 * 60_000;

function expires(entry) {
  return Math.min(entry.observedAt + maxAge + 1, entry.resetAt ?? Infinity);
}

const age = new Intl.RelativeTimeFormat("en", { numeric: "always" });
const quantity = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function readingAge(elapsed) {
  const seconds = Math.floor(Math.max(0, elapsed) / 1000);
  if (seconds < 60) return age.format(-seconds, "second");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return age.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? age.format(-hours, "hour") : age.format(-Math.floor(hours / 24), "day");
}

function allowance(document, escapeText, now) {
  const reason = document.local.allowanceReason === "no-statusline"
    ? "No Claude Code status line snapshot." : "No rate limit reading in local rollout files.";
  const rows = document.quota.entries.map((entry) => {
    const stale = entry.freshness === "stale" || now >= expires(entry);
    const credits = entry.bucket === "Credits";
    const label = credits ? "Current balance" : "Current remaining";
    const reported = credits ? entry.credits : entry.lastRemaining;
    const current = credits ? entry.credits : entry.remaining;
    const format = (amount) => amount == null ? "Unknown" : `${quantity.format(amount)}${credits ? " credits" : "%"}`;
    const observed = time.format(entry.observedAt);
    const detail = stale
      ? `Stale · Last reported ${format(reported)} · ${readingAge(now - entry.observedAt)} · ${observed}`
      : `Read ${observed}`;
    return `<li><strong>${escapeText(entry.bucket)}</strong> · ${label} ${escapeText(format(stale ? null : current))}
      <span class="panel-note">${escapeText(detail)}</span>
    </li>`;
  });
  return rows.length ? `<ul class="local-allowance">${rows.join("")}</ul>` : `<p>Unknown <span class="panel-note">${reason}</span></p>`;
}

function amounts(group) {
  const value = money(group.estimatedMicros);
  const amount = group.estimatedMicros === null && group.pricedMicros !== null
    ? `${value} <span class="panel-note">Priced part ${money(group.pricedMicros)}</span>` : value;
  const unreadable = group.unreadableReadings;
  const count = tokens(group.tokens);
  const lowerBound = unreadable > 0 && group.tokens !== null ? `at least ${count}` : count;
  const skipped = unreadable > 0
    ? `<span class="panel-note">${integer.format(unreadable)} unreadable ${unreadable === 1 ? "reading" : "readings"}</span>` : "";
  const pricedTokens = group.tokens === null ? ""
    : ` · ${tokens(group.pricedTokens)} of ${count} ${unreadable > 0 ? "measured " : ""}tokens`;
  const coverage = group.observations && group.pricedObservations !== group.observations
    ? `<span class="panel-note">${integer.format(group.pricedObservations)} of ${integer.format(group.observations)} readings priced${pricedTokens}</span>` : "";
  return `<dl class="usage-facts">
    <div><dt>Measured tokens</dt><dd>${lowerBound}${skipped}</dd></div>
    <div><dt>Estimated API value</dt><dd>${amount}${coverage}</dd></div>
  </dl>`;
}

export function renderLocalUsage(documents, period, project, escapeText, now = Date.now()) {
  return providers.map(([provider, name]) => {
    const document = documents[provider];
    const range = document.local.periods.find((range) => range.period === period);
    const group = project === null ? range : range.projects[project];
    const skipped = document.local.skipped;
    const models = group.models.length ? `<details>
      <summary>By model</summary><ul class="local-models">${group.models.map((model) =>
        `<li><strong>${escapeText(model.model)}</strong>${amounts(model)}</li>`).join("")}</ul>
    </details>` : "";
    return `<article class="usage-block">
      <h3>${name}</h3>
      ${document.local.available ? "" : '<p class="panel-note">Local files unavailable.</p>'}
      ${skipped ? `<p class="panel-note">${integer.format(skipped)} skipped lines or sources.</p>` : ""}
      ${amounts(group)}${models}
      <h4>Plan allowance</h4>${allowance(document, escapeText, now)}
    </article>`;
  }).join("");
}

export function mountLocalUsage({ invoke, byId, escapeText }) {
  let projects = [];
  let project = "";
  let period = "today";
  let binding = null;
  let running = false;
  let state = { status: "loading" };
  let timer;
  const views = ["dashboard", "harness"].map((page) => {
    const root = byId(`${page}-local-usage`);
    const title = `${page}-local-usage-title`;
    root.setAttribute("aria-labelledby", title);
    root.innerHTML = `<header class="panel-head">
      <h2 id="${title}">Local usage</h2>
      <button id="${page}-local-refresh" type="button" class="outline action" aria-label="Refresh local usage">Refresh</button>
    </header>
    <div class="local-usage-controls">
      <label>Period <select id="${page}-local-period">${periods.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label>
      ${page === "dashboard" ? '<label>Project <select id="dashboard-local-project"></select></label>' : ""}
    </div>
    <p id="${page}-local-status" class="panel-note" role="status" aria-atomic="true"></p>
    <div id="${page}-local-grid" class="local-usage-grid"></div>`;
    root.hidden = false;
    const refresh = byId(`${page}-local-refresh`);
    const periodSelect = byId(`${page}-local-period`);
    const projectSelect = page === "dashboard" ? byId("dashboard-local-project") : null;
    refresh.addEventListener("click", load);
    periodSelect.addEventListener("change", () => { period = periodSelect.value; render(); });
    projectSelect?.addEventListener("change", () => { project = projectSelect.value; render(); });
    return { refresh, periodSelect, projectSelect, status: byId(`${page}-local-status`), grid: byId(`${page}-local-grid`) };
  });

  function render() {
    clearTimeout(timer);
    const now = Date.now();
    const ready = state.status === "ready";
    const message = ready ? `Read ${time.format(state.observedAt)}`
      : state.status === "loading" ? "Loading usage…" : "Usage unavailable. Refresh to try again.";
    for (const view of views) {
      view.refresh.setAttribute("aria-disabled", String(running || binding === null));
      view.periodSelect.value = period;
      if (view.projectSelect) view.projectSelect.value = project;
      const status = `Local files on this Mac · ${message}`;
      if (view.status.textContent !== status) view.status.textContent = status;
      const slot = view.projectSelect && project ? projects.findIndex(({ id }) => id === project) : -1;
      const expanded = [...view.grid.querySelectorAll("details")].map((row) => row.open);
      view.grid.innerHTML = ready ? renderLocalUsage(state.documents, period, slot < 0 ? null : slot, escapeText, now) : "";
      view.grid.querySelectorAll("details").forEach((row, index) => { row.open = expanded[index] ?? false; });
    }
    if (ready) {
      const entries = Object.values(state.documents).flatMap((document) => document.quota.entries);
      const next = entries.map(expires).map((deadline) => deadline > now ? deadline - now : 60_000);
      if (next.length) {
        timer = setTimeout(render, Math.min(...next));
        timer?.unref?.();
      }
    }
  }

  async function load() {
    if (running || binding === null) return;
    const requested = binding;
    running = true;
    state = { status: "loading" };
    render();
    let response;
    try { response = await invoke("local_usage", { projectIds: projects.map(({ id }) => id) }); }
    catch { response = null; }
    running = false;
    if (binding !== requested) return load();
    state = response?.status === "ready" ? response : { status: "unavailable" };
    render();
  }

  render();
  return {
    setProjects(list) {
      // A relink can change a saved path without changing the project ID.
      const next = JSON.stringify(list.map(({ id, name, path, folder }) => [id, name, path, folder]));
      if (binding === next) return;
      binding = next;
      projects = list;
      if (!projects.some(({ id }) => id === project)) project = "";
      for (const { projectSelect } of views) {
        if (projectSelect) projectSelect.innerHTML = '<option value="">All local usage</option>' + projects.map(({ id, name }) =>
          `<option value="${escapeText(id)}">${escapeText(name)}</option>`).join("");
      }
      load();
    },
  };
}
