//! Version control through the system's `git`, so every remote (GitHub, GitLab, a local or network folder) and every
//! credential the user already set up (SSH keys and agents, credential helpers, `gh auth`) just works; Tex stores no
//! secrets. Git runs without a terminal: a missing credential fails the call instead of waiting for a prompt.
use crate::files::{err, write_atomic, CmdResult};
use serde::Serialize;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Output, Stdio};

#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// None on a detached HEAD.
    branch: Option<String>,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    has_remote: bool,
    /// A pull stopped on conflicts: the next commit concludes the merge.
    merging: bool,
    changes: Vec<GitChange>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct GitChange {
    /// Absolute.
    path: String,
    /// The two-letter code of `git status --porcelain` (`M `, ` M`, `??`, `UU`…).
    code: String,
}

fn output(dir: &Path, args: &[&str]) -> CmdResult<Output> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // A session of its own has no controlling terminal, so ssh cannot ask for a passphrase on the one Tex was started
    // from (it uses an agent or a graphical askpass, or fails).
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    command.output().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => "git was not found. Install it: sudo apt install git".into(),
        _ => err(e),
    })
}

/// Stdout on success, else git's message (conflicts are reported on stdout).
fn git(dir: &Path, args: &[&str]) -> CmdResult<String> {
    let out = output(dir, args)?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim_end().to_owned();
    if out.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_owned();
    Err([stdout.trim(), &stderr].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n"))
}

/// None when the folder is not in a repository.
#[tauri::command]
pub async fn git_status(root: String) -> CmdResult<Option<GitStatus>> {
    let root = Path::new(&root);
    let Ok(top) = git(root, &["rev-parse", "--show-toplevel"]) else {
        return Ok(None);
    };
    let porcelain = git(root, &["status", "--porcelain=v1", "--branch", "--untracked-files=all", "-z"])?;
    let mut status = parse_status(&porcelain, &top);
    status.has_remote = !git(root, &["remote"])?.is_empty();
    status.merging = git(root, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_ok();
    Ok(Some(status))
}

fn parse_status(porcelain: &str, top: &str) -> GitStatus {
    let mut status = GitStatus::default();
    let mut entries = porcelain.split('\0').filter(|e| !e.is_empty());
    while let Some(entry) = entries.next() {
        if let Some(head) = entry.strip_prefix("## ") {
            parse_branch(head, &mut status);
            continue;
        }
        let (Some(code), Some(path)) = (entry.get(..2), entry.get(3..)) else { continue };
        if code.starts_with(['R', 'C']) {
            entries.next(); // the original path of a rename or copy
        }
        status.changes.push(GitChange { path: format!("{top}/{path}"), code: code.to_owned() });
    }
    status
}

/// `main...origin/main [ahead 1, behind 2]`, `main`, `No commits yet on main` or `HEAD (no branch)`.
fn parse_branch(head: &str, status: &mut GitStatus) {
    let head = head.strip_prefix("No commits yet on ").or_else(|| head.strip_prefix("Initial commit on ")).unwrap_or(head);
    let (names, counts) = head.split_once(" [").map_or((head, ""), |(n, c)| (n, c.trim_end_matches(']')));
    let (branch, upstream) = names.split_once("...").map_or((names, None), |(b, u)| (b, Some(u)));
    status.branch = (!branch.starts_with("HEAD (")).then(|| branch.to_owned());
    status.upstream = upstream.map(str::to_owned);
    for part in counts.split(", ") {
        if let Some(n) = part.strip_prefix("ahead ") {
            status.ahead = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            status.behind = n.parse().unwrap_or(0);
        }
    }
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Commit {
    hash: String,
    parents: Vec<String>,
    author: String,
    /// Unix seconds.
    time: i64,
    /// Branches and tags pointing here (`main`, `origin/main`, `tag: v1`).
    refs: Vec<String>,
    subject: String,
}

/// The newest 100 commits of HEAD, children before parents (none before the first commit).
#[tauri::command]
pub async fn git_log(root: String) -> CmdResult<Vec<Commit>> {
    let root = Path::new(&root);
    if git(root, &["rev-parse", "-q", "--verify", "HEAD"]).is_err() {
        return Ok(Vec::new());
    }
    let log = git(root, &["log", "--topo-order", "-n", "100", "--format=%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s%x1e", "HEAD"])?;
    Ok(parse_log(&log))
}

fn parse_log(log: &str) -> Vec<Commit> {
    log.split('\x1e')
        .filter_map(|record| {
            let mut fields = record.trim_start_matches('\n').split('\x1f');
            Some(Commit {
                hash: fields.next()?.to_owned(),
                parents: fields.next()?.split_whitespace().map(str::to_owned).collect(),
                author: fields.next()?.to_owned(),
                time: fields.next()?.parse().ok()?,
                refs: fields
                    .next()?
                    .split(", ")
                    .filter(|r| !r.is_empty() && *r != "HEAD" && !r.ends_with("/HEAD"))
                    .map(|r| r.trim_start_matches("HEAD -> ").to_owned())
                    .collect(),
                subject: fields.next()?.to_owned(),
            })
        })
        .collect()
}

#[derive(Serialize, Debug, PartialEq)]
pub struct CommitDetails {
    /// The whole message.
    message: String,
    /// What the commit changed (a merge: what it brought into its first parent).
    files: Vec<GitChange>,
}

#[tauri::command]
pub async fn git_show(root: String, hash: String) -> CmdResult<CommitDetails> {
    if hash.is_empty() || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("this is not a commit".into());
    }
    let root = Path::new(&root);
    let top = git(root, &["rev-parse", "--show-toplevel"])?;
    let message = git(root, &["log", "-1", "--format=%B", &hash])?.trim().to_owned();
    let diff = git(root, &["diff-tree", "--no-commit-id", "-r", "--root", "--name-status", "-z", "--diff-merges=first-parent", &hash])?;
    Ok(CommitDetails { message, files: parse_name_status(&diff, &top) })
}

/// `M\0a.tex\0R100\0old.tex\0new.tex\0`: a status letter (renames and copies add a similarity and the new name).
fn parse_name_status(diff: &str, top: &str) -> Vec<GitChange> {
    let mut files = Vec::new();
    let mut fields = diff.split('\0').filter(|f| !f.is_empty());
    while let (Some(status), Some(mut path)) = (fields.next(), fields.next()) {
        if status.starts_with(['R', 'C']) {
            path = fields.next().unwrap_or(path);
        }
        files.push(GitChange { path: format!("{top}/{path}"), code: status[..1].to_owned() });
    }
    files
}

/// Build artifacts other tools leave in LaTeX folders, for a new repository (Tex itself compiles into its cache).
const GITIGNORE: &str = "*.aux\n*.log\n*.synctex.gz\n*.synctex\n*.fls\n*.fdb_latexmk\n*.out\n*.toc\n*.lof\n*.lot\n*.bbl\n*.blg\n\
*.bcf\n*.run.xml\n*.nav\n*.snm\n*.vrb\n*.xdv\n*.idx\n*.ilg\n*.ind\n";

#[tauri::command]
pub async fn git_init(root: String) -> CmdResult<()> {
    let root = Path::new(&root);
    git(root, &["init"])?;
    let ignore = root.join(".gitignore");
    if !ignore.exists() {
        write_atomic(&ignore, GITIGNORE.as_bytes()).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn git_add_remote(root: String, url: String) -> CmdResult<()> {
    git(Path::new(&root), &["remote", "add", "origin", &url]).map(drop)
}

/// Stages everything (new, changed and deleted files) and commits it.
#[tauri::command]
pub async fn git_commit(root: String, message: String) -> CmdResult<()> {
    let root = Path::new(&root);
    git(root, &["add", "--all"])?;
    git(root, &["commit", "--quiet", "--message", &message]).map(drop)
}

/// Clears every change, new files included, into a stash (`git stash pop` brings it back); during a merge, cancels it.
#[tauri::command]
pub async fn git_discard(root: String) -> CmdResult<()> {
    let root = Path::new(&root);
    if git(root, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_ok() {
        return git(root, &["merge", "--abort"]).map(drop);
    }
    git(root, &["stash", "push", "--include-untracked", "--message", "Discarded in Tex"]).map(drop)
}

/// The first push of a branch sets its upstream on the first remote.
#[tauri::command]
pub async fn git_push(root: String) -> CmdResult<()> {
    let root = Path::new(&root);
    if git(root, &["rev-parse", "--abbrev-ref", "@{upstream}"]).is_ok() {
        return git(root, &["push"]).map(drop);
    }
    let remotes = git(root, &["remote"])?;
    let remote = remotes.lines().next().ok_or("this repository has no remote")?;
    git(root, &["push", "--set-upstream", remote, "HEAD"]).map(drop)
}

/// A merge, not a rebase: on conflicts the files keep the markers, and a commit concludes the merge.
#[tauri::command]
pub async fn git_pull(root: String) -> CmdResult<()> {
    git(Path::new(&root), &["pull", "--no-rebase", "--no-edit"]).map(drop)
}

/// Clones into a new folder of `parent` named after the repository, and returns that folder.
#[tauri::command]
pub async fn git_clone(url: String, parent: String) -> CmdResult<String> {
    let name = repository_name(&url).ok_or("this is not a repository address")?;
    let target = Path::new(&parent).join(name);
    if target.exists() {
        return Err(format!("“{}” already exists", target.display()));
    }
    git(Path::new(&parent), &["clone", "--quiet", "--", &url, &target.to_string_lossy()])?;
    Ok(target.to_string_lossy().into_owned())
}

/// `https://github.com/me/thesis.git`, `git@gitlab.com:me/thesis` and `/srv/git/thesis.git/` are all `thesis`.
fn repository_name(url: &str) -> Option<&str> {
    let last = url.trim().trim_end_matches('/').rsplit(['/', ':']).next()?;
    let name = last.strip_suffix(".git").unwrap_or(last);
    (!name.is_empty() && name != "." && name != "..").then_some(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::async_runtime::block_on as rt;

    #[test]
    fn parses_branches() {
        let mut s = GitStatus::default();
        parse_branch("main...origin/main [ahead 1, behind 2]", &mut s);
        assert_eq!((s.branch.as_deref(), s.upstream.as_deref(), s.ahead, s.behind), (Some("main"), Some("origin/main"), 1, 2));
        let mut s = GitStatus::default();
        parse_branch("No commits yet on main", &mut s);
        assert_eq!((s.branch.as_deref(), s.upstream), (Some("main"), None));
        let mut s = GitStatus::default();
        parse_branch("HEAD (no branch)", &mut s);
        assert_eq!(s.branch, None);
        let mut s = GitStatus::default();
        parse_branch("main...origin/main [gone]", &mut s);
        assert_eq!((s.ahead, s.behind), (0, 0));
    }

    #[test]
    fn parses_changes() {
        let s = parse_status("## main\0 M a.tex\0?? fig/b.png\0R  new.tex\0old.tex\0UU c.tex\0", "/p");
        let changes: Vec<_> = s.changes.iter().map(|c| (c.code.as_str(), c.path.as_str())).collect();
        assert_eq!(changes, [(" M", "/p/a.tex"), ("??", "/p/fig/b.png"), ("R ", "/p/new.tex"), ("UU", "/p/c.tex")]);
    }

    #[test]
    fn parses_log_and_files() {
        let log = "c\x1fa b\x1fToni\x1f1700000000\x1fHEAD -> main, origin/main, origin/HEAD\x1fMerge\x1e\na\x1f\x1fAna\x1f1600000000\x1f\x1fFirst\x1e";
        let commits = parse_log(log);
        assert_eq!(commits.len(), 2);
        assert_eq!((commits[0].parents.len(), commits[0].refs.join(",")), (2, "main,origin/main".into()));
        assert_eq!((commits[1].parents.len(), commits[1].refs.len(), commits[1].subject.as_str()), (0, 0, "First"));
        let files = parse_name_status("M\0a.tex\0R100\0old.tex\0new.tex\0D\0b.bib\0", "/p");
        let files: Vec<_> = files.iter().map(|f| (f.code.as_str(), f.path.as_str())).collect();
        assert_eq!(files, [("M", "/p/a.tex"), ("R", "/p/new.tex"), ("D", "/p/b.bib")]);
    }

    #[test]
    fn names_repositories() {
        assert_eq!(repository_name("https://github.com/me/thesis.git"), Some("thesis"));
        assert_eq!(repository_name("git@gitlab.com:me/thesis"), Some("thesis"));
        assert_eq!(repository_name("/srv/git/thesis.git/"), Some("thesis"));
        assert_eq!(repository_name("https://example.com/"), Some("example.com"));
        assert_eq!(repository_name(".."), None);
    }

    #[test]
    fn commits_and_pulls_between_clones() {
        let base = std::env::temp_dir().join(format!("tex-editor-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let run = |dir: &Path, args: &[&str]| git(dir, args).unwrap();
        run(&base, &["init", "--quiet", "--bare", "origin.git"]);
        let s = |p: &Path| p.to_string_lossy().into_owned();
        let a = Path::new(&rt(git_clone(s(&base.join("origin.git")), s(&base))).unwrap()).to_path_buf();
        assert_eq!(a, base.join("origin"));
        run(&a, &["config", "user.name", "Test"]);
        run(&a, &["config", "user.email", "test@example.com"]);
        std::fs::write(a.join("main.tex"), "one\n").unwrap();
        let status = rt(git_status(s(&a))).unwrap().unwrap();
        assert!(status.has_remote);
        assert_eq!(status.changes[0].code, "??");
        rt(git_commit(s(&a), "First".into())).unwrap();
        rt(git_push(s(&a))).unwrap();
        let b = base.join("b");
        run(&base, &["clone", "--quiet", "origin.git", "b"]);
        std::fs::write(a.join("main.tex"), "two\n").unwrap();
        rt(git_commit(s(&a), "Second".into())).unwrap();
        rt(git_push(s(&a))).unwrap();
        rt(git_pull(s(&b))).unwrap();
        assert_eq!(std::fs::read_to_string(b.join("main.tex")).unwrap(), "two\n");
        let log = rt(git_log(s(&b))).unwrap();
        assert_eq!(log.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["Second", "First"]);
        let details = rt(git_show(s(&b), log[0].hash.clone())).unwrap();
        assert_eq!((details.message.as_str(), details.files[0].code.as_str()), ("Second", "M"));
        assert!(rt(git_show(s(&b), "--help".into())).is_err());
        run(&b, &["config", "user.name", "Test"]);
        run(&b, &["config", "user.email", "test@example.com"]);
        std::fs::write(b.join("main.tex"), "three\n").unwrap();
        std::fs::write(b.join("new.tex"), "new\n").unwrap();
        rt(git_discard(s(&b))).unwrap();
        assert_eq!(std::fs::read_to_string(b.join("main.tex")).unwrap(), "two\n");
        assert!(!b.join("new.tex").exists());
        run(&b, &["stash", "pop", "--quiet"]);
        assert_eq!(std::fs::read_to_string(b.join("main.tex")).unwrap(), "three\n", "the discarded changes come back");
        assert!(b.join("new.tex").exists());
        // A pull that stops on a conflict is aborted, back to b's own commit.
        std::fs::remove_file(b.join("new.tex")).unwrap();
        rt(git_commit(s(&b), "Three".into())).unwrap();
        std::fs::write(a.join("main.tex"), "four\n").unwrap();
        rt(git_commit(s(&a), "Four".into())).unwrap();
        rt(git_push(s(&a))).unwrap();
        assert!(rt(git_pull(s(&b))).is_err());
        assert!(rt(git_status(s(&b))).unwrap().unwrap().merging);
        rt(git_discard(s(&b))).unwrap();
        assert!(!rt(git_status(s(&b))).unwrap().unwrap().merging);
        assert_eq!(std::fs::read_to_string(b.join("main.tex")).unwrap(), "three\n");
        assert_eq!(rt(git_status(s(&base))).unwrap(), None, "not a repository");
        std::fs::remove_dir_all(&base).unwrap();
    }
}
