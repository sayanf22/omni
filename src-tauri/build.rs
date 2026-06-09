fn main() {
    if std::env::var("SKIP_TAURI_BUILD").is_err() {
        tauri_build::build();
    }
}
