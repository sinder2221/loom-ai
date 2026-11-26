mod folder;
mod helper;
mod store;
mod usage;

use folder::{resolve, FolderResult};
use helper::activity::{self, ActivityResult};
use helper::delegation::{self, DelegationResult};
use helper::{CreateResult, ListResult, ListedProject, SocketTransport, Transport};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{atomic::{AtomicBool, Ordering}, Mutex},
    time::{Duration, Instant},
};
use store::{Project, ProjectStore, UpdateResult};
use tauri::{
    ipc::{InvokeBody, Request},
    webview::NewWindowResponse, AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_dialog::DialogExt;

static FOLDER_DIALOG_OPEN: AtomicBool = AtomicBool::new(false);
static RELINKS: Mutex<Relinks> = Mutex::new(Relinks { generation: 0, pending: None });
const SELECTION_TTL: Duration = Duration::from_secs(120);

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase", rename_all_fields = "camelCase")]
enum RelinkResult {
    Cancelled,
    Inaccessible,
    Unchanged,
    Relinked { project: ListedProject },
    Duplicate { owner_id: String, owner_name: String },
    Confirm { token: String, saved_path: String, selected_path: String },
    Invalid,
    Unavailable,
    Changed,
    Expired,
}

impl RelinkResult {
    fn duplicate(owner: &Project) -> Self {
        Self::Duplicate { owner_id: owner.id().to_owned(), owner_name: owner.name().to_owned() }
    }
}

struct PendingRelink {
    project: Project,
    path: String,
    identity: String,
    token: String,
    expires_at: Instant,
}

#[derive(Default)]
struct Relinks {
    generation: u64,
    pending: Option<PendingRelink>,
}

impl Relinks {
    fn start(&mut self, store: &ProjectStore, project_id: &str) -> Result<(u64, Project), RelinkResult> {
        self.pending = None;
        self.generation = self.generation.wrapping_add(1);
        let store::ListResult::Ok { projects } = store.list() else {
            return Err(RelinkResult::Unavailable);
        };
        projects.into_iter().find(|project| project.id() == project_id)
            .map(|project| (self.generation, project)).ok_or(RelinkResult::Invalid)
    }

    fn selected(
        &mut self,
        store: &ProjectStore,
        (generation, project): (u64, Project),
        choice: FolderResult,
        transport: &impl Transport,
        deadline: Instant,
        now: Instant,
    ) -> RelinkResult {
        if generation != self.generation || matches!(choice, FolderResult::Cancelled) {
            return RelinkResult::Cancelled;
        }
        let FolderResult::Chosen { path, folder_identity } = choice else {
            return RelinkResult::Inaccessible;
        };
        if folder_identity == project.folder_identity() {
            return match save_relink(store, &project, &path, &folder_identity, transport, deadline) {
                RelinkResult::Changed => RelinkResult::Inaccessible,
                result => result,
            };
        }
        match store.folder_allowed(&path) {
            Ok(true) => {}
            Ok(false) => return RelinkResult::Inaccessible,
            Err(_) => return RelinkResult::Unavailable,
        }
        let store::ListResult::Ok { projects } = store.list() else {
            return RelinkResult::Unavailable;
        };
        if let Some(owner) = projects.iter().find(|owner| {
            owner.id() != project.id() && owner.folder_identity() == folder_identity
        }) {
            return RelinkResult::duplicate(owner);
        }
        let Ok(token) = store::random_id() else {
            return RelinkResult::Unavailable;
        };
        let answer = RelinkResult::Confirm {
            token: token.clone(), saved_path: project.path().to_owned(), selected_path: path.clone(),
        };
        self.pending = Some(PendingRelink {
            project, path, identity: folder_identity, token, expires_at: now + SELECTION_TTL,
        });
        answer
    }

    fn confirm(
        &mut self,
        store: &ProjectStore,
        token: &str,
        transport: &impl Transport,
        deadline: Instant,
        now: Instant,
    ) -> RelinkResult {
        let Some(selection) = self.pending.as_ref() else {
            return RelinkResult::Expired;
        };
        if now >= selection.expires_at {
            self.pending = None;
            return RelinkResult::Expired;
        }
        if selection.token != token {
            return RelinkResult::Expired;
        }
        let selection = self.pending.take().expect("pending selection was checked");
        match save_relink(store, &selection.project, &selection.path, &selection.identity, transport, deadline) {
            RelinkResult::Unchanged => RelinkResult::Changed,
            result => result,
        }
    }
}

fn save_relink(
    store: &ProjectStore,
    saved: &Project,
    path: &str,
    identity: &str,
    transport: &impl Transport,
    deadline: Instant,
) -> RelinkResult {
    match store.update_folder(saved, path, identity) {
        UpdateResult::Updated(project) => RelinkResult::Relinked {
            project: helper::sync_relinked(project, transport, deadline),
        },
        UpdateResult::Unchanged => RelinkResult::Unchanged,
        UpdateResult::Duplicate(owner) => RelinkResult::duplicate(&owner),
        UpdateResult::Changed => RelinkResult::Changed,
        UpdateResult::Unavailable => RelinkResult::Unavailable,
    }
}

struct FolderDialogGuard<'a>(&'a AtomicBool);

