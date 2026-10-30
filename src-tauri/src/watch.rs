//! Change notifications for open projects: bursts of file-system events (a save is several) become one `fs-changed`
//! event about 150 ms after the last of them.
use crate::files::{err, is_hidden, CmdResult};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Default)]
pub struct Watchers(Mutex<HashMap<String, RecommendedWatcher>>);

#[derive(Clone, Serialize)]
struct FsChanged {
    root: String,
    paths: Vec<String>,
}

#[tauri::command]
pub fn watch_project(app: AppHandle, state: tauri::State<'_, Watchers>, root: String) -> CmdResult<()> {
    let mut watchers = state.0.lock().unwrap();
    if watchers.contains_key(&root) {
        return Ok(());
    }
    let (tx, rx) = channel();
    let mut watcher = notify::recommended_watcher(tx).map_err(err)?;
    watcher.watch(Path::new(&root), RecursiveMode::Recursive).map_err(err)?;
    let thread_root = root.clone();
    std::thread::spawn(move || forward(&app, &thread_root, &rx));
    watchers.insert(root, watcher);
    Ok(())
}

/// Dropping the watcher closes its channel, which ends the forwarding thread.
#[tauri::command]
pub fn unwatch_project(state: tauri::State<'_, Watchers>, root: String) {
    state.0.lock().unwrap().remove(&root);
}

fn forward(app: &AppHandle, root: &str, rx: &Receiver<notify::Result<Event>>) {
    while let Ok(first) = rx.recv() {
        let mut paths = BTreeSet::new();
        // Opening a file is no change (and `git status` opens them all, which would refresh the Git panel forever).
        let mut add =
            |event: notify::Result<Event>| paths.extend(event.into_iter().filter(|e| !e.kind.is_access()).flat_map(|e| e.paths));
        add(first);
        while let Ok(event) = rx.recv_timeout(Duration::from_millis(150)) {
            add(event);
        }
        let paths: Vec<String> =
            paths.into_iter().filter(|p| relevant(root, p)).map(|p| p.to_string_lossy().into_owned()).collect();
        if !paths.is_empty() {
            let _ = app.emit("fs-changed", FsChanged { root: root.to_owned(), paths });
        }
    }
}

/// Changes inside dot folders (`.git`) and to hidden files (temporary files of a save, build artifacts) are noise.
fn relevant(root: &str, path: &PathBuf) -> bool {
    path.strip_prefix(root).is_ok_and(|rel| rel.components().all(|c| !is_hidden(&c.as_os_str().to_string_lossy())))
}
