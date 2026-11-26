import { activityFixture, chatDetailFixture, demo, usageFixture } from "./demo-data.mjs";
import { projectActivity } from "./activity.mjs";
import { chatHistory, deliveryStatus, replyError, replyLimit } from "./chat-details.mjs";
import { createEditResultView } from "./edit-result-view.mjs";
import { fixtureActivityStore, fixtureChatActions, fixtureChatDetailStore, fixtureEditResultStore, fixtureFolderPicker, fixtureHarnessCatalog, fixtureHarnessUsage, fixtureOpenChat, fixtureProjectStore, fixtureUsageStore } from "./fixtures.mjs";
import { summarizeUsage, tokenLabels, usageMessages } from "./usage.mjs";
import { goals } from "./wizard.mjs";
import { mountWizard } from "./wizard-view.mjs";

const byId = (id) => document.getElementById(id);
const nativeInvoke = globalThis.window?.__TAURI_INTERNALS__?.invoke;
const desktopStore = typeof nativeInvoke === "function"
  ? (await import("./desktop-store.mjs")).createDesktopProjectStore(nativeInvoke)
  : null;
const desktopReady = desktopStore ? Promise.withResolvers() : null;
const desktopActivity = desktopStore ? (await import("./desktop-activity.mjs")).mountProjectActivity({
  byId, store: desktopStore, escapeText, panelHeader, badge, setLiveText,
}) : null;
const harnesses = desktopStore ? (await import("./desktop-harnesses.mjs")).mountHarnesses({
  byId, store: desktopStore, projectsReady: desktopReady.promise, escapeText, setLiveText,
}) : null;
const localUsage = desktopStore ? (await import("./desktop-usage.mjs")).mountLocalUsage({
  invoke: nativeInvoke, byId, escapeText,
}) : null;
let loadingProjects = Boolean(desktopStore);
let connectingProjects = false;
let announcedRegistration = new Map();
const relinkFeedback = new Map();
const announcedRelinks = new Map();
let relinkOperation;
let relinkScreen = 0;
const layouts = {
  overview: ["project-activity", "map", "detail", "board", "builds"],
  board: ["board", "detail", "project-activity", "map", "builds"],
  build: ["builds", "detail", "project-activity", "board", "map"],
};
const runLabels = { waiting: "Needs reply", running: "Running", completed: "Completed", failed: "Failed" };
const buildLabels = { queued: "Build queued", running: "Checks running", passed: "Checks passed", failed: "Checks failed", skipped: "No build", unknown: "Build status unknown" };
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const rateMoney = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
const integer = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const params = new URLSearchParams(location.search);
const requestedFixture = params.get("fixture");
const fixture = ["empty", "no-harness"].includes(requestedFixture) ? requestedFixture : "default";
const storagePrefix = `project-loom.fixture.v1.${fixture}`;
const projects = desktopStore || fixture === "empty" ? [] : demo.projects;
const activitySeed = activityFixture({
  empty: Boolean(desktopStore) || fixture === "empty", scenario: desktopStore ? undefined : params.get("activity"),
});
const activityStore = fixtureActivityStore(activitySeed);
const usageStore = fixtureUsageStore({
  records: usageFixture(activitySeed.chats, params.get("activity")),
  scenario: () => {
    const preview = new URLSearchParams(location.search).get("usage");
    return ["loading", "unavailable", "stale"].includes(preview) && !["empty", "loading", "unavailable"].includes(activitySeed.scenario)
      ? preview : activitySeed.scenario;
  },
});
const openChat = fixtureOpenChat();
const chatDetailStore = fixtureChatDetailStore(chatDetailFixture({
  scenario: () => new URLSearchParams(location.search).get("detail"), hostile: params.get("activity") === "hostile",
}));
const editResultStore = fixtureEditResultStore({ scenario: () => new URLSearchParams(location.search).get("edit") });
let failNextReply = params.get("reply") === "retry";
const chatActions = fixtureChatActions({ activityStore, editResultStore, async beforeAnswer() {
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (failNextReply) {
    failNextReply = false;
    throw new Error("Fixture reply failure");
  }
} });
const editResultView = createEditResultView({ inspector: byId("detail"), escapeText, copyPatch: chatActions.copyPatch,
  announce: (message) => setLiveText("edit-result-announcement", message) });
const replyFeedback = new Map();
const storage = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
};
const projectStore = desktopStore ?? fixtureProjectStore({
  storage,
  key: `${storagePrefix}.projects`,
  seed: projects.map((project) => ({ ...project, folderIdentity: project.path })),
});
const harnessCatalog = desktopStore ? { listConnected: () => [] } : fixtureHarnessCatalog({
  storage,
  key: `${storagePrefix}.harnesses`,
  initial: fixture === "no-harness" ? [] : ["claude", "codex", "openclaw"],
  supported: Object.keys(demo.providers),
});
const [usageCards, getHarnessUsage] = desktopStore ? [] : await Promise.all([
  import("./usage-card.mjs"), fixtureHarnessUsage(params.get("quota") ?? params.get("activity")),
]);
const dialog = byId("dialog");
let activeProject = null;
let activity;
let selectedRun = null;
let selectedHandoff = null;
let chatOpener = null;
let announcedChat = null;
let announcedDetailState = null;
let harnessFilter = "all";
let layout = "overview";
let addingFromWizard = false;

