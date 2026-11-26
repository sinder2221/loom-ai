const pageSize = 2000;
const number = new Intl.NumberFormat("en-US");
const stateMessages = {
  ready: "Patch ready for review.",
  stale: "The base moved. Showing the last available patch.",
  unavailable: "Edit result is unavailable.",
  loading: "Loading edit result…",
  "too-large": "The patch is too large to display. Only the diff stat is available.",
  unknown: "Edit result status is unknown.",
};
const originLabels = { true: "Preserved", false: "Changed", unknown: "Unknown" };
const fileLabels = { added: "Added", modified: "Modified", deleted: "Deleted", unknown: "Unknown" };
const copyRecorded = "Demo patch copy recorded.";
const incompleteMessage = "The patch is incomplete.";

function statusAnnouncement(result) {
  if (!result) return "";
  const message = result.state === "ready" && result.incomplete ? "" : stateMessages[result.state];
  if (result.state !== "ready" && result.state !== "stale") return message;
  return [message, result.incomplete && incompleteMessage, result.originPreserved === false && "The origin workspace changed.",
    result.tests?.state === "failed" && "Test evidence failed."].filter(Boolean).join(" ");
}

// Make non-printing controls visible. Tabs still represent indentation in diff lines.
function visibleText(text) {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, (character) => character === "\t" ? character
    : `\\u{${character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}}`);
}

export function createEditResultView({ inspector, escapeText, copyPatch, announce }) {
  let result;
  let runId;
  let copied = false;
  const pages = new Map();
  const text = (value) => value == null ? "Unknown" : escapeText(visibleText(value));
  const count = (value) => value == null ? "Unknown" : number.format(value);

  function pageMarkup(file, index) {
    const lines = file.headers.concat(file.hunks.flat());
    if (!lines.length) return "<p>Diff lines are unavailable.</p>";
    const start = pages.get(index) ?? 0;
    const end = Math.min(start + pageSize, lines.length);
    const preview = lines.slice(start, end).map((line, offset) => {
      const marker = start + offset >= file.headers.length ? line[0] : null;
      const tone = marker === "+" ? ' class="diff-added"' : marker === "-" ? ' class="diff-removed"' : "";
      return `<span${tone}>${text(line)}</span>`;
    }).join("\n");
    const range = lines.length > pageSize ? `<p class="panel-note" data-diff-range>Preview limited to 2,000 lines at a time. Showing lines ${number.format(start + 1)}–${number.format(end)} of ${number.format(lines.length)}.</p>` : "";
    const pager = (name, direction, label) => `<button type="button" class="outline" data-diff-page="${direction}" data-focus-key="diff-${name}-${index}">${label}</button>`;
    return `${range}<pre class="diff-text diff-lines" role="region" aria-label="Diff lines" tabindex="0" data-focus-key="diff-lines-${index}"><code>${preview}</code></pre>${range
      ? `<div class="diff-pager">${start ? pager("previous", -1, "Show previous") : ""}${end < lines.length ? pager("next", 1, "Show more") : ""}</div>` : ""}`;
  }

  function filesMarkup(files) {
    if (!files) return "<p>Changed files are unknown.</p>";
    if (!files.length) return "<p>No changed files in this patch.</p>";
    const items = files.map((file, index) => `<li>
      <details class="diff-file" data-diff-file="${index}" data-detail-key="diff-file-${index}">
        <summary data-focus-key="diff-file-${index}"><code>${text(file.path)}</code>
          <span class="diff-file-meta">${fileLabels[file.status]} · Lines added ${count(file.added)} · Lines removed ${count(file.removed)}</span></summary>
        <div class="diff-page" data-diff-content>${pageMarkup(file, index)}</div>
      </details></li>`);
    return `<ul class="diff-files" role="list">${items.join("")}</ul>`;
  }

  function seedMarkup(seed) {
    const entries = seed?.map((path) => `<li><code>${text(path)}</code></li>`).join("");
    return `<section class="diff-seed"><h4>Seeded from your uncommitted files, not the agent's work</h4>
      ${entries ? `<ul>${entries}</ul>` : `<p>${seed ? "No seeded files." : "Seeded files are unknown."}</p>`}</section>`;
  }

  function render(nextRunId, nextResult) {
    if (runId !== nextRunId || result !== nextResult) {
      runId = nextRunId;
      result = nextResult;
      pages.clear();
      copied = false;
      announce(statusAnnouncement(result));
    }
    if (!result) return "";
    const { state, files, seed, originPreserved, stat, canCopy, incomplete, missingPaths } = result;
    return `<section class="detail-section edit-result" aria-labelledby="edit-result-title">
      <h3 id="edit-result-title">Edit result review</h3>
      ${state === "ready" ? "" : `<p class="notice">${stateMessages[state]}</p>`}
      ${incomplete ? `<div class="notice"><p>${incompleteMessage}</p>${missingPaths.length
        ? `<p>Unmatched file paths</p><ul>${missingPaths.map((path) => `<li><code>${text(path)}</code></li>`).join("")}</ul>` : ""}</div>` : ""}
      ${state === "too-large" ? `<pre class="diff-text" aria-label="Diff stat">${stat?.split("\n").map(text).join("\n") ?? "Unknown"}</pre>` : ""}
      ${state === "ready" || state === "stale" ? `<p>Origin workspace <strong>${originLabels[originPreserved]}</strong></p>
        ${filesMarkup(files)}${seedMarkup(seed)}
        ${canCopy ? `<div class="diff-copy"><button type="button" class="outline" data-copy-patch data-focus-key="edit-copy">Copy patch</button>
          <p class="panel-note" data-copy-feedback>${copied ? copyRecorded : ""}</p></div>` : ""}` : ""}
      <p class="panel-note">Loom never applies, merges or pushes. Review the patch, then apply it yourself.</p>
    </section>`;
  }

  inspector.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (button?.hasAttribute("data-copy-patch") && result?.canCopy) {
      if (copyPatch(runId) !== "recorded") return;
      copied = true;
      inspector.querySelector("[data-copy-feedback]").textContent = copyRecorded;
      announce(copyRecorded);
    }
    if (!button?.dataset.diffPage || !result?.files) return;
    const details = button.closest("[data-diff-file]");
    const index = Number(details.dataset.diffFile);
    const page = details.querySelector("[data-diff-content]");
    const focusKey = button.dataset.focusKey;
    pages.set(index, (pages.get(index) ?? 0) + Number(button.dataset.diffPage) * pageSize);
    page.innerHTML = pageMarkup(result.files[index], index);
    (page.querySelector(`[data-focus-key="${focusKey}"]`) ?? page.querySelector("[data-diff-page]") ?? details.querySelector("summary")).focus();
    announce(page.querySelector("[data-diff-range]").textContent);
  });

  // A native summary keeps focus on keyboard toggle. If a disclosure closes
  // while one of its controls still has focus, return focus to that summary.
  inspector.addEventListener("toggle", (event) => {
    const details = event.target;
    if (!details.hasAttribute("data-diff-file") || details.open) return;
    if (details.contains(document.activeElement)) details.querySelector("summary").focus();
  }, true);

  return { render };
}
