use serde::{Serialize, Deserialize};
use std::path::PathBuf;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextW, IsWindowVisible, GetWindowThreadProcessId,
    SetForegroundWindow, ShowWindow, SW_RESTORE,
};
use windows::Win32::Foundation::{HWND, LPARAM, BOOL};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppInfo {
    pub name: String,
    pub hwnd: isize,
    pub pid: u32,
    pub exe_name: String,
}

// ── Window enumeration ────────────────────────────────────────────────────────

unsafe extern "system" fn enum_windows_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let list = &mut *(lparam.0 as *mut Vec<AppInfo>);
    if IsWindowVisible(hwnd).as_bool() {
        let mut text = [0u16; 512];
        let len = GetWindowTextW(hwnd, &mut text);
        if len > 0 {
            let title = String::from_utf16_lossy(&text[..len as usize]);
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            list.push(AppInfo { name: title, hwnd: hwnd.0 as isize, pid, exe_name: String::new() });
        }
    }
    BOOL::from(true)
}

/// All running visible windows with titles.
pub fn list_running_apps_internal() -> Vec<AppInfo> {
    let mut list = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(enum_windows_callback), LPARAM(&mut list as *mut _ as isize));
    }
    list
}

// ── App name → known AUMID mapping ───────────────────────────────────────────
// AUMIDs are the "Application User Model IDs" that Windows uses to launch Store
// (UWP/MSIX) apps. Format: <PackageFamilyName>!<AppId>.
// Launch via: explorer.exe shell:AppsFolder\<AUMID>
// Source: official Microsoft docs + commonly installed app list.

fn known_aumid(name_lower: &str) -> Option<&'static str> {
    // Common keyword → AUMID mappings for frequently used Store apps.
    // More can be discovered at runtime via PowerShell (see find_uwp_aumid).
    let table: &[(&str, &str)] = &[
        // Messaging
        ("whatsapp",         "5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App"),
        ("telegram",         "TelegramMessengerLLP.TelegramDesktop_t4vj0pshhgkwm!TelegramDesktop"),
        ("signal",           "AnonTech.Signal_n3g3n4e36d6ca!Signal"),
        ("discord",          "Discord.Discord_rd9xb7m6bkpnm!Discord"),
        ("slack",            "91750D7E.Slack_8she8kybcnzb4!Slack"),
        ("teams",            "MicrosoftTeams_8wekyb3d8bbwe!MicrosoftTeams"),
        // Social
        ("twitter",          "Twitter.Twitter_8wekyb3d8bbwe!Twitter"),
        ("instagram",        "Instagram.Instagram_8xx8rvfyw5nnt!Instagram"),
        ("facebook",         "Facebook.Facebook_8xx8rvfyw5nnt!Facebook"),
        ("linkedin",         "LinkedIn.LinkedIn_8wekyb3d8bbwe!LinkedIn"),
        ("snapchat",         "Snapchat.SnapchatApp_8wekyb3d8bbwe!SnapchatApp"),
        ("tiktok",           "ByteDance.TikTok_hz3teg2dcsnhe!TikTokApp"),
        // Productivity
        ("onenote",          "Microsoft.Office.OneNote_8wekyb3d8bbwe!microsoft.onenoteim"),
        ("todo",             "Microsoft.Todos_8wekyb3d8bbwe!App"),
        ("ms-todo",          "Microsoft.Todos_8wekyb3d8bbwe!App"),
        ("sticky notes",     "Microsoft.MicrosoftStickyNotes_8wekyb3d8bbwe!App"),
        ("sticky",           "Microsoft.MicrosoftStickyNotes_8wekyb3d8bbwe!App"),
        ("alarms",           "Microsoft.WindowsAlarms_8wekyb3d8bbwe!App"),
        ("calculator",       "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"),
        ("calendar",         "microsoft.windowscommunicationsapps_8wekyb3d8bbwe!microsoft.windowslive.calendar"),
        ("mail",             "microsoft.windowscommunicationsapps_8wekyb3d8bbwe!microsoft.windowslive.mail"),
        ("maps",             "Microsoft.WindowsMaps_8wekyb3d8bbwe!App"),
        ("weather",          "Microsoft.BingWeather_8wekyb3d8bbwe!App"),
        ("news",             "Microsoft.BingNews_8wekyb3d8bbwe!AppexNews"),
        // Media & Entertainment
        ("spotify",          "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"),
        ("netflix",          "4DF9E0F8.Netflix_mcm4njqhnhss8!Netflix"),
        ("amazon prime",     "AmazonVideo.PrimeVideo_pwbj9vvecjh7j!App"),
        ("prime video",      "AmazonVideo.PrimeVideo_pwbj9vvecjh7j!App"),
        ("youtube",          ""), // YouTube is web-only; no Store app AUMID
        ("photos",           "Microsoft.Windows.Photos_8wekyb3d8bbwe!App"),
        ("movies & tv",      "Microsoft.ZuneVideo_8wekyb3d8bbwe!Microsoft.ZuneVideo"),
        ("groove",           "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"),
        ("xbox",             "Microsoft.XboxApp_8wekyb3d8bbwe!Microsoft.XboxApp"),
        ("game bar",         "Microsoft.XboxGamingOverlay_8wekyb3d8bbwe!App"),
        // Utilities
        ("settings",         "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel"),
        ("store",            "Microsoft.WindowsStore_8wekyb3d8bbwe!App"),
        ("ms store",         "Microsoft.WindowsStore_8wekyb3d8bbwe!App"),
        ("windows store",    "Microsoft.WindowsStore_8wekyb3d8bbwe!App"),
        ("camera",           "Microsoft.WindowsCamera_8wekyb3d8bbwe!App"),
        ("clock",            "Microsoft.WindowsAlarms_8wekyb3d8bbwe!App"),
        ("phone link",       "Microsoft.YourPhone_8wekyb3d8bbwe!App"),
        ("your phone",       "Microsoft.YourPhone_8wekyb3d8bbwe!App"),
        ("snipping tool",    "Microsoft.ScreenSketch_8wekyb3d8bbwe!App"),
        ("screen sketch",    "Microsoft.ScreenSketch_8wekyb3d8bbwe!App"),
        ("paint 3d",         "Microsoft.MSPaint_8wekyb3d8bbwe!Microsoft.MSPaint"),
        ("3d paint",         "Microsoft.MSPaint_8wekyb3d8bbwe!Microsoft.MSPaint"),
    ];

    for (keyword, aumid) in table {
        if name_lower.contains(keyword) {
            if aumid.is_empty() {
                return None; // Web-only app — no AUMID
            }
            return Some(aumid);
        }
    }
    None
}

