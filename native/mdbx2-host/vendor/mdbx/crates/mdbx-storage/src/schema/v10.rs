use rusqlite::{Connection, OptionalExtension};

use crate::error::{StorageError, StorageResult};

const ATTACHMENT_SCOPE_MARKER: &str = "'attachment'";
const MAX_PRESERVED_COLUMNS: usize = 256;
const MAX_PRESERVED_COLUMN_METADATA_BYTES: usize = 64 * 1024;

const EXCEPTION_COLUMNS: &[&str] = &[
    "exception_id",
    "target_scope",
    "target_id",
    "approved_override_json",
    "reason",
    "expires_at_unix_secs",
    "created_at",
    "created_by_session_id",
    "revoked_at",
    "integrity_tag",
];

const OVERRIDE_COLUMNS: &[&str] = &[
    "scope_type",
    "scope_id",
    "policy_json",
    "exception_id",
    "updated_at",
    "updated_by_device_id",
    "integrity_tag",
];

#[derive(Debug, Clone)]
struct PreservedColumn {
    name: String,
    declared_type: String,
    not_null: bool,
    default_value: Option<String>,
}

pub fn create_extensions(conn: &Connection) -> StorageResult<()> {
    let exception_sql = table_sql(conn, "tiga_policy_exceptions")?;
    let override_sql = table_sql(conn, "tiga_policy_overrides")?;
    if exception_sql.contains(ATTACHMENT_SCOPE_MARKER)
        && override_sql.contains(ATTACHMENT_SCOPE_MARKER)
    {
        return Ok(());
    }

    let exception_columns = preserved_columns(conn, "tiga_policy_exceptions", EXCEPTION_COLUMNS)?;
    let override_columns = preserved_columns(conn, "tiga_policy_overrides", OVERRIDE_COLUMNS)?;

    let exception_columns_sql = column_declarations(&exception_columns);
    let override_columns_sql = column_declarations(&override_columns);
    let exception_copy_columns = copy_column_list(EXCEPTION_COLUMNS, &exception_columns);
    let override_copy_columns = copy_column_list(OVERRIDE_COLUMNS, &override_columns);

    let migration_sql = format!(
        "CREATE TABLE tiga_policy_exceptions_v10 (
            exception_id           TEXT PRIMARY KEY NOT NULL,
            target_scope           TEXT NOT NULL CHECK (target_scope IN ('vault', 'project', 'entry', 'attachment')),
            target_id              TEXT NOT NULL,
            approved_override_json TEXT NOT NULL,
            reason                 TEXT NOT NULL CHECK (length(trim(reason)) > 0),
            expires_at_unix_secs   INTEGER,
            created_at             TEXT NOT NULL,
            created_by_session_id  TEXT,
            revoked_at             TEXT,
            integrity_tag          BLOB{exception_columns_sql}
        );
        INSERT INTO tiga_policy_exceptions_v10
            ({exception_copy_columns})
        SELECT {exception_copy_columns}
        FROM tiga_policy_exceptions;

        CREATE TABLE tiga_policy_overrides_v10 (
            scope_type           TEXT NOT NULL CHECK (scope_type IN ('vault', 'project', 'entry', 'attachment')),
            scope_id             TEXT NOT NULL,
            policy_json          TEXT NOT NULL,
            exception_id         TEXT,
            updated_at           TEXT NOT NULL,
            updated_by_device_id TEXT NOT NULL,
            integrity_tag        BLOB{override_columns_sql},
            PRIMARY KEY (scope_type, scope_id),
            FOREIGN KEY (exception_id) REFERENCES tiga_policy_exceptions_v10(exception_id)
        );
        INSERT INTO tiga_policy_overrides_v10
            ({override_copy_columns})
        SELECT {override_copy_columns}
        FROM tiga_policy_overrides;

        DROP TABLE tiga_policy_overrides;
        DROP TABLE tiga_policy_exceptions;
        ALTER TABLE tiga_policy_exceptions_v10 RENAME TO tiga_policy_exceptions;
        ALTER TABLE tiga_policy_overrides_v10 RENAME TO tiga_policy_overrides;
        CREATE INDEX idx_tiga_exceptions_target
            ON tiga_policy_exceptions (target_scope, target_id, revoked_at);"
    );

    conn.execute_batch(&migration_sql)
        .map_err(StorageError::Database)
}

