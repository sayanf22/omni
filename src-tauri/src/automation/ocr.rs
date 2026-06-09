use windows::Media::Ocr::OcrEngine;
use windows::Graphics::Imaging::BitmapDecoder;
use windows::Storage::Streams::{InMemoryRandomAccessStream, DataWriter};
use base64::{Engine as _, engine::general_purpose::STANDARD};

/// Converts image bytes (JPEG) -> Windows SoftwareBitmap -> OcrEngine -> recognized text
pub async fn ocr_image_bytes(jpeg_bytes: &[u8]) -> anyhow::Result<String> {
    let stream = InMemoryRandomAccessStream::new()?;
    let writer = DataWriter::CreateDataWriter(&stream)?;
    writer.WriteBytes(jpeg_bytes)?;
    writer.StoreAsync()?.get()?;
    writer.FlushAsync()?.get()?;
    stream.Seek(0)?;

    let decoder = BitmapDecoder::CreateAsync(&stream)?.get()?;
    let bitmap = decoder.GetSoftwareBitmapAsync()?.get()?;

    let ocr_engine = OcrEngine::TryCreateFromUserProfileLanguages()?;
    let ocr_result = ocr_engine.RecognizeAsync(&bitmap)?.get()?;
    let text = ocr_result.Text()?;
    Ok(text.to_string())
}

/// Captures the screen and performs OCR on the full screen
pub async fn ocr_screen_internal() -> anyhow::Result<String> {
    let screenshot_base64 = super::screen::capture_full_screen()?;
    let screenshot_bytes = STANDARD.decode(screenshot_base64)?;
    ocr_image_bytes(&screenshot_bytes).await
}

/// Finds a partial text match on screen and returns its center coordinates (x, y)
pub async fn ocr_find_text_coords(query: &str) -> anyhow::Result<Option<(i32, i32)>> {
    let screenshot_base64 = super::screen::capture_full_screen()?;
    let screenshot_bytes = STANDARD.decode(screenshot_base64)?;

    let stream = InMemoryRandomAccessStream::new()?;
    let writer = DataWriter::CreateDataWriter(&stream)?;
    writer.WriteBytes(&screenshot_bytes)?;
    writer.StoreAsync()?.get()?;
    writer.FlushAsync()?.get()?;
    stream.Seek(0)?;

    let decoder = BitmapDecoder::CreateAsync(&stream)?.get()?;
    let bitmap = decoder.GetSoftwareBitmapAsync()?.get()?;

    let ocr_engine = OcrEngine::TryCreateFromUserProfileLanguages()?;
    let ocr_result = ocr_engine.RecognizeAsync(&bitmap)?.get()?;

    let query_lower = query.to_lowercase();
    let query_words: Vec<&str> = query_lower.split_whitespace().collect();
    if query_words.is_empty() {
        return Ok(None);
    }

    for line in ocr_result.Lines()? {
        let line_words: Vec<_> = line.Words()?.into_iter().collect();
        for i in 0..=line_words.len().saturating_sub(query_words.len()) {
            let mut matches = true;
            for j in 0..query_words.len() {
                let word_text = line_words[i + j].Text()?.to_string().to_lowercase();
                if !word_text.contains(query_words[j]) && !query_words[j].contains(&word_text) {
                    matches = false;
                    break;
                }
            }
            if matches {
                let mut min_x = f32::MAX;
                let mut min_y = f32::MAX;
                let mut max_x = f32::MIN;
                let mut max_y = f32::MIN;

                for j in 0..query_words.len() {
                    let rect = line_words[i + j].BoundingRect()?;
                    if rect.X < min_x { min_x = rect.X; }
                    if rect.Y < min_y { min_y = rect.Y; }
                    if rect.X + rect.Width > max_x { max_x = rect.X + rect.Width; }
                    if rect.Y + rect.Height > max_y { max_y = rect.Y + rect.Height; }
                }

                let center_x = ((min_x + max_x) / 2.0) as i32;
                let center_y = ((min_y + max_y) / 2.0) as i32;
                return Ok(Some((center_x, center_y)));
            }
        }
    }

    Ok(None)
}

/// Tauri IPC wrappers
#[tauri::command]
pub async fn ocr_screen() -> Result<String, String> {
    ocr_screen_internal().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn find_text_on_screen(query: String) -> Result<Option<(i32, i32)>, String> {
    ocr_find_text_coords(&query).await.map_err(|e| e.to_string())
}
