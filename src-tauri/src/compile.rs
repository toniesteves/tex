//! Compilation with latexmk, in place. TeX runs in the main file's own directory, so every relative path (`\input`,
//! `../macros.tex`, figures, `.bib` files) resolves exactly as it does on disk, and it writes everything into a private
//! cache directory, so the project folder stays clean. Unsaved buffers are written to the cache too and swapped in with
//! the LaTeX kernel's `\declare@file@substitution`: the PDF follows the text while the user types.
use crate::files::{encode, err, write_atomic, CmdResult};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io;
use std::os::unix::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileRequest {
    /// The project folder.
    root: String,
    /// The root `.tex` file.
    main: String,
    /// `pdflatex`, `xelatex` or `lualatex`.
    engine: String,
    /// Unsaved buffers.
    overlays: Vec<Overlay>,
    /// Also copy the PDF next to the main file.
    export: bool,
}

#[derive(Deserialize)]
pub struct Overlay {
    path: String,
    text: String,
    encoding: String,
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CompileResult {
    /// `ok`, `failed` (TeX reported errors), `cancelled` or `error` (latexmk could not run).
    status: &'static str,
    /// The newest PDF in the cache, even after a failed run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pdf: Option<String>,
    pdf_updated: bool,
    log: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    bibtex_log: Option<String>,
    /// The directory TeX ran in: relative paths in the log start here.
    cwd: String,
    /// Cache path → project path of every unsaved buffer, to map log and SyncTeX paths back.
    overlays: HashMap<String, String>,
    duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

impl CompileResult {
    fn cancelled() -> Self {
        CompileResult { status: "cancelled", ..Default::default() }
    }
}

/// One slot per project: a new request kills the running compile, and only the newest waiting request runs.
#[derive(Default)]
struct Slot {
    gate: Mutex<()>,
    generation: AtomicU64,
    pid: Mutex<Option<i32>>,
    /// The `overlays` of the last compile (for SyncTeX); None before the first compile of the session.
    overlays: Mutex<Option<HashMap<String, String>>>,
}

#[derive(Default)]
pub struct Compiler {
    slots: Mutex<HashMap<String, Arc<Slot>>>,
}

impl Compiler {
    fn slot(&self, root: &str) -> Arc<Slot> {
        self.slots.lock().unwrap().entry(root.to_owned()).or_default().clone()
    }

    pub fn cancel_all(&self) {
        for slot in self.slots.lock().unwrap().values() {
            slot.generation.fetch_add(1, SeqCst);
            kill(slot);
        }
    }

    /// The name SyncTeX knows for `path`: its cache copy when the last compile used one.
    pub fn synctex_input(&self, root: &str, path: &str) -> String {
        let slot = self.slot(root);
        let overlays = slot.overlays.lock().unwrap();
        overlays.iter().flatten().find(|(_, p)| *p == path).map_or_else(|| path.to_owned(), |(cached, _)| cached.clone())
    }

    /// The project file behind a path that SyncTeX reported.
    pub fn project_path(&self, root: &str, path: &str) -> String {
        let normalized = normalize(Path::new(path));
        let slot = self.slot(root);
        let overlays = slot.overlays.lock().unwrap();
        overlays.as_ref().and_then(|o| o.get(&normalized)).cloned().unwrap_or(normalized)
    }
}

fn kill(slot: &Slot) {
    if let Some(pid) = *slot.pid.lock().unwrap() {
        // latexmk leads its own process group, together with the engine and BibTeX it starts.
        unsafe { libc::kill(-pid, libc::SIGKILL) };
    }
}

#[tauri::command]
pub async fn compile(state: tauri::State<'_, Compiler>, request: CompileRequest) -> CmdResult<CompileResult> {
    let slot = state.slot(&request.root);
    let generation = slot.generation.fetch_add(1, SeqCst) + 1;
    kill(&slot);
    tauri::async_runtime::spawn_blocking(move || {
        let _gate = slot.gate.lock().unwrap();
        if slot.generation.load(SeqCst) != generation {
            return Ok(CompileResult::cancelled());
        }
        run(&slot, generation, &request)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn cancel_compile(state: tauri::State<'_, Compiler>, root: String) {
    let slot = state.slot(&root);
    slot.generation.fetch_add(1, SeqCst);
    kill(&slot);
}

/// Deletes the project's cache (auxiliary files included), so the next compile starts from scratch.
#[tauri::command]
pub async fn clean_cache(state: tauri::State<'_, Compiler>, root: String) -> CmdResult<()> {
    cancel_compile(state, root.clone());
    match fs::remove_dir_all(cache_dir(&root)?) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(err(e)),
        _ => Ok(()),
    }
}

fn run(slot: &Slot, generation: u64, req: &CompileRequest) -> CmdResult<CompileResult> {
    let started = Instant::now();
    let started_at = SystemTime::now();
    let main = Path::new(&req.main);
    let (Some(cwd), Some(stem), Some(main_name)) = (main.parent(), main.file_stem(), main.file_name()) else {
        return Err(format!("not a file: {}", req.main));
    };
    let stem = stem.to_string_lossy();
    let engine = match req.engine.as_str() {
        "pdflatex" => "-pdf",
        "xelatex" => "-xelatex",
        "lualatex" => "-lualatex",
        other => return Err(format!("unknown engine: {other}")),
    };
    let latexmk = find_in_path("latexmk").ok_or("latexmk was not found (sudo apt install latexmk)")?;
    let cache = cache_dir(&req.root)?;
    let (ov_dir, out) = (cache.join("ov"), cache.join("out"));
    let _ = fs::remove_dir_all(&ov_dir);
    fs::create_dir_all(&ov_dir).map_err(err)?;
    mirror_dirs(cwd, &out).map_err(err)?;
    let (pretex, overlays) = prepare_overlays(Path::new(&req.root), cwd, &ov_dir, &req.overlays)?;
    let previous = slot.overlays.lock().unwrap().replace(overlays.clone());

    // latexmk only compares the files it already knows, so it would see "nothing to do" when a buffer is swapped in
    // for an unchanged file, and keep a log that names cached buffers after they are saved. Compiles with unsaved
    // buffers, the compile after them and the first compile of the session (the cache may be from such a compile)
    // are forced (-g).
    let force = (!overlays.is_empty() || previous.is_none_or(|p| !p.is_empty())).then_some("-g");
    let child = Command::new(latexmk)
        .args([engine, "-interaction=nonstopmode", "-file-line-error", "-synctex=1"])
        .args(force)
        .arg(format!("-outdir={}", out.display()))
        .arg(format!("-jobname={stem}"))
        .arg(format!("-usepretex={pretex}"))
        .arg(main_name)
        .current_dir(cwd)
        .env("max_print_line", "10000") // one log line per message
        .env("TEXMFOUTPUT", &cache) // lets `\include` write .aux files next to cached buffers
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(err)?;
    *slot.pid.lock().unwrap() = Some(child.id() as i32);
    if slot.generation.load(SeqCst) != generation {
        kill(slot); // a newer request arrived while this one was starting
    }
    let output = child.wait_with_output().map_err(err)?;
    *slot.pid.lock().unwrap() = None;
    if slot.generation.load(SeqCst) != generation {
        return Ok(CompileResult::cancelled());
    }

    let read = |ext: &str| fs::read(out.join(format!("{stem}.{ext}"))).ok().map(|b| String::from_utf8_lossy(&b).into_owned());
    let log = read("log").unwrap_or_default();
    let pdf_path = out.join(format!("{stem}.pdf"));
    let pdf_updated = fs::metadata(&pdf_path).and_then(|m| m.modified()).is_ok_and(|t| t >= started_at);
    let pdf = pdf_path.exists().then(|| pdf_path.to_string_lossy().into_owned());
    if let (true, Some(pdf)) = (req.export, &pdf) {
        write_atomic(&cwd.join(format!("{stem}.pdf")), &fs::read(pdf).map_err(err)?).map_err(err)?;
    }
    let message = (!output.status.success() && log.is_empty()).then(|| tail(&output.stdout, &output.stderr));
    Ok(CompileResult {
        status: if output.status.success() { "ok" } else { "failed" },
        pdf,
        pdf_updated,
        log,
        bibtex_log: read("blg"),
        cwd: cwd.to_string_lossy().into_owned(),
        overlays,
        duration_ms: started.elapsed().as_millis() as u64,
        message,
    })
}

/// The LaTeX code that swaps the unsaved buffers in, and the cache path → project path map of those buffers.
///
/// The kernel matches substitutions by file name only (`intro.tex`, without its folder). A name that only one file
/// in the project carries is substituted directly. A name shared by several files goes through a dispatcher that
/// reads the requested path (`\CurrentFilePath`) and inputs the cached buffer or, for the others, the file on disk.
fn prepare_overlays(
    root: &Path,
    cwd: &Path,
    ov_dir: &Path,
    buffers: &[Overlay],
) -> CmdResult<(String, HashMap<String, String>)> {
    let counts = if buffers.is_empty() { HashMap::new() } else { name_counts(root) };
    let mut code = String::new();
    let mut overlays = HashMap::new();
    let mut shared: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    for (i, buffer) in buffers.iter().enumerate() {
        let path = Path::new(&buffer.path);
        let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let ext = path.extension().map_or_else(|| "tex".into(), |e| e.to_string_lossy().into_owned());
        let requested = relative(cwd, path);
        let cached = ov_dir.join(format!("{i}.{ext}")).to_string_lossy().into_owned();
        if ![&name, &requested, &cached].iter().all(|s| tex_safe(s)) {
            continue; // TeX could misread the name: this file compiles from disk
        }
        fs::write(&cached, encode(&buffer.text, &buffer.encoding)?).map_err(err)?;
        overlays.insert(cached.clone(), buffer.path.clone());
        if counts.get(&name).copied().unwrap_or(0) > 1 {
            shared.entry(name).or_default().push((requested, cached));
        } else {
            code += &format!(r"\declare@file@substitution{{{name}}}{{{cached}}}");
        }
    }
    if !shared.is_empty() {
        code += DISPATCHER;
        let dir = ov_dir.join("shared");
        fs::create_dir_all(&dir).map_err(err)?;
        for (name, files) in shared {
            let dispatcher = dir.join(&name);
            fs::write(&dispatcher, r"\csname texeditor@dispatch\endcsname").map_err(err)?;
            code += &format!(r"\declare@file@substitution{{{name}}}{{{}}}", dispatcher.display());
            for (requested, cached) in files {
                code += &format!(r"\@namedef{{texeditor@src@{requested}}}{{\@@input {cached} }}");
                if !requested.starts_with("../") {
                    code += &format!(r"\@namedef{{texeditor@src@./{requested}}}{{\@@input {cached} }}");
                }
            }
        }
    }
    let pretex = if code.is_empty() { r"\relax".to_owned() } else { format!(r"\makeatletter{code}\makeatother") };
    Ok((pretex, overlays))
}

/// Inputs the cached buffer registered for the requested path, else the requested file itself (with the primitive
/// `\input`, which does not substitute again). latexmk hands this code to the shell inside double quotes, so it must not
/// contain `"`: file names end at a space instead (`tex_safe` names have none).
const DISPATCHER: &str = r"\def\texeditor@dispatch{\edef\texeditor@req{\if\relax\detokenize\expandafter{\CurrentFilePath}\relax\else\CurrentFilePath/\fi\CurrentFile}\@ifundefined{texeditor@src@\texeditor@req}{\@@input\texeditor@req\space}{\@nameuse{texeditor@src@\texeditor@req}}}";

/// Names that can go verbatim into TeX code.
fn tex_safe(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '+' | '/'))
}

/// How many files in the project carry each file name.
fn name_counts(root: &Path) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    let mut budget = 20_000;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if budget == 0 {
                return counts;
            }
            budget -= 1;
            if name.starts_with('.') {
                continue;
            }
            if entry.path().is_dir() {
                stack.push(entry.path());
            } else {
                *counts.entry(name).or_insert(0) += 1;
            }
        }
    }
    counts
}