function escapeText(text) {
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(text).replace(/[&<>"']/g, (character) => entities[character]);
}

function agentTime(seconds) {
  if (seconds == null) return "Unknown";
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function tokenValue(total) {
  return total == null ? "Unknown" : `<span title="${integer.format(total)} tokens">${compact.format(total)}</span>`;
}

function amount(estimate) {
  return estimate == null ? "Unknown" : money.format(estimate);
}

function runUsage(snapshot, runId) {
  return snapshot.records?.find((record) => record.runId === runId);
}

function runById(id) {
  return activity.chats.find((run) => run.id === id);
}

function mark(harness, size = "") {
  return `<span class="mark ${harness} ${size}" aria-hidden="true">${escapeText(demo.providers[harness].mark)}</span>`;
}

function badge(state, label) {
  return `<span class="badge ${escapeText(state)}"><i aria-hidden="true"></i>${escapeText(label)}</span>`;
}

function runState(run) {
  return badge(run.state, runLabels[run.state]);
}

function buildState(usage, missing = "Build status unknown") {
  return usage ? badge(usage.build.state, buildLabels[usage.build.state]) : badge("unknown", missing);
}

function panelHeader(id, title, accessory = "") {
  return `<header class="panel-head"><h2 id="${id}">${title}</h2>${accessory}</header>`;
}

function renderProviders() {
  const target = byId("providers");
  byId("demo-label").hidden = Boolean(desktopStore);
  if (desktopStore) {
    target.hidden = true;
    byId("shell-add-harness").hidden = false;
    return;
  }
  const focused = document.activeElement;
  const hadFocus = target.contains(focused);
  const notices = [];
  const cards = harnessCatalog.listConnected().map(({ id }) => {
    const provider = demo.providers[id];
    const model = usageCards.usageCardModel(id, getHarnessUsage(id));
    const { text, percent } = usageCards.usageCardSummary(model);
    if (model.allowanceNotices.length) notices.push(`${provider.name} · ${model.allowanceNotices.join(", ")}`);
    return `<button type="button" class="provider-card" data-provider="${escapeText(id)}" aria-haspopup="dialog">
      ${mark(id)}<span class="provider-text"><strong>${escapeText(provider.name)}</strong>
      <small>${escapeText(text)}</small></span>
      ${percent === null ? "" : `<progress class="quota-meter" value="${escapeText(percent)}" max="100" aria-hidden="true"></progress>`}
    </button>`;
  }).join("");
  target.innerHTML = `${cards}<button id="add-provider" class="add-provider" type="button" data-add-provider aria-haspopup="dialog"><b aria-hidden="true">+</b> Add harness</button>`;
  if (hadFocus) {
    const replacement = [...target.querySelectorAll("[data-provider]")].find((button) => button.dataset.provider === focused.dataset.provider);
    (replacement ?? byId("add-provider")).focus();
  }
  setLiveText("quota-announcement", notices.join(". "));
}

function renderProjectNav() {
  if (!loadingProjects) localUsage?.setProjects(projectStore.list());
  const dashboardButton = document.querySelector(".sidebar [data-dashboard]");
  const currentProject = harnesses?.isOpen ? null : activeProject;
  if (currentProject || harnesses?.isOpen) dashboardButton.removeAttribute("aria-current");
  else dashboardButton.setAttribute("aria-current", "page");
  byId("projects").innerHTML = projectStore.list().map(({ id, name }) => `<button type="button" class="folder-link" data-project="${escapeText(id)}" ${id === currentProject ? 'aria-current="page"' : ""}>
      <span class="folder-icon" aria-hidden="true"></span><span>${escapeText(name)}</span></button>`).join("");
}

function renderProject(project, { openQuestions }) {
  byId("breadcrumb").innerHTML = `<button type="button" class="breadcrumb-home" data-dashboard>Dashboard</button><span aria-hidden="true">/</span><span>${escapeText(project.name)}</span>`;
  byId("project-title").textContent = project.name;
  byId("folder-path").textContent = project.path;
  renderProjectRegistration(project);
  const question = byId("jump-to-question");
  if (desktopStore) {
    question.hidden = true;
    return;
  }
  const count = openQuestions.length;
  const unknown = activity.state === "loading" || activity.state === "unavailable";
  question.disabled = count === 0;
  question.dataset.run = openQuestions[0]?.chatId ?? "";
  question.dataset.question = openQuestions[0]?.id ?? "";
  const label = unknown ? "Open questions" : count
    ? `${count} ${count === 1 ? "question needs" : "questions need"} a reply` : "No open questions";
  question.innerHTML = `<span class="question-icon" aria-hidden="true">?</span>${label}`;
}

function registrationMessages(project) {
  if (!desktopStore) return [];
  const folder = {
    ok: "",
    missing: "Folder missing or moved.",
    changed: "Folder changed.",
  }[project.folder] ?? "Folder status unknown.";
  const registration = {
    registered: "",
    conflict: "Project or folder already used by Loom's helper.",
  }[project.registration] ?? "Not connected to Loom's helper.";
  return [folder, registration].filter(Boolean);
}

function registrationMessage(project) {
  return registrationMessages(project)[0] ?? "";
}

function renderProjectRegistration(project) {
  const line = byId("project-registration");
  const message = registrationMessage(project);
  line.hidden = !message;
  setLiveText("project-registration", message);
  const recovery = byId("project-relink");
  const focused = document.activeElement;
  const markup = folderRecovery(project, "project");
  if (recovery.innerHTML !== markup) {
    recovery.innerHTML = markup;
    if (focused?.dataset.relinkProject === project.id && !focused.isConnected) focusAfterRelink(project.id);
  }
}

const relinkMessages = {
  found: "Folder found. Path updated.",
  updated: "Project folder updated.",
  duplicate: "Another project already uses this folder.",
  cancelled: "Folder selection canceled.",
  inaccessible: "Loom couldn’t read the selected folder.",
  changed: "The selected folder changed. Choose it again.",
  uncertain: "Loom couldn’t verify the folder update.",
};

function folderRecovery(project, screen) {
  if (!desktopStore) return "";
  const feedback = relinkFeedback.get(project.id);
  const blocked = desktopStore.relinkBlocked(project.id);
  const state = blocked ? "uncertain" : feedback?.status;
  const message = state !== "cancelled" && relinkMessages[state];
  const success = state === "found" || state === "updated";
  const refused = ["duplicate", "inaccessible", "changed"].includes(state);
  const chooser = !blocked && (refused || ["missing", "changed"].includes(project.folder));
  const owner = state === "duplicate" && desktopStore.get(feedback.ownerId);
  if (!message && !chooser) return "";
  return `<div class="folder-recovery">
    ${message ? `<p class="${success ? "relink-saved" : "registration-state"}">${message}</p>` : ""}
    ${owner || chooser ? `<div class="folder-recovery-actions">
      ${owner ? `<button type="button" class="outline action" data-project="${escapeText(owner.id)}">Open ${escapeText(feedback.ownerName)}</button>` : ""}
      ${chooser ? `<button type="button" class="outline action" id="relink-${screen}-${escapeText(project.id)}"
        data-relink-project="${escapeText(project.id)}"${relinkOperation?.id === project.id ? ' aria-disabled="true"' : ""}>${refused ? "Choose another folder…" : "Choose folder…"}</button>` : ""}
    </div>` : ""}</div>`;
}

function focusAfterRelink(id, success = false) {
  const chooser = !success && byId(`relink-${activeProject ? "project" : "dashboard"}-${id}`);
  const destination = activeProject ? byId("project-title") : byId(`dashboard-project-${id}`);
  (chooser || destination || byId("dashboard-title")).focus({ preventScroll: true });
}

function announceProjectRegistration(createdProject, relinked) {
  const next = new Map();
  const changes = createdProject
    ? [`${createdProject.name} added to Project Loom.`, ...registrationMessages(createdProject)]
    : [];
  const { id, status } = relinked ?? {};
  if (id && announcedRelinks.get(id) !== status) {
    announcedRelinks.set(id, status);
    if (relinkMessages[status]) changes.push(relinkMessages[status]);
  }
  const success = status === "found" || status === "updated";
  for (const project of desktopStore?.list() ?? []) {
    const message = registrationMessage(project);
    const previous = announcedRegistration.get(project.id);
    next.set(project.id, message);
    if (project.id !== createdProject?.id && message !== previous && (message || (previous && !(success && project.id === id)))) {
      changes.push(`${project.name}. ${message || "Folder available and connected to Loom's helper."}`);
    }
  }
  announcedRegistration = next;
  if (changes.length) {
    const message = changes.join(" ");
    // Separate relink interactions can produce the same feedback wording.
    if (relinked && byId("announcement").textContent === message) {
      setLiveText("announcement", "");
    }
    setLiveText("announcement", message);
  }
}

function hasUnregisteredProjects() {
  return desktopStore?.list().some(({ registration }) => registration === "unregistered");
}

function canRetryConnection() {
  return hasUnregisteredProjects() || desktopStore?.hasUnverifiedRelinks;
}

function refreshFolderViews() {
  localUsage?.setProjects(desktopStore.list());
  if (!activeProject) {
    renderDashboard();
    return;
  }
  const project = desktopStore.get(activeProject);
  if (!project) {
    selectProject(null);
    return;
  }
  const path = byId("folder-path");
  if (path.textContent !== project.path) {
    path.textContent = project.path;
    if (!byId("project-setup").hidden) renderNewProject(project);
  }
  renderProjectRegistration(project);
  if (!harnesses?.isOpen) desktopActivity.open(project);
}

async function connectProjects() {
  if (connectingProjects || !canRetryConnection()) return;
  connectingProjects = true;
  const retry = byId("retry-connection");
  retry.setAttribute("aria-disabled", "true");
  const before = desktopStore.list();
  const blocked = before.filter(({ id }) => desktopStore.relinkBlocked(id));
  const result = await desktopStore.connect();
  connectingProjects = false;
  retry.removeAttribute("aria-disabled");
  if (result.status !== "ok") return;
  for (const { id } of blocked) {
    if (!desktopStore.relinkBlocked(id)) {
      if (relinkFeedback.get(id)?.status === "uncertain") relinkFeedback.delete(id);
      if (announcedRelinks.get(id) === "uncertain") announcedRelinks.delete(id);
    }
  }
  const after = desktopStore.list();
  if (before.length !== after.length ||
      after.some(({ id, name }, index) => id !== before[index]?.id || name !== before[index]?.name)) {
    renderProjectNav();
  }
  refreshFolderViews();
  announceProjectRegistration();
}

function finishRelink(operation, result, confirmed = false) {
  relinkOperation = undefined;
  const onScreen = operation.screen === relinkScreen;
  const status = result.status === "relinked" ? (confirmed ? "updated" : "found")
    : result.status === "expired" ? "changed"
    : result.status;
  if (onScreen) relinkFeedback.set(operation.id, { ...result, status });
  if (result.status === "duplicate" || result.status === "uncertain") renderProjectNav();
  refreshFolderViews();
  announceProjectRegistration(undefined, onScreen ? { id: operation.id, status } : undefined);
  if (onScreen) focusAfterRelink(operation.id, result.status === "relinked");
}

async function chooseRelinkFolder(button) {
  const id = button.dataset.relinkProject;
  if (!desktopStore?.get(id) || relinkOperation || desktopStore.relinkBlocked(id)) return;
  announcedRelinks.delete(id);
  const operation = { id, screen: relinkScreen };
  relinkOperation = operation;
  button.setAttribute("aria-disabled", "true");
  const result = await desktopStore.relink(id);
  const project = desktopStore.get(id);
  if (result.status === "confirm" && !project) {
    desktopStore.discardRelink(result.token);
    relinkOperation = undefined;
    relinkFeedback.delete(id);
    refreshFolderViews();
    return;
  }
  if (result.status !== "confirm" || operation.screen !== relinkScreen) {
    finishRelink(operation, result);
    return;
  }
  operation.selection = result;
  byId("relink-name").textContent = project.name;
  byId("relink-saved-path").textContent = result.savedPath;
  byId("relink-selected-path").textContent = result.selectedPath;
  byId("relink-dialog").showModal();
  byId("relink-cancel").focus();
}

async function closeRelinkDialog(confirmed) {
  const operation = relinkOperation;
  if (!operation?.selection) return;
  const { token } = operation.selection;
  operation.selection = undefined;
  byId("relink-dialog").close();
  const result = confirmed ? await desktopStore.confirm(token) : { status: "cancelled" };
  finishRelink(operation, result, confirmed);
}

function metric(label, value, context, graph = "") {
  return `<div class="metric"><span>${label}</span><strong>${value}</strong><small>${context}</small>${graph}</div>`;
}

const metricLabels = ["Tokens today", "Estimated API value", "Agent time", "Build checks"];

function renderMetrics(target, snapshots, activityMessages = []) {
  const totals = summarizeUsage(snapshots);
  const stateMessages = [...new Set(snapshots.map(({ state }) => usageMessages[state]).filter(Boolean))];
  const messages = [...activityMessages, ...stateMessages];
  const partial = totals.knownProjects < snapshots.length;
  const coverage = partial && totals.knownProjects ? `from ${totals.knownProjects} of ${snapshots.length} projects` : "";
  const missingPrices = totals.unknownPrices
    ? `${totals.unknownPrices} unknown ${totals.unknownPrices === 1 ? "price" : "prices"} excluded` : "";
  setLiveText("usage-announcement", [
    ...stateMessages,
    totals.unknownUsage && "Some usage data is unknown.",
    missingPrices && `${missingPrices}.`,
  ].filter(Boolean).join(" "));
  const context = (text) => [text, coverage, ...messages].filter(Boolean).join(" · ");
  if (!totals.hasData) {
    target.innerHTML = metricLabels.map((label) => metric(label, messages.join(" "), coverage)).join("");
    return;
  }
  const segments = totals.tokenTotal > 0
    ? `<div class="token-segments" aria-hidden="true">${Object.entries(totals.tokens)
      .map(([type, count]) => `<i class="${type}" style="--share: ${count}"></i>`).join("")}</div>`
    : "";
  const checks = totals.completedChecks === null || totals.plannedChecks === null
    ? "Unknown" : `${totals.completedChecks} <em>/ ${totals.plannedChecks}</em>`;
  const priceCoverage = ["USD", `${totals.pricedCount} of ${totals.runCount} chats priced`, missingPrices].filter(Boolean).join(" · ");
  target.innerHTML = [
    metric("Tokens today", tokenValue(totals.tokenTotal), context("Input, output and cache"), segments),
    metric("Estimated API value", totals.runCount ? amount(totals.estimate) : "No runs", context(priceCoverage)),
    metric("Agent time", agentTime(totals.seconds), context("Active processing today")),
    metric("Build checks", checks, context("Completed today")),
  ].join("");
}

function dashboardProjectCard(project, snapshot, usage, { running, openQuestions }) {
  const active = running.length;
  const waiting = openQuestions.length;
  const failed = usage.records?.filter(({ build }) => build.state === "failed").length;
  const emptyLabel = desktopStore ? "Not connected to Loom yet."
    : { loading: "Loading activity…", unavailable: "Activity is unavailable." }[snapshot.state]
      ?? (snapshot.chats.length ? "No active chats" : "No chats yet");
  const registration = registrationMessage(project);
  const recovery = folderRecovery(project, "dashboard");
  const status = [
    active && badge("running", `${active} running`),
    waiting && badge("waiting", `${waiting} ${waiting === 1 ? "question" : "questions"}`),
    failed && badge("failed", `${failed} ${failed === 1 ? "failed build" : "failed builds"}${usage.state === "stale" ? " (stale)" : ""}`),
  ].filter(Boolean).join("");
  return `<li${recovery ? ' class="dashboard-project-item"' : ""}><button type="button" class="dashboard-project" id="dashboard-project-${escapeText(project.id)}" data-project="${escapeText(project.id)}">
    <span class="project-folder" aria-hidden="true"><span class="folder-icon"></span></span>
    <span class="dashboard-project-text"><strong>${escapeText(project.name)}</strong><small class="folder-path">${escapeText(project.path)}</small>
    <span class="dashboard-project-meta">${projectHarness(project)}</span>
    ${registration ? `<small class="registration-state">${escapeText(registration)}</small>` : ""}</span>
    <span class="dashboard-project-state">${status || `<span class="panel-note">${emptyLabel}</span>`}<span class="open-detail" aria-hidden="true">↗</span></span>
  </button>${recovery}</li>`;
}

function dashboardRunCard(run, question) {
  const project = projectStore.get(run.project);
  return `<li><button type="button" class="running-card" data-project="${escapeText(project.id)}" data-run="${escapeText(run.id)}"${question ? ` data-question="${escapeText(question.id)}"` : ""}>
    ${mark(run.harness)}<span class="run-name"><strong>${escapeText(run.title)}</strong><small>${escapeText(project.name)} · ${demo.providers[run.harness].name}</small></span>
    <span class="open-detail" aria-hidden="true">↗</span></button></li>`;
}

function renderDashboard() {
  const storeMessage = loadingProjects ? "Loading saved projects…"
    : desktopStore?.status === "unavailable" ? "Saved projects could not be read." : "";
  const projectsUnknown = Boolean(storeMessage);
  const create = document.querySelector("[data-new-project]");
  create.disabled = projectsUnknown;
  const retry = byId("retry-connection");
  const hideRetry = projectsUnknown || !canRetryConnection();
  if (hideRetry && document.activeElement === retry) {
    (projectsUnknown ? byId("dashboard-title") : create).focus({ preventScroll: true });
  }
  retry.hidden = hideRetry;
  byId("dashboard-metrics").hidden = projectsUnknown;
  byId("dashboard-grid").hidden = projectsUnknown;
  setLiveText("project-store-status", storeMessage);
  if (projectsUnknown) {
    setLiveText("relationship-announcement", "");
    setLiveText("usage-announcement", "");
    return;
  }
  const focused = document.activeElement;
  const opener = byId("dashboard").contains(focused) && focused.dataset.project && describeChatOpener(focused);
  const projects = projectStore.list();
  const snapshots = projects.map(({ id }) => activityStore.get(id));
  const usage = projects.map(({ id }) => usageStore.get(id));
  const views = snapshots.map(projectActivity);
  byId("dashboard-projects").innerHTML = panelHeader("dashboard-projects-title", "Project folders", `<span class="panel-note">${projects.length} ${projects.length === 1 ? "project" : "projects"}</span>`) +
    `<ul class="dashboard-list">${projects.map((project, index) => dashboardProjectCard(project, snapshots[index], usage[index], views[index])).join("")}</ul>`;
  renderDashboardActivity(snapshots, usage, views);
  if (focused?.dataset.relinkProject && !focused.isConnected) focusAfterRelink(focused.dataset.relinkProject);
  else if (opener && !focused.isConnected) focusChatOpener(opener);
}

function renderDashboardActivity(snapshots, usage, views) {
  const metrics = byId("dashboard-metrics");
  if (desktopStore) {
    const message = "Not connected to Loom yet.";
    const note = `<p class="empty">${escapeText(message)}</p>`;
    metrics.innerHTML = metricLabels.slice(2).map((label) => metric(label, "—", "Not connected yet")).join("");
    byId("dashboard-questions").innerHTML = panelHeader("dashboard-questions-title", "Needs a reply") + note;
    byId("dashboard-running").innerHTML = panelHeader("dashboard-running-title", "Running chats") + note;
    setLiveText("relationship-announcement", message);
    return;
  }
  const known = snapshots.map(({ state }) => state !== "loading" && state !== "unavailable");
  const knownCount = known.filter(Boolean).length;
  const unknown = knownCount < snapshots.length;
  const messages = [
    snapshots.some(({ state }) => state === "loading") && "Loading activity…",
    snapshots.some(({ state }) => state === "unavailable") && "Activity is unavailable.",
    snapshots.some(({ state }) => state === "stale") && "Showing the last available chat relationships.",
  ].filter(Boolean);
  const coverage = unknown && knownCount ? `from ${knownCount} of ${snapshots.length} projects` : "";
  const active = views.flatMap(({ running }, index) => known[index] ? running : []);
  const waiting = views.flatMap(({ openQuestions }, index) => (known[index] ? openQuestions : []).map((question) =>
    dashboardRunCard(snapshots[index].chats.find(({ id }) => id === question.chatId), question)));
  renderMetrics(metrics, usage, messages);
  const notes = messages.map((message) => `<p class="empty">${message}</p>`).join("");
  const countLabel = (count, label) => `${count} ${label}${coverage ? ` · ${coverage}` : ""}`;
  const showCounts = !unknown || knownCount > 0;
  byId("dashboard-questions").innerHTML = panelHeader("dashboard-questions-title", "Needs a reply", showCounts ? badge(waiting.length ? "waiting" : "completed", countLabel(waiting.length, "open")) : "") + notes +
    (waiting.length ? `<ul class="dashboard-list">${waiting.join("")}</ul>` : unknown ? "" : '<p class="empty">No open questions across your projects.</p>');
  byId("dashboard-running").innerHTML = panelHeader("dashboard-running-title", "Running chats", showCounts ? badge("running", countLabel(active.length, "active")) : "") + notes +
    (active.length ? `<ul class="dashboard-list">${active.map((run) => dashboardRunCard(run)).join("")}</ul>` : unknown ? "" : '<p class="empty">No chats are running.</p>');
  setLiveText("relationship-announcement", [...messages, coverage].filter(Boolean).join(" "));
}

function projectHarness(project) {
  const preference = project.connection ?? project.mainHarness;
  if (!Object.hasOwn(demo.providers, preference)) return escapeText(preference || "None selected");
  return `${mark(preference, "tiny")}${escapeText(demo.providers[preference].name)}`;
}

function projectDetails(project) {
  const preset = project.goal !== "none" && project.goal !== "custom" && Object.hasOwn(goals, project.goal);
  const goal = Object.hasOwn(project, "connection")
    ? escapeText(preset ? goals[project.goal] : project.goal).replaceAll("\n", "<br>")
    : [project.goal, project.description].filter(Boolean).map(escapeText).join("<br>");
  return `<div><dt>Project name</dt><dd>${escapeText(project.name)}</dd></div>
    <div><dt>Project directory</dt><dd class="folder-path">${escapeText(project.path)}</dd></div>
    <div><dt>Goal</dt><dd>${goal || "Decide later"}</dd></div>
    <div><dt>Main harness</dt><dd class="detail-harness">${projectHarness(project)}</dd></div>
    <div><dt>Project rules</dt><dd>${project.rules ? escapeText(project.rules) : "None added"}</dd></div>`;
}

function renderNewProject(project) {
  byId("project-setup").innerHTML = `<section class="panel" aria-labelledby="saved-setup-title">
    ${panelHeader("saved-setup-title", "Project setup")}<dl class="project-details saved-details">${projectDetails(project)}</dl></section>` +
    (desktopStore ? "" : `
    <section class="panel" aria-labelledby="empty-activity-title">
    ${panelHeader("empty-activity-title", "Activity")}<div class="empty-activity"><span class="project-folder" aria-hidden="true"><span class="dashboard-icon"></span></span><h3>No chats yet</h3><p>Chats and delegated work will appear here when this project has activity.</p></div></section>`);
}

function chatButtonAttrs(run) {
  return `data-run="${escapeText(run.id)}" aria-controls="detail" aria-pressed="${selectedRun === run.id}"`;
}

function runningCard(run, question, usage) {
  const time = runUsage(usage, run.id)?.seconds;
  return `<li><button type="button" class="running-card" ${chatButtonAttrs(run)}${question ? ` data-question="${escapeText(question.id)}"` : ""}>
    ${mark(run.harness)}<span class="run-name"><strong>${escapeText(run.title)}</strong>
    ${question ? `<span class="question-excerpt">${escapeText(question.text)}</span>` : ""}
    <small>${demo.providers[run.harness].name}${question ? "" : ` · ${time == null ? missingUsage(usage.state) : agentTime(time)}`}</small></span>
    <span class="open-detail" aria-hidden="true">↗</span></button></li>`;
}

function renderActivityPanels({ running, openQuestions }, usage) {
  const status = { loading: "Loading activity…", unavailable: "Activity is unavailable." }[activity.state];
  byId("running").innerHTML = panelHeader("running-title", "Running chats", status ? "" : badge("running", `${running.length} active`)) + (running.length
    ? `<ul class="running-list">${running.map((run) => runningCard(run, null, usage)).join("")}</ul>`
    : `<p class="empty">${status ?? "No chats are running in this folder."}</p>`);
  byId("open-questions").innerHTML = panelHeader("open-questions-title", "Open questions", status ? "" :
    badge(openQuestions.length ? "waiting" : "completed", `${openQuestions.length} open`)) + (openQuestions.length
    ? `<ul class="running-list">${openQuestions.map((question) => runningCard(runById(question.chatId), question, usage)).join("")}</ul>`
    : `<p class="empty">${status ?? "No open questions in this folder."}</p>`);
  byId("open-questions-title").tabIndex = -1;
}

function mapNode(run, detail) {
  return `<button type="button" class="map-node" ${chatButtonAttrs(run)}>
    ${mark(run.harness, "small")}<span class="run-name"><small>${demo.providers[run.harness].name}</small><strong>${escapeText(run.title)}</strong>${detail}</span></button>`;
}

function renderMap({ groups, message }) {
  const rows = groups.map(({ origin, relationships }) => {
    const count = `${relationships.length} ${relationships.length === 1 ? "task" : "tasks"}`;
    const targets = relationships.map(({ handoffId, active, superseded }) =>
      `<li data-handoff="${escapeText(handoffId)}">
        <div class="map-handoff${superseded.length ? " has-history" : ""}">
          ${mapNode(active, `<span class="map-states">${badge("active", "Active")}${runState(active)}</span>`)}
          ${superseded.map((run) => mapNode(run, badge("superseded", "Superseded"))).join("")}
        </div>
      </li>`).join("");
    return `<div class="map-group ${relationships.length > 1 ? "branches" : ""}">
      <div class="map-source"><span class="list-column-label">Originating chat</span>${mapNode(origin, `<small>${count}</small>`)}</div>
      <div><span class="list-column-label">Delegated tasks</span>
      <ul class="map-targets" role="list" aria-label="Tasks from ${escapeText(origin.title)}">${targets}</ul></div>
    </div>`;
  }).join("");
  byId("relationship-status").textContent = message;
  byId("relationship-status").hidden = !message;
  byId("map-legend").hidden = !rows;
  byId("chat-relations").setAttribute("aria-busy", String(activity.state === "loading"));
  byId("chat-relations").innerHTML = rows ? `<div class="map-body">
    <div class="map-column-labels"><span>Originating chat</span><span>Delegated tasks</span></div>${rows}</div>` : "";
}

function setChatView(view) {
  byId("chat-relations").dataset.view = view;
  byId("map-title").textContent = view === "list" ? "Chat list" : "Chat map";
  document.querySelectorAll("[data-chat-view]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.chatView === view));
  });
}

function missingUsage(state) {
  if (state === "loading") return "Loading…";
  if (state === "unavailable") return "Unavailable";
  return "Unknown";
}

function boardRow(run, snapshot) {
  const usage = runUsage(snapshot, run.id);
  const missing = missingUsage(snapshot.state);
  const build = buildState(usage, missing === "Unknown" ? "Build status unknown" : missing);
  const superseded = activity.edges.some(({ supersededChatIds }) => supersededChatIds.includes(run.id));
  const state = superseded ? badge("superseded", "Superseded") : runState(run);
  return `<tr class="${run.origin ? "delegated" : "origin"} ${selectedRun === run.id ? "selected" : ""}">
    <th scope="row"><button type="button" class="table-run" ${chatButtonAttrs(run)}>
      ${mark(run.harness, "small")}<span class="run-name"><strong>${escapeText(run.title)}</strong>
      <small>${demo.providers[run.harness].name}${run.origin ? "" : " · Origin chat"}</small></span></button>
      <span class="mobile-status">${state}${build}</span></th>
    <td>${state}</td><td class="number">${usage ? agentTime(usage.seconds) : missing}</td>
    <td class="number">${usage ? tokenValue(usage.tokenTotal) : missing}</td>
    <td class="number ${usage?.estimate == null ? "quiet" : ""}">${usage ? amount(usage.estimate) : missing}</td>
    <td>${build}</td>
  </tr>`;
}

function renderBoard(snapshot) {
  const runs = activity.chats;
  const notice = usageMessages[snapshot.state];
  const heading = (accessory) => panelHeader("board-title", "Ponytail board", accessory);
  if (!runs.length) {
    byId("board").innerHTML = heading() + `<p class="empty">${notice ?? "No runs for this folder."}</p>`;
    return;
  }
  const harnesses = [...new Set(runs.map((run) => run.harness))];
  const visible = harnessFilter === "all" ? runs : runs.filter((run) => run.harness === harnessFilter);
  const selector = `<label class="filter-label"><span class="visually-hidden">Filter board by harness</span>
    <select id="harness-filter"><option value="all">All harnesses</option>${harnesses.map((id) => `<option value="${escapeText(id)}" ${id === harnessFilter ? "selected" : ""}>${escapeText(demo.providers[id].name)}</option>`).join("")}</select></label>`;
  byId("board").innerHTML = heading(selector) + (notice ? `<p class="empty">${notice}</p>` : "") + `<div id="board-scroll" class="table-scroll" tabindex="0" role="region" aria-label="Agent usage table">
    <table><thead><tr><th scope="col">Chat and harness</th><th scope="col">Run state</th><th scope="col">Agent time</th><th scope="col">Tokens</th><th scope="col">Est. API value</th><th scope="col">Build</th></tr></thead>
    <tbody>${visible.map((run) => boardRow(run, snapshot)).join("")}</tbody></table></div>`;
}

function buildProgress({ completed, total }) {
  return total && completed !== null ? `<div class="build-progress"><progress value="${completed}" max="${total}" aria-label="${completed} of ${total} checks completed"></progress><span>${completed}/${total}</span></div>` : "";
}

function renderBuilds(snapshot) {
  const order = { failed: 0, running: 1, queued: 2, passed: 3, unknown: 4 };
  const buildRuns = activity.chats.map((run) => ({ run, usage: runUsage(snapshot, run.id) }));
  const rows = snapshot.records ? buildRuns.filter(({ usage }) => usage?.build.state !== "skipped")
    .sort((first, second) => order[first.usage?.build.state ?? "unknown"] - order[second.usage?.build.state ?? "unknown"])
    .map(({ run, usage }) => `<li><button type="button" class="build-card" ${chatButtonAttrs(run)}>
    <span class="build-name"><strong>${escapeText(run.title)}</strong><small>${demo.providers[run.harness].name} · ${escapeText(run.time)}</small></span>
    ${buildState(usage)}${usage ? buildProgress(usage.build) : ""}</button></li>`).join("") : "";
  const notice = usageMessages[snapshot.state];
  byId("builds").innerHTML = panelHeader("builds-title", "Build & test checks", '<span class="panel-note">Today</span>') +
    (notice || !rows ? `<p class="empty">${notice ?? "No build checks for this folder."}</p>` : "") +
    (rows ? `<ul class="build-list">${rows}</ul>` : "");
}

function questionPanel(run, question, index, state) {
  const heading = `Question from ${demo.providers[run.harness].name}`;
  const fieldId = `reply-${index}`;
  const answered = question.state !== "open";
  const reason = answered ? "" : replyUnavailable[state];
  return `<section class="question"${answered ? "" : ' aria-label="Pending question"'}><h3>${heading}</h3><p>${escapeText(question.text)}</p>
      ${answered ? `<section class="answer"><h3>Your demo reply</h3><p>${escapeText(question.reply)}</p></section>` : ""}
      <form data-reply-form="${escapeText(question.id)}" data-answered="${answered}" data-unavailable="${Boolean(reason)}" novalidate><label class="visually-hidden" for="${fieldId}">Your reply</label><textarea id="${fieldId}" data-focus-key="reply-${escapeText(question.id)}" required maxlength="${replyLimit}" rows="2" placeholder="Write a reply…" aria-describedby="${fieldId}-error${reason ? ` ${fieldId}-reason` : ""}" ${answered || reason ? "readonly" : ""}></textarea>
      ${reason ? `<p id="${fieldId}-reason">${reason}</p>` : ""}
      <p id="${fieldId}-error" class="setup-error" hidden></p>
      <button class="primary" type="submit" data-focus-key="send-${escapeText(question.id)}" ${answered || reason ? "disabled" : ""}><span data-reply-label>Send demo reply</span> <span aria-hidden="true">↗</span></button></form></section>`;
}

const detailMessages = {
  loading: "Loading chat details…",
  unavailable: "Chat details are unavailable.",
  stale: "Showing the last available chat details.",
};
const replyUnavailable = {
  loading: "Chat details are loading. You can reply when they are available.",
  unavailable: "Chat details are unavailable. You can reply when they are available.",
  stale: "Chat details are out of date. You can reply when they are available.",
};

function deliveryHistory(deliveries) {
  const rows = deliveries.map((delivery, index) => {
    const { label, tone } = deliveryStatus(delivery);
    const receiptId = `delivery-receipt-${index}`;
    const message = label === "Delivered to chat"
      ? `<a href="#${receiptId}" data-focus-key="delivery-${index}">${escapeText(delivery.message)}</a>`
      : escapeText(delivery.message);
    return `<li><p><strong>${message}</strong> <time>${escapeText(delivery.time)}</time></p>
      ${badge(tone, label)}${label === "Delivered to chat" ? `<p id="${receiptId}" class="panel-note">${escapeText(delivery.receipt)}</p>` : ""}</li>`;
  });
  return `<section class="detail-section"><h3>Delivery history</h3>${rows.length
    ? `<ol class="detail-history" role="list">${rows.join("")}</ol>` : "<p>No delivery messages recorded.</p>"}</section>`;
}

function resultSection({ result, evidence }) {
  const evidenceLabel = { passed: "Passed", failed: "Failed", unavailable: "Unavailable", unknown: "Unknown" }[evidence.state];
  return `<section class="detail-section"><h3>Result ${result?.late ? badge("superseded", "Historical result") : ""}</h3>
    <p>${result ? escapeText(result.summary) : "Result unavailable."}</p>
    <h3>Test evidence ${badge(evidence.state, evidenceLabel)}</h3>${evidence.name ? `<p>${escapeText(evidence.name)}</p>` : ""}</section>`;
}

function replacementHistory(edge, run) {
  const entries = chatHistory({ edge, chats: activity.chats, resultFor: (id) => chatDetailStore.get(activeProject, id).result });
  const rows = entries.map(({ chat, time, label }) => {
    const title = escapeText(chat.title);
    const chatTitle = chat.id === run.id ? `<strong>${title}</strong>`
      : `<button class="outline" type="button" data-focus-key="history-${escapeText(chat.id)}-${escapeText(label)}" data-run="${escapeText(chat.id)}" data-handoff="${escapeText(edge.handoffId)}">${title} <span aria-hidden="true">↗</span></button>`;
    return `<li><p>${escapeText(label)} <time>${escapeText(time)}</time></p>${chatTitle}</li>`;
  });
  return rows.length ? `<section class="detail-section"><h3>Chat history</h3><ol class="detail-history" role="list">${rows.join("")}</ol></section>` : "";
}

function tokenBreakdown(usage, notice) {
  const heading = `<details class="breakdown" data-detail-key="token-breakdown"><summary data-focus-key="token-breakdown">Token breakdown & pricing</summary>`;
  if (!usage) return `${heading}<p>${notice ?? "Usage is unknown."}</p></details>`;
  const { tokens, rates, estimate } = usage;
  const rows = Object.entries(tokenLabels).map(([type, label]) => `<tr><th scope="row">${label}</th>
    <td>${tokens[type] === null ? "Unknown" : integer.format(tokens[type])}</td><td>${rates[type] === null ? "Unknown" : rateMoney.format(rates[type])}</td></tr>`).join("");
  return `${heading}
    <p>${estimate === null ? "Price unknown. This run is excluded from estimated API totals." : "Sample USD rates per million tokens."}</p>
    <table><thead><tr><th scope="col">Type</th><th scope="col">Tokens</th><th scope="col">$/1M</th></tr></thead><tbody>${rows}</tbody></table>
  </details>`;
}

function renderDetail(run, questions, snapshot) {
  const edge = activity.edges.find(({ handoffId, activeChatId, supersededChatIds }) =>
    (!selectedHandoff || handoffId === selectedHandoff) && (activeChatId === run.id || supersededChatIds.includes(run.id)));
  const handoff = activity.handoffs.find(({ id }) => id === edge?.handoffId);
  const source = handoff ? runById(handoff.originChatId) : null;
  const superseded = edge?.supersededChatIds.includes(run.id);
  const data = chatDetailStore.get(activeProject, run.id);
  const note = detailMessages[data.state];
  const hasData = data.state === "ready" || data.state === "stale";
  const chatKey = `${activeProject}:${run.id}`;
  if (announcedChat !== chatKey || announcedDetailState !== data.state) {
    const opened = announcedChat !== chatKey ? `${run.title}. ${superseded ? "Superseded" : runLabels[run.state]}.` : "";
    const notice = questions.some(({ state }) => state === "open") ? replyUnavailable[data.state] : note;
    setLiveText("detail-announcement", [opened, notice].filter(Boolean).join(" "));
    announcedChat = chatKey;
    announcedDetailState = data.state;
  }
  const editResult = hasData ? editResultStore.get(run.id) : null;
  const result = hasData ? resultSection({ ...data, evidence: editResult?.tests ?? data.evidence }) : "";
  const deliveries = hasData ? deliveryHistory([
    ...data.deliveries,
    ...questions.filter(({ answerTime }) => answerTime).map(({ answerTime }) => ({
      time: answerTime, message: "Your demo reply", state: "Queued",
    })),
  ]) : "";
  const history = replacementHistory(edge, run);
  const usage = runUsage(snapshot, run.id);
  const usageNotice = usageMessages[snapshot.state] ?? (!usage ? "Usage is unknown." : "");
  const missing = missingUsage(snapshot.state);
  const build = `<section class="detail-section"><h3>Build status ${buildState(usage, missing)}</h3>
    ${usage?.build.detail ? `<p>${escapeText(usage.build.detail)}</p>` : ""}
    ${usage ? buildProgress(usage.build) : ""}</section>`;
  setLiveText("run-usage-announcement", [
    usageNotice === "Usage is unknown." && usageNotice,
    usage?.estimate === null && "Run price unknown.",
    usage && [usage.seconds, usage.tokenTotal, usage.turns].includes(null) && "Some run usage is unknown.",
    { unknown: "Build status unknown.", failed: "Checks failed." }[usage?.build.state],
  ].filter(Boolean).join(" "));
  const usageTotals = usage ? `<dl class="run-totals">
    <div><dt>Agent time</dt><dd>${agentTime(usage.seconds)}</dd></div><div><dt>Tokens</dt><dd>${tokenValue(usage.tokenTotal)}</dd></div>
    <div><dt>API estimate</dt><dd>${amount(usage.estimate)}</dd></div></dl>
    <p class="panel-note">${usage.turns === null ? "Turns unknown" : `${usage.turns} ${usage.turns === 1 ? "turn" : "turns"}`} · Sample usage${usage.estimate === null ? " · 1 unknown price excluded" : ""}</p>` : "";
  byId("detail").innerHTML = `<header class="detail-head">
      <div class="detail-route-row">
        <div class="detail-route">${source ? `${mark(source.harness, "tiny")} ${demo.providers[source.harness].name} <span aria-label="delegated to">→</span>` : ""}${mark(run.harness, "tiny")} ${demo.providers[run.harness].name}</div>
        <button type="button" class="close-button" id="close-chat" data-focus-key="close-chat" aria-label="Close chat">×</button>
      </div>
      <h2 id="detail-title" tabindex="-1" data-focus-key="title">${escapeText(run.title)}</h2>
      <div class="detail-meta">${superseded ? badge("superseded", "Superseded") : runState(run)}<span>${demo.models[run.model].name} · ${escapeText(run.time)}</span></div>
    </header>
    <div class="detail-body">
      ${note ? `<p class="notice">${note}</p>` : ""}
      ${layout === "build" ? build : ""}
      ${questions.map((question, index) => questionPanel(run, question, index, data.state)).join("")}
      <section class="detail-section"><h3>Run usage</h3>
        ${usageNotice ? `<p class="notice">${usageNotice}</p>` : ""}${usageTotals}${tokenBreakdown(usage, usageNotice)}
      </section>
      ${hasData ? `<div class="detail-section detail-workspace"><h3>${escapeText(data.workspace.label)}</h3><p class="folder-path">${escapeText(data.workspace.path)}</p></div>` : ""}
      <section class="detail-section"><h3>Brief</h3><p>${escapeText(run.brief)}</p></section>
      ${result}
      ${editResultView.render(run.id, editResult)}
      ${layout === "build" ? "" : build}
      ${deliveries}
      ${history}
      ${source ? `<button type="button" class="outline" data-focus-key="origin-chat" data-run="${escapeText(source.id)}">View origin chat <span aria-hidden="true">↗</span></button>` : ""}
    </div>`;
  questions.forEach((question, index) => {
    const field = byId(`reply-${index}`);
    field.value = question.state === "open" ? question.draft ?? "" : "";
  });
  updateReplyFeedback();
}

function renderProjectContent({ preserveInspector = false } = {}) {
  const inspector = byId("detail");
  const focused = document.activeElement;
  const hadInspectorFocus = inspector.contains(focused);
  const focusKey = hadInspectorFocus ? focused.dataset.focusKey : null;
  const hadProjectFocus = byId("project-view").contains(focused);
  const focusedChat = !hadInspectorFocus && focused?.dataset.run && describeChatOpener(focused);
  const project = projectStore.get(activeProject);
  const runs = activity.chats;
  const usage = usageStore.get(activeProject);
  const hasUsageStatus = Object.hasOwn(usageMessages, usage.state);
  const hasRuns = runs.length > 0;
  const view = projectActivity(activity);
  renderProject(project, view);
  const showSetup = desktopStore || (!hasRuns && activity.state === "ready");
  byId("project-setup").hidden = !showSetup;
  if (showSetup) renderNewProject(project);
  byId("draft-nav").hidden = !hasRuns;
  ["metrics", "board", "builds"].forEach((id) => { byId(id).hidden = !hasRuns && !hasUsageStatus; });
  if (!desktopStore) {
    renderActivityPanels(view, usage);
    renderMap(view);
  }
  if (hasRuns || hasUsageStatus) {
    renderMetrics(byId("metrics"), [usage]);
    renderBoard(usage);
    renderBuilds(usage);
  } else {
    setLiveText("usage-announcement", "");
  }
  if (!preserveInspector) renderInspector(usage);
  const shownLayout = hasRuns ? layout : "overview";
  byId("work-grid").dataset.layout = shownLayout;
  byId("work-grid").append(...layouts[shownLayout].map(byId));
  if (hadInspectorFocus && !inspector.hidden) restoreInspectorFocus(focusKey);
  else if (hadProjectFocus && (focused !== document.activeElement || !focused.isConnected || focused.disabled)) {
    const replacement = focused.isConnected ? focused : focused.id && byId(focused.id);
    if (replacement && !replacement.disabled && !replacement.closest("[hidden]")) replacement.focus();
    else if (focusedChat) focusChatOpener(focusedChat);
    else byId("project-title").focus();
  }
  document.querySelectorAll("#draft-nav [data-layout]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.layout === layout));
  });
}

function selectProject(project, createdProject) {
  if (project !== activeProject) {
    relinkScreen += 1;
    relinkFeedback.clear();
    if (relinkOperation?.selection) {
      byId("relink-dialog").close();
      relinkOperation = undefined;
    }
  }
  activeProject = project;
  activity = project ? activityStore.get(project) : null;
  const runs = activity?.chats ?? [];
  selectedRun = (runs.find((item) => item.state === "waiting" || item.state === "failed") ?? runs[0])?.id;
  selectedHandoff = null;
  chatOpener = null;
  harnessFilter = "all";
  updateWorkspaceVisibility();
  renderProjectNav();
  if (project) {
    renderProjectContent();
    if (desktopActivity) {
      if (!harnesses.isOpen) desktopActivity.open(projectStore.get(project));
    } else {
      setLiveText("relationship-announcement", ["loading", "unavailable", "stale"].includes(activity.state)
        ? byId("relationship-status").textContent : "");
    }
  } else {
    desktopActivity?.close();
    renderDashboard();
    renderInspector();
  }
  announceProjectRegistration(createdProject);
}

function updateWorkspaceVisibility() {
  byId("dashboard").hidden = Boolean(activeProject || harnesses?.isOpen);
  byId("project-view").hidden = !activeProject || Boolean(harnesses?.isOpen);
}

function showHarnesses() {
  if (harnesses.isOpen) return;
  desktopActivity.close();
  byId("shell-add-harness").setAttribute("aria-current", "page");
  harnesses.open();
  updateWorkspaceVisibility();
  renderProjectNav();
}

function hideHarnesses() {
  byId("shell-add-harness").removeAttribute("aria-current");
  harnesses.close();
  updateWorkspaceVisibility();
  renderProjectNav();
}

function openHarnesses() {
  if (harnesses.isOpen) return;
  const url = new URL(location.href);
  url.searchParams.set("harnesses", "");
  history.pushState({ loomHarnesses: true }, "", url);
  showHarnesses();
}

function leaveHarnesses() {
  if (!harnesses.isOpen) return;
  if (history.state?.loomHarnesses) history.back();
  else {
    const url = new URL(location.href);
    url.searchParams.delete("harnesses");
    history.replaceState(null, "", url);
    readRoute(true);
  }
}

function readRoute(restoreFocus = false) {
  const query = new URLSearchParams(location.search);
  const draft = query.get("draft");
  if (Object.hasOwn(layouts, draft)) layout = draft;
  const requestedProject = query.get("project") ?? (Object.hasOwn(layouts, draft) ? projects[0]?.id : null);
  const project = projectStore.get(requestedProject) ? requestedProject : null;
  if (harnesses && query.has("harnesses")) {
    showHarnesses();
    if (activeProject !== project) selectProject(project);
    return;
  }
  if (harnesses?.isOpen) {
    hideHarnesses();
    if (activeProject !== project) selectProject(project);
    else if (project) desktopActivity.open(projectStore.get(project));
    if (restoreFocus) byId("shell-add-harness").focus();
    return;
  }
  const dashboardOpener = !project && chatOpener && byId("dashboard").contains(chatOpener.button) ? chatOpener : null;
  selectProject(project);
  if (dashboardOpener) focusChatOpener(dashboardOpener);
  else if (restoreFocus && document.activeElement === document.body) {
    byId(activeProject ? "project-title" : "dashboard-title").focus({ preventScroll: true });
  }
}

function navigateTo(project, opener, createdProject) {
  if (project !== activeProject || harnesses?.isOpen) {
    if (harnesses?.isOpen) hideHarnesses();
    const url = new URL(location.href);
    url.hash = "";
    if (harnesses) url.searchParams.delete("harnesses");
    if (project) url.searchParams.set("project", project);
    else url.searchParams.delete("project");
    if (projects.some(({ id }) => id === project)) url.searchParams.set("draft", layout);
    else url.searchParams.delete("draft");
    history.pushState(null, "", url);
    selectProject(project, createdProject);
  }
  if (opener?.dataset.run) showRun(opener);
  else {
    window.scrollTo(0, 0);
    byId(project ? "project-title" : "dashboard-title").focus({ preventScroll: true });
  }
}

function renderInspector(usage = usageStore.get(activeProject)) {
  const inspector = byId("detail");
  const run = activity && runById(selectedRun);
  const sameChat = run && announcedChat === `${activeProject}:${run.id}`;
  const focused = sameChat && inspector.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = focused?.dataset.focusKey;
  const openDetails = sameChat ? [...inspector.querySelectorAll("[data-detail-key]")]
    .filter((details) => details.open).map((details) => details.dataset.detailKey) : [];
  inspector.hidden = !run;
  if (run) {
    const questions = activityStore.get(activeProject).questions.filter(({ chatId }) => chatId === run.id);
    renderDetail(run, questions, usage);
    for (const details of inspector.querySelectorAll("[data-detail-key]")) {
      details.open = openDetails.includes(details.dataset.detailKey);
    }
    if (focused) restoreInspectorFocus(focusKey);
  } else {
    inspector.replaceChildren();
    editResultView.render(null, null);
    announcedChat = null;
    announcedDetailState = null;
    setLiveText("detail-announcement", "");
    setLiveText("run-usage-announcement", "");
    updateReplyFeedback();
  }
}

function restoreInspectorFocus(focusKey) {
  const inspector = byId("detail");
  const controls = [...inspector.querySelectorAll("[data-focus-key]")];
  const target = controls.find((control) => control.dataset.focusKey === focusKey && !control.disabled)
    ?? inspector.querySelector("[data-reply-form] textarea") ?? byId("detail-title");
  target.focus();
}

function syncChatSelection() {
  document.querySelectorAll("#work-grid [data-run][aria-pressed]").forEach((button) => {
    const selected = button.dataset.run === selectedRun;
    button.setAttribute("aria-pressed", String(selected));
    button.closest("tr")?.classList.toggle("selected", selected);
  });
}

function showRun(button) {
  const chatId = button.dataset.run;
  if (!runById(chatId)) return;
  const handoffId = button.closest("[data-handoff]")?.dataset.handoff;
  openChat.open({ projectId: activeProject, chatId });
  if (!byId("detail").contains(button)) {
    chatOpener = describeChatOpener(button);
  }
  selectedRun = chatId;
  selectedHandoff = handoffId ?? null;
  renderInspector();
  syncChatSelection();
  const form = [...byId("detail").querySelectorAll("[data-reply-form]")].find(
    (item) => item.dataset.replyForm === button.dataset.question,
  );
  (form?.querySelector("textarea") ?? byId("detail-title")).focus();
}

function describeChatOpener(button) {
  return {
    button, chatId: button.dataset.run, projectId: button.dataset.project, questionId: button.dataset.question,
    panelId: button.closest("section[id]")?.id, handoffId: button.closest("[data-handoff]")?.dataset.handoff,
  };
}

function focusChatOpener(opener) {
  const panel = opener?.panelId && byId(opener.panelId);
  const view = byId(activeProject ? "project-view" : "dashboard");
  const visiblePanel = panel && view.contains(panel) && !panel.hidden;
  const replacement = visiblePanel && [...panel.querySelectorAll(opener.chatId ? "[data-run]" : "[data-project]")].find((button) =>
    !button.disabled && button.dataset.run === opener.chatId && button.dataset.project === opener.projectId &&
    button.dataset.question === opener.questionId && button.closest("[data-handoff]")?.dataset.handoff === opener.handoffId);
  const target = opener && view.contains(opener.button) && !opener.button.disabled ? opener.button
    : replacement || (visiblePanel && panel.id === "board" && byId("harness-filter"));
  const fallback = (visiblePanel && panel.querySelector("h2"))
    || byId(activeProject ? "project-title" : "dashboard-title");
  if (target) target.focus();
  else {
    fallback.tabIndex = -1;
    fallback.focus();
  }
}

function closeChat() {
  const opener = chatOpener;
  if (opener && byId("dashboard").contains(opener.button)) {
    history.back();
    return;
  }
  chatOpener = null;
  selectedRun = null;
  selectedHandoff = null;
  renderInspector();
  syncChatSelection();
  focusChatOpener(opener);
}

function openProvider(id) {
  const model = usageCards.usageCardModel(id, getHarnessUsage(id));
  byId("dialog-title").textContent = demo.providers[id].name;
  byId("dialog-content").innerHTML = usageCards.renderUsageCard(model, escapeText);
  dialog.showModal();
  setLiveText("quota-dialog-announcement", model.announcement);
}

function openAdd(fromWizard = false) {
  addingFromWizard = fromWizard;
  const connected = harnessCatalog.listConnected();
  setLiveText("quota-dialog-announcement", "");
  byId("dialog-title").textContent = "Add a harness";
  byId("dialog-content").innerHTML = Object.entries(demo.providers).map(([id, provider]) => {
    const exists = connected.some((harness) => harness.id === id);
    return `<button type="button" class="add-option" data-connect="${id}" ${exists ? "disabled" : ""}>${mark(id)}<strong>${provider.name}</strong><span>${exists ? "Added" : "Add to demo"}</span></button>`;
  }).join("");
  dialog.showModal();
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.relinkProject) return chooseRelinkFolder(button);
  const { project, run, provider, connect, chatView, layout: draft } = button.dataset;

  if (chatView) setChatView(chatView);
  if (button.id === "close-chat") closeChat();
  if (draft) {
    layout = draft;
    const url = new URL(location.href);
    url.searchParams.set("draft", layout);
    history.replaceState(null, "", url);
    renderProjectContent();
  }
  if (button.hasAttribute("data-dashboard")) navigateTo(null);
  if (project) navigateTo(project, button);
  else if (run) showRun(button);
  if (desktopStore) return;
  if (provider) openProvider(provider);
  if (button.hasAttribute("data-add-provider")) openAdd();
  if (connect) {
    const { persisted } = harnessCatalog.connect(connect);
    dialog.close();
    renderProviders();
    if (addingFromWizard) wizard.harnessAdded();
    else document.querySelector(`[data-provider="${connect}"]`).focus();
    setLiveText("announcement", persisted ? "" : "The demo harness was added for this visit. Browser storage is unavailable.");
  }
});

