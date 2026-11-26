import { replyError } from "./chat-details.mjs";
import { parseEditResult } from "./edit-result.mjs";
import { measureRun } from "./usage.mjs";

// ProjectStore: list(), get(id), create(metadata). Only create writes project metadata.
export function fixtureProjectStore({ storage, key, seed = [], locks = globalThis.navigator?.locks }) {
  function read() {
    const value = storage.getItem(key);
    return value === null ? [] : JSON.parse(value);
  }

  function list() {
    try {
      return [...seed, ...read()];
    } catch {
      return [...seed];
    }
  }

  return Object.freeze({
    list,
    get: (id) => list().find((project) => project.id === id),
    async create(metadata) {
      const save = async () => {
        const saved = read();
        const existing = [...seed, ...saved].find((project) => project.folderIdentity === metadata.folderIdentity);
        if (existing) return { status: "duplicate", project: existing };

        const project = { ...metadata, id: crypto.randomUUID() };
        storage.setItem(key, JSON.stringify([...saved, project]));
        return { status: "created", project };
      };
      // The lookup and write share a lock across same-origin browser tabs.
      return locks ? locks.request(key, save) : save();
    },
  });
}

// FolderPicker: pick(path) returns a resolved directory and opaque identity, or a failure.
const aliases = new Map([["/loom-fixtures/atlas-alias", "/loom-fixtures/atlas"]]);

export const fixtureFolderPicker = Object.freeze({
  pick(input) {
    const path = input.trim();
    if (!path.startsWith("/") || path.includes("\0")) return { status: "invalid" };

    const parts = [];
    for (const part of path.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        parts.pop();
        continue;
      }
      parts.push(part);
      const current = "/" + parts.join("/");
      if (current === "/loom-fixtures/unavailable") return { status: "inaccessible" };
      if (aliases.has(current)) parts.splice(0, parts.length, ...aliases.get(current).slice(1).split("/"));
    }

    const resolved = "/" + parts.join("/");
    return { status: "chosen", path: resolved, folderIdentity: resolved };
  },
});

// HarnessCatalog: listConnected() includes the main preference. connect(id) adds a fixture only.
export function fixtureHarnessCatalog({ storage, key, initial, supported }) {
  let sessionConnections;
  function connectedIds() {
    if (sessionConnections) return sessionConnections;
    try {
      const value = storage.getItem(key);
      return value === null ? initial : JSON.parse(value).filter((id) => supported.includes(id));
    } catch {
      return initial;
    }
  }

  return Object.freeze({
    listConnected: () => connectedIds().map((id, index) => ({ id, main: index === 0 })),
    connect(id) {
      if (!supported.includes(id)) throw new RangeError("Unknown harness");
      const ids = [...new Set([...connectedIds(), id])];
      try {
        storage.setItem(key, JSON.stringify(ids));
        sessionConnections = undefined;
        return { persisted: true };
      } catch {
        sessionConnections = ids;
        return { persisted: false };
      }
    },
  });
}

// Only the browser preview loads these assets. The packaged shell has no fixture usage source.
export async function fixtureHarnessUsage(scenario) {
  const { default: samples } = await import("./usage-fixtures.json", { with: { type: "json" } });
  const management = {
    claude: "Claude account settings",
    codex: "Codex account settings",
    openclaw: "OpenClaw gateway settings",
    antigravity: "Antigravity account settings",
    hostile: '<a href="fake-manage">Fake manage destination</a>',
  };
  return (harness) => {
    const key = harness === "claude" && scenario === "hostile" ? "hostile" : harness;
    if (!Object.hasOwn(samples, key)) return {};
    return { ...structuredClone(samples[key]), manage: management[key], loading: harness === "claude" && scenario === "loading" };
  };
}

