const unknown = Object.freeze({ status: "unknown" });
const failureMessages = new Map([
  ["helper-not-running", "Loom’s helper is not running."],
  ["not-registered", "Project not registered with Loom’s helper."],
  ["folder-unavailable", "Project folder unavailable."],
]);
const disconnected = "Not connected to Loom yet.";
const unavailable = "Project activity could not be read.";
const incomplete = "Some items are not shown.";
const ageLimit = 60_000;
const providerNames = new Map([
  ["claude", "Claude"], ["codex", "Codex"], ["openclaw", "OpenClaw"], ["antigravity", "Antigravity"],
]);
const roleNames = new Map([["origin", "Origin"], ["destination", "Destination"]]);
const runStates = ["Starting", "Running", "Completed", "Interrupted"];
const deliveryStates = ["Queued", "Accepted by transport", "Held for approval", "Delivered to chat", "Refused", "Needs verification"];
const questionFields = ["id", "chatId", "expiresAt", "excerpt", "excerptTruncated", "excerptWithheld"];
const formatTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
const integer = new Intl.NumberFormat();

function exact(value, ...keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

const bool = (value) => typeof value === "boolean";
const natural = (value) => Number.isSafeInteger(value) && value >= 0;
const time = (value) => Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000;
const id = (value) => typeof value === "string" && value.length >= 1 && value.length <= 128 && !/[^a-z0-9_-]/i.test(value);
const nullable = (value, check) => value === null || check(value);
function rows(value, cap, check) {
  return Array.isArray(value) && value.length <= cap &&
    Array.from(value).every(check) && new Set(value.map(({ id }) => id)).size === value.length;
}

function chat(value) {
  return exact(value, "id", "provider", "role", "placeholder", "runState", "createdAt", "lastActivityAt", "parentChatId", "deliveryState") &&
    id(value.id) && nullable(value.provider, (provider) => providerNames.has(provider)) &&
    nullable(value.role, (role) => roleNames.has(role)) && bool(value.placeholder) &&
    nullable(value.runState, (state) => runStates.includes(state)) && nullable(value.deliveryState, (state) => deliveryStates.includes(state)) &&
    nullable(value.createdAt, time) && nullable(value.lastActivityAt, time) &&
    nullable(value.parentChatId, id) && value.parentChatId !== value.id;
}

function question(value) {
  const hiddenForPath = Object.hasOwn(value ?? {}, "excerptWithheldForPath");
  const fields = hiddenForPath ? [...questionFields, "excerptWithheldForPath"] : questionFields;
  if (!exact(value, ...fields) ||
    !id(value.id) || !id(value.chatId) || !time(value.expiresAt) || !bool(value.excerptWithheld)) return false;
  if (hiddenForPath) return value.excerptWithheldForPath === true && !value.excerptWithheld &&
    value.excerpt === null && value.excerptTruncated === null;
  if (value.excerpt === null) return value.excerptTruncated === null;
  if (value.excerptWithheld || typeof value.excerpt !== "string" || !value.excerpt.isWellFormed() ||
    /\p{Cc}/u.test(value.excerpt) || !bool(value.excerptTruncated)) return false;
  const length = [...value.excerpt].length;
  return length > 0 && length <= 160 && (!value.excerptTruncated || length === 160);
}

export function readActivity(answer) {
  if (exact(answer, "status") && failureMessages.has(answer.status)) return { status: answer.status };
  if (!exact(answer, "status", "snapshot") || answer.status !== "ok") return unknown;
  const { snapshot } = answer;
  if (!exact(snapshot, "schema", "generatedAt", "truncated", "omitted", "counts", "chats", "questions")) return unknown;
  const { schema, generatedAt, truncated, omitted, counts, chats, questions } = snapshot;
  if (schema !== 1 || !time(generatedAt) ||
    !exact(truncated, "chats", "questions") || !bool(truncated.chats) || !bool(truncated.questions) ||
    !exact(omitted, "chats", "questions") || !natural(omitted.chats) || !natural(omitted.questions) ||
    !exact(counts, "runningRuns", "openQuestions") || !natural(counts.runningRuns) || !natural(counts.openQuestions) ||
    !rows(chats, 200, chat) || !rows(questions, 50, question)) return unknown;
  return { status: "ok", snapshot };
}

const isPartial = ({ truncated, omitted }, key) => truncated[key] || omitted[key] > 0;
const providerFor = (chat) => chat?.placeholder ? "Codex (not a chat yet)" : providerNames.get(chat?.provider) ?? "Unknown";

export function mountProjectActivity({ byId, store, escapeText, panelHeader, badge, setLiveText }) {
  const refreshButton = byId("refresh-project-activity");
  const note = byId("project-activity-status");
  const coverage = byId("project-activity-coverage");
  const relation = byId("chat-relations");
  const relationshipStatus = byId("relationship-status");
  const chatsPanel = byId("desktop-chats");
  const cache = new Map();
  let visit;
  let freshnessTimer;

  function timestamp(value) {
    if (value === null) return "Unknown";
    const date = new Date(value);
    return `<time datetime="${date.toISOString()}">${escapeText(formatTime.format(date))}</time>`;
  }

  function chatNode(chat, chatId) {
    return `<div class="map-node"><div class="run-name"><small>${providerFor(chat)}</small><strong>${escapeText(chatId)}</strong>
      <small>Run state · ${escapeText(chat?.runState ?? "Unknown")}</small>
      <small>Delivery state · ${escapeText(chat?.deliveryState ?? "Unknown")}</small></div></div>`;
  }

  function renderMap(chats, fallback) {
    const byChatId = new Map(chats?.map((chat) => [chat.id, chat]));
    const groups = new Map();
    for (const chat of byChatId.values()) {
      if (chat.parentChatId === null) continue;
      if (!groups.has(chat.parentChatId)) groups.set(chat.parentChatId, []);
      groups.get(chat.parentChatId).push(chat);
    }
    const body = [...groups].map(([parentId, targets]) => `<div class="map-group${targets.length > 1 ? " branches" : ""}">
      <div class="map-source"><span class="list-column-label">Originating chat</span>${chatNode(byChatId.get(parentId), parentId)}</div>
      <div><span class="list-column-label">Destination chats</span><ul class="map-targets" role="list" aria-label="Destinations from ${escapeText(parentId)}">
        ${targets.map((chat) => `<li>${chatNode(chat, chat.id)}</li>`).join("")}</ul></div></div>`).join("");
    relationshipStatus.textContent = body ? "" : fallback || "No chat relationships are shown.";
    relationshipStatus.hidden = Boolean(body);
    byId("map-legend").hidden = !body;
    relation.innerHTML = body ? `<div class="map-body">
      <div class="map-column-labels"><span>Originating chat</span><span>Destination chats</span></div>${body}</div>` : "";
  }

  function chatCard(chat) {
    return `<li><div class="activity-card run-name"><small>${providerFor(chat)}</small><strong>${escapeText(chat.id)}</strong>
      <small>Role · ${roleNames.get(chat.role) ?? "Unknown"}</small>
      <small>Run state · ${escapeText(chat.runState ?? "Unknown")}</small>
      <small>Delivery state · ${escapeText(chat.deliveryState ?? "Unknown")}</small>
      <small>Originating chat · ${escapeText(chat.parentChatId ?? "Unknown")}</small>
      <small>Created · ${timestamp(chat.createdAt)}</small>
      <small>Last activity · ${timestamp(chat.lastActivityAt)}</small>
    </div></li>`;
  }

  function questionCard(question, chats) {
    const { chatId, excerpt, excerptWithheld, excerptWithheldForPath, excerptTruncated, expiresAt } = question;
    const text = excerptWithheldForPath ? "Question text hidden: it contains a file path." :
      excerptWithheld ? "Question text hidden: it looks like it contains a key or password." : excerpt ?? "Unknown";
    return `<li><div class="activity-card run-name"><small>${providerFor(chats.get(chatId))}</small><strong>${escapeText(chatId)}</strong>
      <p class="question-excerpt">${escapeText(text)}</p>
      ${excerptTruncated ? "<small>Excerpt truncated.</small>" : ""}
      <small>Expires · ${timestamp(expiresAt)}</small></div></li>`;
  }

  function renderLists(snapshot, fallback) {
    const note = (message) => `<p class="empty">${escapeText(message)}</p>`;
    const list = (cards) => `<ul class="running-list" role="list">${cards.join("")}</ul>`;
    const { counts, questions, chats } = snapshot ?? {};
    const questionEmpty = counts && (counts.openQuestions > 0 || isPartial(snapshot, "questions"))
      ? "No question excerpts are shown." : "No open questions in this folder.";
    const chatEmpty = snapshot && isPartial(snapshot, "chats") ? "No chats are shown." : "No chats yet.";
    byId("running").innerHTML = panelHeader("running-title", "Running runs", badge("running", counts ? `${integer.format(counts.runningRuns)} active` : "—")) +
      (counts ? "" : note(fallback));
    const byChatId = new Map(chats?.map((chat) => [chat.id, chat]));
    byId("open-questions").innerHTML = panelHeader("open-questions-title", "Open questions", badge("waiting", counts ? `${integer.format(counts.openQuestions)} open` : "—")) +
      (questions?.length ? list(questions.map((question) => questionCard(question, byChatId))) : note(snapshot ? questionEmpty : fallback));
    chatsPanel.innerHTML = panelHeader("desktop-chats-title", "Chats") +
      (chats?.length ? list(chats.map(chatCard)) : note(snapshot ? chatEmpty : fallback));
    renderMap(chats, fallback);
  }

  function renderStatus(current, announce = false) {
    clearTimeout(freshnessTimer);
    const { snapshot, failure, pending } = current;
    const reason = failureMessages.get(failure) ?? (failure ? unavailable : "");
    const delay = snapshot ? snapshot.generatedAt + ageLimit + 1 - Date.now() : 0;
    const stale = Boolean(snapshot && (failure || delay <= 0));
    const partial = snapshot && (isPartial(snapshot, "chats") || isPartial(snapshot, "questions"));
    const headline = snapshot ? stale ? "Stale snapshot from" : "Snapshot from" : pending ? "Loading activity…" : disconnected;
    const detail = pending ? (snapshot ? "Refreshing activity…" : "") : reason;
    note.innerHTML = escapeText(headline) + (snapshot ? ` ${timestamp(snapshot.generatedAt)}.` : "") +
      (detail ? ` ${escapeText(detail)}` : "");
    coverage.hidden = !partial;
    coverage.textContent = partial ? incomplete : "";
    if (announce) {
      const summary = snapshot ? stale ? `Stale snapshot from ${formatTime.format(snapshot.generatedAt)}.` :
        `Activity updated. ${integer.format(snapshot.counts.runningRuns)} active. ${integer.format(snapshot.counts.openQuestions)} open.` : disconnected;
      setLiveText("relationship-announcement", [summary, reason, partial && incomplete].filter(Boolean).join(" "));
    }
    if (snapshot && !stale) {
      freshnessTimer = setTimeout(() => {
        if (visit === current) renderStatus(current, true);
      }, Math.min(delay, 2_147_483_647));
    }
  }

  async function refresh() {
    const current = visit;
    if (!current || current.pending) return;
    current.pending = true;
    refreshButton.setAttribute("aria-disabled", "true");
    relation.setAttribute("aria-busy", "true");
    renderStatus(current);
    const result = await store.projectActivity(current.project.id);
    if (visit !== current) return;
    current.pending = false;
    refreshButton.removeAttribute("aria-disabled");
    current.failure = result.status === "ok" ? "" : result.status;
    if (result.status === "ok" || !current.snapshot) {
      current.snapshot = result.snapshot;
      renderLists(current.snapshot, disconnected);
    }
    relation.setAttribute("aria-busy", "false");
    if (current.snapshot) cache.set(current.project.id, {
      project: current.project, snapshot: current.snapshot, failure: current.failure,
    });
    renderStatus(current, true);
  }

  const sameBinding = (left, right) => left?.id === right.id && left.path === right.path && left.folderIdentity === right.folderIdentity;

  function open(project) {
    if (sameBinding(visit?.project, project)) {
      if (visit.project.registration === project.registration) return;
      // Discard any reply started before the registration changed.
      visit = { ...visit, project, pending: false };
      return refresh();
    }
    clearTimeout(freshnessTimer);
    const previous = cache.get(project.id);
    const snapshot = sameBinding(previous?.project, project) ? previous.snapshot : undefined;
    if (!snapshot) cache.delete(project.id);
    visit = { project, snapshot, failure: snapshot ? previous.failure : "" };
    setLiveText("relationship-announcement", "");
    renderLists(snapshot, "Loading activity…");
    return refresh();
  }

  function close() {
    if (!visit) return;
    visit = undefined;
    clearTimeout(freshnessTimer);
    setLiveText("relationship-announcement", "");
  }

  refreshButton.addEventListener("click", refresh);
  byId("desktop-project-activity").hidden = false;
  chatsPanel.hidden = false;
  return { open, close };
}
