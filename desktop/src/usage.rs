use crate::{
    folder::{resolve, FolderResult},
    store::{ListResult, ProjectStore},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    env,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

const MAX_REPLY: u64 = 8 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(120);
static READER: Mutex<()> = Mutex::new(());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    project_ids: Vec<String>,
}

pub fn unavailable() -> Value {
    json!({"status": "unavailable"})
}

fn node(home: &Path) -> Option<PathBuf> {
    let candidates = env::var_os("PATH").unwrap_or_default();
    supported_node(env::split_paths(&candidates).chain([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        home.join(".local/bin"),
    ]))
}

fn supported_node(directories: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    let mut seen = HashSet::new();
    directories.into_iter()
        .filter(|path| path.is_absolute())
        .map(|path| path.join("node"))
        .filter(|path| path.is_file() && seen.insert(path.clone()))
        .find(|path| node_major(path).is_some_and(|major| major >= 24))
}

fn node_major(path: &Path) -> Option<u32> {
    let mut child = Command::new(path).arg("--version").env_clear()
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    if !wait_for(&mut child, Duration::from_secs(2)) {
        return None;
    }
    let mut output = String::new();
    child.stdout.take()?.take(64).read_to_string(&mut output).ok()?;
    let version = output.trim().strip_prefix('v')?;
    let (major, rest) = version.split_once('.')?;
    let (minor, patch) = rest.split_once('.')?;
    let _: u32 = minor.parse().ok()?;
    patch.split('-').next()?.parse::<u32>().ok()?;
    major.parse().ok()
}

fn runner(resources: Option<&Path>) -> Option<PathBuf> {
    let bundled = resources.map(|path| path.join("usage-runtime/bridge/usage/local/main.ts"));
    bundled.filter(|path| path.is_file()).or_else(|| {
        if cfg!(debug_assertions) {
            let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../bridge/usage/local/main.ts");
            path.is_file().then_some(path)
        } else {
            None
        }
    })
}

pub fn query(directory: PathBuf, home: PathBuf, resources: Option<PathBuf>, input: Value) -> Value {
    run(directory, home, resources, input).unwrap_or_else(unavailable)
}

fn run(directory: PathBuf, home: PathBuf, resources: Option<PathBuf>, input: Value) -> Option<Value> {
    let request: Request = serde_json::from_value(input).ok()?;
    let mut ids = HashSet::new();
    if !request.project_ids.iter().all(|id| {
        id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) && ids.insert(id)
    }) {
        return None;
    }
    let _reader = READER.try_lock().ok()?;
    let folders = if request.project_ids.is_empty() {
        vec![]
    } else {
        let ListResult::Ok { projects } = ProjectStore::new(directory.clone()).list() else {
            return None;
        };
        let mut folders = Vec::new();
        for id in &request.project_ids {
            let project = projects.iter().find(|project| project.id() == id)?;
            folders.push(match resolve(Path::new(project.path())) {
                FolderResult::Chosen { path, folder_identity } if folder_identity == project.folder_identity() => Some(path),
                _ => None,
            });
        }
        folders
    };
    let mut command = Command::new(node(&home)?);
    command.arg(runner(resources.as_deref())?)
        .arg("--project-folders-stdin")
        .env_clear()
        .env("LOOM_USAGE_CACHE_DIR", directory.join("local-usage"))
        .env("LOOM_DATA_DIR", env::var_os("LOOM_DATA_DIR").unwrap_or_else(|| directory.into_os_string()))
        .env("LOOM_CLAUDE_PROJECTS", env::var_os("LOOM_CLAUDE_PROJECTS").unwrap_or_else(|| home.join(".claude/projects").into_os_string()))
        .env("LOOM_CODEX_SESSIONS", env::var_os("LOOM_CODEX_SESSIONS").unwrap_or_else(|| home.join(".codex/sessions").into_os_string()));
    if let Some(tz) = env::var_os("TZ") {
        command.env("TZ", tz);
    }
    let reply = execute(command, serde_json::to_vec(&json!({"folders": folders})).ok()?)?;
    validate(&reply, folders.len()).then_some(reply)
}