impl<'a> FolderDialogGuard<'a> {
    fn try_acquire(open: &'a AtomicBool) -> Option<Self> {
        open.compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .ok()?;
        Some(Self(open))
    }
}

impl Drop for FolderDialogGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

async fn resolve_path(path: PathBuf) -> FolderResult {
    tauri::async_runtime::spawn_blocking(move || resolve(&path))
        .await
        .unwrap_or(FolderResult::Inaccessible)
}

#[tauri::command]
async fn resolve_folder(path: String) -> FolderResult {
    resolve_path(path.into()).await
}

#[tauri::command]
async fn choose_folder(window: WebviewWindow) -> FolderResult {
    pick_folder(window).await
}

async fn pick_folder(window: WebviewWindow) -> FolderResult {
    match pick_folder_path(window).await {
        Ok(path) => resolve_path(path).await,
        Err(result) => result,
    }
}

async fn pick_folder_path(window: WebviewWindow) -> Result<PathBuf, FolderResult> {
    let Some(guard) = FolderDialogGuard::try_acquire(&FOLDER_DIALOG_OPEN) else {
        return Err(FolderResult::Cancelled);
    };

    let (sender, mut selection) = tauri::async_runtime::channel(1);
    window
        .dialog()
        .file()
        .set_parent(&window)
        .pick_folder(move |path| {
            // The dialog owns the guard even if the IPC request stops waiting.
            drop(guard);
            let _ = sender.try_send(path);
        });

    match selection.recv().await {
        Some(Some(path)) => path.into_path().map_err(|_| FolderResult::Invalid),
        Some(None) => Err(FolderResult::Cancelled),
        None => Err(FolderResult::Inaccessible),
    }
}

#[tauri::command]
async fn relink_project(window: WebviewWindow, project_id: String) -> RelinkResult {
    let started = Instant::now();
    let Ok(directory) = window.app_handle().path().app_data_dir() else {
        return RelinkResult::Unavailable;
    };
    let first_read = directory.clone();
    let initial = tauri::async_runtime::spawn_blocking(move || {
        RELINKS.lock().map_err(|_| RelinkResult::Unavailable)?
            .start(&ProjectStore::new(first_read), &project_id)
    }).await.unwrap_or(Err(RelinkResult::Unavailable));
    let selection = match initial {
        Ok(selection) => selection,
        Err(result) => return result,
    };
    let picking = Instant::now();
    let choice = pick_folder_path(window).await;
    // The user can keep the picker open. Only time spent in the native dialog
    // is excluded from the single budget that begins before the first store read.
    let deadline = helper::relink_deadline(started) + picking.elapsed();
    let choice = match choice {
        Ok(path) => resolve_path(path).await,
        Err(result) => result,
    };
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(mut relinks) = RELINKS.lock() else { return RelinkResult::Unavailable; };
        relinks.selected(&ProjectStore::new(directory), selection, choice,
            &SocketTransport::from_env(), deadline, Instant::now())
    }).await.unwrap_or(RelinkResult::Unavailable)
}

#[tauri::command]
async fn confirm_relink(app: AppHandle, token: String) -> RelinkResult {
    let deadline = helper::relink_deadline(Instant::now());
    let Ok(directory) = app.path().app_data_dir() else {
        return RelinkResult::Unavailable;
    };
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(mut relinks) = RELINKS.lock() else { return RelinkResult::Unavailable; };
        relinks.confirm(&ProjectStore::new(directory), &token,
            &SocketTransport::from_env(), deadline, Instant::now())
    }).await.unwrap_or(RelinkResult::Unavailable)
}

#[tauri::command]
async fn list_projects(app: AppHandle) -> ListResult {
    read_projects(app, false).await
}