fn preserved_columns(
    conn: &Connection,
    table: &str,
    known_columns: &[&str],
) -> StorageResult<Vec<PreservedColumn>> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_xinfo({})", quote_identifier(table)))
        .map_err(StorageError::Database)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })
        .map_err(StorageError::Database)?;

    let mut preserved = Vec::new();
    let mut metadata_bytes = 0usize;
    for row in rows {
        let (name, declared_type, not_null, default_value, primary_key, hidden) =
            row.map_err(StorageError::Database)?;
        if known_columns
            .iter()
            .any(|known| known.eq_ignore_ascii_case(&name))
        {
            continue;
        }
        if primary_key != 0 {
            return Err(StorageError::Validation(format!(
                "cannot preserve unknown primary-key column {table}.{name}"
            )));
        }
        if hidden != 0 {
            return Err(StorageError::Validation(format!(
                "cannot preserve unknown generated column {table}.{name}"
            )));
        }
        if not_null != 0 && default_value.is_none() {
            return Err(StorageError::Validation(format!(
                "cannot preserve unknown NOT NULL column {table}.{name} without a default"
            )));
        }
        validate_column_metadata(table, &name, &declared_type, default_value.as_deref())?;
        metadata_bytes = metadata_bytes
            .checked_add(name.len())
            .and_then(|value| value.checked_add(declared_type.len()))
            .and_then(|value| value.checked_add(default_value.as_ref().map_or(0, String::len)))
            .ok_or_else(|| StorageError::ResourceLimit {
                resource: "schema extension metadata".to_string(),
                actual: u64::MAX,
                limit: MAX_PRESERVED_COLUMN_METADATA_BYTES as u64,
            })?;
        if metadata_bytes > MAX_PRESERVED_COLUMN_METADATA_BYTES {
            return Err(StorageError::ResourceLimit {
                resource: "schema extension metadata".to_string(),
                actual: metadata_bytes as u64,
                limit: MAX_PRESERVED_COLUMN_METADATA_BYTES as u64,
            });
        }
        preserved.push(PreservedColumn {
            name,
            declared_type,
            not_null: not_null != 0,
            default_value,
        });
        if preserved.len() > MAX_PRESERVED_COLUMNS {
            return Err(StorageError::ResourceLimit {
                resource: "schema extension columns".to_string(),
                actual: preserved.len() as u64,
                limit: MAX_PRESERVED_COLUMNS as u64,
            });
        }
    }
    Ok(preserved)
}

fn validate_column_metadata(
    table: &str,
    name: &str,
    declared_type: &str,
    default_value: Option<&str>,
) -> StorageResult<()> {
    if name.is_empty() || name.contains('\0') {
        return Err(StorageError::Validation(format!(
            "invalid unknown column name in {table}"
        )));
    }
    let mut depth = 0usize;
    for character in declared_type.chars() {
        if character == '(' {
            depth += 1;
        } else if character == ')' {
            depth = depth.checked_sub(1).ok_or_else(|| {
                StorageError::Validation(format!("invalid type for unknown column {table}.{name}"))
            })?;
        } else if !(character.is_ascii_alphanumeric()
            || character == '_'
            || character.is_ascii_whitespace()
            || character == ',')
        {
            return Err(StorageError::Validation(format!(
                "unsupported type for unknown column {table}.{name}"
            )));
        }
    }
    if depth != 0 {
        return Err(StorageError::Validation(format!(
            "invalid type for unknown column {table}.{name}"
        )));
    }
    if let Some(default_value) = default_value {
        if !is_safe_default(default_value) {
            return Err(StorageError::Validation(format!(
                "unsupported default for unknown column {table}.{name}"
            )));
        }
    }
    Ok(())
}

