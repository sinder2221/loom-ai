import { createWizard, goals } from "./wizard.mjs";

const byId = (id) => document.getElementById(id);
const nativeInvoke = globalThis.window?.__TAURI_INTERNALS__?.invoke;
const desktopPicker = typeof nativeInvoke === "function"
  ? (await import("./desktop-picker.mjs")).createDesktopPicker(nativeInvoke)
  : undefined;

export function mountWizard({
  projectStore, folderPicker, harnessCatalog, harnessOptional, mark, providers,
  projectDetails, navigateTo, openAdd, onProjectCreated,
}) {
  const dialog = byId("setup-dialog");
  const form = byId("setup-form");
  const panels = [...form.querySelectorAll("[data-setup-step]")];
  const steps = [...byId("setup-steps").children];
  const next = byId("setup-next");
  const back = byId("setup-back");
  const cancelButtons = [...dialog.querySelectorAll("[data-cancel-setup]")];
  const existingButton = byId("setup-open-existing");
  const alert = byId("setup-alert");
  const picker = desktopPicker ?? folderPicker;
  const controls = {
    directory: byId("setup-directory"),
    name: byId("setup-name"),
    goal: byId("setup-goal"),
    description: byId("setup-description"),
    mainHarness: byId("setup-harness-options"),
    rules: byId("setup-rules"),
  };
  let wizard;
  let existingProject;
  let choosingFor;
  let chooseFolder;

  for (const [value, label] of Object.entries(goals)) controls.goal.add(new Option(label, value));

  if (desktopPicker) {
    chooseFolder = document.createElement("button");
    chooseFolder.type = "button";
    chooseFolder.className = "outline action";
    chooseFolder.textContent = "Choose folder";
    chooseFolder.setAttribute("aria-haspopup", "dialog");
    const row = document.createElement("div");
    row.className = "setup-directory-row";
    controls.directory.before(row);
    row.append(controls.directory, chooseFolder);
    controls.directory.removeAttribute("placeholder");
    byId("setup-path-hint").textContent = "Enter a full folder path or choose a folder.";

    chooseFolder.addEventListener("click", async () => {
      if (choosingFor === wizard || wizard.saving) return;
      const currentWizard = wizard;
      choosingFor = currentWizard;
      chooseFolder.focus();
      chooseFolder.setAttribute("aria-disabled", "true");
      const result = await desktopPicker.choose();
      if (!dialog.open || wizard !== currentWizard) return;
      choosingFor = undefined;
      chooseFolder.removeAttribute("aria-disabled");
      if (result.status === "cancelled") return;

      if (result.status === "chosen") {
        controls.directory.value = result.path;
        updateDirectory(result.path);
      } else {
        clearError("directory");
        const message = result.status === "invalid"
          ? "Choose a valid folder."
          : "This folder is inaccessible. Choose another folder.";
        showError({ field: "directory", message });
      }
    });
  }

  function clearError(field) {
    const error = byId(`setup-${field}-error`);
    error.hidden = true;
    error.textContent = "";
    byId(`setup-${field}`)?.removeAttribute("aria-invalid");
    if (field === "directory") {
      existingButton.hidden = true;
      existingProject = undefined;
    }
    alert.textContent = "";
  }

  function renderHarnesses() {
    if (harnessOptional) {
      controls.mainHarness.innerHTML = `<label class="setup-harness">
        <input type="radio" name="setup-harness" value="" checked aria-describedby="setup-harness-error">
        <span>None for now</span></label>`;
      return;
    }
    const connected = harnessCatalog.listConnected();
    controls.mainHarness.innerHTML = connected.length
      ? connected.map(({ id }) => `<label class="setup-harness">
          <input type="radio" name="setup-harness" value="${id}" ${id === wizard.draft.mainHarness ? "checked" : ""} required aria-describedby="setup-harness-error">
          ${mark(id, "small")}<span>${providers[id].name}</span></label>`).join("")
      : `<p class="field-hint">No harnesses are connected.</p>
         <button type="button" class="outline action" data-setup-add aria-haspopup="dialog" aria-describedby="setup-harness-error">Add harness</button>`;
  }

  function focusHeading() {
    dialog.scrollTop = 0;
    panels[wizard.step].querySelector("h3").focus({ preventScroll: true });
  }

  function renderStep() {
    const { step } = wizard;
    panels.forEach((panel, index) => { panel.hidden = index !== step; });
    steps.forEach((item, index) => {
      if (index === step) item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
      item.dataset.complete = String(index < step);
    });

    back.hidden = step === 0;
    next.textContent = step === panels.length - 1 ? "Create project" : "Continue";
    if (step === 2) {
      wizard.useMainHarness();
      renderHarnesses();
    }
    if (step === 3) byId("setup-review").innerHTML = projectDetails(wizard.review());
  }

  function showError({ field, message, project }) {
    const error = byId(`setup-${field}-error`);
    error.textContent = message;
    error.hidden = false;
    if (field === "directory" && project) {
      existingProject = project;
      existingButton.hidden = false;
    }
    byId(`setup-${field}`)?.setAttribute("aria-invalid", "true");
    const target = field === "harness"
      ? controls.mainHarness.querySelector("input, button")
      : controls[field] ?? next;
    target.focus();
    alert.textContent = message;
  }

  function syncGoalRequirement() {
    controls.description.required = controls.goal.value === "custom";
    byId("setup-description-optional").hidden = controls.description.required;
  }

  function updateDirectory(path) {
    wizard.update("directory", path);
    controls.name.value = wizard.draft.name;
    clearError("directory");
    clearError("name");
  }

  function setSubmissionPending(pending) {
    const buttons = [back, next, ...cancelButtons];
    if (!chooseFolder) {
      buttons.forEach((button) => { button.disabled = pending; });
      return;
    }
    for (const button of [chooseFolder, ...buttons]) {
      if (pending) button.setAttribute("aria-disabled", "true");
      else button.removeAttribute("aria-disabled");
    }
    controls.directory.readOnly = pending;
    controls.name.readOnly = pending;
  }

  for (const [field, control] of Object.entries(controls)) {
    if (field === "mainHarness") continue;
    control.addEventListener(field === "goal" ? "change" : "input", () => {
      if (field === "directory") {
        updateDirectory(control.value);
        return;
      }
      wizard.update(field, control.value);
      if (field === "goal") syncGoalRequirement();
      if (field === "name") clearError("name");
      if (field === "goal" || field === "description") clearError("description");
    });
  }

  controls.mainHarness.addEventListener("change", (event) => {
    wizard.update("mainHarness", event.target.value);
    clearError("harness");
  });
  controls.mainHarness.addEventListener("click", (event) => {
    if (!harnessOptional && event.target.closest("[data-setup-add]")) openAdd(true);
  });

  function pickFolder(path) {
    const result = picker.pick(path);
    if (typeof result?.then !== "function") return result;
    const message = "Checking folder.";
    alert.textContent = message;
    return Promise.resolve(result).finally(() => {
      if (alert.textContent === message) alert.textContent = "";
    });
  }

  function open() {
    wizard = createWizard({ projectStore, folderPicker: { pick: pickFolder }, harnessCatalog, harnessOptional });
    choosingFor = undefined;
    chooseFolder?.removeAttribute("aria-disabled");
    form.reset();
    for (const field of ["directory", "name", "description", "harness", "save"]) clearError(field);
    syncGoalRequirement();
    renderStep();
    dialog.showModal();
    focusHeading();
  }

  document.querySelector("[data-new-project]").addEventListener("click", open);

  for (const button of cancelButtons) {
    button.addEventListener("click", () => {
      if (wizard.cancel()) dialog.close();
    });
  }
  dialog.addEventListener("cancel", (event) => {
    if (!wizard.cancel()) event.preventDefault();
  });

  back.addEventListener("click", () => {
    if (wizard.saving) return;
    clearError("save");
    wizard.back();
    renderStep();
    focusHeading();
  });

  existingButton.addEventListener("click", () => {
    if (!wizard.cancel()) return;
    dialog.close();
    navigateTo(existingProject.id);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (choosingFor === wizard || wizard.saving) return;
    clearError("save");
    const previousStep = wizard.step;
    const submission = wizard.submit();
    const saving = wizard.saving;
    if (saving) setSubmissionPending(true);
    const result = await submission;
    controls.name.value = wizard.draft.name;
    if (saving) setSubmissionPending(false);

    if (result.status === "created") {
      dialog.close();
      onProjectCreated(result.project);
    } else if (result.status === "step" || result.status === "error") {
      renderStep();
      if (result.status === "error") showError(result);
      else if (wizard.step !== previousStep) focusHeading();
    }
  });

  return {
    harnessAdded() {
      if (!dialog.open) return;
      wizard.useMainHarness();
      renderHarnesses();
      clearError("harness");
      const radio = controls.mainHarness.querySelector("input:checked") ?? controls.mainHarness.querySelector("input");
      radio?.focus();
    },
  };
}