/// Known exe names for popular non-Store apps, keyed by common nickname.
fn known_exe(name_lower: &str) -> Option<PathBuf> {
    // Hardcoded high-priority lookups for apps that are always in the same place
    // or discoverable via PATH.
    if name_lower.contains("chrome") {
        let candidates = [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        ];
        for c in &candidates {
            if std::path::Path::new(c).exists() { return Some(PathBuf::from(c)); }
        }
    }
    if name_lower.contains("edge") || name_lower.contains("msedge") {
        let p = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe";
        if std::path::Path::new(p).exists() { return Some(PathBuf::from(p)); }
    }
    if name_lower.contains("firefox") {
        let candidates = [
            r"C:\Program Files\Mozilla Firefox\firefox.exe",
            r"C:\Program Files (x86)\Mozilla Firefox\firefox.exe",
        ];
        for c in &candidates {
            if std::path::Path::new(c).exists() { return Some(PathBuf::from(c)); }
        }
    }
    if name_lower.contains("brave") {
        let candidates = [
            r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
            r"C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe",
        ];
        for c in &candidates {
            if std::path::Path::new(c).exists() { return Some(PathBuf::from(c)); }
        }
    }
    if name_lower == "notepad" || name_lower.contains("notepad") {
        return Some(PathBuf::from(r"C:\Windows\System32\notepad.exe"));
    }
    if name_lower == "wordpad" {
        return Some(PathBuf::from(r"C:\Program Files\Windows NT\Accessories\wordpad.exe"));
    }
    if name_lower.contains("paint") && !name_lower.contains("3d") {
        return Some(PathBuf::from(r"C:\Windows\System32\mspaint.exe"));
    }
    if name_lower == "cmd" || name_lower.contains("command prompt") {
        return Some(PathBuf::from(r"C:\Windows\System32\cmd.exe"));
    }
    if name_lower.contains("powershell") {
        return Some(PathBuf::from(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"));
    }
    if name_lower.contains("explorer") || name_lower == "files" || name_lower.contains("file explorer") {
        return Some(PathBuf::from(r"C:\Windows\explorer.exe"));
    }
    if name_lower.contains("task manager") {
        return Some(PathBuf::from(r"C:\Windows\System32\Taskmgr.exe"));
    }
    if name_lower.contains("vscode") || name_lower == "code" || name_lower.contains("visual studio code") {
        // VS Code is usually in AppData\Local\Programs
        let local = dirs::data_local_dir().unwrap_or_default();
        let p = local.join(r"Programs\Microsoft VS Code\Code.exe");
        if p.exists() { return Some(p); }
    }
    if name_lower.contains("cursor") {
        let local = dirs::data_local_dir().unwrap_or_default();
        let p = local.join(r"Programs\cursor\Cursor.exe");
        if p.exists() { return Some(p); }
    }
    if name_lower.contains("winrar") {
        let p = PathBuf::from(r"C:\Program Files\WinRAR\WinRAR.exe");
        if p.exists() { return Some(p); }
    }
    if name_lower.contains("7-zip") || name_lower == "7zip" {
        let p = PathBuf::from(r"C:\Program Files\7-Zip\7zFM.exe");
        if p.exists() { return Some(p); }
    }
    if name_lower.contains("vlc") {
        let candidates = [
            r"C:\Program Files\VideoLAN\VLC\vlc.exe",
            r"C:\Program Files (x86)\VideoLAN\VLC\vlc.exe",
        ];
        for c in &candidates {
            if std::path::Path::new(c).exists() { return Some(PathBuf::from(c)); }
        }
    }
    if name_lower.contains("zoom") {
        let local = dirs::data_local_dir().unwrap_or_default();
        let p = local.join(r"Zoom\bin\Zoom.exe");
        if p.exists() { return Some(p); }
    }
    if name_lower.contains("obs") {
        let candidates = [
            r"C:\Program Files\obs-studio\bin\64bit\obs64.exe",
            r"C:\Program Files (x86)\obs-studio\bin\32bit\obs32.exe",
        ];
        for c in &candidates {
            if std::path::Path::new(c).exists() { return Some(PathBuf::from(c)); }
        }
    }
    if name_lower.contains("steam") {
        let candidates = [
            r"C:\Program Files (x86)\Steam\steam.exe",
            r"C:\Program Files\Steam\steam.exe",
        ];
        for c in &candidates {
            if std::path::Path::new(c).exists() { return Some(PathBuf::from(c)); }
        }
    }
    if name_lower.contains("word") && !name_lower.contains("wordpad") {
        for version in ["Office16", "Office15", "root"] {
            let p = PathBuf::from(format!(r"C:\Program Files\Microsoft Office\{}\WINWORD.EXE", version));
            if p.exists() { return Some(p); }
        }
    }
    if name_lower.contains("excel") {
        for version in ["Office16", "Office15", "root"] {
            let p = PathBuf::from(format!(r"C:\Program Files\Microsoft Office\{}\EXCEL.EXE", version));
            if p.exists() { return Some(p); }
        }
    }
    if name_lower.contains("powerpoint") {
        for version in ["Office16", "Office15", "root"] {
            let p = PathBuf::from(format!(r"C:\Program Files\Microsoft Office\{}\POWERPNT.EXE", version));
            if p.exists() { return Some(p); }
        }
    }
    None
}

/// Try to discover the AUMID of a UWP/MSIX app at runtime using PowerShell.
/// This finds ANY installed Store app by searching its package display name,
/// not just the ones in our static table.
fn find_uwp_aumid(name_lower: &str) -> Option<String> {
    // PowerShell one-liner: list all packages + their app IDs, filter by name.
    // This is the same method Windows itself uses in Get-AppxPackage.
    let ps_script = format!(
        r#"$n='{name}'; \
        Get-AppxPackage | Where-Object {{ $_.Name -match $n -or $_.PackageFullName -match $n }} | \
        ForEach-Object {{ \
            $pkg = $_; \
            try {{ \
                (Get-AppxPackageManifest $pkg).Package.Applications.Application | \
                ForEach-Object {{ \
                    Write-Output ('{{}}'.Replace('{{}}', ($pkg.PackageFamilyName + '!' + $_.Id))) \
                }} \
            }} catch {{}} \
        }} | Select-Object -First 1"#,
        name = name_lower.replace('\'', "")
    );

    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps_script])
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() || !stdout.contains('!') {
        return None;
    }
    Some(stdout)
}

