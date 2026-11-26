import { goals } from "./wizard.mjs";
import { readActivity } from "./desktop-activity.mjs";

const presets = new Map(Object.entries(goals).map(([id, label]) => [label, id]));
const unavailable = Object.freeze({ status: "unavailable" });
const uncertain = Object.freeze({ status: "uncertain" });
const registrations = new Set(["registered", "unregistered", "conflict"]);
const folders = new Set(["ok", "changed", "missing"]);

const validId = (id) => typeof id === "string" && id.length === 32 && !/[^0-9a-f]/.test(id);
const validName = (name) => typeof name === "string" && /[^\p{White_Space}]/u.test(name) &&
  !/\p{Cc}/u.test(name) && [...name].length <= 80;
const validPath = (path) => typeof path === "string" && path.startsWith("/") && !path.includes("\0") &&
  (path === "/" || path.slice(1).split("/").every((part) => !["", ".", ".."].includes(part)));

function validIdentity(identity) {
  if (typeof identity !== "string") return false;
  const parts = identity.split(":");
  return parts.length === 2 && parts.every((part) => part.length > 0 && part.length <= 20 &&
    !/[^0-9]/.test(part) && (part.length === 1 || part[0] !== "0") && BigInt(part) <= 0xffffffffffffffffn);
}

function readProject(value) {
  const { id, name, path, folderIdentity, goal, connection, rules, createdAt, registration, folder } = value ?? {};
  if (!validId(id) || !validName(name) || !validPath(path) ||
      !validIdentity(folderIdentity) ||
      !Number.isSafeInteger(createdAt) || createdAt < 0) return;
  for (const [field, limit] of [[goal, 320], [connection, 128], [rules, 1200]]) {
    if (typeof field !== "string" || [...field].length > limit) return;
  }
  return Object.freeze({
    id, name, path, folderIdentity, goal, connection, rules, createdAt,
    registration: registrations.has(registration) ? registration : "unregistered",
    folder: folders.has(folder) ? folder : "unknown",
  });
}

function readProjects(result) {
  if (result?.status !== "ok" || !Array.isArray(result.projects)) return;
  const projects = new Map();
  const identities = new Set();
  for (const entry of result.projects) {
    const project = readProject(entry);
    if (!project || projects.has(project.id) || identities.has(project.folderIdentity)) return;
    projects.set(project.id, project);
    identities.add(project.folderIdentity);
  }
  return { status: "ok", projects };
}

function nativeMetadata({ name, path, folderIdentity, goal, description, mainHarness, connection, rules }) {
  // A preset alone uses its id. A reviewed description is retained with the goal as text.
  const savedGoal = description ? [goal, description].filter(Boolean).join("\n") : presets.get(goal) ?? goal;
  const savedName = typeof name === "string" ? name.replace(/\p{Cc}+/gu, " ").trim() : name;
  return { name: savedName, path, folderIdentity, goal: savedGoal, connection: mainHarness ?? connection, rules };
}

function readRelink(answer, saved, selection) {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return;
  const { status, ownerId, ownerName, token, savedPath, selectedPath } = answer;
  const fields = Object.keys(answer).length;
  switch (status) {
    case "relinked": {
      const project = readProject(answer.project);
      if (fields !== 2 || !project || !Object.hasOwn(answer.project, "registration") ||
        !Object.hasOwn(answer.project, "folder") || !["id", "name", "goal", "connection", "rules", "createdAt"]
        .every((key) => project[key] === saved[key])) return;
      const matches = selection
        ? project.path === selection.selectedPath && project.folderIdentity !== saved.folderIdentity
        : project.path !== saved.path && project.folderIdentity === saved.folderIdentity;
      if (matches) return { status, project };
      break;
    }
    case "duplicate":
      if (fields === 3 && validId(ownerId) && ownerId !== saved.id && validName(ownerName)) {
        return { status, ownerId, ownerName };
      }
      break;
    case "confirm":
      if (!selection && fields === 4 && validId(token) && savedPath === saved.path && validPath(selectedPath)) {
        return { status, token, savedPath, selectedPath };
      }
      break;
    default: {
      const allowed = selection ? ["changed", "expired"] : ["cancelled", "inaccessible", "unchanged", "invalid"];
      if (fields === 1 && allowed.includes(status)) return { status };
    }
  }
}