fn is_safe_default(value: &str) -> bool {
    let value = value.trim();
    if value.eq_ignore_ascii_case("null")
        || value.eq_ignore_ascii_case("true")
        || value.eq_ignore_ascii_case("false")
        || value.eq_ignore_ascii_case("current_time")
        || value.eq_ignore_ascii_case("current_date")
        || value.eq_ignore_ascii_case("current_timestamp")
        || value.parse::<f64>().is_ok()
    {
        return true;
    }
    if value.len() >= 3 && value.starts_with("X'") && value.ends_with('\'') {
        let hexadecimal = &value[2..value.len() - 1];
        return hexadecimal.len() % 2 == 0
            && hexadecimal
                .chars()
                .all(|character| character.is_ascii_hexdigit());
    }
    if value.len() >= 2 && value.starts_with('\'') && value.ends_with('\'') {
        let mut characters = value[1..value.len() - 1].chars();
        while let Some(character) = characters.next() {
            if character == '\'' && characters.next() != Some('\'') {
                return false;
            }
        }
        return true;
    }
    false
}

fn column_declarations(columns: &[PreservedColumn]) -> String {
    let mut declarations = String::new();
    for column in columns {
        declarations.push_str(",\n            ");
        declarations.push_str(&quote_identifier(&column.name));
        declarations.push(' ');
        declarations.push_str(if column.declared_type.is_empty() {
            "BLOB"
        } else {
            &column.declared_type
        });
        if column.not_null {
            declarations.push_str(" NOT NULL");
        }
        if let Some(default_value) = &column.default_value {
            declarations.push_str(" DEFAULT ");
            declarations.push_str(default_value);
        }
    }
    declarations
}

fn copy_column_list(known_columns: &[&str], preserved: &[PreservedColumn]) -> String {
    known_columns
        .iter()
        .map(|column| quote_identifier(column))
        .chain(
            preserved
                .iter()
                .map(|column| quote_identifier(&column.name)),
        )
        .collect::<Vec<_>>()
        .join(", ")
}

fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('\"', "\"\""))
}

