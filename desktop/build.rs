fn main() {
    let manifest = tauri_build::AppManifest::new().commands(&[
        "resolve_folder",
        "choose_folder",
        "list_projects",
        "create_project",
        "connect_projects",
        "relink_project",
        "confirm_relink",
        "project_activity",
        "delegation_status",
        "enable_delegation",
        "local_usage",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to build Tauri context");
}