document.addEventListener("change", (event) => {
  if (event.target.id !== "harness-filter") return;
  harnessFilter = event.target.value;
  renderBoard(usageStore.get(activeProject));
  byId("harness-filter").focus({ preventScroll: true });
});

dialog.addEventListener("close", () => {
  if (!dialog.open) setLiveText("quota-dialog-announcement", "");
});

function setLiveText(id, message) {
  const region = byId(id);
  if (region.textContent !== message) region.textContent = message;
}

function updateReplyFeedback() {
  const errors = [];
  for (const form of byId("detail").querySelectorAll("[data-reply-form]")) {
    const { pending = false, message = "" } = replyFeedback.get(form.dataset.replyForm) ?? {};
    const field = form.querySelector("textarea");
    const error = byId(`${field.id}-error`);
    const button = form.querySelector("button");
    field.readOnly = pending || form.dataset.unavailable === "true" || form.dataset.answered === "true";
    button.disabled = form.dataset.unavailable === "true" || form.dataset.answered === "true";
    button.setAttribute("aria-disabled", String(pending));
    form.querySelector("[data-reply-label]").textContent = pending ? "Sending demo reply…" : "Send demo reply";
    error.hidden = !message;
    error.textContent = message;
    if (message) {
      field.setAttribute("aria-invalid", "true");
      errors.push(message);
    } else field.removeAttribute("aria-invalid");
  }
  setLiveText("reply-alert", errors.join(" "));
}

