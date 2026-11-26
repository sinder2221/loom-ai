// Illustrative observations and USD rates per million tokens for the UI drafts.
export const demo = {
  providers: {
    claude: {
      name: "Claude Code",
      mark: "✳",
    },
    codex: {
      name: "Codex",
      mark: "⌘",
    },
    openclaw: {
      name: "OpenClaw",
      mark: "◇",
    },
    antigravity: {
      name: "Antigravity",
      mark: "▲",
    },
  },
  projects: [
    { id: "atlas", name: "Atlas Workspace", path: "/loom-fixtures/atlas", mainHarness: "claude" },
    { id: "pine", name: "Pine API", path: "/loom-fixtures/pine-api", mainHarness: "claude" },
  ],
  models: {
    sonnet: { name: "Claude Sonnet", rates: { input: 3, output: 14, cacheRead: 0.3, cacheWrite: 3.5 } },
    codex: { name: "Codex Standard", rates: { input: 2, output: 11, cacheRead: 0.25, cacheWrite: 2 } },
    gateway: { name: "Gateway model", rates: null },
  },
  runs: [
    {
      id: "settings", project: "atlas", origin: null, harness: "claude", model: "sonnet",
      title: "Settings redesign", time: "09:42", seconds: 996, turns: 8, state: "running",
      tokens: { input: 45800, output: 8400, cacheRead: 192500, cacheWrite: 21500 },
      build: { state: "skipped", completed: 0, total: 0, detail: "This chat delegated the work and did not run build checks." },
      brief: "Coordinate changes to the settings area and review the results before they land.",
    },
    {
      id: "audit", project: "atlas", origin: "settings", harness: "codex", model: "codex",
      title: "Implement audit filters", time: "10:06", seconds: 522, turns: 5, state: "waiting",
      tokens: { input: 36300, output: 10500, cacheRead: 113000, cacheWrite: 0 },
      build: { state: "queued", completed: 0, total: 12, detail: "The audit filter checks are queued and have yet to start." },
      brief: "Add date and action filters to the audit log while preserving existing bookmarks.",
    },
    {
      id: "tests", project: "atlas", origin: "settings", harness: "codex", model: "codex",
      title: "Cover audit filters", time: "10:03", seconds: 738, turns: 9, state: "running",
      tokens: { input: 64200, output: 17800, cacheRead: 225400, cacheWrite: 0 },
      build: { state: "running", completed: 7, total: 12, detail: "Seven checks have completed. The shared-link cases are still running." },
      brief: "Cover date ranges, action filters, and shared links in the audit log test suite.",
    },
    {
      id: "tokens", project: "atlas", origin: "settings", harness: "codex", model: "codex",
      title: "Verify spacing tokens", time: "09:57", seconds: 311, turns: 4, state: "completed",
      tokens: { input: 21600, output: 6700, cacheRead: 58600, cacheWrite: 0 },
      build: { state: "passed", completed: 12, total: 12, detail: "All spacing and visual snapshot checks passed." },
      brief: "Check the settings screens for hard-coded spacing and use shared tokens where appropriate.",
      result: "Replaced four hard-coded spacing values and verified the settings snapshots.",
    },
    {
      id: "notes", project: "atlas", origin: "settings", harness: "openclaw", model: "gateway",
      title: "Draft release notes", time: "10:01", seconds: 194, turns: 3, state: "completed",
      tokens: { input: 14500, output: 2600, cacheRead: 7900, cacheWrite: 0 },
      build: { state: "skipped", completed: 0, total: 0, detail: "This documentation task did not require build checks." },
      brief: "Draft release notes for the settings update and the new audit filters.",
      result: "Drafted user-facing notes for the settings and audit log changes.",
    },
    {
      id: "pine-origin", project: "pine", origin: null, harness: "claude", model: "sonnet",
      title: "Prepare API migration", time: "09:32", seconds: 462, turns: 5, state: "completed",
      tokens: { input: 27900, output: 5200, cacheRead: 64000, cacheWrite: 7800 },
      build: { state: "skipped", completed: 0, total: 0, detail: "This chat delegated the smoke test to Codex." },
      brief: "Check whether the new schema is ready to migrate on the next release.",
      result: "Sent the migration smoke test to Codex for verification.",
    },
    {
      id: "schema", project: "pine", origin: "pine-origin", harness: "codex", model: "codex",
      title: "Check migration build", time: "09:40", seconds: 603, turns: 6, state: "failed",
      tokens: { input: 39100, output: 7300, cacheRead: 85000, cacheWrite: 0 },
      build: { state: "failed", completed: 6, total: 12, detail: "The legacy fixture has a null creation date, which the new schema rejects." },
      brief: "Run the migration against the legacy database fixture and report the first failure.",
      result: "The migration halted at the new creation-date constraint.",
    },
    {
      id: "tests-previous", project: "atlas", origin: "settings", harness: "codex", model: "codex",
      title: "Cover audit filters (previous chat)", time: "09:51", seconds: 0, turns: 0, state: "failed",
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      build: { state: "skipped", completed: 0, total: 0, detail: "This chat was replaced before it ran any checks." },
      brief: "Cover date ranges, action filters, and shared links in the audit log test suite.",
    },
  ],
  questions: [
    {
      id: "audit-link-question", chatId: "audit", state: "open",
      text: "Should the filters stay in the URL so users can share a filtered audit log?",
    },
  ],
};

