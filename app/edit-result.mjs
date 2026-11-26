const states = new Set(["ready", "stale", "unavailable", "loading", "too-large"]);
const testStates = new Set(["passed", "failed", "unavailable"]);
const quotedPath = /^"(?:[^"\\]|\\.)*"$/;
const gitEscapes = { a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r", '"': '"', "\\": "\\" };
const utf8 = new TextDecoder("utf-8", { fatal: true });
const emptyBlobIds = [
  "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", // SHA-1
  "473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813", // SHA-256
];

function textField(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function decodePath(value) {
  if (!value.startsWith('"')) return textField(value);
  if (!quotedPath.test(value)) return null;

  let invalid = false;
  const path = value.slice(1, -1).replace(/(?:\\[0-3][0-7]{2})+|\\./g, (escape) => {
    if (Object.hasOwn(gitEscapes, escape[1])) return gitEscapes[escape[1]];
    if (escape.length >= 4) {
      try {
        return utf8.decode(Uint8Array.from(escape.slice(1).split("\\"), (byte) => Number.parseInt(byte, 8)));
      } catch {
        // An undecodable Git path has no reliable text representation.
      }
    }
    invalid = true;
    return "";
  });
  return invalid ? null : textField(path);
}

function diffPath(value, prefix) {
  // Git appends a tab after unquoted paths containing spaces.
  const path = decodePath(value.split("\t", 1)[0]);
  return path?.startsWith(prefix) ? textField(path.slice(prefix.length)) : path;
}

function gitHeaderPath(line) {
  const pair = line?.slice("diff --git ".length);
  const unquoted = pair?.match(/^a\/(.+) b\/\1$/);
  if (unquoted) return unquoted[1];
  const quoted = pair?.match(/^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/);
  if (!quoted) return null;
  const before = diffPath(quoted[1], "a/");
  const after = diffPath(quoted[2], "b/");
  return before === after ? after : null;
}

function hasEmptyBlob(headers, status) {
  const index = headers.find((line) => line.startsWith("index "))
    ?.match(/^index ([0-9a-f]{4,64})\.\.([0-9a-f]{4,64})(?: [0-7]{6})?$/);
  if (!index) return false;
  const [, before, after] = index;
  const [missing, blob] = status === "added" ? [before, after] : [after, before];
  return /^0+$/.test(missing) && emptyBlobIds.some((id) => id.startsWith(blob));
}

function parseFile(lines) {
  const headers = [];
  const hunks = [];
  let remaining;
  let valid = true;
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (remaining?.some(Boolean)) valid = false;
      const range = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?: .*)?$/);
      remaining = range ? [Number(range[1] ?? 1), Number(range[2] ?? 1)] : null;
      if (!remaining?.every(Number.isSafeInteger)) valid = false;
      hunks.push([line]);
    } else if (!hunks.length) {
      headers.push(line);
    } else {
      hunks.at(-1).push(line);
      if (!remaining || line === "\\ No newline at end of file") continue;
      // Git can omit the context prefix on empty lines.
      switch (line[0] ?? " ") {
        case "+":
          added++;
          remaining[1]--;
          break;
        case "-":
          removed++;
          remaining[0]--;
          break;
        case " ":
          remaining[0]--;
          remaining[1]--;
          break;
        default:
          valid = false;
      }
      if (remaining.some((count) => count < 0)) valid = false;
    }
  }
  const oldHeader = headers.find((line) => line.startsWith("--- "));
  const newHeader = headers.find((line) => line.startsWith("+++ "));
  const before = oldHeader ? diffPath(oldHeader.slice(4), "a/") : null;
  const after = newHeader ? diffPath(newHeader.slice(4), "b/") : null;
  const fromNull = before === "/dev/null";
  const toNull = after === "/dev/null";
  const newFile = headers.some((line) => /^new file mode [0-7]{6}$/.test(line));
  const deletedFile = headers.some((line) => /^deleted file mode [0-7]{6}$/.test(line));
  const modeChange = headers.some((line) => /^old mode [0-7]{6}$/.test(line))
    && headers.some((line) => /^new mode [0-7]{6}$/.test(line));
  const binary = headers.some((line) => line === "GIT binary patch" || /^Binary files .* differ$/.test(line));

  let status = "unknown";
  const hasPaths = before && after && !(fromNull && toNull);
  if (hasPaths) status = fromNull ? "added" : toNull ? "deleted" : "modified";
  else if (!oldHeader && !newHeader && newFile !== deletedFile) status = newFile ? "added" : "deleted";
  else if (!oldHeader && !newHeader && (modeChange || binary)) status = "modified";

  const path = (toNull ? before : after) ?? gitHeaderPath(headers.find((line) => line.startsWith("diff --git ")));
  const headerOnly = !hunks.length && !binary && (status === "added" || status === "deleted");
  const emptyFile = headerOnly && hasEmptyBlob(headers, status);
  const modeOnly = !oldHeader && !newHeader && status === "modified" && modeChange;
  const countable = !binary && (hunks.length ? hasPaths && valid && remaining?.every((count) => count === 0)
    : path && (emptyFile || modeOnly));
  return { path, status, added: countable ? added : null, removed: countable ? removed : null,
    headers, hunks, incomplete: headerOnly && !emptyFile };
}