document.addEventListener("input", (event) => {
  const field = event.target;
  const form = field.closest("[data-reply-form]");
  if (!form || form.dataset.unavailable === "true" || form.dataset.answered === "true" || replyFeedback.get(form.dataset.replyForm)?.pending) return;
  activityStore.saveDraft(activeProject, form.dataset.replyForm, field.value);
  if (replyFeedback.delete(form.dataset.replyForm)) updateReplyFeedback();
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!form.matches("[data-reply-form]")) return;
  event.preventDefault();
  const questionId = form.dataset.replyForm;
  if (!byId("detail").contains(form) || form.dataset.unavailable === "true" || form.dataset.answered === "true" ||
      chatDetailStore.get(activeProject, selectedRun).state !== "ready" || replyFeedback.get(questionId)?.pending) return;
  const field = form.querySelector("textarea");
  const answer = field.value;
  const message = replyError(answer);
  if (message) {
    setLiveText("detail-announcement", "");
    replyFeedback.set(questionId, { message });
    updateReplyFeedback();
    field.focus();
    return;
  }
  const projectId = activeProject;
  const chatId = selectedRun;
  replyFeedback.set(questionId, { pending: true });
  setLiveText("detail-announcement", "Sending demo reply…");
  updateReplyFeedback();
  const outcome = await chatActions.answerQuestion({ projectId, chatId, questionId, answer });
  replyFeedback.delete(questionId);
  if (outcome === "retry") {
    replyFeedback.set(questionId, { message: "Couldn’t record the demo reply. Try sending it again." });
    if (activeProject === projectId && selectedRun === chatId) setLiveText("detail-announcement", "");
  }
  if (outcome !== "recorded") {
    updateReplyFeedback();
    if (outcome === "retry" && form.contains(document.activeElement)) field.focus();
    return;
  }

  const focused = document.activeElement;
  const focusedForm = focused?.closest("[data-reply-form]");
  if (activeProject === projectId) {
    activity = activityStore.get(projectId);
    if (selectedRun === chatId && focusedForm?.dataset.replyForm === questionId) field.focus();
    renderProjectContent({ preserveInspector: selectedRun !== chatId });
    if (selectedRun === chatId) setLiveText("detail-announcement", "Demo reply recorded.");
  } else if (!activeProject) {
    renderDashboard();
  }
});

