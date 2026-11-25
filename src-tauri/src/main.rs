// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Claude Code hooks call this same executable to report a session's state
    // (see status.rs); answer and exit before any window is created.
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("--gc-hook") => return gian_claudio_lib::hook_main(&args[2..]),
        Some("--gc-statusline") => return gian_claudio_lib::statusline_main(&args[2..]),
        _ => {}
    }
    gian_claudio_lib::run()
}