/// Search installed .exe apps by scanning common directories (non-Store apps
/// not covered by the known_exe table).
fn search_exe_in_dirs(name_lower: &str) -> Option<PathBuf> {
    // Directories where non-Store apps commonly install
    let mut search_roots: Vec<PathBuf> = vec![
        PathBuf::from(r"C:\Program Files"),
        PathBuf::from(r"C:\Program Files (x86)"),
    ];
    // Add user-local programs dir (Cursor, VS Code, etc.)
    if let Some(local) = dirs::data_local_dir() {
        search_roots.push(local.join("Programs"));
    }
    // User's desktop shortcuts sometimes point here
    if let Some(home) = dirs::home_dir() {
        search_roots.push(home.join("Desktop"));
        search_roots.push(home.join("AppData\\Local\\Programs"));
    }

    for root in &search_roots {
        if !root.exists() { continue; }
        // Only look one level deep (immediate subdirectories) to keep it fast
        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten() {
                let dir = entry.path();
                if !dir.is_dir() { continue; }
                // Check for an .exe matching the name inside this subdirectory
                if let Ok(sub_entries) = std::fs::read_dir(&dir) {
                    for sub in sub_entries.flatten() {
                        let path = sub.path();
                        if path.is_file()
                            && path.extension().map_or(false, |e| e.eq_ignore_ascii_case("exe"))
                        {
                            let stem = path
                                .file_stem()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .to_lowercase();
                            if stem.contains(name_lower) || name_lower.contains(&stem) {
                                return Some(path);
                            }
                        }
                    }
                }
                // Also check if the directory name matches
                let dir_name = dir
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase();
                if dir_name.contains(name_lower) {
                    // Look for any .exe inside it
                    if let Ok(sub_entries) = std::fs::read_dir(&dir) {
                        for sub in sub_entries.flatten() {
                            let path = sub.path();
                            if path.is_file()
                                && path.extension().map_or(false, |e| e.eq_ignore_ascii_case("exe"))
                            {
                                return Some(path);
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

/// Try launching via PATH (apps like `git`, `python`, `node`, `code`, etc.)
fn launch_via_path(name: &str) -> anyhow::Result<u32> {
    let child = std::process::Command::new(name)
        .spawn()
        .map_err(|e| anyhow::anyhow!("Not found in PATH: {}", e))?;
    Ok(child.id())
}

/// Check if a Store app with the given PackageFamilyName is actually installed.
/// Extracts the PFN from an AUMID (everything before the '!').
/// Uses a simple in-process cache so the PowerShell check only runs ONCE per PFN per session.
fn is_uwp_installed(aumid: &str) -> bool {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    static CACHE: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));

    // AUMID format: PackageFamilyName!AppId
    let pfn = match aumid.split('!').next() {
        Some(p) => p.to_string(),
        None => return false,
    };

    // Return cached result immediately if we've checked before
    if let Ok(map) = cache.lock() {
        if let Some(&result) = map.get(&pfn) {
            return result;
        }
    }

    // PowerShell check — only runs once per PFN per session
    let script = format!(
        "if (Get-AppxPackage | Where-Object {{$_.PackageFamilyName -eq '{}'}}) {{ Write-Output 'yes' }} else {{ Write-Output 'no' }}",
        pfn.replace('\'', "")
    );
    let result = match std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
    {
        Ok(out) => {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_lowercase();
            s == "yes"
        }
        Err(_) => true, // If PowerShell fails, assume installed and try anyway
    };

    // Cache the result
    if let Ok(mut map) = cache.lock() {
        map.insert(pfn, result);
    }
    result
}

/// Launch a Store/UWP app by AUMID using `explorer.exe shell:AppsFolder\<AUMID>`.
/// Checks installation first so we can return a meaningful error if not installed.
/// This is the official Microsoft-recommended way to launch packaged apps.
fn launch_uwp(aumid: &str) -> anyhow::Result<u32> {
    // Pre-flight: verify the app is actually installed.
    // explorer.exe always returns Ok(pid) even when the AUMID doesn't exist,
    // so without this check we'd silently do nothing.
    if !is_uwp_installed(aumid) {
        return Err(anyhow::anyhow!(
            "App not installed (AUMID: {}). \
             This app is not installed on this PC.",
            aumid
        ));
    }
    let target = format!("shell:AppsFolder\\{}", aumid);
    let child = std::process::Command::new("explorer.exe")
        .arg(&target)
        .spawn()
        .map_err(|e| anyhow::anyhow!("Failed to launch UWP app '{}': {}", aumid, e))?;
    Ok(child.id())
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Find the best-matching Start Menu .lnk shortcut path for an app name.
/// Launching the shortcut is the most reliable universal method — Windows
/// resolves it correctly for BOTH Store and desktop apps.
fn find_start_menu_shortcut(name_lower: &str) -> Option<PathBuf> {
    let mut roots: Vec<PathBuf> = vec![
        PathBuf::from(r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs"),
    ];
    if let Some(appdata) = dirs::data_dir() {
        roots.push(appdata.join(r"Microsoft\Windows\Start Menu\Programs"));
    }

    fn scan(dir: &std::path::Path, target: &str, best: &mut Option<(usize, PathBuf)>, depth: u8) {
        if depth > 4 { return; }
        let entries = match std::fs::read_dir(dir) { Ok(e) => e, Err(_) => return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                scan(&path, target, best, depth + 1);
            } else if path.extension().map_or(false, |e| e.eq_ignore_ascii_case("lnk")) {
                if let Some(stem) = path.file_stem() {
                    let stem_l = stem.to_string_lossy().to_lowercase();
                    let nl = stem_l.as_str();
                    if nl.contains("uninstall") { continue; }
                    // Lower score = better match: exact(0), starts-with(1), contains(2)
                    let score = if nl == target { 0 }
                        else if nl.starts_with(target) { 1 }
                        else if nl.contains(target) { 2 }
                        else { continue };
                    let better = match best { Some((s, _)) => score < *s, None => true };
                    if better { *best = Some((score, path.clone())); }
                }
            }
        }
    }

    let mut best: Option<(usize, PathBuf)> = None;
    for root in &roots {
        if root.exists() { scan(root, name_lower, &mut best, 0); }
    }
    best.map(|(_, p)| p)
}

/// Launch an app by opening its Start Menu shortcut via ShellExecute.
fn launch_shortcut(lnk: &std::path::Path) -> anyhow::Result<u32> {
    let child = std::process::Command::new("cmd")
        .args(["/c", "start", "", &lnk.to_string_lossy()])
        .spawn()
        .map_err(|e| anyhow::anyhow!("Failed to launch shortcut {:?}: {}", lnk, e))?;
    Ok(child.id())
}

/// Searches and launches an application by name using a 4-tier strategy:
///
/// Tier 1 — Known AUMID table (instant, covers WhatsApp, Spotify, Telegram, etc.)
/// Tier 2 — Known .exe paths (browsers, Office, VS Code, VLC, etc.)
/// Tier 3 — Runtime UWP discovery via PowerShell Get-AppxPackage
/// Tier 4 — Filesystem scan (C:\Program Files, AppData\Local\Programs)
/// Tier 5 — PATH lookup (CLI tools)
/// Tier 6 — Direct spawn (treat 'name' as executable name/path directly)
pub fn launch_app_internal(name: &str) -> anyhow::Result<u32> {
    let name_lower = name.to_lowercase().trim().to_string();

    // ── Tier 1: Static AUMID table ──────────────────────────────────────────
    if let Some(aumid) = known_aumid(&name_lower) {
        tracing::debug!("launch_app: AUMID table hit for '{}' -> {}", name, aumid);
        match launch_uwp(aumid) {
            Ok(pid) => return Ok(pid),
            Err(e) => tracing::warn!("launch_app: AUMID launch failed ({}), trying next tier", e),
        }
    }

    // ── Tier 2: Known .exe path table ───────────────────────────────────────
    if let Some(exe) = known_exe(&name_lower) {
        tracing::debug!("launch_app: known exe hit for '{}' -> {:?}", name, exe);
        if exe.exists() {
            let child = std::process::Command::new(&exe)
                .spawn()
                .map_err(|e| anyhow::anyhow!("Failed to launch {:?}: {}", exe, e))?;
            return Ok(child.id());
        }
    }

    // ── Tier 3: Start Menu shortcut (universal — Store + desktop apps) ──────
    // Most reliable method for any installed app: launch its .lnk shortcut.
    // Windows resolves it correctly whether it's a UWP or classic app.
    if let Some(lnk) = find_start_menu_shortcut(&name_lower) {
        tracing::debug!("launch_app: Start Menu shortcut hit for '{}' -> {:?}", name, lnk);
        if let Ok(pid) = launch_shortcut(&lnk) {
            return Ok(pid);
        }
    }

    // ── Tier 4: Runtime UWP discovery via PowerShell ────────────────────────
    tracing::debug!("launch_app: trying PowerShell UWP discovery for '{}'", name);
    if let Some(aumid) = find_uwp_aumid(&name_lower) {
        tracing::debug!("launch_app: PowerShell found AUMID '{}' for '{}'", aumid, name);
        match launch_uwp(&aumid) {
            Ok(pid) => return Ok(pid),
            Err(e) => tracing::warn!("launch_app: dynamic AUMID launch failed ({}), trying next", e),
        }
    }

    // ── Tier 5: Filesystem scan ─────────────────────────────────────────────
    tracing::debug!("launch_app: filesystem scan for '{}'", name);
    if let Some(exe) = search_exe_in_dirs(&name_lower) {
        tracing::debug!("launch_app: fs scan found {:?}", exe);
        let child = std::process::Command::new(&exe)
            .spawn()
            .map_err(|e| anyhow::anyhow!("Failed to launch {:?}: {}", exe, e))?;
        return Ok(child.id());
    }

    // ── Tier 6: PATH lookup ──────────────────────────────────────────────────
    tracing::debug!("launch_app: PATH lookup for '{}'", name);
    if let Ok(pid) = launch_via_path(&name_lower) {
        return Ok(pid);
    }

    // ── Tier 7: Direct spawn (last resort) ──────────────────────────────────
    tracing::debug!("launch_app: direct spawn for '{}'", name);
    let child = std::process::Command::new(name)
        .spawn()
        .map_err(|_| anyhow::anyhow!(
            "App '{}' is not installed on this PC and could not be found anywhere. \
             It is not in Program Files, AppData, PATH, or the Windows Store. \
             Tell the user the app is not installed and ask if they want you to \
             open the Microsoft Store or official website to download it.",
            name
        ))?;
    Ok(child.id())
}

/// Sets the focus to a window matching the specified name.
pub fn focus_window_by_name(name: &str) -> anyhow::Result<()> {
    unsafe {
        let mut hwnd = HWND(std::ptr::null_mut());
        let name_lower = name.to_lowercase();
        let list = list_running_apps_internal();

        for app in &list {
            if app.name.to_lowercase().contains(&name_lower) {
                hwnd = HWND(app.hwnd as _);
                break;
            }
        }

        if hwnd.0.is_null() {
            return Err(anyhow::anyhow!("Window not found matching '{}'. Is the app open?", name));
        }

        let _ = ShowWindow(hwnd, SW_RESTORE);
        let _ = SetForegroundWindow(hwnd);
        Ok(())
    }
}

/// Retrieves the active window info.
pub fn get_active_window() -> AppInfo {
    AppInfo {
        name: super::uia::get_focused_window_name(),
        hwnd: 0,
        pid: 0,
        exe_name: String::new(),
    }
}

/// Checks if an app matching the specified name is running.
pub fn is_app_running(name: &str) -> bool {
    let name_lower = name.to_lowercase();
    list_running_apps_internal()
        .iter()
        .any(|app| app.name.to_lowercase().contains(&name_lower))
}

/// Builds a concise "system awareness" snapshot for the agent: what windows are
/// currently open, so the agent can focus an already-running app instead of
/// re-launching it, and reason strategically about the desktop state.
/// Fast — only enumerates visible windows (no PowerShell, no disk scan).
pub fn get_system_context() -> String {
    let windows = list_running_apps_internal();
    // Filter out our own windows and empty/system titles
    let mut titles: Vec<String> = windows
        .into_iter()
        .map(|w| w.name)
        .filter(|t| {
            let tl = t.to_lowercase();
            !t.trim().is_empty()
                && !tl.contains("omni")
                && tl != "program manager"
                && tl != "windows input experience"
                && tl != "microsoft text input application"
        })
        .collect();
    titles.sort();
    titles.dedup();

    let open_section = if titles.is_empty() {
        "No application windows are currently open.".to_string()
    } else {
        let shown: Vec<String> = titles.into_iter().take(25).collect();
        format!(
            "Currently OPEN windows (use 'app focus' to switch to one instead of re-opening):\n- {}",
            shown.join("\n- ")
        )
    };

    // Installed apps (cached after first call) — lets the agent know exactly
    // what it can open, so it never guesses or wrongly says "not installed".
    let installed = list_installed_app_names();
    let installed_section = if installed.is_empty() {
        String::new()
    } else {
        format!(
            "\n\nINSTALLED apps on this PC (open any with 'app open name=<name>'):\n{}",
            installed.join(", ")
        )
    };

    format!("{}{}", open_section, installed_section)
}

/// Returns a de-duplicated, lowercased-friendly list of installed application
/// names by scanning Start Menu shortcuts (.lnk) for both all-users and the
/// current user. This is FAST (filesystem only, no PowerShell) and covers BOTH
/// Microsoft Store apps and traditional desktop apps. Cached for the session.
pub fn list_installed_app_names() -> Vec<String> {
    use std::collections::BTreeSet;
    use std::sync::{Mutex, OnceLock};

    static CACHE: OnceLock<Mutex<Option<Vec<String>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));

    if let Ok(guard) = cache.lock() {
        if let Some(ref cached) = *guard {
            return cached.clone();
        }
    }

    let mut names: BTreeSet<String> = BTreeSet::new();

    // Start Menu shortcut roots
    let mut roots: Vec<PathBuf> = Vec::new();
    roots.push(PathBuf::from(r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs"));
    if let Some(appdata) = dirs::data_dir() {
        roots.push(appdata.join(r"Microsoft\Windows\Start Menu\Programs"));
    }

    fn scan_dir(dir: &std::path::Path, names: &mut std::collections::BTreeSet<String>, depth: u8) {
        if depth > 4 { return; }
        let entries = match std::fs::read_dir(dir) { Ok(e) => e, Err(_) => return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                scan_dir(&path, names, depth + 1);
            } else if path.extension().map_or(false, |e| e.eq_ignore_ascii_case("lnk")) {
                if let Some(stem) = path.file_stem() {
                    let name = stem.to_string_lossy().trim().to_string();
                    let nl = name.to_lowercase();
                    // Skip uninstallers, docs, and noise
                    if !name.is_empty()
                        && !nl.contains("uninstall")
                        && !nl.contains("readme")
                        && !nl.contains("help")
                        && !nl.contains("documentation")
                        && !nl.contains("release notes")
                        && !nl.contains("website")
                        && name.len() < 40
                    {
                        names.insert(name);
                    }
                }
            }
        }
    }

    for root in &roots {
        if root.exists() {
            scan_dir(root, &mut names, 0);
        }
    }

    // Cap to keep the prompt lean
    let result: Vec<String> = names.into_iter().take(60).collect();

    if let Ok(mut guard) = cache.lock() {
        *guard = Some(result.clone());
    }
    result
}

/// Tauri command — expose system context to the frontend if needed.
#[tauri::command]
pub fn get_running_windows() -> Vec<AppInfo> {
    list_running_apps_internal()
}

// ── Tauri IPC wrappers ────────────────────────────────────────────────────────

#[tauri::command]
pub fn launch_app(name: String) -> Result<(), String> {
    launch_app_internal(&name).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn focus_window(name: String) -> Result<(), String> {
    focus_window_by_name(&name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_running_apps() -> Vec<AppInfo> {
    list_running_apps_internal()
}