export const validDelegationLabel = (label) => typeof label === "string" && label.isWellFormed() &&
  label.trim() !== "" && [...label].length <= 60 && !/\p{Cc}/u.test(label);
export const validDelegationModel = (model) => typeof model === "string" && model.length <= 128 &&
  /^[a-z0-9]/i.test(model) && !/[^a-z0-9_.:/-]/i.test(model) && !/^[a-z]:|:\/\//i.test(model);

const unknown = Object.freeze({ status: "unknown" });
const delegationStates = new Set(["not-enabled", "not-registered", "folder-unavailable", "helper-not-running", "unknown"]);
const delegationRefusals = new Set(["sensitive-label", "delegation-conflict", "not-registered", "folder-unavailable", "invalid-request"]);

function readDelegation(answer, saving) {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return unknown;
  const { status, accountLabel, model, reason } = answer;
  const fields = Object.keys(answer).length;
  if (fields === 1 && (saving ? ["saved", "helper-not-running"].includes(status) : delegationStates.has(status))) {
    return { status };
  }
  if (saving && fields === 2 && status === "refused" && delegationRefusals.has(reason)) {
    return { status, reason };
  }
  if (!saving && fields === 3 && status === "enabled" && validDelegationLabel(accountLabel) &&
    accountLabel.trim() === accountLabel && validDelegationModel(model)) return { status, accountLabel, model };
  return unknown;
}

