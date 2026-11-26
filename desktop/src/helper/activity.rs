use super::{
    call_helper, decode_reply, folder_state, status, Failure, Folder, HelperStatus, Transport,
    RETRY_BUDGET,
};
use crate::store::{ListResult, ProjectStore};
use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Map, Value};
use std::{collections::HashSet, fmt, path::Path, time::Instant};

const CHAT_LIMIT: usize = 200;
const QUESTION_LIMIT: usize = 50;
const EXCERPT_LIMIT: usize = 160;
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
const MAX_DATE_MS: i64 = 8_640_000_000_000_000;

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum ActivityResult {
    Ok { snapshot: Value },
    InvalidRequest,
    NotRegistered,
    FolderUnavailable,
    HelperNotRunning,
    Unknown,
}

pub fn query(
    store: &ProjectStore,
    transport: &impl Transport,
    input: Value,
    started: Instant,
) -> ActivityResult {
    let Some(fields) = object(&input, &["projectId"]) else {
        return ActivityResult::InvalidRequest;
    };
    let Some(id) = fields["projectId"].as_str().filter(|id| {
        id.len() == 32 && id.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    }) else {
        return ActivityResult::InvalidRequest;
    };
    let ListResult::Ok { projects } = store.list() else {
        return ActivityResult::Unknown;
    };
    let Some(project) = projects.iter().find(|project| project.id() == id) else {
        return ActivityResult::NotRegistered;
    };
    if folder_state(project) != Folder::Ok {
        return ActivityResult::FolderUnavailable;
    }
    let deadline = started + RETRY_BUDGET;
    // The read takes only an ID. Confirm that it is bound to the saved folder.
    match status(transport, project, deadline) {
        Ok(HelperStatus::Registered) => {}
        Ok(HelperStatus::NotRegistered) => return ActivityResult::NotRegistered,
        Ok(HelperStatus::FolderChanged | HelperStatus::FolderUnavailable) => {
            return ActivityResult::FolderUnavailable;
        }
        Err(error) => return failure(error),
    }
    match call_helper(transport, "projectActivity", json!({ "projectId": id }), deadline) {
        Ok(reply) if not_registered(&reply) => ActivityResult::NotRegistered,
        Ok(mut snapshot) if valid_snapshot(&snapshot) => {
            let socket = transport.socket_path();
            hide_excerpt_paths(&mut snapshot, project.path(), socket.as_deref().and_then(Path::to_str));
            ActivityResult::Ok { snapshot }
        }
        Ok(_) => ActivityResult::Unknown,
        Err(error) => failure(error),
    }
}

fn failure(error: Failure) -> ActivityResult {
    match error {
        Failure::NotRunning => ActivityResult::HelperNotRunning,
        _ => ActivityResult::Unknown,
    }
}

fn object<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Map<String, Value>> {
    let fields = value.as_object()?;
    (fields.len() == keys.len() && keys.iter().all(|key| fields.contains_key(*key))).then_some(fields)
}

fn not_registered(reply: &Value) -> bool {
    object(reply, &["outcome", "reason"]).is_some()
        && reply["outcome"] == "refused"
        && reply["reason"] == "not-registered"
}

fn natural(value: &Value) -> bool {
    value.as_u64().is_some_and(|number| number <= MAX_SAFE_INTEGER)
}

fn time(value: &Value) -> bool {
    value.as_i64().is_some_and(|ms| (-MAX_DATE_MS..=MAX_DATE_MS).contains(&ms))
}

fn nullable(value: &Value, check: impl FnOnce(&Value) -> bool) -> bool {
    value.is_null() || check(value)
}

fn named(value: &Value, names: &[&str]) -> bool {
    nullable(value, |value| value.as_str().is_some_and(|name| names.contains(&name)))
}

fn id(value: &Value) -> bool {
    value.as_str().is_some_and(|id| {
        (1..=128).contains(&id.len())
            && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
            && !credential_id(id)
    })
}

