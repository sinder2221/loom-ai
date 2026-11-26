import { validDelegationLabel, validDelegationModel } from "./desktop-store.mjs";

const enabled = "Set up. Delegation does not run yet: the live setup is waiting.";
const unknown = "Delegation status unknown.";
const helperDown = "Loom’s helper is not running.";
const savingSetup = "Saving Codex setup…";
const statusMessages = new Map([
  ["enabled", enabled],
  ["not-enabled", "Not set up."],
  ["not-registered", "Project not registered with Loom’s helper."],
  ["folder-unavailable", "Project folder unavailable. Delegation status unknown."],
  ["helper-not-running", helperDown],
  ["saving", savingSetup],
]);
const refusalMessages = new Map([
  ["sensitive-label", "Use a short account name such as Private. Leave out email addresses, paths, and keys."],
  ["delegation-conflict", "This project already has a different delegation setup. Loom kept the existing setup."],
  ["not-registered", "Register this project with Loom’s helper before setting up Codex."],
  ["folder-unavailable", "Restore or relink the project folder before trying again."],
  ["invalid-request", "Check the account name and model, then try again."],
]);
const uncertainRefusalStates = new Map([
  ["delegation-conflict", "unknown"],
  ["not-registered", "not-registered"],
  ["folder-unavailable", "folder-unavailable"],
]);

export function mountHarnesses({ byId, store, projectsReady, escapeText, setLiveText }) {
  const view = byId("harness-view");
  const list = byId("harness-projects");
  const dialog = byId("delegation-dialog");
  const form = byId("delegation-form");
  const account = byId("delegation-account");
  const model = byId("delegation-model");
  const acknowledged = byId("delegation-acknowledged");
  const save = byId("delegation-save");
  const cancel = byId("delegation-cancel");
  const note = byId("harness-project-message");
  let visit;
  let rows = [];
  let editing;

  function rowContent({ project, result }) {
    const { status, accountLabel, model } = result;
    return `<div>
        <h3 id="harness-project-${escapeText(project.id)}" tabindex="-1">${escapeText(project.name)}</h3>
        <p>${escapeText(statusMessages.get(status) ?? unknown)}</p>
        ${status === "enabled" ? `<dl>
          <div><dt>Account name</dt><dd>${escapeText(accountLabel)}</dd></div>
          <div><dt>Model</dt><dd>${escapeText(model)}</dd></div>
        </dl><p>Account not verified by Loom</p>` : ""}
      </div>${status === "not-enabled" ? `<button type="button" class="outline action" data-delegation-project="${escapeText(project.id)}" aria-describedby="harness-project-${escapeText(project.id)}" aria-haspopup="dialog">Set up</button>` : ""}`;
  }

  function renderRows() {
    list.hidden = rows.length === 0;
    list.innerHTML = rows.map((row) =>
      `<li id="harness-row-${escapeText(row.project.id)}">${rowContent(row)}</li>`).join("");
  }

  async function refreshAfterSave(current, row) {
    await row.completion;
    if (visit !== current) return;
    const result = await store.delegationStatus(row.project.id);
    if (visit !== current) return;
    row.result = result;
    byId(`harness-row-${row.project.id}`).innerHTML = rowContent(row);
    setLiveText("harness-announcement", `${row.project.name}. ${statusMessages.get(result.status) ?? unknown}`);
  }

  function showNote(message) {
    note.hidden = !message;
    setLiveText("harness-project-message", message);
    setLiveText("harness-announcement", message || "Codex delegation status loaded.");
  }

  async function open() {
    if (visit) return;
    const current = {};
    visit = current;
    view.hidden = false;
    byId("harness-title").focus();
    showNote("Checking Codex delegation status…");
    await projectsReady;
    if (visit !== current) return;
    if (store.status !== "ok") return showNote("Saved projects could not be read. Delegation status unknown.");
    const projects = store.list();
    if (!projects.length) return showNote("No saved projects.");
    const observed = await Promise.all(projects.map(async (project) => {
      const completion = store.delegationSavePending(project.id);
      const result = completion ? { status: "saving" } : await store.delegationStatus(project.id);
      return { project, result, completion };
    }));
    if (visit !== current) return;
    rows = observed;
    renderRows();
    showNote("");
    for (const row of rows) {
      if (row.completion) refreshAfterSave(current, row);
    }
  }

  function close() {
    visit = undefined;
    editing = undefined;
    if (dialog.open) dialog.close();
    rows = [];
    renderRows();
    view.hidden = true;
    setLiveText("harness-announcement", "");
  }

  function feedback(message = "", field) {
    for (const input of [account, model, acknowledged]) {
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-errormessage");
    }
    if (field) {
      field.setAttribute("aria-invalid", "true");
      field.setAttribute("aria-errormessage", "delegation-error");
      field.focus();
    }
    setLiveText("delegation-error", message);
  }

  function pending(saving) {
    if (saving && byId("delegation-fields").contains(document.activeElement)) save.focus();
    byId("delegation-fields").disabled = saving;
    for (const button of [save, cancel]) {
      if (saving) button.setAttribute("aria-disabled", "true");
      else button.removeAttribute("aria-disabled");
    }
    save.textContent = saving ? "Saving…" : "Save setup";
    setLiveText("delegation-progress", saving ? savingSetup : "");
  }

  list.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-delegation-project]");
    const row = rows.find(({ project }) => project.id === button?.dataset.delegationProject);
    if (editing || row?.result.status !== "not-enabled") return;
    editing = { row, button, saving: false };
    form.reset();
    pending(false);
    feedback();
    byId("delegation-project").textContent = row.project.name;
    dialog.showModal();
    account.focus();
  });

  function cancelSetup() {
    if (!editing || editing.saving) return;
    const { button, row } = editing;
    editing = undefined;
    dialog.close();
    if (row.result.status === "not-enabled") button.focus();
    else byId(`harness-project-${row.project.id}`).focus();
  }
  cancel.addEventListener("click", cancelSetup);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    cancelSetup();
  });

  form.addEventListener("input", () => feedback());
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!editing || editing.saving) return;
    const accountLabel = account.value;
    const modelName = model.value;
    if (!validDelegationLabel(accountLabel)) return feedback("Enter an account name of 1 to 60 characters.", account);
    if (!validDelegationModel(modelName)) return feedback("Enter a valid model name, such as gpt-6.2-sol.", model);
    if (!acknowledged.checked) return feedback("Select I understand before saving.", acknowledged);
    const attempt = editing;
    attempt.saving = true;
    feedback();
    pending(true);
    const { row } = attempt;
    const result = await store.enableDelegation(row.project.id, { accountLabel, model: modelName, acknowledged: true });
    if (editing !== attempt) return;
    attempt.saving = false;
    pending(false);
    if (result.status !== "saved") {
      const message = result.status === "helper-not-running" ? helperDown
        : refusalMessages.get(result.reason) ?? "Loom could not confirm the save. Try again with the same details.";
      const status = result.status === "refused" ? uncertainRefusalStates.get(result.reason)
        : result.status === "helper-not-running" ? "helper-not-running" : "unknown";
      if (status) {
        row.result = { status };
        renderRows();
      }
      feedback(message, result.reason === "sensitive-label" ? account : undefined);
      return;
    }
    editing = undefined;
    dialog.close();
    row.result = { status: "enabled", accountLabel: accountLabel.trim(), model: modelName };
    renderRows();
    byId(`harness-project-${row.project.id}`).focus();
    setLiveText("harness-announcement", `${row.project.name}. ${enabled}`);
  });

  return { get isOpen() { return Boolean(visit); }, get isEditing() { return dialog.open; }, open, close };
}
