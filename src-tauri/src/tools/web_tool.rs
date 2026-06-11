/// web_tool — search the web and fetch page content for the agent.
/// Uses DuckDuckGo's HTML search (no API key required) + reqwest for page fetching.
use serde_json::Value;
use crate::tools::{Tool, RiskLevel};

pub struct WebTool;

impl WebTool {
    pub fn new() -> Self { Self }
}

#[async_trait::async_trait]
impl Tool for WebTool {
    fn name(&self) -> &str { "web" }

    fn description(&self) -> &str {
        "Search the web and read web page content. Actions:\n\
         • search — search the web for a query, returns top results with titles, URLs, snippets\n\
         • fetch  — fetch and read the text content of any URL (useful after search to read a page)"
    }

    fn params_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["search", "fetch"] },
                "query":  { "type": "string", "description": "Search query (for search action)" },
                "url":    { "type": "string", "description": "URL to fetch (for fetch action)" },
                "max_results": { "type": "integer", "description": "Max search results to return (default 6, max 10)" }
            },
            "required": ["action"]
        })
    }

    fn risk_level(&self, _params: &Value) -> RiskLevel { RiskLevel::ReadOnly }

    async fn execute(&self, params: Value) -> anyhow::Result<String> {
        let action = params["action"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'action'"))?;
        match action {
            "search" => {
                let query = params["query"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'query' for search"))?;
                let max = params["max_results"].as_u64().unwrap_or(6).min(10) as usize;
                search_ddg(query, max).await
            }
            "fetch" => {
                let url = params["url"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'url' for fetch"))?;
                fetch_page(url).await
            }
            _ => Err(anyhow::anyhow!("Unknown action: {}", action))
        }
    }
}

/// Search DuckDuckGo (HTML endpoint, no API key needed) and extract results.
async fn search_ddg(query: &str, max: usize) -> anyhow::Result<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .build()?;

    let url = format!("https://html.duckduckgo.com/html/?q={}", urlencoding::encode(query));
    let html = client.get(&url)
        .header("Accept-Language", "en-US,en;q=0.9")
        .send().await?.text().await?;

    // Parse results from the HTML — DuckDuckGo HTML uses well-known class names
    let mut results: Vec<serde_json::Value> = Vec::new();

    // Find result blocks: <div class="result__body">
    let mut pos = 0;
    while results.len() < max {
        // Title link: <a class="result__a" href="...">title</a>
        let title_start = match html[pos..].find("class=\"result__a\"") {
            Some(p) => pos + p,
            None => break,
        };
        // Extract href
        let before_href = &html[..title_start];
        let href_start = match before_href.rfind("href=\"") {
            Some(p) => p + 6,
            None => { pos = title_start + 10; continue; }
        };
        let href_end = match html[href_start..].find('"') {
            Some(p) => href_start + p,
            None => { pos = title_start + 10; continue; }
        };
        let raw_href = html[href_start..href_end].to_string();

        // Resolve redirect URLs (DDG wraps them)
        let url = if raw_href.starts_with("//duckduckgo.com/l/?uddg=") || raw_href.contains("uddg=") {
            // Extract the actual URL from the redirect parameter
            if let Some(uddg_pos) = raw_href.find("uddg=") {
                let encoded = &raw_href[uddg_pos + 5..];
                let end = encoded.find('&').unwrap_or(encoded.len());
                urlencoding::decode(&encoded[..end]).unwrap_or_default().to_string()
            } else {
                raw_href
            }
        } else if raw_href.starts_with('/') {
            format!("https://duckduckgo.com{}", raw_href)
        } else {
            raw_href
        };

        // Skip DDG internal links
        if url.contains("duckduckgo.com") || url.is_empty() {
            pos = title_start + 10;
            continue;
        }

        // Extract title text
        let tag_end = match html[title_start..].find('>') {
            Some(p) => title_start + p + 1,
            None => { pos = title_start + 10; continue; }
        };
        let title_text_end = match html[tag_end..].find("</a>") {
            Some(p) => tag_end + p,
            None => { pos = title_start + 10; continue; }
        };
        let title = strip_tags(&html[tag_end..title_text_end]).trim().to_string();
        if title.is_empty() { pos = title_start + 10; continue; }

        // Extract snippet
        let snippet = extract_snippet(&html, title_text_end);

        results.push(serde_json::json!({
            "title": title,
            "url": url,
            "snippet": snippet,
        }));
        pos = title_text_end + 4;
    }

    if results.is_empty() {
        return Ok(format!("No results found for: {}", query));
    }

    let mut out = format!("Search results for \"{}\":\n\n", query);
    for (i, r) in results.iter().enumerate() {
        out.push_str(&format!(
            "{}. {}\n   URL: {}\n   {}\n\n",
            i + 1,
            r["title"].as_str().unwrap_or(""),
            r["url"].as_str().unwrap_or(""),
            r["snippet"].as_str().unwrap_or(""),
        ));
    }
    Ok(out.trim_end().to_string())
}

fn extract_snippet(html: &str, from: usize) -> String {
    let search = &html[from..];
    // Look for the snippet class
    if let Some(p) = search.find("class=\"result__snippet\"") {
        let after = &search[p..];
        if let Some(start) = after.find('>') {
            let content_start = p + start + 1;
            if let Some(end) = search[content_start..].find("</a>")
                .or_else(|| search[content_start..].find("</div>"))
            {
                return strip_tags(&search[content_start..content_start + end])
                    .trim().chars().take(200).collect();
            }
        }
    }
    String::new()
}

fn strip_tags(s: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    // Decode common HTML entities
    out.replace("&amp;", "&")
       .replace("&lt;", "<")
       .replace("&gt;", ">")
       .replace("&quot;", "\"")
       .replace("&#39;", "'")
       .replace("&nbsp;", " ")
}

/// Fetch a URL and return its readable text content.
async fn fetch_page(url: &str) -> anyhow::Result<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .build()?;

    let resp = client.get(url).send().await
        .map_err(|e| anyhow::anyhow!("Failed to fetch {}: {}", url, e))?;

    if !resp.status().is_success() {
        return Err(anyhow::anyhow!("HTTP {} for {}", resp.status(), url));
    }

    // Only process text/html responses
    let ct = resp.headers().get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    if !ct.contains("text/html") && !ct.contains("text/plain") {
        return Err(anyhow::anyhow!("Not a text page (content-type: {})", ct));
    }

    let html = resp.text().await?;

    // Extract readable text: remove scripts/styles/tags, collapse whitespace
    let text = extract_readable_text(&html);

    // Cap at 6000 chars so we don't flood the context
    const MAX: usize = 6000;
    if text.len() > MAX {
        Ok(format!("{}\n\n[... content truncated at {} chars ...]", &text[..MAX], MAX))
    } else {
        Ok(text)
    }
}

fn extract_readable_text(html: &str) -> String {
    // Remove <script> and <style> blocks
    let mut s = remove_block(html, "script");
    s = remove_block(&s, "style");
    s = remove_block(&s, "nav");
    s = remove_block(&s, "footer");
    s = remove_block(&s, "header");

    // Strip remaining tags and decode entities
    let plain = strip_tags(&s);

    // Collapse whitespace
    let mut out = String::new();
    let mut last_newline = true;
    for line in plain.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if !last_newline { out.push('\n'); last_newline = true; }
        } else {
            out.push_str(trimmed);
            out.push('\n');
            last_newline = false;
        }
    }
    out.trim().to_string()
}

fn remove_block(html: &str, tag: &str) -> String {
    let open = format!("<{}", tag);
    let close = format!("</{}>", tag);
    let mut out = String::new();
    let mut pos = 0;
    let lower = html.to_lowercase();
    loop {
        match lower[pos..].find(&open) {
            None => { out.push_str(&html[pos..]); break; }
            Some(start) => {
                out.push_str(&html[pos..pos + start]);
                let end_search = pos + start;
                match lower[end_search..].find(&close) {
                    None => break,
                    Some(end) => { pos = end_search + end + close.len(); }
                }
            }
        }
    }
    out
}
