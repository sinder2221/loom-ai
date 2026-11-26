use crate::store::{CreateResult as SavedCreate, ListResult as SavedList, Project, ProjectStore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    env,
    fs::{self, Metadata, OpenOptions},
    io::{self, Read, Write},
    os::unix::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
        net::UnixStream,
    },
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

pub mod activity;
pub mod delegation;

const TIMEOUT: Duration = Duration::from_secs(2);
// Leave room for IPC within the page's five-second limit.
const LIST_BUDGET: Duration = Duration::from_secs(3);
const RETRY_BUDGET: Duration = Duration::from_secs(4);
const REQUEST_LIMIT: usize = 64 * 1024;
const REPLY_LIMIT: usize = 1024 * 1024;
const SOCKET_PATH_LIMIT: usize = 103;
const TOKEN_LENGTH: usize = 43;
// Each connection carries exactly one request.
const REQUEST_ID: &str = "loom-project";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Registration {
    Registered,
    Unregistered,
    Conflict,
}

enum HelperStatus {
    Registered,
    NotRegistered,
    FolderChanged,
    FolderUnavailable,
}

enum RegistrationAttempt {
    State(Registration),
    ProjectConflict,
}

impl RegistrationAttempt {
    fn state(self) -> Registration {
        match self {
            Self::State(state) => state,
            Self::ProjectConflict => Registration::Conflict,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Folder {
    Ok,
    Changed,
    Missing,
    Unknown,
}

#[derive(Debug, Serialize)]
pub struct RegisteredProject {
    #[serde(flatten)]
    project: Project,
    registration: Registration,
}

#[derive(Debug, Serialize)]
pub struct ListedProject {
    #[serde(flatten)]
    project: RegisteredProject,
    folder: Folder,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum CreateResult {
    Created { project: RegisteredProject },
    Duplicate { project: RegisteredProject },
    Invalid,
    Unavailable,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ListResult {
    Ok { projects: Vec<ListedProject> },
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Failure {
    NotRunning,
    Unreachable,
    InvalidReply,
    Refused,
    OversizeRequest,
}

pub trait Transport {
    fn call(&self, op: &str, input: Value, deadline: Instant) -> Result<Value, Failure>;

    fn socket_path(&self) -> Option<PathBuf> {
        None
    }
}

pub struct SocketTransport {
    directory: Option<PathBuf>,
}

impl SocketTransport {
    pub fn from_env() -> Self {
        Self { directory: env::var_os("LOOM_DATA_DIR").map(PathBuf::from) }
    }
}

impl Transport for SocketTransport {
    fn socket_path(&self) -> Option<PathBuf> {
        self.directory.as_ref().filter(|path| path.is_absolute())
            .map(|path| path.join("run/bridge.sock"))
    }

    fn call(&self, op: &str, input: Value, deadline: Instant) -> Result<Value, Failure> {
        let socket = self.socket_path().ok_or(Failure::Unreachable)?;
        let address = darwin::Address::new(&socket).ok_or(Failure::Unreachable)?;
        let token = read_token(&socket.with_file_name("issuer-token"), darwin::current_uid()).ok_or_else(|| {
            match fs::symlink_metadata(&socket) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => Failure::NotRunning,
                _ => Failure::Unreachable,
            }
        })?;
        if op == "enableDelegation" && delegation_fields_contain(&input, &token) {
            return Err(Failure::Refused);
        }
        let frame = request_frame(op, &token, input)?;
        let mut stream = darwin::connect(&address, deadline).map_err(|error| match error.kind() {
            io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused => Failure::NotRunning,
            _ => Failure::Unreachable,
        })?;
        write_frame(&mut stream, &frame, deadline).map_err(|_| Failure::Unreachable)?;
        let reply = read_frame(|buffer| {
            stream.set_read_timeout(Some(remaining(deadline)?))?;
            stream.read(buffer)
        })?;
        checked_reply(op, &reply, &token, &socket)
    }
}

fn delegation_fields_contain(fields: &Value, text: &str) -> bool {
    ["accountLabel", "model"].iter().any(|field| {
        fields.get(*field).and_then(Value::as_str).is_some_and(|value| value.contains(text))
    })
}

fn checked_reply(op: &str, reply: &[u8], token: &str, socket: &Path) -> Result<Value, Failure> {
    if op == "projectActivity" {
        return activity::checked_reply(reply, token);
    }
    let result = reply_result(reply)?;
    if op == "delegationStatus" && (delegation_fields_contain(&result, token)
        || socket.to_str().is_some_and(|path| delegation_fields_contain(&result, path)))
    {
        return Err(Failure::InvalidReply);
    }
    Ok(result)
}

fn valid_token_file(metadata: &Metadata, uid: u32) -> bool {
    metadata.is_file() && metadata.uid() == uid && metadata.mode() & 0o7777 == 0o600
        && metadata.len() == TOKEN_LENGTH as u64
}

fn read_token(path: &Path, uid: u32) -> Option<String> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(darwin::O_NOFOLLOW | darwin::O_NONBLOCK)
        .open(path).ok()?;
    if !valid_token_file(&file.metadata().ok()?, uid) {
        return None;
    }
    let mut bytes = Vec::new();
    file.take((TOKEN_LENGTH + 1) as u64).read_to_end(&mut bytes).ok()?;
    if bytes.len() != TOKEN_LENGTH
        || !bytes.iter().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return None;
    }
    String::from_utf8(bytes).ok()
}

fn request_frame(op: &str, token: &str, input: Value) -> Result<Vec<u8>, Failure> {
    let mut frame = serde_json::to_vec(&json!({
        "v": 1, "id": REQUEST_ID, "op": op, "args": [token, input],
    }))
    .map_err(|_| Failure::OversizeRequest)?;
    if frame.len() > REQUEST_LIMIT {
        return Err(Failure::OversizeRequest);
    }
    frame.push(b'\n');
    Ok(frame)
}

fn remaining(deadline: Instant) -> io::Result<Duration> {
    let duration = deadline.saturating_duration_since(Instant::now());
    if duration.is_zero() {
        return Err(io::ErrorKind::TimedOut.into());
    }
    Ok(duration)
}

fn write_frame(stream: &mut UnixStream, mut frame: &[u8], deadline: Instant) -> io::Result<()> {
    while !frame.is_empty() {
        stream.set_write_timeout(Some(remaining(deadline)?))?;
        match stream.write(frame) {
            Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
            Ok(count) => frame = &frame[count..],
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn read_frame(mut read: impl FnMut(&mut [u8]) -> io::Result<usize>) -> Result<Vec<u8>, Failure> {
    let mut reply = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let count = match read(&mut buffer) {
            Ok(0) => return Err(Failure::InvalidReply),
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(Failure::Unreachable),
        };
        let chunk = &buffer[..count];
        let end = chunk.iter().position(|&byte| byte == b'\n');
        let line = &chunk[..end.unwrap_or(count)];
        if reply.len() + line.len() > REPLY_LIMIT {
            return Err(Failure::InvalidReply);
        }
        reply.extend_from_slice(line);
        if end.is_some() {
            return Ok(reply);
        }
    }
}

fn reply_result(reply: &[u8]) -> Result<Value, Failure> {
    decode_reply(reply)
}

fn decode_reply<T: serde::de::DeserializeOwned>(reply: &[u8]) -> Result<T, Failure> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields, bound(deserialize = "T: Deserialize<'de>"))]
    struct Reply<T> {
        v: u8,
        id: String,
        ok: bool,
        #[serde(default, deserialize_with = "present")]
        result: Option<T>,
        #[serde(default, deserialize_with = "present")]
        error: Option<Value>,
    }

    fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(decoder: D) -> Result<Option<T>, D::Error> {
        T::deserialize(decoder).map(Some)
    }

    // A derived struct also accepts an array. Only a JSON object is a reply.
    if reply.iter().find(|byte| !byte.is_ascii_whitespace()) != Some(&b'{') {
        return Err(Failure::InvalidReply);
    }
    let reply: Reply<T> = serde_json::from_slice(reply).map_err(|_| Failure::InvalidReply)?;
    match (reply.v, reply.id.as_str(), reply.ok, reply.result, reply.error) {
        (1, REQUEST_ID, true, Some(result), None) => Ok(result),
        (1, REQUEST_ID, false, None, Some(Value::String(_))) => Err(Failure::Refused),
        _ => Err(Failure::InvalidReply),
    }
}

fn folder_state(project: &Project) -> Folder {
    let Ok(metadata) = fs::canonicalize(project.path()).and_then(fs::metadata) else {
        return Folder::Missing;
    };
    if !metadata.is_dir() {
        return Folder::Missing;
    }
    if format!("{}:{}", metadata.dev(), metadata.ino()) == project.folder_identity() {
        Folder::Ok
    } else {
        Folder::Changed
    }
}

fn call_helper(
    transport: &impl Transport,
    op: &str,
    input: Value,
    command_deadline: Instant,
) -> Result<Value, Failure> {
    let deadline = command_deadline.min(Instant::now() + TIMEOUT);
    remaining(deadline).map_err(|_| Failure::Unreachable)?;
    transport.call(op, input, deadline)
}

fn register(transport: &impl Transport, project: &Project, deadline: Instant) -> Result<RegistrationAttempt, Failure> {
    let result = call_helper(transport, "registerProject", json!({
        "projectId": project.id(), "name": project.name(), "folder": project.path(),
    }), deadline)?;
    let Some(fields) = result.as_object() else {
        return Err(Failure::InvalidReply);
    };
    match (
        fields.len(),
        fields.get("outcome").and_then(Value::as_str),
        fields.get("reason").and_then(Value::as_str),
    ) {
        (1, Some("registered" | "already-registered"), None) => Ok(RegistrationAttempt::State(Registration::Registered)),
        (2, Some("refused"), Some("project-conflict")) => Ok(RegistrationAttempt::ProjectConflict),
        (2, Some("refused"), Some("folder-already-registered")) => Ok(RegistrationAttempt::State(Registration::Conflict)),
        (2, Some("refused"), Some("folder-unavailable" | "invalid-request")) => Ok(RegistrationAttempt::State(Registration::Unregistered)),
        _ => Err(Failure::InvalidReply),
    }
}

fn status(transport: &impl Transport, project: &Project, deadline: Instant) -> Result<HelperStatus, Failure> {
    let result = call_helper(transport, "projectStatus", json!({
        "projectId": project.id(), "folder": project.path(),
    }), deadline)?;
    match result.as_str() {
        Some("registered") => Ok(HelperStatus::Registered),
        Some("not-registered") => Ok(HelperStatus::NotRegistered),
        Some("folder-changed") => Ok(HelperStatus::FolderChanged),
        Some("folder-unavailable") => Ok(HelperStatus::FolderUnavailable),
        _ => Err(Failure::InvalidReply),
    }
}

fn relink(transport: &impl Transport, project: &Project, deadline: Instant) -> Result<Registration, Failure> {
    let result = call_helper(transport, "relinkProject", json!({
        "projectId": project.id(), "folder": project.path(),
    }), deadline)?;
    let Some(fields) = result.as_object() else {
        return Err(Failure::InvalidReply);
    };
    match (
        fields.len(),
        fields.get("outcome").and_then(Value::as_str),
        fields.get("reason").and_then(Value::as_str),
    ) {
        (1, Some("relinked" | "unchanged"), None) => Ok(Registration::Registered),
        (2, Some("refused"), Some("not-registered")) => {
            match register(transport, project, deadline)? {
                RegistrationAttempt::State(state) => Ok(state),
                RegistrationAttempt::ProjectConflict => Ok(Registration::Unregistered),
            }
        }
        (2, Some("refused"), Some("folder-already-registered")) => Ok(Registration::Conflict),
        (2, Some("refused"), Some("folder-unavailable")) => Ok(Registration::Unregistered),
        _ => Err(Failure::InvalidReply),
    }
}

pub fn relink_deadline(started: Instant) -> Instant {
    started + RETRY_BUDGET
}

pub fn sync_relinked(project: Project, transport: &impl Transport, deadline: Instant) -> ListedProject {
    let (folder, registration) = if Instant::now() < deadline {
        let folder = folder_state(&project);
        let registration = if folder == Folder::Ok {
            relink(transport, &project, deadline).unwrap_or(Registration::Unregistered)
        } else {
            Registration::Unregistered
        };
        (folder, registration)
    } else {
        (Folder::Unknown, Registration::Unregistered)
    };
    ListedProject { project: RegisteredProject { project, registration }, folder }
}

fn retry_registration(
    transport: &impl Transport,
    project: &Project,
    observed: HelperStatus,
    deadline: Instant,
) -> Result<Registration, Failure> {
    // A moved directory can leave the helper's old path missing entirely.
    // The native folder has already been checked against the saved identity.
    if matches!(observed, HelperStatus::FolderChanged | HelperStatus::FolderUnavailable) {
        return relink(transport, project, deadline);
    }
    match register(transport, project, deadline)? {
        RegistrationAttempt::State(state) => Ok(state),
        // The helper may have gained a registration since its first status reply.
        RegistrationAttempt::ProjectConflict => match status(transport, project, deadline)? {
            HelperStatus::FolderChanged | HelperStatus::FolderUnavailable => relink(transport, project, deadline),
            HelperStatus::Registered => Ok(Registration::Registered),
            _ => Ok(Registration::Conflict),
        },
    }
}

pub fn save_and_register(store: &ProjectStore, metadata: Value, transport: &impl Transport) -> CreateResult {
    let (project, duplicate) = match store.create(metadata) {
        SavedCreate::Created { project } => (project, false),
        SavedCreate::Duplicate { project } => (project, true),
        SavedCreate::Invalid => return CreateResult::Invalid,
        SavedCreate::Unavailable => return CreateResult::Unavailable,
    };
    // A duplicate can refer to a saved path that no longer points to its original folder.
    let registration = if folder_state(&project) == Folder::Ok {
        register(transport, &project, Instant::now() + TIMEOUT)
            .map(RegistrationAttempt::state).unwrap_or(Registration::Unregistered)
    } else {
        Registration::Unregistered
    };
    let project = RegisteredProject { project, registration };
    if duplicate {
        CreateResult::Duplicate { project }
    } else {
        CreateResult::Created { project }
    }
}

pub fn project_list(
    read_store: impl FnOnce() -> SavedList,
    transport: &impl Transport,
    retry: bool,
    started: Instant,
) -> ListResult {
    let deadline = started + if retry { RETRY_BUDGET } else { LIST_BUDGET };
    let SavedList::Ok { projects } = read_store() else {
        return ListResult::Unavailable;
    };
    let mut projects: Vec<_> = projects.into_iter().map(|project| {
        let folder = if Instant::now() < deadline {
            folder_state(&project)
        } else {
            Folder::Unknown
        };
        ListedProject {
            project: RegisteredProject { project, registration: Registration::Unregistered },
            folder,
        }
    }).collect();

    for listed in &mut projects {
        if Instant::now() >= deadline {
            break;
        }
        let project = &listed.project.project;
        let observed = status(transport, project, deadline).and_then(|observed| match observed {
            HelperStatus::Registered => Ok(Registration::Registered),
            _ if retry && listed.folder == Folder::Ok => retry_registration(transport, project, observed, deadline),
            _ => Ok(Registration::Unregistered),
        });
        if matches!(observed, Err(Failure::Unreachable | Failure::NotRunning)) {
            break;
        }
        listed.project.registration = observed.unwrap_or(Registration::Unregistered);
    }
    ListResult::Ok { projects }
}

// std's UnixStream has no timed connect API. Use Darwin's nonblocking connect and
// poll for that step, then hand blocking reads and writes back to UnixStream.
mod darwin {
    use super::{remaining, OsStrExt, Path, SOCKET_PATH_LIMIT};
    use std::{
        ffi::{c_int, c_short, c_uint},
        io,
        os::fd::{AsRawFd, FromRawFd, OwnedFd},
        os::unix::net::UnixStream,
        time::Instant,
    };

    pub const O_NOFOLLOW: c_int = 0x0100;
    pub const O_NONBLOCK: c_int = 0x0004;
    const AF_UNIX: u8 = 1;
    const SOCK_STREAM: c_int = 1;
    const F_SETFD: c_int = 2;
    const FD_CLOEXEC: c_int = 1;
    const SOL_SOCKET: c_int = 0xffff;
    const SO_NOSIGPIPE: c_int = 0x1022;
    const EINPROGRESS: c_int = 36;
    const POLLOUT: c_short = 0x0004;

    #[repr(C)]
    pub struct Address {
        len: u8,
        family: u8,
        path: [u8; SOCKET_PATH_LIMIT + 1],
    }

    impl Address {
        pub fn new(path: &Path) -> Option<Self> {
            let bytes = path.as_os_str().as_bytes();
            if bytes.is_empty() || bytes.len() > SOCKET_PATH_LIMIT || bytes.contains(&0) {
                return None;
            }
            let mut address = Self {
                len: (2 + bytes.len() + 1) as u8,
                family: AF_UNIX,
                path: [0; SOCKET_PATH_LIMIT + 1],
            };
            address.path[..bytes.len()].copy_from_slice(bytes);
            Some(address)
        }
    }

    #[repr(C)]
    struct PollFd {
        fd: c_int,
        events: c_short,
        revents: c_short,
    }

    unsafe extern "C" {
        fn getuid() -> c_uint;
        fn socket(domain: c_int, kind: c_int, protocol: c_int) -> c_int;
        fn fcntl(fd: c_int, command: c_int, ...) -> c_int;
        fn setsockopt(fd: c_int, level: c_int, name: c_int, value: *const c_int, len: c_uint) -> c_int;
        #[link_name = "connect"]
        fn connect_socket(fd: c_int, address: *const Address, length: c_uint) -> c_int;
        fn poll(fds: *mut PollFd, count: c_uint, milliseconds: c_int) -> c_int;
    }

    pub fn current_uid() -> u32 {
        // SAFETY: getuid takes no arguments and has no error return.
        unsafe { getuid() }
    }

    pub fn connect(address: &Address, deadline: Instant) -> io::Result<UnixStream> {
        // SAFETY: AF_UNIX and SOCK_STREAM create a new descriptor, owned below.
        let fd = unsafe { socket(AF_UNIX.into(), SOCK_STREAM, 0) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: socket succeeded and transferred ownership of this descriptor.
        let owned = unsafe { OwnedFd::from_raw_fd(fd) };
        // SAFETY: F_SETFD takes an integer flag for the live descriptor.
        if unsafe { fcntl(fd, F_SETFD, FD_CLOEXEC) } < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: SO_NOSIGPIPE takes an integer option on the live socket.
        if unsafe { setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &1, size_of::<c_int>() as c_uint) } < 0 {
            return Err(io::Error::last_os_error());
        }
        let stream = UnixStream::from(owned);
        stream.set_nonblocking(true)?;
        remaining(deadline)?;
        // SAFETY: Address is a Darwin sockaddr_un with len bounded by its size.
        if unsafe { connect_socket(fd, address, address.len.into()) } < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(EINPROGRESS)
                && !matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted)
            {
                return Err(error);
            }
            wait_for_connect(&stream, deadline)?;
        }
        stream.set_nonblocking(false)?;
        Ok(stream)
    }

    fn wait_for_connect(stream: &UnixStream, deadline: Instant) -> io::Result<()> {
        let mut fd = PollFd { fd: stream.as_raw_fd(), events: POLLOUT, revents: 0 };
        loop {
            let milliseconds = remaining(deadline)?.as_millis().max(1) as c_int;
            // SAFETY: fd points to one initialized pollfd for the live stream.
            match unsafe { poll(&mut fd, 1, milliseconds) } {
                0 => continue,
                -1 => {
                    let error = io::Error::last_os_error();
                    if error.kind() != io::ErrorKind::Interrupted {
                        return Err(error);
                    }
                }
                _ => return stream.take_error()?.map_or(Ok(()), Err),
            }
        }
    }
}


