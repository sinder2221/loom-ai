use crate::folder::{resolve, FolderResult};
use serde::{
    de::{value::MapAccessDeserializer, MapAccess, Visitor},
    Deserialize, Deserializer, Serialize,
};
use serde_json::Value;
use std::{
    collections::HashSet,
    fs::{self, DirBuilder, File, OpenOptions, Permissions},
    io::{self, Write},
    marker::PhantomData,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

const VERSION: u32 = 1;
const STORE_FILE: &str = "projects.json";
const LOCK_FILE: &str = "projects.lock";
const DIRECTORY_MODE: u32 = 0o700;
const FILE_MODE: u32 = 0o600;
const NAME_LIMIT: usize = 80;
const GOAL_LIMIT: usize = 320;
const CONNECTION_LIMIT: usize = 128;
const RULES_LIMIT: usize = 1_200;
const MAX_TIMESTAMP: u64 = (1 << 53) - 1;
static STORE_MUTEX: Mutex<()> = Mutex::new(());

#[derive(Deserialize)]
struct Metadata {
    name: String,
    path: String,
    goal: String,
    connection: String,
    rules: String,
}

impl Metadata {
    fn valid(&self) -> bool {
        valid_fields(&self.name, &self.goal, &self.connection, &self.rules)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Project {
    id: String,
    name: String,
    path: String,
    folder_identity: String,
    goal: String,
    connection: String,
    rules: String,
    created_at: u64,
}

impl Project {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn folder_identity(&self) -> &str {
        &self.folder_identity
    }

    fn valid(&self) -> bool {
        self.id.len() == 32
            && self
                .id
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
            && valid_fields(&self.name, &self.goal, &self.connection, &self.rules)
            && canonical_path_syntax(&self.path)
            && self
                .folder_identity
                .split_once(':')
                .is_some_and(|(device, inode)| valid_identity_part(device) && valid_identity_part(inode))
            && self.created_at <= MAX_TIMESTAMP
    }
}

fn valid_fields(name: &str, goal: &str, connection: &str, rules: &str) -> bool {
    !name.trim().is_empty()
        && name.chars().count() <= NAME_LIMIT
        && !name.chars().any(char::is_control)
        && goal.chars().count() <= GOAL_LIMIT
        && connection.chars().count() <= CONNECTION_LIMIT
        && rules.chars().count() <= RULES_LIMIT
}

fn canonical_path_syntax(path: &str) -> bool {
    // A saved folder may have moved or become inaccessible since it was registered.
    path == "/"
        || (!path.contains('\0')
            && path.strip_prefix('/').is_some_and(|rest| {
                rest.split('/').all(|part| !matches!(part, "" | "." | ".."))
            }))
}

fn valid_identity_part(part: &str) -> bool {
    part.parse::<u64>()
        .is_ok_and(|number| number.to_string() == part)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StoreFile {
    version: u32,
    #[serde(deserialize_with = "read_projects")]
    projects: Vec<Project>,
}

// Serde's derived struct decoder also accepts positional arrays. The disk schema requires objects.
struct JsonObject<T>(T);

impl<'de, T: Deserialize<'de>> Deserialize<'de> for JsonObject<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ObjectVisitor<T>(PhantomData<T>);

        impl<'de, T: Deserialize<'de>> Visitor<'de> for ObjectVisitor<T> {
            type Value = JsonObject<T>;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a JSON object")
            }

            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Self::Value, A::Error> {
                T::deserialize(MapAccessDeserializer::new(map)).map(JsonObject)
            }
        }

        deserializer.deserialize_map(ObjectVisitor(PhantomData))
    }
}

fn read_projects<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<Project>, D::Error> {
    let projects = Vec::<JsonObject<Project>>::deserialize(deserializer)?;
    Ok(projects.into_iter().map(|JsonObject(project)| project).collect())
}

impl StoreFile {
    fn empty() -> Self {
        Self {
            version: VERSION,
            projects: Vec::new(),
        }
    }

