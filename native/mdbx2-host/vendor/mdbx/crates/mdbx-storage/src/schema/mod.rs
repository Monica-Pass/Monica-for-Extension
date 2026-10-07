pub mod v1;
pub mod v10;
pub mod v11;
pub mod v12;
pub mod v13;
pub mod v14;
pub mod v15;
pub mod v16;
pub mod v17;
pub mod v2;
pub mod v7;
pub mod v8;
pub mod v9;

use rusqlite::Connection;

use crate::error::StorageResult;

/// 当前 schema 版本号。
pub const SCHEMA_VERSION: u32 = 17;

/// 创建全部表与索引。
pub fn create_all_tables(conn: &Connection) -> StorageResult<()> {
    v1::create_all_tables(conn)?;
    v2::create_extensions(conn)?;
    v7::create_extensions(conn)?;
    v8::create_extensions(conn)?;
    v9::create_extensions(conn)?;
    v10::create_extensions(conn)?;
    v11::create_extensions(conn)?;
    v12::create_extensions(conn)?;
    v13::create_extensions(conn)?;
    v14::create_extensions(conn)?;
    v15::create_extensions(conn)?;
    v16::create_extensions(conn)?;
    v17::create_extensions(conn)
}
