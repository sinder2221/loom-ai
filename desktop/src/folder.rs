use serde::Serialize;
use std::{fs, io::ErrorKind, os::unix::fs::MetadataExt, path::Path};

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum FolderResult {
    Chosen {
        path: String,
        #[serde(rename = "folderIdentity")]
        folder_identity: String,
    },
    Invalid,
    Inaccessible,
    Cancelled,
}

pub fn resolve(path: &Path) -> FolderResult {
    if !path.is_absolute() || path.as_os_str().as_encoded_bytes().contains(&0) {
        return FolderResult::Invalid;
    }

    let canonical = match fs::canonicalize(path) {
        Ok(path) => path,
        Err(error) => return failure(error.kind()),
    };
    let Some(path) = canonical.to_str() else {
        return FolderResult::Invalid;
    };
    let metadata = match canonical.metadata() {
        Ok(metadata) => metadata,
        Err(error) => return failure(error.kind()),
    };
    if !metadata.is_dir() {
        return FolderResult::Invalid;
    }
    // Looking up "." inside the directory requires search permission.
    if let Err(error) = canonical.join(".").metadata() {
        return failure(error.kind());
    }
    if let Err(error) = canonical.read_dir() {
        return failure(error.kind());
    }

    FolderResult::Chosen {
        path: path.to_owned(),
        folder_identity: format!("{}:{}", metadata.dev(), metadata.ino()),
    }
}

fn failure(kind: ErrorKind) -> FolderResult {
    match kind {
        ErrorKind::NotFound | ErrorKind::NotADirectory | ErrorKind::InvalidInput => {
            FolderResult::Invalid
        }
        _ => FolderResult::Inaccessible,
    }
}