#[tauri::command]
async fn connect_projects(app: AppHandle) -> ListResult {
    read_projects(app, true).await
}

async fn read_projects(app: AppHandle, retry: bool) -> ListResult {
    let started = Instant::now();
    let Ok(directory) = app.path().app_data_dir() else {
        return ListResult::Unavailable;
    };
    tauri::async_runtime::spawn_blocking(move || {
        // A retry can change the helper's folder. Serialize it with native saves
        // so it cannot apply an older saved path after a newer relink.
        let _write = if retry {
            let Ok(guard) = RELINKS.lock() else { return ListResult::Unavailable; };
            Some(guard)
        } else {
            None
        };
        let store = ProjectStore::new(directory);
        helper::project_list(|| store.list(), &SocketTransport::from_env(), retry, started)
    })
    .await
    .unwrap_or(ListResult::Unavailable)
}

#[tauri::command]
async fn create_project(app: AppHandle, metadata: Option<serde_json::Value>) -> CreateResult {
    let Ok(directory) = app.path().app_data_dir() else {
        return CreateResult::Unavailable;
    };
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(_write) = RELINKS.lock() else { return CreateResult::Unavailable; };
        helper::save_and_register(
            &ProjectStore::new(directory),
            metadata.unwrap_or_default(),
            &SocketTransport::from_env(),
        )
    })
    .await
    .unwrap_or(CreateResult::Unavailable)
}

#[tauri::command]
async fn project_activity(app: AppHandle, request: Request<'_>) -> Result<ActivityResult, ()> {
    let started = Instant::now();
    let InvokeBody::Json(input) = request.body() else {
        return Ok(ActivityResult::InvalidRequest);
    };
    let input = input.clone();
    let Ok(directory) = app.path().app_data_dir() else {
        return Ok(ActivityResult::Unknown);
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        // Keep the helper's folder check and snapshot read on the same saved binding.
        let Ok(_binding) = RELINKS.lock() else { return ActivityResult::Unknown; };
        activity::query(&ProjectStore::new(directory), &SocketTransport::from_env(), input, started)
    })
    .await
    .unwrap_or(ActivityResult::Unknown);
    Ok(result)
}

#[tauri::command]
async fn delegation_status(app: AppHandle, input: Option<serde_json::Value>) -> DelegationResult {
    project_delegation(app, input, false).await
}

#[tauri::command]
async fn enable_delegation(app: AppHandle, input: Option<serde_json::Value>) -> DelegationResult {
    project_delegation(app, input, true).await
}

async fn project_delegation(
    app: AppHandle, input: Option<serde_json::Value>, enable: bool,
) -> DelegationResult {
    let started = Instant::now();
    let Ok(directory) = app.path().app_data_dir() else {
        return DelegationResult::Unknown;
    };
    tauri::async_runtime::spawn_blocking(move || {
        // Serialize the setup write with shell registration and folder changes.
        let _write = if enable {
            let Ok(guard) = RELINKS.lock() else { return DelegationResult::Unknown; };
            Some(guard)
        } else {
            None
        };
        delegation::query(
            &ProjectStore::new(directory), &SocketTransport::from_env(),
            input.unwrap_or_default(), enable, started,
        )
    })
    .await
    .unwrap_or(DelegationResult::Unknown)
}

#[tauri::command]
async fn local_usage(app: AppHandle, request: Request<'_>) -> Result<serde_json::Value, ()> {
    let InvokeBody::Json(input) = request.body() else {
        return Ok(usage::unavailable());
    };
    let input = input.clone();
    let (Ok(data), Ok(home)) = (app.path().app_data_dir(), app.path().home_dir()) else {
        return Ok(usage::unavailable());
    };
    let resources = app.path().resource_dir().ok();
    Ok(tauri::async_runtime::spawn_blocking(move || usage::query(data, home, resources, input))
        .await.unwrap_or_else(|_| usage::unavailable()))
}

fn is_app_navigation(url: &Url) -> bool {
    url.scheme() == "tauri"
        && url.host_str() == Some("localhost")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            resolve_folder,
            choose_folder,
            list_projects,
            create_project,
            connect_projects,
            relink_project,
            confirm_relink,
            project_activity,
            delegation_status,
            enable_delegation,
            local_usage
        ])
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Loom")
                .inner_size(1280.0, 800.0)
                .on_navigation(is_app_navigation)
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Loom");
}