fn table_sql(conn: &Connection, table: &str) -> StorageResult<String> {
    conn.query_row(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |row| row.get(0),
    )
    .optional()
    .map_err(StorageError::Database)?
    .ok_or_else(|| StorageError::Validation(format!("missing required table {table}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema;

    #[test]
    fn schema_10_accepts_attachment_tiga_scopes() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        schema::create_all_tables(&conn).unwrap();
        conn.execute(
            "INSERT INTO tiga_policy_exceptions
                (exception_id, target_scope, target_id, approved_override_json,
                 reason, created_at)
             VALUES ('e1', 'attachment', 'a1', '{}', 'test', '2026-07-20T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tiga_policy_overrides
                (scope_type, scope_id, policy_json, exception_id, updated_at,
                 updated_by_device_id)
             VALUES ('attachment', 'a1', '{}', 'e1', '2026-07-20T00:00:00Z', 'd1')",
            [],
        )
        .unwrap();
    }

    #[test]
    fn schema_10_rebuild_preserves_existing_policy_rows_and_foreign_keys() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE tiga_policy_exceptions (
                exception_id TEXT PRIMARY KEY NOT NULL,
                target_scope TEXT NOT NULL CHECK (target_scope IN ('vault', 'project', 'entry')),
                target_id TEXT NOT NULL,
                approved_override_json TEXT NOT NULL,
                reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
                expires_at_unix_secs INTEGER,
                created_at TEXT NOT NULL,
                created_by_session_id TEXT,
                revoked_at TEXT,
                integrity_tag BLOB
             );
             CREATE TABLE tiga_policy_overrides (
                scope_type TEXT NOT NULL CHECK (scope_type IN ('vault', 'project', 'entry')),
                scope_id TEXT NOT NULL,
                policy_json TEXT NOT NULL,
                exception_id TEXT,
                updated_at TEXT NOT NULL,
                updated_by_device_id TEXT NOT NULL,
                integrity_tag BLOB,
                PRIMARY KEY (scope_type, scope_id),
                FOREIGN KEY (exception_id) REFERENCES tiga_policy_exceptions(exception_id)
             );
             CREATE INDEX idx_tiga_exceptions_target
                ON tiga_policy_exceptions (target_scope, target_id, revoked_at);
             INSERT INTO tiga_policy_exceptions
                (exception_id, target_scope, target_id, approved_override_json,
                 reason, created_at)
             VALUES ('legacy-exception', 'project', 'p1', '{}', 'legacy',
                     '2026-07-19T00:00:00Z');
             INSERT INTO tiga_policy_overrides
                (scope_type, scope_id, policy_json, exception_id, updated_at,
                 updated_by_device_id)
             VALUES ('project', 'p1', '{}', 'legacy-exception',
                     '2026-07-19T00:00:00Z', 'd1');",
        )
        .unwrap();

        create_extensions(&conn).unwrap();

        let preserved: (String, String) = conn
            .query_row(
                "SELECT e.target_scope, o.scope_type
                 FROM tiga_policy_exceptions e
                 JOIN tiga_policy_overrides o ON o.exception_id = e.exception_id
                 WHERE e.exception_id = 'legacy-exception'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(preserved, ("project".to_string(), "project".to_string()));
        let foreign_key_target: String = conn
            .query_row(
                "PRAGMA foreign_key_list(tiga_policy_overrides)",
                [],
                |row| row.get(2),
            )
            .unwrap();
        assert_eq!(foreign_key_target, "tiga_policy_exceptions");
        let foreign_key_errors: i64 = conn
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(foreign_key_errors, 0);

        conn.execute(
            "INSERT INTO tiga_policy_overrides
                (scope_type, scope_id, policy_json, updated_at, updated_by_device_id)
             VALUES ('attachment', 'a1', '{}', '2026-07-20T00:00:00Z', 'd1')",
            [],
        )
        .unwrap();
    }

    #[test]
    fn schema_10_rebuild_preserves_unknown_additive_columns_and_values() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE tiga_policy_exceptions (
                exception_id TEXT PRIMARY KEY NOT NULL,
                target_scope TEXT NOT NULL CHECK (target_scope IN ('vault', 'project', 'entry')),
                target_id TEXT NOT NULL,
                approved_override_json TEXT NOT NULL,
                reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
                expires_at_unix_secs INTEGER,
                created_at TEXT NOT NULL,
                created_by_session_id TEXT,
                revoked_at TEXT,
                integrity_tag BLOB,
                future_note TEXT,
                future_counter INTEGER NOT NULL DEFAULT 7
             );
             CREATE TABLE tiga_policy_overrides (
                scope_type TEXT NOT NULL CHECK (scope_type IN ('vault', 'project', 'entry')),
                scope_id TEXT NOT NULL,
                policy_json TEXT NOT NULL,
                exception_id TEXT,
                updated_at TEXT NOT NULL,
                updated_by_device_id TEXT NOT NULL,
                integrity_tag BLOB,
                future_note TEXT,
                future_counter INTEGER NOT NULL DEFAULT 11,
                PRIMARY KEY (scope_type, scope_id),
                FOREIGN KEY (exception_id) REFERENCES tiga_policy_exceptions(exception_id)
             );
             INSERT INTO tiga_policy_exceptions
                (exception_id, target_scope, target_id, approved_override_json,
                 reason, created_at, future_note, future_counter)
             VALUES ('future-exception', 'project', 'p1', '{}', 'legacy',
                     '2026-07-19T00:00:00Z', 'keep-me', 42);
             INSERT INTO tiga_policy_overrides
                (scope_type, scope_id, policy_json, exception_id, updated_at,
                 updated_by_device_id, future_note, future_counter)
             VALUES ('project', 'p1', '{}', 'future-exception',
                     '2026-07-19T00:00:00Z', 'd1', 'also-keep-me', 84);
             CREATE INDEX idx_tiga_exceptions_target
                ON tiga_policy_exceptions (target_scope, target_id, revoked_at);",
        )
        .unwrap();

        create_extensions(&conn).unwrap();

        let exception: (String, i64) = conn
            .query_row(
                "SELECT future_note, future_counter
                 FROM tiga_policy_exceptions WHERE exception_id = 'future-exception'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(exception, ("keep-me".to_string(), 42));
        let override_row: (String, i64) = conn
            .query_row(
                "SELECT future_note, future_counter
                 FROM tiga_policy_overrides WHERE scope_type = 'project' AND scope_id = 'p1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(override_row, ("also-keep-me".to_string(), 84));
    }
}
