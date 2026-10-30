// Tex: a thin Tauri shell. Rust reads and writes files, runs latexmk, synctex and git, and watches folders; everything
// that understands LaTeX lives in the TypeScript frontend.
mod compile;
mod files;
mod git;
mod synctex;
mod watch;

use tauri::{Manager, RunEvent};

/// Folders or files given on the command line (`tex-editor ~/thesis`), for the first window.
#[tauri::command]
fn launch_paths() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter_map(|arg| std::fs::canonicalize(arg).ok())
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(compile::Compiler::default())
        .manage(watch::Watchers::default())
        .invoke_handler(tauri::generate_handler![
            launch_paths,
            files::list_tree,
            files::read_text,
            files::write_text,
            files::read_bytes,
            files::create_file,
            files::create_dir,
            files::rename_path,
            files::duplicate_path,
            files::trash_path,
            files::reveal_path,
            files::open_external,
            compile::compile,
            compile::cancel_compile,
            compile::clean_cache,
            compile::detect_tex,
            git::git_status,
            git::git_init,
            git::git_add_remote,
            git::git_commit,
            git::git_discard,
            git::git_push,
            git::git_pull,
            git::git_clone,
            git::git_log,
            git::git_show,
            synctex::synctex_forward,
            synctex::synctex_inverse,
            watch::watch_project,
            watch::unwatch_project,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build the application");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<compile::Compiler>().cancel_all();
        }
    });
}