fn execute(mut command: Command, payload: Vec<u8>) -> Option<Value> {
    let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let input = child.stdin.take()?;
    let output = child.stdout.take()?;
    let writer = thread::spawn(move || (&input).write_all(&payload));
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        output.take(MAX_REPLY + 1).read_to_end(&mut bytes).ok()?;
        (bytes.len() as u64 <= MAX_REPLY).then_some(bytes)
    });
    let success = wait_for(&mut child, TIMEOUT);
    let wrote = writer.join().ok()?.is_ok();
    let bytes = reader.join().ok()??;
    if !success || !wrote {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn wait_for(child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

fn fields(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
    })
}

fn count(value: &Value) -> Option<u64> {
    value.as_u64().filter(|count| *count <= (1 << 53) - 1)
}

fn timestamp(value: &Value) -> bool {
    count(value).is_some_and(|time| time <= 8_640_000_000_000_000)
}

fn nullable_count(value: &Value) -> bool {
    value.is_null() || count(value).is_some()
}

fn nullable_amount(value: &Value) -> bool {
    value.is_null() || value.as_f64().is_some_and(|amount| amount.is_finite() && amount >= 0.0)
}

fn decimal(value: &Value) -> bool {
    value.as_str().is_some_and(|text| {
        !text.is_empty() && text.len() <= 40 && (text.len() == 1 || !text.starts_with('0'))
            && text.bytes().all(|byte| byte.is_ascii_digit())
    })
}

fn safe_model(value: &Value, provider: &str) -> bool {
    let Some(model) = value.as_str() else { return false };
    if model == "Unknown model" {
        return true;
    }
    fn version(segment: &str) -> bool {
        !segment.is_empty() && segment.len() <= 2 && segment.bytes().all(|byte| byte.is_ascii_digit())
    }
    let mut parts = model.split('-');
    if provider == "claude" {
        return parts.next() == Some("claude")
            && matches!(parts.next(), Some("fable" | "opus" | "sonnet" | "haiku"))
            && matches!(parts.next(), Some("1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"))
            && parts.clone().count() <= 2 && parts.all(version);
    }
    if parts.next() != Some("gpt") {
        return false;
    }
    let Some(model_version) = parts.next() else { return false };
    let mut segments = model_version.split('.');
    let major = segments.next();
    (model_version == "4o"
        || (matches!(major, Some("3" | "4" | "5" | "6")) && segments.clone().count() <= 2 && segments.all(version)))
        && parts.clone().count() <= 3
        && parts.all(|part| matches!(part, "codex" | "mini" | "nano" | "max" | "spark" | "sol" | "astra" | "terra" | "luna"))
}

const AMOUNTS: &[&str] = &[
    "tokens", "estimatedMicros", "pricedMicros", "pricedTokens",
    "pricedObservations", "observations", "unreadableReadings",
];

fn amounts(value: &Value, provider: &str) -> bool {
    let (Some(priced), Some(observations), Some(unreadable)) = (
        count(&value["pricedObservations"]),
        count(&value["observations"]),
        count(&value["unreadableReadings"]),
    ) else {
        return false;
    };
    let Some(measured) = observations.checked_sub(unreadable) else {
        return false;
    };
    priced <= measured && decimal(&value["pricedTokens"])
        && (if measured == 0 { value["tokens"].is_null() } else { decimal(&value["tokens"]) })
        && (if priced == 0 {
            value["pricedMicros"].is_null() && value["estimatedMicros"].is_null() && value["pricedTokens"] == "0"
        } else {
            provider == "claude" && decimal(&value["pricedMicros"])
                && if priced == observations { value["estimatedMicros"] == value["pricedMicros"] }
                   else { value["estimatedMicros"].is_null() }
        })
}

fn group(value: &Value, provider: &str, extras: &[&str]) -> bool {
    let keys = [AMOUNTS, &["models"], extras].concat();
    fields(value, &keys) && amounts(value, provider) && value["models"].as_array().is_some_and(|models| {
        let keys = [AMOUNTS, &["model"]].concat();
        let mut seen = HashSet::new();
        models.iter().all(|model| fields(model, &keys) && safe_model(&model["model"], provider)
            && seen.insert(model["model"].as_str()) && amounts(model, provider))
    })
}