/// `\include{chapters/one}` writes `chapters/one.aux` inside the output directory, which TeX does not create.
fn mirror_dirs(source: &Path, target: &Path) -> io::Result<()> {
    fs::create_dir_all(target)?;
    let mut budget = 2_000;
    let mut stack = vec![PathBuf::new()];
    while let Some(rel) = stack.pop() {
        let Ok(entries) = fs::read_dir(source.join(&rel)) else { continue };
        for entry in entries.flatten() {
            if budget == 0 || entry.file_name().to_string_lossy().starts_with('.') || !entry.path().is_dir() {
                continue;
            }
            budget -= 1;
            let rel = rel.join(entry.file_name());
            fs::create_dir_all(target.join(&rel))?;
            stack.push(rel);
        }
    }
    Ok(())
}

/// `path` relative to the directory `base` (both absolute), with `..` where needed.
fn relative(base: &Path, path: &Path) -> String {
    let base: Vec<_> = base.components().collect();
    let path: Vec<_> = path.components().collect();
    let common = base.iter().zip(&path).take_while(|(a, b)| a == b).count();
    let mut parts = vec!["..".to_owned(); base.len() - common];
    parts.extend(path[common..].iter().map(|c| c.as_os_str().to_string_lossy().into_owned()));
    parts.join("/")
}