// UsageStore: get(projectId) returns usage records by exact project and run IDs.
// A ready (or stale) empty array is an observation. Loading and unavailable have no records.
export function fixtureUsageStore({ records, scenario }) {
  const samples = structuredClone(records).map(measureRun);
  return Object.freeze({
    get(projectId) {
      const records = samples.filter((run) => run.projectId === projectId);
      const preview = typeof scenario === "function" ? scenario() : scenario;
      if (!records.length || preview === "empty") return { state: "ready", records: [] };
      if (preview === "loading" || preview === "unavailable") return { state: preview };
      return { state: preview === "stale" ? "stale" : "ready", records: structuredClone(records) };
    },
  });
}

// ActivityStore: get(projectId) returns availability and a project-scoped snapshot
// of chats, handoffs, edges and questions. Loading and unavailable have no data.
// Each edge links one handoff to its current destination and its replaced destinations.
// Demo replies are session-only.
export function fixtureActivityStore({ chats, handoffs, edges, questions, scenario }) {
  const records = structuredClone({ chats, handoffs, edges, questions });
  const chatsById = new Map(records.chats.map((chat) => [chat.id, chat]));
  const questionsById = new Map(records.questions.map((question) => [question.id, question]));
  const hidesActivity = ["empty", "loading", "unavailable"].includes(scenario);

  function get(projectId) {
    const projectChats = records.chats.filter((chat) => chat.project === projectId);
    const hasChats = projectChats.length > 0;
    const state = hasChats && ["loading", "stale", "unavailable"].includes(scenario) ? scenario : "ready";
    if (!hasChats || hidesActivity) {
      return { state, chats: [], handoffs: [], edges: [], questions: [] };
    }

    const chatIds = new Set(projectChats.map(({ id }) => id));
    const projectHandoffs = records.handoffs.filter((handoff) => handoff.projectId === projectId);
    const handoffIds = new Set(projectHandoffs.map(({ id }) => id));
    return structuredClone({
      state,
      chats: projectChats,
      handoffs: projectHandoffs,
      edges: records.edges.filter(({ handoffId }) => handoffIds.has(handoffId)),
      questions: records.questions.filter(({ chatId }) => chatIds.has(chatId)),
    });
  }

  function openQuestion(projectId, questionId) {
    const question = questionsById.get(questionId);
    if (hidesActivity || question?.state !== "open" || chatsById.get(question.chatId)?.project !== projectId) return;
    return question;
  }

  return Object.freeze({
    get,
    saveDraft(projectId, questionId, draft) {
      const question = openQuestion(projectId, questionId);
      if (question) question.draft = draft;
    },
    reply(projectId, questionId, input, answerTime) {
      const question = openQuestion(projectId, questionId);
      if (!question || replyError(input)) return false;

      question.reply = input.trim();
      question.state = "answered";
      if (answerTime) question.answerTime = answerTime;
      delete question.draft;
      const chat = chatsById.get(question.chatId);
      if (!records.questions.some(({ chatId, state }) => chatId === chat.id && state === "open")) {
        chat.state = "running";
      }
      return true;
    },
  });
}

// OpenChat: open({ projectId, chatId }) requests the exact chat by ID.
export function fixtureOpenChat() {
  const requests = [];
  return Object.freeze({
    open({ projectId, chatId }) {
      requests.push({ projectId, chatId });
    },
    requests: () => structuredClone(requests),
  });
}

// ChatDetailStore: get(projectId, chatId) reads supplementary detail data by exact identity.
export function fixtureChatDetailStore({ records, scenario }) {
  const data = structuredClone(records);
  return Object.freeze({
    get(projectId, chatId) {
      const record = data.find((item) => item.projectId === projectId && item.chatId === chatId);
      const currentScenario = typeof scenario === "function" ? scenario() : scenario;
      if (!record || currentScenario === "unavailable") return { state: "unavailable" };
      if (currentScenario === "loading") return { state: "loading" };
      return { ...structuredClone(record), state: currentScenario === "stale" ? "stale" : "ready" };
    },
  });
}