byId("detail").addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeChat();
});

const wizardStore = desktopStore ? {
  list: desktopStore.list,
  async create(metadata) {
    const result = await desktopStore.create(metadata);
    // A rejected save leaves the existing wizard's review draft available for retry.
    if (result.status === "invalid") throw new Error("Invalid project metadata");
    if (result.status === "unavailable") {
      byId("setup-dialog").close();
      selectProject(null);
      byId("dashboard-title").focus({ preventScroll: true });
    }
    return result;
  },
} : projectStore;

const wizard = mountWizard({
  projectStore: wizardStore, folderPicker: fixtureFolderPicker, harnessCatalog, harnessOptional: Boolean(desktopStore),
  mark, providers: demo.providers, projectDetails, navigateTo, openAdd,
  onProjectCreated: (project) => navigateTo(project.id, undefined, project),
});

byId("retry-connection").addEventListener("click", connectProjects);
if (harnesses) {
  byId("shell-add-harness").addEventListener("click", openHarnesses);
  byId("harness-back").addEventListener("click", leaveHarnesses);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.repeat || event.defaultPrevented || !harnesses.isOpen || harnesses.isEditing) return;
    event.preventDefault();
    leaveHarnesses();
  });
}
byId("relink-cancel").addEventListener("click", () => closeRelinkDialog(false));
byId("relink-confirm").addEventListener("click", () => closeRelinkDialog(true));
byId("relink-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  return closeRelinkDialog(false);
});
renderProviders();
if (desktopStore) {
  selectProject(null);
  await desktopStore.load();
  loadingProjects = false;
}
window.addEventListener("popstate", () => readRoute(true));
readRoute();
if (hasUnregisteredProjects()) await connectProjects();
desktopReady?.resolve();
