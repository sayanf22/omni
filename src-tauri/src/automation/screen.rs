use std::sync::{Arc, Mutex};
use windows_capture::{
    capture::{GraphicsCaptureApiHandler, Context},
    frame::Frame,
    graphics_capture_api::InternalCaptureControl,
    monitor::Monitor,
    settings::{ColorFormat, CursorCaptureSettings, DrawBorderSettings, Settings, SecondaryWindowSettings, MinimumUpdateIntervalSettings, DirtyRegionSettings},
};
use image::{codecs::jpeg::JpegEncoder, ColorType, ImageBuffer, Rgba, ImageEncoder};
use base64::{Engine as _, engine::general_purpose::STANDARD};

struct CaptureState {
    frame_data: Option<Vec<u8>>,
    width: u32,
    height: u32,
    error: Option<String>,
}

struct ScreenCaptureHandler {
    state: Arc<Mutex<CaptureState>>,
}

impl GraphicsCaptureApiHandler for ScreenCaptureHandler {
    type Flags = Arc<Mutex<CaptureState>>;
    type Error = anyhow::Error;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self { state: ctx.flags })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        let mut buffer = frame.buffer()?;
        let width = buffer.width();
        let height = buffer.height();
        
        let mut state = self.state.lock().unwrap();
        let raw_pixels = buffer.as_raw_buffer();
        state.frame_data = Some(raw_pixels.to_vec());
        state.width = width;
        state.height = height;

        capture_control.stop();
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        Ok(())
    }
}

/// Captures full screen, encodes as JPEG 85%, returns base64 string.
pub fn capture_full_screen() -> anyhow::Result<String> {
    let state = Arc::new(Mutex::new(CaptureState {
        frame_data: None,
        width: 0,
        height: 0,
        error: None,
    }));

    let primary_monitor = Monitor::primary()
        .map_err(|e| anyhow::anyhow!("Failed to get primary monitor: {:?}", e))?;

    let settings = Settings::new(
        primary_monitor,
        CursorCaptureSettings::Default,
        DrawBorderSettings::Default,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Rgba8,
        state.clone(),
    );

    ScreenCaptureHandler::start(settings)
        .map_err(|e| anyhow::anyhow!("Capture start failed: {:?}", e))?;

    let state = state.lock().unwrap();
    if let Some(err) = &state.error {
        return Err(anyhow::anyhow!("Capture handler error: {}", err));
    }

    let frame_data = state.frame_data.as_ref()
        .ok_or_else(|| anyhow::anyhow!("No frame captured"))?;

    let mut jpeg_bytes = Vec::new();
    {
        let mut cursor = std::io::Cursor::new(&mut jpeg_bytes);
        let encoder = JpegEncoder::new_with_quality(&mut cursor, 85);
        encoder.write_image(frame_data, state.width, state.height, ColorType::Rgba8.into())?;
    }

    Ok(STANDARD.encode(jpeg_bytes))
}

/// Captures a specific region of the screen, encodes as JPEG 85%, returns base64 string.
pub fn capture_region(x: i32, y: i32, w: u32, h: u32) -> anyhow::Result<String> {
    let state = Arc::new(Mutex::new(CaptureState {
        frame_data: None,
        width: 0,
        height: 0,
        error: None,
    }));

    let primary_monitor = Monitor::primary()
        .map_err(|e| anyhow::anyhow!("Failed to get primary monitor: {:?}", e))?;

    let settings = Settings::new(
        primary_monitor,
        CursorCaptureSettings::Default,
        DrawBorderSettings::Default,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Rgba8,
        state.clone(),
    );

    ScreenCaptureHandler::start(settings)
        .map_err(|e| anyhow::anyhow!("Capture start failed: {:?}", e))?;

    let state = state.lock().unwrap();
    if let Some(err) = &state.error {
        return Err(anyhow::anyhow!("Capture handler error: {}", err));
    }

    let frame_data = state.frame_data.as_ref()
        .ok_or_else(|| anyhow::anyhow!("No frame captured"))?;

    let img_buf = ImageBuffer::<Rgba<u8>, _>::from_raw(state.width, state.height, frame_data.clone())
        .ok_or_else(|| anyhow::anyhow!("Failed to load image buffer from raw pixels"))?;

    let rx = x.clamp(0, state.width as i32) as u32;
    let ry = y.clamp(0, state.height as i32) as u32;
    let rw = w.min(state.width - rx);
    let rh = h.min(state.height - ry);

    let cropped_buf = image::imageops::crop_imm(&img_buf, rx, ry, rw, rh).to_image();

    let mut jpeg_bytes = Vec::new();
    {
        let mut cursor = std::io::Cursor::new(&mut jpeg_bytes);
        let encoder = JpegEncoder::new_with_quality(&mut cursor, 85);
        encoder.write_image(&cropped_buf, rw, rh, ColorType::Rgba8.into())?;
    }

    Ok(STANDARD.encode(jpeg_bytes))
}

/// Tauri IPC wrapper
#[tauri::command]
pub fn take_screenshot() -> Result<String, String> {
    capture_full_screen().map_err(|e| e.to_string())
}