// An identifier has only ASCII letters, digits, underscores and hyphens. Of the
// helper's credential patterns, only these token shapes can occur in that alphabet.
fn credential_id(id: &str) -> bool {
    let mut tails = std::iter::once(id).chain(id.match_indices('-').map(|(index, _)| &id[index + 1..]));
    tails.any(|tail| {
        ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "xoxb-", "xoxa-",
            "xoxp-", "xoxr-", "xoxs-", "sk-", "sk_live_", "sk_test_", "AIza"]
            .iter().any(|prefix| tail.strip_prefix(prefix).is_some_and(|body| body.len() >= 12))
            || (matches!(tail.get(..4), Some("AKIA" | "ASIA"))
                && tail.get(4..20).is_some_and(|body| body.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()))
                && matches!(tail.as_bytes().get(20), None | Some(b'-')))
    })
}

fn chat(value: &Value) -> bool {
    object(value, &[
        "id", "provider", "role", "placeholder", "runState", "createdAt", "lastActivityAt",
        "parentChatId", "deliveryState",
    ]).is_some()
        && id(&value["id"])
        && named(&value["provider"], &["codex", "claude", "openclaw", "antigravity"])
        && named(&value["role"], &["origin", "destination"])
        && value["placeholder"].is_boolean()
        && named(&value["runState"], &["Starting", "Running", "Completed", "Interrupted"])
        && nullable(&value["createdAt"], time)
        && nullable(&value["lastActivityAt"], time)
        && nullable(&value["parentChatId"], id)
        && value["parentChatId"] != value["id"]
        && named(&value["deliveryState"], &[
            "Queued", "Accepted by transport", "Held for approval", "Delivered to chat",
            "Refused", "Needs verification",
        ])
}

fn contains_path(text: &str) -> bool {
    let delimiter = |c: char| c.is_whitespace()
        || matches!(c, '"' | '\'' | '`' | '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>' | '=' | ':' | ',' | ';' | '|');
    let mut previous = None;
    for (offset, character) in text.char_indices() {
        let before = previous.replace(character);
        if before.is_some_and(|c| c.is_alphanumeric() || matches!(c, '/' | '\\' | '_' | '.' | '-')) {
            continue;
        }
        let tail = &text[offset..];
        let quoted = before.filter(|c| matches!(c, '"' | '\'' | '`'))
            .and_then(|quote| tail.split_once(quote).map(|(inside, _)| inside));
        let word = || quoted.unwrap_or_else(|| tail.split(delimiter).next().unwrap_or_default());
        let rooted = match character {
            '/' => word().split('/').filter(|component| !component.is_empty()).nth(1).is_some(),
            '~' => word().strip_prefix('~').and_then(|tail| tail.split_once('/'))
                .is_some_and(|(user, path)| {
                    !path.is_empty() && user.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
                }),
            '\\' => word().starts_with("\\\\"),
            _ => matches!(tail.as_bytes(), [drive, b':', b'/' | b'\\', ..] if drive.is_ascii_alphabetic())
                || (tail.get(..5).is_some_and(|scheme| scheme.eq_ignore_ascii_case("file:"))
                    && tail[5..].starts_with('/')),
        };
        if rooted {
            return true;
        }
    }
    false
}

fn hide_excerpt_paths(snapshot: &mut Value, project_path: &str, socket_path: Option<&str>) {
    let questions = snapshot["questions"].as_array_mut().expect("validated activity questions");
    for question in questions {
        let hide = question["excerpt"].as_str().is_some_and(|text| {
            contains_path(text) || (project_path != "/" && text.contains(project_path))
                || socket_path.is_some_and(|path| text.contains(path))
        });
        if hide {
            question["excerpt"] = Value::Null;
            question["excerptTruncated"] = Value::Null;
            question["excerptWithheldForPath"] = Value::Bool(true);
        }
    }
}