export function usageFixture(chats, scenario) {
  const records = chats.map(({ id, project, seconds, turns, tokens, build, model }) => ({
    runId: id, projectId: project, seconds, turns, tokens, build, rates: demo.models[model].rates,
  }));
  if (scenario === "hostile") {
    const audit = records.find(({ runId }) => runId === "audit");
    if (audit) audit.build = { ...audit.build, detail: "<strong>Fake build detail</strong>" };
  }
  return records;
}

// Each entry represents one handoff. A separate chat ID identifies each destination.
const handoffs = [
  { id: "atlas-audit", projectId: "atlas", originChatId: "settings", activeChatId: "audit" },
  { id: "atlas-tests", projectId: "atlas", originChatId: "settings", activeChatId: "tests", supersededChatIds: ["tests-previous"] },
  { id: "atlas-tokens", projectId: "atlas", originChatId: "settings", activeChatId: "tokens" },
  { id: "atlas-notes", projectId: "atlas", originChatId: "settings", activeChatId: "notes" },
  { id: "pine-schema", projectId: "pine", originChatId: "pine-origin", activeChatId: "schema" },
];

export function activityFixture({ empty, scenario }) {
  const chats = structuredClone(demo.runs);
  const questions = structuredClone(demo.questions);
  if (scenario === "hostile") {
    chats.find(({ id }) => id === "settings").title = `<strong>Fake origin</strong> & "quotes"`;
    const audit = chats.find(({ id }) => id === "audit");
    audit.title = `<img src="fake-fixture.png"> Fake chat & "quotes"`;
    audit.brief = "<strong>Fake brief</strong>";
    questions[0].text = "</textarea><strong>Fake question</strong>";
  }
  return {
    scenario,
    chats: empty ? [] : chats,
    questions: empty ? [] : questions,
    handoffs: empty ? [] : handoffs.map(({ id, projectId, originChatId }) => ({ id, projectId, originChatId })),
    edges: empty ? [] : handoffs.map(({ id, activeChatId, supersededChatIds = [] }) => ({
      handoffId: id, activeChatId, supersededChatIds,
    })),
  };
}

export function chatDetailFixture({ scenario, hostile }) {
  const records = demo.runs.map((run) => {
    const folder = demo.projects.find(({ id }) => id === run.project).path;
    return {
      projectId: run.project,
      chatId: run.id,
      workspace: { label: "Folder", path: folder },
      deliveries: [],
      result: run.result ? { summary: run.result } : null,
      evidence: { state: "unavailable" },
    };
  });
  const forChat = (id) => records.find(({ chatId }) => chatId === id);
  forChat("audit").workspace = { label: "Worktree", path: "/loom-fixtures/atlas/worktrees/audit-filters" };
  forChat("audit").deliveries = [
    { time: "10:06", message: "Chat brief", state: "Delivered to chat", receipt: "Sample destination receipt" },
    { time: "10:07", message: "Question", state: "Accepted by transport" },
    { time: "10:08", message: "Context update", state: "Held for approval" },
    { time: "10:09", message: "Progress update", state: "Refused" },
    { time: "10:10", message: "Status update", state: "Needs verification" },
    { time: "10:11", message: "Follow-up note" },
    { time: "10:12", message: "Build update", state: "Queued" },
  ];
  forChat("tests").result = { summary: "The replacement ran the shared-link cases and is still checking date ranges." };
  forChat("tests-previous").result = {
    summary: "The previous chat reported a shared-link finding after its replacement started.", time: "10:13", late: true,
  };
  forChat("tokens").evidence = { state: "passed", name: "Settings spacing and visual snapshots" };
  forChat("tokens").workspace = { label: "Worktree", path: "/loom-fixtures/atlas/worktrees/settings-spacing" };
  forChat("schema").evidence = { state: "failed", name: "Legacy migration smoke test" };

  if (hostile) {
    const audit = forChat("audit");
    audit.workspace.path = '/loom-fixtures/<strong>Fake worktree</strong>';
    audit.deliveries[0].message = '<em>Fake message</em> & "quotes"';
    audit.deliveries[0].receipt = '<strong>Fake receipt</strong>';
    audit.result = { summary: '<strong>Fake result</strong>' };
    audit.evidence = { state: "failed", name: '<strong>Fake test name</strong>' };
  }
  return { records, scenario };
}