/// Removes `.` and `..` components without touching the disk.
pub fn normalize(path: &Path) -> String {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out.to_string_lossy().into_owned()
}

fn tail(stdout: &[u8], stderr: &[u8]) -> String {
    let text = format!("{}\n{}", String::from_utf8_lossy(stdout), String::from_utf8_lossy(stderr));
    let lines: Vec<_> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(20)..].join("\n")
}

fn cache_dir(root: &str) -> CmdResult<PathBuf> {
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
        .ok_or("no cache directory")?;
    let mut hasher = DefaultHasher::new();
    root.hash(&mut hasher);
    Ok(base.join("tex-editor").join(format!("{:016x}", hasher.finish())))
}

pub fn find_in_path(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?).map(|dir| dir.join(name)).find(|p| p.is_file())
}

#[derive(Serialize)]
pub struct TexInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    distribution: Option<String>,
    tools: HashMap<&'static str, bool>,
}

#[tauri::command]
pub async fn detect_tex() -> TexInfo {
    let tools = ["latexmk", "pdflatex", "xelatex", "lualatex", "bibtex", "biber", "synctex"]
        .into_iter()
        .map(|tool| (tool, find_in_path(tool).is_some()))
        .collect();
    let distribution = Command::new("pdftex")
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).lines().next().map(distribution_name));
    TexInfo { distribution, tools }
}