export function createDesktopProjectStore(invoke, { timeoutMs = 5_000, chooseTimeoutMs = 300_000 } = {}) {
  let status = "unavailable";
  let loading;
  let connecting;
  let revision = 0;
  let projects = new Map();
  let relinking = false;
  let pending;
  const unverified = new Map();
  const pendingDelegation = new Map();

  function fail() {
    status = "unavailable";
    projects.clear();
    return unavailable;
  }

  async function call(command, args, read, limit = timeoutMs, request) {
    let timer;
    try {
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(unavailable), limit);
      });
      let reply = invoke(command, args);
      if (request) {
        request.settled = false;
        request.completion = Promise.resolve(reply);
        reply = request.completion.finally(() => { request.settled = true; });
      }
      return read(await Promise.race([reply, timeout])) ?? unavailable;
    } catch {
      return unavailable;
    } finally {
      clearTimeout(timer);
    }
  }

  function load() {
    loading ??= call("list_projects", {}, readProjects).then((result) => {
      if (result.status === "ok") {
        projects = result.projects;
        status = "ok";
      }
      return { status };
    });
    return loading;
  }

  function connect() {
    connecting ??= (async () => {
      await load();
      if (status !== "ok") return unavailable;
      let verified = false;
      if (unverified.size) {
        verified = await verifyRelinks();
        if (![...projects.values()].some((entry) => entry.registration === "unregistered")) {
          return verified ? { status } : unavailable;
        }
      }
      const startedAt = revision;
      const result = await call("connect_projects", {}, readProjects);
      if (result.status !== "ok" || status !== "ok" || startedAt !== revision) {
        return verified && status === "ok" ? { status } : unavailable;
      }
      projects = result.projects;
      return { status };
    })().finally(() => { connecting = undefined; });
    return connecting;
  }

  async function verifyRelinks() {
    // A list taken before the original invoke finishes cannot rule out a late save.
    const settled = [...unverified].filter(([, request]) => request.settled);
    const startedAt = revision;
    const result = await call("list_projects", {}, readProjects);
    if (result.status !== "ok" || status !== "ok" || startedAt !== revision) return false;
    projects = result.projects;
    revision += 1;
    for (const [id, request] of settled) {
      if (unverified.get(id) === request && projects.has(id)) unverified.delete(id);
    }
    return true;
  }

  async function changeFolder(saved, selection) {
    relinking = true;
    revision += 1;
    const request = { settled: true };
    const result = await call(
      selection ? "confirm_relink" : "relink_project",
      selection ? { token: selection.token } : { projectId: saved.id },
      (answer) => readRelink(answer, saved, selection),
      selection ? timeoutMs : chooseTimeoutMs,
      request,
    );
    revision += 1;
    const collision = result.project && [...projects.values()].some((entry) =>
      entry.id !== saved.id && entry.folderIdentity === result.project.folderIdentity);
    if (result === unavailable || collision || status !== "ok") {
      unverified.set(saved.id, request);
      await verifyRelinks();
      relinking = false;
      return uncertain;
    }
    if (result.project) projects.set(saved.id, result.project);
    if (result.status === "unchanged" || (result.status === "duplicate" && !projects.has(result.ownerId))) {
      await verifyRelinks();
    }
    if (result.status === "confirm") pending = { ...result, saved };
    relinking = false;
    return result;
  }

  async function relink(id) {
    await load();
    const saved = projects.get(id);
    if (!saved) return { status: "invalid" };
    if (relinking || unverified.has(id)) return uncertain;
    pending = undefined;
    return changeFolder(saved);
  }

  async function confirm(token) {
    if (relinking || !pending || token !== pending.token) return { status: "expired" };
    const selection = pending;
    pending = undefined;
    return changeFolder(selection.saved, selection);
  }

  function discardRelink(token) {
    if (pending?.token === token) pending = undefined;
  }

  async function create(metadata) {
    await load();
    if (status !== "ok") return unavailable;

    const result = await call("create_project", { metadata: nativeMetadata(metadata) }, (answer) => {
      if (answer?.status === "invalid") return { status: "invalid" };
      if (answer?.status !== "created" && answer?.status !== "duplicate") return;
      const project = readProject(answer.project);
      if (project && (metadata.folderIdentity === undefined || project.folderIdentity === metadata.folderIdentity)) {
        return { status: answer.status, project };
      }
    });
    if (result.status === "unavailable") return fail();
    if (status !== "ok") return unavailable;
    if (result.project) {
      const { id, folderIdentity } = result.project;
      if (result.project.folder === "unknown") {
        // Create returns the registration outcome. Read folder health from the native list.
        const read = await call("list_projects", {}, readProjects);
        if (status !== "ok") return unavailable;
        const saved = read.projects?.get(id);
        if (saved?.folderIdentity === folderIdentity) {
          result.project = Object.freeze({ ...result.project, folder: saved.folder });
        }
      }
      if ((projects.has(id) && projects.get(id).folderIdentity !== folderIdentity) ||
          [...projects.values()].some((entry) => entry.id !== id && entry.folderIdentity === folderIdentity)) return fail();
      projects.set(id, result.project);
      revision += 1;
    }
    return result;
  }

  return Object.freeze({
    get status() { return status; },
    load,
    list: () => [...projects.values()],
    get: (id) => projects.get(id),
    create,
    connect,
    relink,
    confirm,
    discardRelink,
    relinkBlocked: (id) => unverified.has(id),
    get hasUnverifiedRelinks() { return unverified.size > 0; },
    async projectActivity(projectId) {
      if (!projects.has(projectId)) return unknown;
      const result = await call("project_activity", { projectId }, readActivity);
      return result === unavailable ? unknown : result;
    },
    async delegationStatus(projectId) {
      if (!projects.has(projectId)) return unknown;
      return call("delegation_status", { input: { projectId } }, (answer) => readDelegation(answer, false));
    },
    delegationSavePending: (projectId) => pendingDelegation.get(projectId),
    async enableDelegation(projectId, { accountLabel, model, acknowledged }) {
      if (!projects.has(projectId) || !validDelegationLabel(accountLabel) || !validDelegationModel(model) || acknowledged !== true) {
        return { status: "refused", reason: "invalid-request" };
      }
      if (pendingDelegation.has(projectId)) return unknown;
      const request = {};
      const result = call("enable_delegation", { input: { projectId, accountLabel: accountLabel.trim(), model, acknowledged } },
        (answer) => readDelegation(answer, true), timeoutMs, request);
      if (request.completion) {
        // The native invoke can still be pending after the page's timeout.
        const settled = () => { pendingDelegation.delete(projectId); };
        pendingDelegation.set(projectId, request.completion.then(settled, settled));
      }
      return result;
    },
  });
}