fn quota_entry(value: &Value, provider: &str) -> bool {
    let keys = [
        "label", "provider", "account", "plan", "bucket", "windowSeconds", "resetAt", "remaining",
        "remainingPercent", "total", "units", "semantics", "observedAt", "state", "freshness", "sources",
        "harnesses", "credits", "earnedResets", "lastRemaining",
    ];
    let (buckets, source): (&[&str], &str) = if provider == "claude" {
        (&["5 hours", "Weekly"], "Claude Code status line")
    } else {
        (&["Primary window", "Secondary window", "Credits"], "Local rollout files")
    };
    fields(value, &keys)
        && value["label"] == "plan-allowance" && value["provider"] == provider
        && value["account"] == "Unknown" && value["plan"] == "Unknown"
        && value["bucket"].as_str().is_some_and(|bucket| buckets.contains(&bucket))
        && value["sources"] == json!([source]) && value["harnesses"] == json!([provider])
        && matches!((value["units"].as_str(), value["semantics"].as_str()), (Some("%"), Some("used")) | (Some("credits"), Some("remaining")))
        && value["state"] == "ok" && matches!(value["freshness"].as_str(), Some("fresh" | "stale"))
        && timestamp(&value["observedAt"]) && (value["resetAt"].is_null() || timestamp(&value["resetAt"]))
        && ["windowSeconds", "remainingPercent", "earnedResets"].iter().all(|key| nullable_count(&value[*key]))
        && ["remaining", "total", "credits"].iter().all(|key| nullable_amount(&value[*key]))
        && value["remainingPercent"].as_u64().unwrap_or_default() <= 100
        && nullable_amount(&value["lastRemaining"]) && value["lastRemaining"].as_f64().unwrap_or_default() <= 100.0
        && (value["freshness"] != "fresh" || value["remaining"] == value["lastRemaining"])
        && (value["freshness"] != "stale" || (value["remaining"].is_null() && value["remainingPercent"].is_null()))
}

fn document(value: &Value, provider: &str, project_count: usize) -> bool {
    let local = &value["local"];
    let quota = &value["quota"];
    let reason = if provider == "claude" { "no-statusline" } else { "no-rate-limits" };
    let reasons = ["oversizedLine", "invalidUtf8", "invalidJson", "invalidRecord", "invalidTimestamp",
        "invalidUsage", "symlink", "unreadableSource", "changedSource", "nonRegularSource"];
    let skips = &local["skipReasons"];
    fields(value, &["schema", "harness", "quota", "totals", "estimate", "local"])
        && value["schema"] == 1 && value["harness"] == provider
        && value["totals"] == json!({"label": "measured", "byScope": {}, "rows": []})
        && value["estimate"] == json!({"outcome": "estimated", "label": "estimated-api-value", "scopes": []})
        && fields(quota, &["outcome", "entries"]) && quota["outcome"] == "reconciled"
        && quota["entries"].as_array().is_some_and(|entries| {
            entries.len() <= 3 && entries.iter().all(|entry| quota_entry(entry, provider))
                && if entries.is_empty() { local["allowanceReason"] == reason } else { local["allowanceReason"].is_null() }
        })
        && fields(local, &["available", "skipped", "skipReasons", "reused", "scanned", "allowanceReason", "periods"])
        && local["available"].is_boolean()
        && fields(skips, &reasons)
        && reasons.iter().map(|reason| count(&skips[*reason])).sum::<Option<u64>>() == count(&local["skipped"])
        && ["skipped", "reused", "scanned"].iter().all(|key| count(&local[*key]).is_some())
        && local["periods"].as_array().is_some_and(|periods| {
            periods.len() == 3 && periods.iter().zip(["today", "last7", "last30"]).all(|(period, name)| {
                period["period"] == name && group(period, provider, &["period", "projects"])
                    && period["projects"].as_array().is_some_and(|projects| projects.len() == project_count
                        && projects.iter().all(|project| group(project, provider, &[])))
            })
        })
}

fn validate(value: &Value, project_count: usize) -> bool {
    let documents = &value["documents"];
    fields(value, &["status", "observedAt", "documents"]) && value["status"] == "ready"
        && timestamp(&value["observedAt"]) && fields(documents, &["claude", "codex"])
        && ["claude", "codex"].iter().all(|provider| document(&documents[*provider], provider, project_count))
}


