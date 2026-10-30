//! Source ↔ PDF positions through the `synctex` command-line tool. Coordinates are PDF points from the top-left
//! corner of the page, as SyncTeX reports them.
use crate::compile::Compiler;
use crate::files::{err, CmdResult};
use serde::Serialize;
use std::process::Command;

#[derive(Serialize, Debug, PartialEq)]
pub struct SyncBox {
    page: u32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct SourceLocation {
    path: String,
    line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    column: Option<u32>,
}

fn synctex(args: &[String]) -> CmdResult<String> {
    let output = Command::new("synctex").args(args).output().map_err(err)?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[tauri::command]
pub async fn synctex_forward(
    state: tauri::State<'_, Compiler>,
    root: String,
    pdf: String,
    path: String,
    line: u32,
    column: u32,
) -> CmdResult<Vec<SyncBox>> {
    let input = state.synctex_input(&root, &path);
    let output = synctex(&["view".into(), "-i".into(), format!("{line}:{column}:{input}"), "-o".into(), pdf])?;
    Ok(parse_view(&output))
}

#[tauri::command]
pub async fn synctex_inverse(
    state: tauri::State<'_, Compiler>,
    root: String,
    pdf: String,
    page: u32,
    x: f64,
    y: f64,
) -> CmdResult<Option<SourceLocation>> {
    let output = synctex(&["edit".into(), "-o".into(), format!("{page}:{x}:{y}:{pdf}")])?;
    Ok(parse_edit(&output).map(|loc| SourceLocation { path: state.project_path(&root, &loc.path), ..loc }))
}

#[derive(Default)]
struct Record {
    page: Option<u32>,
    h: Option<f64>,
    v: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
}

impl Record {
    /// `h` is the left edge and `v` the bottom of the box, so it spans `v − H … v`.
    fn into_box(self) -> Option<SyncBox> {
        let height = self.height.unwrap_or(0.0);
        Some(SyncBox { page: self.page?, x: self.h?, y: self.v? - height, width: self.width.unwrap_or(0.0), height })
    }
}

/// The boxes of `synctex view`: one record per `Output:` line.
pub fn parse_view(text: &str) -> Vec<SyncBox> {
    let mut boxes = Vec::new();
    let mut record = Record::default();
    for line in text.lines() {
        let Some((key, value)) = line.split_once(':') else { continue };
        match key {
            "Output" => boxes.extend(std::mem::take(&mut record).into_box()),
            "Page" => record.page = value.parse().ok(),
            "h" => record.h = value.parse().ok(),
            "v" => record.v = value.parse().ok(),
            "W" => record.width = value.parse().ok(),
            "H" => record.height = value.parse().ok(),
            _ => {}
        }
    }
    boxes.extend(record.into_box());
    boxes
}

/// The first source location of `synctex edit`.
pub fn parse_edit(text: &str) -> Option<SourceLocation> {
    let (mut path, mut line, mut column) = (None, None, None);
    for l in text.lines() {
        match l.split_once(':') {
            Some(("Input", v)) if path.is_none() => path = Some(v.to_owned()),
            Some(("Line", v)) if line.is_none() => line = v.parse::<u32>().ok(),
            Some(("Column", v)) if column.is_none() => column = v.parse::<i64>().ok(),
            _ => {}
        }
    }
    let column = column.and_then(|c| u32::try_from(c).ok()).filter(|&c| c > 0);
    Some(SourceLocation { path: path?, line: line.filter(|&l| l > 0)?, column })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_view_records() {
        let out = "This is SyncTeX command line utility, version 1.5\nSyncTeX result begin\nOutput:/c/main.pdf\nPage:1\n\
                   x:245.57\ny:134.76\nh:133.75\nv:137.25\nW:343.5\nH:9.75\nbefore:\noffset:0\nOutput:/c/main.pdf\n\
                   Page:2\nh:10\nv:20\nW:5\nH:4\nSyncTeX result end\n";
        assert_eq!(
            parse_view(out),
            vec![
                SyncBox { page: 1, x: 133.75, y: 127.5, width: 343.5, height: 9.75 },
                SyncBox { page: 2, x: 10.0, y: 16.0, width: 5.0, height: 4.0 },
            ]
        );
        assert!(parse_view("SyncTeX ERROR: no result").is_empty());
    }

    #[test]
    fn parses_edit_record() {
        let out = "SyncTeX result begin\nOutput:/c/main.pdf\nInput:/p/./sections/intro.tex\nLine:12\nColumn:-1\n\
                   Offset:0\nContext:\nSyncTeX result end\n";
        assert_eq!(parse_edit(out), Some(SourceLocation { path: "/p/./sections/intro.tex".into(), line: 12, column: None }));
        assert_eq!(parse_edit("SyncTeX result begin\nSyncTeX result end\n"), None);
    }
}