fn question(value: &Value) -> bool {
    if object(value, &["id", "chatId", "expiresAt", "excerpt", "excerptTruncated", "excerptWithheld"]).is_none()
        || !id(&value["id"]) || !id(&value["chatId"]) || !time(&value["expiresAt"])
    {
        return false;
    }
    match (value["excerptWithheld"].as_bool(), &value["excerpt"], &value["excerptTruncated"]) {
        (Some(_), Value::Null, Value::Null) => true,
        (Some(false), Value::String(text), Value::Bool(truncated)) => {
            let length = text.chars().count();
            (1..=EXCERPT_LIMIT).contains(&length)
                && (!truncated || length == EXCERPT_LIMIT)
                && !text.chars().any(char::is_control)
        }
        _ => false,
    }
}

fn valid_snapshot(value: &Value) -> bool {
    object(value, &["schema", "generatedAt", "truncated", "omitted", "counts", "chats", "questions"]).is_some()
        && value["schema"].as_u64() == Some(1)
        && time(&value["generatedAt"])
        && object(&value["truncated"], &["chats", "questions"])
            .is_some_and(|fields| fields.values().all(Value::is_boolean))
        && object(&value["omitted"], &["chats", "questions"])
            .is_some_and(|fields| fields.values().all(natural))
        && object(&value["counts"], &["runningRuns", "openQuestions"])
            .is_some_and(|fields| fields.values().all(natural))
        && rows(&value["chats"], CHAT_LIMIT, chat)
        && rows(&value["questions"], QUESTION_LIMIT, question)
}

fn rows(value: &Value, cap: usize, check: impl Fn(&Value) -> bool) -> bool {
    value.as_array().is_some_and(|rows| {
        let mut ids = HashSet::new();
        rows.len() <= cap && rows.iter().all(|row| check(row) && ids.insert(row["id"].as_str()))
    })
}

fn contains_text(value: &Value, text: &str) -> bool {
    match value {
        Value::String(value) => value.contains(text),
        Value::Array(rows) => rows.iter().any(|row| contains_text(row, text)),
        Value::Object(fields) => fields.values().any(|field| contains_text(field, text)),
        _ => false,
    }
}

pub(super) fn checked_reply(reply: &[u8], token: &str) -> Result<Value, Failure> {
    let UniqueValue(result) = decode_reply(reply)?;
    if not_registered(&result) || (valid_snapshot(&result) && !contains_text(&result, token)) {
        Ok(result)
    } else {
        Err(Failure::InvalidReply)
    }
}

// serde_json::Value silently keeps the last value of duplicate object keys.
struct UniqueValue(Value);

impl<'de> Deserialize<'de> for UniqueValue {
    fn deserialize<D: Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
        struct JsonVisitor;
        impl<'de> Visitor<'de> for JsonVisitor {
            type Value = UniqueValue;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("JSON with unique object fields")
            }

            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(UniqueValue(Value::Null))
            }
            fn visit_bool<E: de::Error>(self, value: bool) -> Result<Self::Value, E> {
                Ok(UniqueValue(value.into()))
            }
            fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
                Ok(UniqueValue(value.into()))
            }
            fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
                Ok(UniqueValue(value.into()))
            }
            fn visit_f64<E: de::Error>(self, value: f64) -> Result<Self::Value, E> {
                Ok(UniqueValue(value.into()))
            }
            fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
                Ok(UniqueValue(value.into()))
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut input: A) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(UniqueValue(value)) = input.next_element()? {
                    values.push(value);
                }
                Ok(UniqueValue(Value::Array(values)))
            }

            fn visit_map<A: MapAccess<'de>>(self, mut input: A) -> Result<Self::Value, A::Error> {
                let mut values = Map::new();
                while let Some((key, UniqueValue(value))) = input.next_entry()? {
                    if values.insert(key, value).is_some() {
                        return Err(de::Error::custom("duplicate field"));
                    }
                }
                Ok(UniqueValue(Value::Object(values)))
            }
        }
        decoder.deserialize_any(JsonVisitor)
    }
}