    fn valid(&self) -> bool {
        let mut ids = HashSet::new();
        let mut folders = HashSet::new();
        self.version == VERSION
            && self.projects.iter().all(|project| {
                project.valid()
                    && ids.insert(&project.id)
                    && folders.insert(&project.folder_identity)
            })
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ListResult {
    Ok { projects: Vec<Project> },
    Unavailable,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum CreateResult {
    Created { project: Project },
    Duplicate { project: Project },
    Invalid,
    Unavailable,
}

pub enum UpdateResult {
    Updated(Project),
    Unchanged,
    Duplicate(Project),
    Changed,
    Unavailable,
}

pub struct ProjectStore {
    directory: PathBuf,
}

impl ProjectStore {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    pub fn list(&self) -> ListResult {
        self.with_lock(|| {
            Ok(ListResult::Ok {
                projects: self.read()?.projects,
            })
        })
        .unwrap_or(ListResult::Unavailable)
    }

    pub fn create(&self, input: Value) -> CreateResult {
        let resolved = JsonObject::<Metadata>::deserialize(&input)
            .ok()
            .filter(|JsonObject(metadata)| metadata.valid())
            .and_then(|JsonObject(metadata)| {
                let FolderResult::Chosen { path, folder_identity } = resolve(Path::new(&metadata.path))
                else {
                    return None;
                };
                Some((metadata, path, folder_identity))
            });
        if let Some((_, path, _)) = &resolved {
            // Reject app data as a project before the lock file can be created there.
            match self.directory.canonicalize() {
                Ok(directory) => {
                    if Path::new(path).starts_with(directory) {
                        return CreateResult::Invalid;
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(_) => return CreateResult::Unavailable,
            }
        }

        self.with_lock(|| {
            let mut data = self.read()?;
            let Some((metadata, path, folder_identity)) = resolved else {
                return Ok(CreateResult::Invalid);
            };
            if input
                .get("folderIdentity")
                .is_some_and(|sent| sent.as_str() != Some(folder_identity.as_str()))
            {
                return Ok(CreateResult::Invalid);
            }
            if let Some(project) = data
                .projects
                .iter()
                .find(|project| project.folder_identity == folder_identity)
            {
                return Ok(CreateResult::Duplicate {
                    project: project.clone(),
                });
            }

            let project = Project {
                id: random_id()?,
                name: metadata.name,
                path,
                folder_identity,
                goal: metadata.goal,
                connection: metadata.connection,
                rules: metadata.rules,
                created_at: timestamp()?,
            };
            if !project.valid() || data.projects.iter().any(|existing| existing.id == project.id) {
                return Err(io::Error::other("invalid generated project"));
            }
            data.projects.push(project.clone());
            self.write(&data)?;
            Ok(CreateResult::Created { project })
        })
        .unwrap_or(CreateResult::Unavailable)
    }

    pub fn folder_allowed(&self, path: &str) -> io::Result<bool> {
        Ok(!Path::new(path).starts_with(self.directory.canonicalize()?))
    }

    pub fn update_folder(&self, saved: &Project, path: &str, folder_identity: &str) -> UpdateResult {
        self.with_lock(|| {
            let mut data = self.read()?;
            let Some(index) = data.projects.iter().position(|project| project.id == saved.id) else {
                return Ok(UpdateResult::Changed);
            };
            if data.projects[index].folder_identity != saved.folder_identity {
                return Ok(UpdateResult::Changed);
            }

            // Recheck the selection and ownership while holding the write lock.
            let FolderResult::Chosen { path: resolved, folder_identity: identity } = resolve(Path::new(path))
            else {
                return Ok(UpdateResult::Changed);
            };
            if resolved != path || identity != folder_identity || !self.folder_allowed(&resolved)? {
                return Ok(UpdateResult::Changed);
            }
            if let Some(owner) = data.projects.iter().find(|project| {
                project.id != saved.id && project.folder_identity == identity
            }) {
                return Ok(UpdateResult::Duplicate(owner.clone()));
            }
            let project = &mut data.projects[index];
            if project.path == resolved && project.folder_identity == identity {
                return Ok(UpdateResult::Unchanged);
            }
            project.path = resolved;
            project.folder_identity = identity;
            let updated = project.clone();
            if !data.valid() {
                return Ok(UpdateResult::Changed);
            }
            self.write(&data)?;
            Ok(UpdateResult::Updated(updated))
        })
        .unwrap_or(UpdateResult::Unavailable)
    }

    fn with_lock<T>(&self, operation: impl FnOnce() -> io::Result<T>) -> io::Result<T> {
        let _guard = STORE_MUTEX
            .lock()
            .map_err(|_| io::Error::other("project store lock poisoned"))?;
        DirBuilder::new()
            .recursive(true)
            .mode(DIRECTORY_MODE)
            .create(&self.directory)?;
        let metadata = fs::symlink_metadata(&self.directory)?;
        if !metadata.is_dir() {
            return Err(io::Error::other("invalid project store directory"));
        }
        let mode = metadata.permissions().mode() & 0o7777;
        if mode & DIRECTORY_MODE != DIRECTORY_MODE {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "project store directory is inaccessible",
            ));
        }
        if mode != DIRECTORY_MODE {
            fs::set_permissions(&self.directory, Permissions::from_mode(DIRECTORY_MODE))?;
        }

        // The lock has its own inode so it remains held across replacement of projects.json.
        let lock_path = self.directory.join(LOCK_FILE);
        check_regular_file(&lock_path)?;
        let lock = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .mode(FILE_MODE)
            .open(lock_path)?;
        lock.lock()?;
        operation()
    }

    fn read(&self) -> io::Result<StoreFile> {
        let path = self.directory.join(STORE_FILE);
        if !check_regular_file(&path)? {
            return Ok(StoreFile::empty());
        }
        let JsonObject(data) = serde_json::from_slice::<JsonObject<StoreFile>>(&fs::read(path)?)?;
        if !data.valid() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid project store",
            ));
        }
        Ok(data)
    }

    fn write(&self, data: &StoreFile) -> io::Result<()> {
        let temporary_path = self.directory.join(format!(".projects-{}.tmp", random_id()?));
        let mut temporary = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(FILE_MODE)
            .open(&temporary_path)?;
        let result = (|| {
            temporary.set_permissions(Permissions::from_mode(FILE_MODE))?;
            serde_json::to_writer(&mut temporary, data)?;
            temporary.flush()?;
            temporary.sync_all()?;
            drop(temporary);
            fs::rename(&temporary_path, self.directory.join(STORE_FILE))?;
            File::open(&self.directory)?.sync_all()
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary_path);
        }
        result
    }
}

fn check_regular_file(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(true),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "expected a regular file",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

pub fn random_id() -> io::Result<String> {
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).map_err(io::Error::other)?;
    let value = u128::from_ne_bytes(bytes);
    Ok(format!("{value:032x}"))
}

fn timestamp() -> io::Result<u64> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?;
    u64::try_from(elapsed.as_millis()).map_err(io::Error::other)
}