// ChatActions records demo answers and copyPatch(runId) requests in memory.
export function fixtureChatActions({ activityStore, editResultStore, beforeAnswer = () => {}, answerTime = "10:14" }) {
  const pending = new Set();
  const requests = [];
  const patchRequests = [];
  return Object.freeze({
    async answerQuestion({ projectId, chatId, questionId, answer }) {
      const snapshot = activityStore.get(projectId);
      const question = snapshot.questions.find((item) => item.id === questionId && item.chatId === chatId);
      if (question?.state !== "open" || pending.has(questionId)) return "ignored";
      if (replyError(answer)) return "invalid";

      pending.add(questionId);
      requests.push({ projectId, chatId, questionId, answer: answer.trim() });
      try {
        activityStore.saveDraft(projectId, questionId, answer);
        await beforeAnswer();
        return activityStore.reply(projectId, questionId, answer, answerTime) ? "recorded" : "ignored";
      } catch {
        return "retry";
      } finally {
        pending.delete(questionId);
      }
    },
    requests: () => structuredClone(requests),
    copyPatch(runId) {
      if (!editResultStore?.get(runId)?.canCopy) return "ignored";
      patchRequests.push({ runId });
      return "recorded";
    },
    patchRequests: () => structuredClone(patchRequests),
  });
}

export function fixtureEditResultStore({ scenario } = {}) {
  const ready = {
    state: "ready",
    originPreserved: true,
    paths: ["styles/settings.css", "styles/spacing.css", "styles/legacy-spacing.css"],
    seed: [{ path: "notes/settings-spacing.md", sha256: "1b".repeat(32), bytes: 48 }],
    diff: `diff --git a/styles/settings.css b/styles/settings.css
--- a/styles/settings.css
+++ b/styles/settings.css
@@ -1,3 +1,3 @@
 .settings {
-  gap: 8px;
+  gap: var(--space-sm);
 }
diff --git a/styles/spacing.css b/styles/spacing.css
new file mode 100644
--- /dev/null
+++ b/styles/spacing.css
@@ -0,0 +1,2 @@
+:root { --space-sm: 8px; }
+:root { --space-md: 16px; }
diff --git a/styles/legacy-spacing.css b/styles/legacy-spacing.css
deleted file mode 100644
--- a/styles/legacy-spacing.css
+++ /dev/null
@@ -1,2 +0,0 @@
-.settings-row { margin: 8px; }
-.settings-card { padding: 16px; }
`,
  };
  const hostilePath = "../../etc/x";
  const hostile = [
    "diff --git a/sample.txt b/sample.txt",
    "--- a/sample.txt",
    `+++ b/${hostilePath}`,
    "@@ -1 +1,2001 @@",
    '-<strong>Sample old value</strong>',
    '+<img src="fake-fixture.png"> & <em>Sample patch</em>',
    "+Control characters: \x00\x1B\x7F\u0085\u202E",
    `+${"long-value-".repeat(750)}`,
    ...Array.from({ length: 1998 }, (_, index) => `+Sample line ${index + 4}`),
    "",
  ].join("\n");
  const results = new Map(Object.entries({
    ready,
    stale: { ...ready, state: "stale", originPreserved: null },
    "origin-changed": { ...ready, originPreserved: false },
    unavailable: { state: "unavailable" },
    loading: { state: "loading" },
    "too-large": { state: "too-large", stat: " styles/generated-spacing.css | 8000 +\n 1 file changed, 8000 insertions(+)" },
    "test-failed": { ...ready, tests: { state: "failed", name: "Settings spacing snapshot mismatch" } },
    hostile: { ...ready, paths: [hostilePath], diff: hostile },
  }).map(([name, raw]) => [name, parseEditResult(raw)]));
  return Object.freeze({
    get(runId) {
      const preview = typeof scenario === "function" ? scenario() : scenario;
      if (runId === "tokens") return results.get(preview) ?? results.get("ready");
    },
  });
}
