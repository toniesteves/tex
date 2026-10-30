//! File commands: the project tree, text files (UTF-8 or Latin-1) with atomic saves, and file operations through GIO
//! and the desktop's file manager.
use serde::Serialize;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub type CmdResult<T> = Result<T, String>;

pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    name: String,
    path: String,
    is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<FileNode>>,
}

/// Build artifacts that other tools leave in LaTeX folders (Tex itself compiles into its cache).
const ARTIFACTS: [&str; 21] = [
    ".aux", ".log", ".synctex.gz", ".synctex", ".fls", ".fdb_latexmk", ".out", ".toc", ".lof", ".lot", ".bbl", ".blg",
    ".bcf", ".run.xml", ".nav", ".snm", ".vrb", ".xdv", ".idx", ".ilg", ".ind",
];
const MAX_TREE_ENTRIES: usize = 10_000;

/// Dot files and build artifacts stay out of the tree and out of change notifications.
pub fn is_hidden(name: &str) -> bool {
    name.starts_with('.') || ARTIFACTS.iter().any(|ext| name.ends_with(ext))
}

#[tauri::command]
pub async fn list_tree(root: String) -> CmdResult<Vec<FileNode>> {
    let mut budget = MAX_TREE_ENTRIES;
    read_tree(Path::new(&root), &mut budget).map_err(err)
}

fn read_tree(dir: &Path, budget: &mut usize) -> io::Result<Vec<FileNode>> {
    let mut nodes = Vec::new();
    for entry in fs::read_dir(dir)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_hidden(&name) {
            continue;
        }
        if *budget == 0 {
            break;
        }
        *budget -= 1;
        let path = entry.path();
        let is_dir = path.is_dir();
        let children = if is_dir { Some(read_tree(&path, budget).unwrap_or_default()) } else { None };
        nodes.push(FileNode { name, path: path.to_string_lossy().into_owned(), is_dir, children });
    }
    nodes.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(nodes)
}

#[derive(Serialize, Debug, PartialEq)]
pub struct TextFile {
    text: String,
    encoding: &'static str,
}

const MAX_TEXT_BYTES: u64 = 32 << 20;

#[tauri::command]
pub async fn read_text(path: String) -> CmdResult<TextFile> {
    if fs::metadata(&path).map_err(err)?.len() > MAX_TEXT_BYTES {
        return Err("the file is too large to edit".into());
    }
    decode(fs::read(&path).map_err(err)?)
}

/// UTF-8 (with or without a byte-order mark), else Latin-1, which maps every byte to the code point of the same value.
pub fn decode(bytes: Vec<u8>) -> CmdResult<TextFile> {
    if bytes.iter().take(8192).any(|&b| b == 0) {
        return Err("this is not a text file".into());
    }
    if let Some(rest) = bytes.strip_prefix(b"\xEF\xBB\xBF") {
        if let Ok(text) = std::str::from_utf8(rest) {
            return Ok(TextFile { text: text.to_owned(), encoding: "utf-8-bom" });
        }
    }
    match String::from_utf8(bytes) {
        Ok(text) => Ok(TextFile { text, encoding: "utf-8" }),
        Err(e) => Ok(TextFile { text: e.into_bytes().into_iter().map(char::from).collect(), encoding: "latin-1" }),
    }
}

pub fn encode(text: &str, encoding: &str) -> CmdResult<Vec<u8>> {
    match encoding {
        "latin-1" => text
            .chars()
            .map(|c| u8::try_from(c).map_err(|_| format!("“{c}” cannot be saved in Latin-1")))
            .collect(),
        "utf-8-bom" => Ok([b"\xEF\xBB\xBF".as_slice(), text.as_bytes()].concat()),
        _ => Ok(text.as_bytes().to_vec()),
    }
}

#[tauri::command]
pub async fn write_text(path: String, text: String, encoding: String) -> CmdResult<()> {
    write_atomic(Path::new(&path), &encode(&text, &encoding)?).map_err(err)
}

/// Writes a temporary sibling and renames it over the target, so a crash never leaves half a file. A symlink is
/// followed (the link survives) and the permissions are kept where the file system supports them.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let dir = target.parent().ok_or_else(|| io::Error::other("no parent directory"))?;
    let name = target.file_name().ok_or_else(|| io::Error::other("no file name"))?.to_string_lossy();
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    let write = || -> io::Result<()> {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        if let Ok(meta) = fs::metadata(&target) {
            let _ = fs::set_permissions(&tmp, meta.permissions());
        }
        fs::rename(&tmp, &target)
    };
    write().inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

#[tauri::command]
pub async fn read_bytes(path: String) -> CmdResult<tauri::ipc::Response> {
    fs::read(&path).map(tauri::ipc::Response::new).map_err(err)
}

#[tauri::command]
pub async fn create_file(path: String) -> CmdResult<()> {
    fs::OpenOptions::new().write(true).create_new(true).open(&path).map(drop).map_err(err)
}

