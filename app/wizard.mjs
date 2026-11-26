export const goals = Object.freeze({
  none: "Decide later",
  feature: "Build a feature",
  bug: "Fix a bug",
  explore: "Explore a codebase",
  review: "Review changes",
  custom: "Write my own",
});

const folderStep = 0;
const goalStep = 1;
const harnessStep = 2;
const reviewStep = 3;

function folderName(path) {
  return (path.trim().split("/").filter(Boolean).at(-1) ?? "").slice(0, 80);
}

export function createWizard({ projectStore, folderPicker, harnessCatalog, harnessOptional = false }) {
  const draft = {
    directory: "",
    name: "",
    goal: "none",
    description: "",
    mainHarness: harnessCatalog.listConnected().find(({ main }) => main)?.id ?? "",
    rules: "",
  };
  let step = folderStep;
  let nameEdited = false;
  let folder;
  let saving = false;
  let closed = false;

  function review() {
    return {
      name: draft.name.trim(),
      path: folder.path,
      folderIdentity: folder.folderIdentity,
      goal: ["none", "custom"].includes(draft.goal) ? "" : goals[draft.goal],
      description: draft.description.trim(),
      mainHarness: draft.mainHarness,
      rules: draft.rules.trim(),
    };
  }

  function issue(atStep, field, message, project) {
    step = atStep;
    return { status: "error", field, message, project };
  }

  function duplicate(project) {
    return issue(folderStep, "directory", "This folder is already in Project Loom. Choose another folder.", project);
  }

  function checkFolder(chosen) {
    if (chosen.status === "cancelled") return { status: "ignored" };
    if (chosen.status === "invalid") {
      return issue(folderStep, "directory", "Enter a full folder path starting with /.");
    }
    if (chosen.status === "inaccessible") {
      return issue(folderStep, "directory", "This folder is inaccessible. Choose another folder.");
    }
    if (!nameEdited) draft.name = folderName(chosen.path);
    folder = chosen;
  }

  function checkHarness() {
    if (harnessOptional && draft.mainHarness === "") return;
    const available = harnessCatalog.listConnected();
    if (available.some(({ id }) => id === draft.mainHarness)) return;
    const message = draft.mainHarness
      ? "This harness is no longer connected. Choose a connected harness."
      : "Choose a connected harness.";
    return issue(harnessStep, "harness", message);
  }

  return {
    get step() { return step; },
    get draft() { return { ...draft }; },
    get saving() { return saving; },
    review,
    update(field, value) {
      if (closed || saving) return;
      draft[field] = value;
      if (field === "name") nameEdited = true;
      if (field === "directory" && !nameEdited) draft.name = folderName(value);
    },
    useMainHarness() {
      if (!draft.mainHarness && !closed && !saving) {
        draft.mainHarness = harnessCatalog.listConnected().find(({ main }) => main)?.id ?? "";
      }
    },
    back() {
      if (!closed && !saving && step > folderStep) step -= 1;
    },
    cancel() {
      if (saving) return false;
      closed = true;
      return true;
    },
    async submit() {
      if (closed || saving) return { status: "ignored" };

      if (step === folderStep || step === reviewStep) {
        let chosen = folderPicker.pick(draft.directory);
        if (typeof chosen?.then === "function") {
          saving = true;
          try {
            chosen = await chosen;
          } finally {
            saving = false;
          }
        }
        const problem = checkFolder(chosen);
        if (problem) return problem;
      }
      if (step === folderStep) {
        const existing = projectStore.list().find((project) => project.folderIdentity === folder.folderIdentity);
        if (existing) return duplicate(existing);
      }
      if ((step === folderStep || step === reviewStep) && !draft.name.trim()) {
        return issue(folderStep, "name", "Enter a project name.");
      }
      if (step === goalStep && draft.goal === "custom" && !draft.description.trim()) {
        return issue(goalStep, "description", "Write a short description for your goal.");
      }
      if (step === harnessStep || step === reviewStep) {
        const problem = checkHarness();
        if (problem) return problem;
      }
      if (step < reviewStep) {
        step += 1;
        return { status: "step" };
      }

      saving = true;
      try {
        const result = await projectStore.create(review());
        if (result.status === "duplicate") return duplicate(result.project);
        closed = true;
        return result;
      } catch {
        return issue(reviewStep, "save", "Project Loom couldn’t save this project. Your answers are kept. Try again.");
      } finally {
        saving = false;
      }
    },
  };
}