function parseFiles(diff) {
  if (diff === "") return [];
  const lines = typeof diff === "string" ? diff.split("\n") : [];
  if (!lines[0]?.startsWith("diff --git ") && !lines[0]?.startsWith("--- ")) return null;
  if (lines.at(-1) === "") lines.pop();
  const files = [];
  let start = 0;
  for (let index = 1; index < lines.length; index++) {
    if (!lines[index].startsWith("diff --git ")) continue;
    files.push(parseFile(lines.slice(start, index)));
    start = index;
  }
  files.push(parseFile(lines.slice(start)));
  return files;
}

function unmatchedPaths(files, paths) {
  const listed = new Set(paths);
  const parsed = new Set(files?.map(({ path }) => path));
  const missing = new Set();
  for (const path of listed) if (path === null || !parsed.has(path)) missing.add(path);
  for (const path of parsed) if (path === null || !listed.has(path)) missing.add(path);
  return [...missing];
}

export function parseEditResult(raw) {
  const state = states.has(raw?.state) ? raw.state : "unknown";
  const hasPatchData = state === "ready" || state === "stale";
  const parsedFiles = hasPatchData ? parseFiles(raw.diff) : null;
  const paths = hasPatchData && Array.isArray(raw.paths) ? Array.from(raw.paths, textField) : null;
  const missingPaths = unmatchedPaths(parsedFiles, paths);
  const incomplete = hasPatchData && (!parsedFiles || !paths || missingPaths.length > 0
    || parsedFiles.some((file) => file.incomplete));
  let files = parsedFiles;
  if (!parsedFiles?.length && paths?.length) {
    files = paths.map((path) => ({ path, status: "unknown", added: null, removed: null, headers: [], hunks: [] }));
  } else if (!parsedFiles?.length && !paths) {
    files = null;
  }
  return {
    state,
    files,
    stat: state === "too-large" ? textField(raw.stat) : null,
    seed: hasPatchData && Array.isArray(raw.seed)
      ? Array.from(raw.seed, (file) => textField(file?.path)) : null,
    originPreserved: typeof raw?.originPreserved === "boolean" ? raw.originPreserved : "unknown",
    tests: raw?.tests == null ? null : {
      state: testStates.has(raw.tests.state) ? raw.tests.state : "unknown",
      name: textField(raw.tests.name),
    },
    incomplete,
    missingPaths,
    canCopy: state === "ready" && !incomplete && Boolean(files?.length) && files.every(({ status }) => status !== "unknown"),
  };
}
