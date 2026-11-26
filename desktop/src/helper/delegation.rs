use super::{
    call_helper, delegation_fields_contain, folder_state, status, Failure, Folder, HelperStatus,
    Transport, RETRY_BUDGET,
};
use crate::store::{ListResult, ProjectStore};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Instant;

#[derive(Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Refusal {
    SensitiveLabel,
    DelegationConflict,
    NotRegistered,
    FolderUnavailable,
    InvalidRequest,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum DelegationResult {
    Enabled { account_label: String, model: String },
    NotEnabled,
    NotRegistered,
    FolderUnavailable,
    HelperNotRunning,
    Unknown,
    Saved,
    Refused { reason: Refusal },
}

fn refused(reason: Refusal) -> DelegationResult {
    DelegationResult::Refused { reason }
}

fn reason(value: Option<&str>) -> Option<Refusal> {
    Some(match value? {
        "sensitive-label" => Refusal::SensitiveLabel,
        "delegation-conflict" => Refusal::DelegationConflict,
        "not-registered" => Refusal::NotRegistered,
        "folder-unavailable" => Refusal::FolderUnavailable,
        "invalid-request" => Refusal::InvalidRequest,
        _ => return None,
    })
}

fn failure(error: Failure) -> DelegationResult {
    match error {
        Failure::NotRunning => DelegationResult::HelperNotRunning,
        _ => DelegationResult::Unknown,
    }
}

fn trim_label(label: &str) -> &str {
    label.trim_matches(label_whitespace)
}

fn label_whitespace(character: char) -> bool {
    character.is_whitespace() || character == '\u{feff}'
}

fn valid_label(label: &str) -> bool {
    !trim_label(label).is_empty()
        && label.chars().count() <= 60
        && !label.chars().any(char::is_control)
}

fn drive_path(value: &str) -> bool {
    matches!(value.as_bytes(), [first, b':', ..] if first.is_ascii_alphabetic())
}

fn valid_model(model: &str) -> bool {
    model.len() <= 128
        && model.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        && model.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_.:/-".contains(&byte))
        && !drive_path(model)
        && !model.contains("://")
}

fn label_contains_path(label: &str) -> bool {
    label.contains('\\')
        || label.contains("://")
        || label.starts_with(['/', '~'])
        || drive_path(label)
        || label.split(label_whitespace).any(|word| {
            (word.len() > 1 && word.starts_with(['/', '~']))
                || (drive_path(word) && word.as_bytes().get(2) == Some(&b'/'))
        })
}

fn display_label(label: &str) -> bool {
    valid_label(label)
        && trim_label(label) == label
        && !label.contains('@')
        && !label_contains_path(label)
}

pub fn query(
    store: &ProjectStore,
    transport: &impl Transport,
    input: Value,
    enable: bool,
    started: Instant,
) -> DelegationResult {
    let invalid = || refused(Refusal::InvalidRequest);
    let Some(fields) = input.as_object() else { return invalid(); };
    let Some(id) = fields.get("projectId").and_then(Value::as_str) else { return invalid(); };
    if id.len() != 32 || !id.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')) {
        return invalid();
    }
    let settings = if enable {
        match (
            fields.len(),
            fields.get("acknowledged").and_then(Value::as_bool),
            fields.get("accountLabel").and_then(Value::as_str),
            fields.get("model").and_then(Value::as_str),
        ) {
            (4, Some(true), Some(label), Some(model)) => {
                if label_contains_path(trim_label(label)) {
                    return refused(Refusal::SensitiveLabel);
                }
                if !valid_label(label) || !valid_model(model) {
                    return invalid();
                }
                Some((trim_label(label), model))
            }
            _ => return invalid(),
        }
    } else if fields.len() == 1 {
        None
    } else {
        return invalid();
    };

    let ListResult::Ok { projects } = store.list() else { return DelegationResult::Unknown; };
    let Some(project) = projects.iter().find(|project| project.id() == id) else {
        return unavailable_binding(Refusal::NotRegistered, enable);
    };
    if folder_state(project) != Folder::Ok {
        return unavailable_binding(Refusal::FolderUnavailable, enable);
    }
    let deadline = started + RETRY_BUDGET;
    // The helper's delegation calls take only an ID. Check that the helper still
    // associates that ID with the folder saved by the shell.
    match status(transport, project, deadline) {
        Ok(HelperStatus::Registered) => {}
        Ok(HelperStatus::NotRegistered) => return unavailable_binding(Refusal::NotRegistered, enable),
        Ok(HelperStatus::FolderChanged | HelperStatus::FolderUnavailable) => {
            return unavailable_binding(Refusal::FolderUnavailable, enable);
        }
        Err(error) => return failure(error),
    }
    let (operation, input) = match settings {
        Some((label, model)) => (
            "enableDelegation",
            json!({ "projectId": id, "accountLabel": label, "model": model }),
        ),
        None => ("delegationStatus", json!({ "projectId": id })),
    };
    match call_helper(transport, operation, input, deadline) {
        Ok(reply) if !enable && project.path() != "/" && delegation_fields_contain(&reply, project.path()) => {
            DelegationResult::Unknown
        }
        Ok(reply) => read_reply(&reply, enable),
        // A write may have reached the helper before it stopped responding.
        Err(error) => failure(error),
    }
}

fn unavailable_binding(reason: Refusal, enable: bool) -> DelegationResult {
    if enable {
        return refused(reason);
    }
    match reason {
        Refusal::NotRegistered => DelegationResult::NotRegistered,
        Refusal::FolderUnavailable => DelegationResult::FolderUnavailable,
        _ => DelegationResult::Unknown,
    }
}

fn read_reply(reply: &Value, enable: bool) -> DelegationResult {
    let Some(fields) = reply.as_object() else { return DelegationResult::Unknown; };
    let field = |key| fields.get(key).and_then(Value::as_str);
    match (enable, fields.len(), field("outcome")) {
        (true, 1, Some("enabled" | "already-enabled")) => DelegationResult::Saved,
        (false, 1, Some("not-enabled")) => DelegationResult::NotEnabled,
        (false, 4, Some("enabled")) => match (field("accountLabel"), field("model"), field("accountCheck")) {
            (Some(label), Some(model), Some("not-verified")) if display_label(label) && valid_model(model) =>
                DelegationResult::Enabled { account_label: label.to_owned(), model: model.to_owned() },
            _ => DelegationResult::Unknown,
        },
        (_, 2, Some("refused")) => match reason(field("reason")) {
            Some(reason) => unavailable_binding(reason, enable),
            None => DelegationResult::Unknown,
        },
        _ => DelegationResult::Unknown,
    }
}