/// "pdfTeX 3.14… (TeX Live 2023/Debian)" → "TeX Live 2023".
fn distribution_name(line: &str) -> String {
    let inner = line.rsplit_once('(').map_or(line, |(_, rest)| rest.trim_end_matches(')'));
    inner.split('/').next().unwrap_or(inner).trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        assert_eq!(relative(Path::new("/p/thesis"), Path::new("/p/thesis/ch/a.tex")), "ch/a.tex");
        assert_eq!(relative(Path::new("/p/thesis"), Path::new("/p/common/m.tex")), "../common/m.tex");
        assert_eq!(normalize(Path::new("/p/./thesis/../x.tex")), "/p/x.tex");
        assert!(tex_safe("chapters/cap_1.tex") && !tex_safe("my file.tex") && !tex_safe("a%b.tex"));
        assert_eq!(distribution_name("pdfTeX 3.141592653-2.6-1.40.25 (TeX Live 2023/Debian)"), "TeX Live 2023");
    }

    fn project(name: &str, files: &[(&str, &str)]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tex-editor-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        for (path, text) in files {
            let path = dir.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
        dir
    }

    fn overlay(path: &Path, text: &str) -> Overlay {
        Overlay { path: path.to_string_lossy().into_owned(), text: text.into(), encoding: "utf-8".into() }
    }

    #[test]
    fn unique_names_are_substituted_and_shared_names_dispatched() {
        let root = project("overlays", &[("main.tex", ""), ("a/intro.tex", ""), ("b/intro.tex", ""), ("c/only.tex", "")]);
        let ov = root.join(".cache-ov");
        fs::create_dir_all(&ov).unwrap();
        let buffers = [overlay(&root.join("c/only.tex"), "X"), overlay(&root.join("a/intro.tex"), "Y")];
        let (pretex, map) = prepare_overlays(&root, &root, &ov, &buffers).unwrap();
        let only = ov.join("0.tex").to_string_lossy().into_owned();
        assert!(pretex.contains(&format!(r"\declare@file@substitution{{only.tex}}{{{only}}}")));
        assert!(pretex.contains(r"\declare@file@substitution{intro.tex}"));
        assert!(pretex.contains(r"\@namedef{texeditor@src@a/intro.tex}") && pretex.contains(r"\@namedef{texeditor@src@./a/intro.tex}"));
        assert_eq!(map.get(&only).map(String::as_str), Some(root.join("c/only.tex").to_str().unwrap()));
        assert_eq!(fs::read_to_string(&only).unwrap(), "X");
        fs::remove_dir_all(&root).unwrap();
    }

    /// A real compile (needs latexmk and pdflatex; skipped without them): unsaved text reaches the PDF, a saved file
    /// with the same name as an unsaved one is read from disk, and the project folder is left untouched.
    #[test]
    fn compiles_unsaved_buffers_in_place() {
        if find_in_path("latexmk").is_none() || find_in_path("pdflatex").is_none() {
            eprintln!("skipped: latexmk or pdflatex not found");
            return;
        }
        let main = "\\documentclass{article}\\begin{document}\\input{a/intro}\\input{b/intro}\\input{c/only}\\end{document}";
        let root = project("e2e", &[("main.tex", main), ("a/intro.tex", "AA"), ("b/intro.tex", "BB"), ("c/only.tex", "CC")]);
        let request = CompileRequest {
            root: root.to_string_lossy().into_owned(),
            main: root.join("main.tex").to_string_lossy().into_owned(),
            engine: "pdflatex".into(),
            overlays: vec![
                overlay(&root.join("a/intro.tex"), "\\typeout{MARK-A-UNSAVED}"),
                overlay(&root.join("c/only.tex"), "\\typeout{MARK-C-UNSAVED}"),
            ],
            export: false,
        };
        let before: Vec<_> = fs::read_dir(&root).unwrap().flatten().map(|e| e.file_name()).collect();
        let result = run(&Slot::default(), 0, &request).unwrap();
        assert_eq!(result.status, "ok", "{}", result.log);
        assert!(result.log.contains("MARK-A-UNSAVED") && result.log.contains("MARK-C-UNSAVED"));
        assert!(result.log.contains("(./b/intro.tex") && !result.log.contains("(./a/intro.tex"), "b from disk, a from the buffer");
        assert!(result.pdf.is_some() && result.pdf_updated);
        let after: Vec<_> = fs::read_dir(&root).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(before.len(), after.len(), "nothing is written into the project folder");
        let _ = fs::remove_dir_all(cache_dir(&request.root).unwrap());
        fs::remove_dir_all(&root).unwrap();
    }

    /// latexmk sees no change on disk when a file first becomes unsaved; the compile must run anyway.
    #[test]
    fn recompiles_when_a_buffer_becomes_unsaved() {
        if find_in_path("latexmk").is_none() || find_in_path("pdflatex").is_none() {
            eprintln!("skipped: latexmk or pdflatex not found");
            return;
        }
        let saved = "\\documentclass{article}\\begin{document}Saved.\\end{document}";
        let root = project("dirty", &[("main.tex", saved)]);
        let main = root.join("main.tex");
        let mut request = CompileRequest {
            root: root.to_string_lossy().into_owned(),
            main: main.to_string_lossy().into_owned(),
            engine: "pdflatex".into(),
            overlays: vec![],
            export: false,
        };
        let slot = Slot::default();
        assert_eq!(run(&slot, 0, &request).unwrap().status, "ok");
        assert!(!run(&slot, 0, &request).unwrap().pdf_updated, "nothing changed: the compile is not forced");
        request.overlays = vec![overlay(&main, "\\documentclass{article}\\begin{document}\\typeout{MARK-TYPED}Typed.\\end{document}")];
        let result = run(&slot, 0, &request).unwrap();
        assert!(result.pdf_updated && result.log.contains("MARK-TYPED"), "{}", result.log);
        request.overlays.clear();
        let result = run(&slot, 0, &request).unwrap();
        assert!(result.pdf_updated && !result.log.contains("MARK-TYPED") && !result.log.contains("/ov/"), "{}", result.log);
        let _ = fs::remove_dir_all(cache_dir(&request.root).unwrap());
        fs::remove_dir_all(&root).unwrap();
    }
}
