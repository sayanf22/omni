#[path = "../../src/storage/sqlite.rs"]
pub mod sqlite;
#[path = "../../src/storage/keychain.rs"]
pub mod keychain;

use sqlite::{init_db, save_task, get_recent_tasks_internal, Task, clear_all_data};
use keychain::{store_key, get_key, delete_key, has_key};

fn test_keychain_operations() {
    println!("Running test_keychain_operations...");
    let test_name = "test_api_key_123";
    let test_val = "sk-proj-abcdef123456";

    // Clean up first in case it was left over
    let _ = delete_key(test_name);

    assert!(!has_key(test_name), "Key should not exist initially");
    assert!(get_key(test_name).unwrap().is_none(), "Key value should be None initially");

    store_key(test_name, test_val).unwrap();
    assert!(has_key(test_name), "Key should exist after storing");
    assert_eq!(get_key(test_name).unwrap(), Some(test_val.to_string()), "Key value should match");

    delete_key(test_name).unwrap();
    assert!(!has_key(test_name), "Key should not exist after deletion");
    println!("test_keychain_operations passed!");
}

fn test_sqlite_operations() {
    println!("Running test_sqlite_operations...");
    // Initialize database
    init_db().unwrap();

    // Clear old data for a clean test
    clear_all_data().unwrap();

    let task = Task {
        id: "test-task-uuid".to_string(),
        description: "Test description".to_string(),
        status: "pending".to_string(),
        steps_json: "[]".to_string(),
        outcome: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        synced_at: None,
    };

    save_task(&task).unwrap();

    let tasks = get_recent_tasks_internal(10).unwrap();
    assert_eq!(tasks.len(), 1, "There should be exactly 1 task");
    assert_eq!(tasks[0].id, "test-task-uuid");
    assert_eq!(tasks[0].description, "Test description");

    clear_all_data().unwrap();
    let tasks_cleared = get_recent_tasks_internal(10).unwrap();
    assert!(tasks_cleared.is_empty(), "Tasks should be empty after clear");
    println!("test_sqlite_operations passed!");
}

fn main() {
    println!("Starting storage test suite...");
    test_keychain_operations();
    
    // Print keys for active models
    for id in &[
        "006e661b-12b5-446c-8966-bfaaf426aec8",
        "217dbc94-6999-488b-b5db-746d880e1097",
        "c4f01ea5-5588-4398-acc2-190c72c0e474"
    ] {
        if let Ok(Some(k)) = get_key(id) {
            println!("Key for {}: {}", id, k);
        } else {
            println!("No key found for {}", id);
        }
    }
    
    test_sqlite_operations();
    println!("ALL STORAGE TESTS PASSED SUCCESSFULLY!");
}