#[tauri::command]
pub async fn create_dir(path: String) -> CmdResult<()> {
    fs::create_dir(&path).map_err(err)
}

#[tauri::command]
pub async fn rename_path(from: String, to: String) -> CmdResult<()> {
    if Path::new(&to).exists() {
        return Err("an item with this name already exists".into());
    }
    fs::rename(&from, &to).map_err(err)
}

/// Copies a file or folder next to itself as “name copy.ext”, “name copy 2.ext”… (`suffix` is the localized “copy”)
/// and returns the new path.
#[tauri::command]
pub async fn duplicate_path(path: String, suffix: String) -> CmdResult<String> {
    let source = PathBuf::from(&path);
    let target = copy_name(&source, &suffix);
    copy_recursive(&source, &target).map_err(err)?;
    Ok(target.to_string_lossy().into_owned())
}

fn copy_name(source: &Path, suffix: &str) -> PathBuf {
    let dir = source.parent().unwrap_or(Path::new("/"));
    let (stem, ext) = match (source.is_dir(), source.file_stem(), source.extension()) {
        (false, Some(stem), Some(ext)) => (stem.to_string_lossy(), format!(".{}", ext.to_string_lossy())),
        _ => (source.file_name().unwrap_or_default().to_string_lossy(), String::new()),
    };
    (1..)
        .map(|n| match n {
            1 => dir.join(format!("{stem} {suffix}{ext}")),
            n => dir.join(format!("{stem} {suffix} {n}{ext}")),
        })
        .find(|p| !p.exists())
        .expect("an unused name exists")
}

fn copy_recursive(from: &Path, to: &Path) -> io::Result<()> {
    if from.is_dir() {
        fs::create_dir(to)?;
        for entry in fs::read_dir(from)?.flatten() {
            copy_recursive(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(from, to).map(drop)
    }
}

fn run(command: &mut Command) -> CmdResult<()> {
    let output = command.stdin(Stdio::null()).output().map_err(err)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
    }
}

#[tauri::command]
pub async fn trash_path(path: String) -> CmdResult<()> {
    run(Command::new("gio").args(["trash", "--"]).arg(&path))
}

/// Shows the item selected in the file manager (the FileManager1 D-Bus interface of Nemo and Nautilus), else opens
/// its folder.
#[tauri::command]
pub async fn reveal_path(path: String) -> CmdResult<()> {
    let shown = run(Command::new("dbus-send").args([
        "--session",
        "--dest=org.freedesktop.FileManager1",
        "--type=method_call",
        "/org/freedesktop/FileManager1",
        "org.freedesktop.FileManager1.ShowItems",
        &format!("array:string:file://{}", percent_encode(&path)),
        "string:",
    ]));
    match (shown, Path::new(&path).parent()) {
        (Ok(()), _) => Ok(()),
        (Err(_), Some(dir)) => open_external(dir.to_string_lossy().into_owned()).await,
        (Err(e), None) => Err(e),
    }
}

fn percent_encode(path: &str) -> String {
    path.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Opens a file or URL with the desktop's default application.
#[tauri::command]
pub async fn open_external(target: String) -> CmdResult<()> {
    let mut child = Command::new("xdg-open")
        .arg(&target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(err)?;
    std::thread::spawn(move || child.wait());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_utf8_bom_and_latin1() {
        assert_eq!(decode("ação".into()).unwrap(), TextFile { text: "ação".into(), encoding: "utf-8" });
        assert_eq!(decode(b"\xEF\xBB\xBFx".to_vec()).unwrap(), TextFile { text: "x".into(), encoding: "utf-8-bom" });
        assert_eq!(decode(b"a\xe7\xe3o".to_vec()).unwrap(), TextFile { text: "ação".into(), encoding: "latin-1" });
        assert!(decode(b"PK\0\x03".to_vec()).is_err());
    }

    #[test]
    fn encodes_back() {
        assert_eq!(encode("ação", "latin-1").unwrap(), b"a\xe7\xe3o");
        assert!(encode("π", "latin-1").is_err());
        assert_eq!(encode("x", "utf-8-bom").unwrap(), b"\xEF\xBB\xBFx");
    }

    #[test]
    fn hides_dot_files_and_artifacts() {
        assert!(is_hidden(".git") && is_hidden("main.aux") && is_hidden("main.synctex.gz"));
        assert!(!is_hidden("main.tex") && !is_hidden("refs.bib") && !is_hidden("main.pdf"));
    }

    #[test]
    fn atomic_write_and_copy_names() {
        let dir = std::env::temp_dir().join(format!("tex-editor-files-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.tex");
        write_atomic(&file, b"one").unwrap();
        write_atomic(&file, b"two").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"two");
        assert_eq!(copy_name(&file, "copy"), dir.join("a copy.tex"));
        fs::write(dir.join("a copy.tex"), "").unwrap();
        assert_eq!(copy_name(&file, "copy"), dir.join("a copy 2.tex"));
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2, "no temporary file is left behind");
        fs::remove_dir_all(&dir).unwrap();
    }
}
