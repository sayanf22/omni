use uiautomation::UIAutomation;
use uiautomation::UIElement;
use uiautomation::UITreeWalker;
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct ElementInfo {
    pub name: String,
    pub control_type: String,
    pub rect: [i32; 4], // x, y, w, h
    pub value: String,
}

/// Retrieves the name of the currently focused window.
pub fn get_focused_window_name() -> String {
    if let Ok(automation) = UIAutomation::new() {
        if let Ok(focused) = automation.get_focused_element() {
            if let Ok(name) = focused.get_name() {
                return name;
            }
        }
    }
    String::from("Unknown")
}

/// Dumps the UI accessibility tree up to 4 levels deep in JSON format.
pub fn get_ui_tree_json() -> anyhow::Result<Value> {
    let automation = UIAutomation::new()
        .map_err(|e| anyhow::anyhow!("Failed to init UIAutomation: {:?}", e))?;
    let root = automation.get_root_element()
        .map_err(|e| anyhow::anyhow!("Failed to get root element: {:?}", e))?;
    let walker = automation.get_control_view_walker()
        .map_err(|e| anyhow::anyhow!("Failed to get walker: {:?}", e))?;

    fn build_node(walker: &UITreeWalker, element: &UIElement, depth: usize) -> Value {
        if depth > 4 {
            return json!({});
        }

        let name = element.get_name().unwrap_or_default();
        let classname = element.get_classname().unwrap_or_default();
        
        let rect = element.get_bounding_rectangle().map(|r| {
            json!({
                "x": r.get_left(),
                "y": r.get_top(),
                "w": r.get_right() - r.get_left(),
                "h": r.get_bottom() - r.get_top()
            })
        }).unwrap_or(json!({
            "x": 0, "y": 0, "w": 0, "h": 0
        }));

        let mut children = Vec::new();
        if let Ok(child) = walker.get_first_child(element) {
            let child_node = build_node(walker, &child, depth + 1);
            if child_node != json!({}) {
                children.push(child_node);
            }
            let mut next = child;
            while let Ok(sibling) = walker.get_next_sibling(&next) {
                let sibling_node = build_node(walker, &sibling, depth + 1);
                if sibling_node != json!({}) {
                    children.push(sibling_node);
                }
                next = sibling;
            }
        }

        json!({
            "name": name,
            "classname": classname,
            "rect": rect,
            "children": children
        })
    }

    Ok(build_node(&walker, &root, 0))
}

/// Recursively searches for an element by name.
pub fn find_element(search_text: &str) -> anyhow::Result<Option<ElementInfo>> {
    let automation = UIAutomation::new()
        .map_err(|e| anyhow::anyhow!("Failed to init UIAutomation: {:?}", e))?;
    let root = automation.get_root_element()
        .map_err(|e| anyhow::anyhow!("Failed to get root element: {:?}", e))?;
    let walker = automation.get_control_view_walker()
        .map_err(|e| anyhow::anyhow!("Failed to get walker: {:?}", e))?;

    let search_lower = search_text.to_lowercase();

    fn search_node(walker: &UITreeWalker, element: &UIElement, search_lower: &str) -> Option<ElementInfo> {
        if let Ok(name) = element.get_name() {
            if name.to_lowercase().contains(search_lower) {
                let rect = element.get_bounding_rectangle().map(|r| {
                    [r.get_left(), r.get_top(), r.get_right() - r.get_left(), r.get_bottom() - r.get_top()]
                }).unwrap_or([0, 0, 0, 0]);

                let classname = element.get_classname().unwrap_or_default();

                return Some(ElementInfo {
                    name,
                    control_type: classname,
                    rect,
                    value: String::new(),
                });
            }
        }

        if let Ok(child) = walker.get_first_child(element) {
            if let Some(res) = search_node(walker, &child, search_lower) {
                return Some(res);
            }
            let mut next = child;
            while let Ok(sibling) = walker.get_next_sibling(&next) {
                if let Some(res) = search_node(walker, &sibling, search_lower) {
                    return Some(res);
                }
                next = sibling;
            }
        }
        None
    }

    Ok(search_node(&walker, &root, &search_lower))
}

/// Invokes the click action on the specified element by name, falling back to mouse click if unsupported.
pub fn click_element_by_name(name: &str) -> anyhow::Result<()> {
    let automation = UIAutomation::new()
        .map_err(|e| anyhow::anyhow!("Failed to init UIAutomation: {:?}", e))?;
    let root = automation.get_root_element()
        .map_err(|e| anyhow::anyhow!("Failed to get root element: {:?}", e))?;
    let walker = automation.get_control_view_walker()
        .map_err(|e| anyhow::anyhow!("Failed to get walker: {:?}", e))?;

    let search_lower = name.to_lowercase();

    fn find_element_ref(walker: &UITreeWalker, element: &UIElement, search_lower: &str) -> Option<UIElement> {
        if let Ok(elem_name) = element.get_name() {
            if elem_name.to_lowercase().contains(search_lower) {
                return Some(element.clone());
            }
        }

        if let Ok(child) = walker.get_first_child(element) {
            if let Some(res) = find_element_ref(walker, &child, search_lower) {
                return Some(res);
            }
            let mut next = child;
            while let Ok(sibling) = walker.get_next_sibling(&next) {
                if let Some(res) = find_element_ref(walker, &sibling, search_lower) {
                    return Some(res);
                }
                next = sibling;
            }
        }
        None
    }

    if let Some(element) = find_element_ref(&walker, &root, &search_lower) {
        // Try InvokePattern
        if let Ok(invoke_pattern) = element.get_pattern::<uiautomation::patterns::UIInvokePattern>() {
            if let Ok(_) = invoke_pattern.invoke() {
                return Ok(());
            }
        }

        // Fall back to mouse click
        if let Ok(rect) = element.get_bounding_rectangle() {
            let x = (rect.get_left() + rect.get_right()) / 2;
            let y = (rect.get_top() + rect.get_bottom()) / 2;
            super::input::mouse_click_internal(x, y)?;
            return Ok(());
        }
    }

    Err(anyhow::anyhow!("UI Element not found: {}", name))
}

/// Tauri IPC wrapper
#[tauri::command]
pub fn get_ui_tree() -> Result<Value, String> {
    get_ui_tree_json().map_err(|e| e.to_string())
}
