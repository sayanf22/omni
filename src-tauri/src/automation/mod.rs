pub mod screen;
pub mod ocr;
pub mod uia;
pub mod input;
pub mod process;
pub mod takeover;

use windows::Win32::UI::HiDpi::GetDpiForSystem;

/// Converts logical pixels to physical pixels based on the system DPI.
pub fn logical_to_physical(logical: i32) -> i32 {
    unsafe {
        let dpi = GetDpiForSystem();
        let scale = dpi as f64 / 96.0;
        (logical as f64 * scale).round() as i32
    }
}

/// Converts physical pixels to logical pixels based on the system DPI.
pub fn physical_to_logical(physical: i32) -> i32 {
    unsafe {
        let dpi = GetDpiForSystem();
        let scale = dpi as f64 / 96.0;
        (physical as f64 / scale).round() as i32
    }
}
