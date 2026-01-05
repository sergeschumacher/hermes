const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

let db = null;
let logger = null;

function runAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function getAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function allAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

// Map of tables to the migration version that creates them
const TABLE_MIGRATIONS = {
    'sources': 1,
    'media': 1,
    'episodes': 1,
    'people': 1,
    'media_people': 1,
    'downloads': 1,
    'requests': 3,
    'tmdb_cache': 4,
    'logs': 7,
    'epg_programs': 11,
    'epg_sync': 11,
    'scheduled_recordings': 12,
    'scheduler_tasks': 12,
    'transcode_queue': 15,
    'media_trailers': 18,
    'enrichment_queue': 19,
    'channel_mappings': 20,
    'epg_channel_cache': 22,
    'seasons': 23,
    'enrichment_cache': 26,
    'source_samples': 27,
    'hdhr_channels': 29,
    'hdhr_category_rules': 29,
    'users': 31,
    'sessions': 31
};

// Map of table.column to migration version that adds them
const COLUMN_MIGRATIONS = {
    'media.show_name': 2,
    'media.season_number': 2,
    'media.episode_number': 2,
    'media.show_language': 2,
    'media.episode_count': 14,
    'media.is_active': 24,
    'media.last_seen_at': 24,
    'media.platform': 25,
    'sources.m3u_parser_config': 30,
};

async function verifyTables() {
    // Get list of existing tables
    const tables = await allAsync(
        "SELECT name FROM sqlite_master WHERE type='table'"
    );
    const existingTables = new Set(tables.map(t => t.name));

    // Check for missing tables and reset their migrations
    const missingMigrations = new Set();
    for (const [table, version] of Object.entries(TABLE_MIGRATIONS)) {
        if (!existingTables.has(table)) {
            logger?.warn('db', `Missing table: ${table} (migration ${version})`);
            missingMigrations.add(version);
        }
    }

    // Reset migrations for missing tables
    if (missingMigrations.size > 0) {
        const versions = Array.from(missingMigrations);
        logger?.info('db', `Resetting migrations for missing tables: ${versions.join(', ')}`);
        for (const version of versions) {
            await runAsync('DELETE FROM migrations WHERE version = ?', [version]);
        }
    }

    return missingMigrations.size;
}

async function verifyColumns() {
    const missingMigrations = new Set();

    // Group columns by table
    const tableColumns = {};
    for (const key of Object.keys(COLUMN_MIGRATIONS)) {
        const [table, column] = key.split('.');
        if (!tableColumns[table]) tableColumns[table] = [];
        tableColumns[table].push(column);
    }

    // Check each table's columns
    for (const [table, columns] of Object.entries(tableColumns)) {
        try {
            const info = await allAsync(`PRAGMA table_info(${table})`);
            const existingColumns = new Set(info.map(c => c.name));

            for (const column of columns) {
                if (!existingColumns.has(column)) {
                    const version = COLUMN_MIGRATIONS[`${table}.${column}`];
                    logger?.warn('db', `Missing column: ${table}.${column} (migration ${version})`);
                    missingMigrations.add(version);
                }
            }
        } catch (err) {
            // Table doesn't exist - will be handled by verifyTables
        }
    }

    // Reset migrations for missing columns
    if (missingMigrations.size > 0) {
        const versions = Array.from(missingMigrations);
        logger?.info('db', `Resetting migrations for missing columns: ${versions.join(', ')}`);
        for (const version of versions) {
            await runAsync('DELETE FROM migrations WHERE version = ?', [version]);
        }
    }

    return missingMigrations.size;
}

async function applyMigrations() {
    // Create migrations table if not exists
    await runAsync(`
        CREATE TABLE IF NOT EXISTS migrations (
            id INTEGER PRIMARY KEY,
            version INTEGER UNIQUE,
            applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Verify tables exist and reset migrations if needed
    const tableResetCount = await verifyTables();
    if (tableResetCount > 0) {
        logger?.info('db', `Will re-run ${tableResetCount} migrations to restore missing tables`);
    }

    // Verify columns exist and reset migrations if needed
    const columnResetCount = await verifyColumns();
    if (columnResetCount > 0) {
        logger?.info('db', `Will re-run ${columnResetCount} migrations to restore missing columns`);
    }

    // Get all applied migrations
    const applied = await allAsync('SELECT version FROM migrations');
    const appliedVersions = new Set(applied.map(m => m.version));

    // Get SQL files
    const sqlFiles = fs.readdirSync(PATHS.sql)
        .filter(f => f.endsWith('.sql'))
        .sort();

    for (const file of sqlFiles) {
        const version = parseInt(file.split('_')[0]);
        // Run migration if not already applied (handles both new and reset migrations)
        if (!appliedVersions.has(version)) {
            logger?.info('db', `Applying migration: ${file}`);
            const sql = fs.readFileSync(path.join(PATHS.sql, file), 'utf8');

            // Split by semicolons and execute each statement
            // Filter out empty statements and comment-only statements
            const statements = sql.split(';')
                .map(s => s.trim())
                .filter(s => s && !s.split('\n').every(line => !line.trim() || line.trim().startsWith('--')));
            for (const stmt of statements) {
                try {
                    await runAsync(stmt);
                } catch (stmtErr) {
                    // Handle common idempotent errors gracefully
                    const errMsg = stmtErr.message || '';
                    if (errMsg.includes('duplicate column name')) {
                        // Column already exists - this is fine, continue
                        logger?.info('db', `Column already exists, skipping: ${errMsg}`);
                    } else if (errMsg.includes('already exists') && stmt.toUpperCase().includes('CREATE TABLE')) {
                        // Table already exists - this is fine for IF NOT EXISTS cases
                        logger?.info('db', `Table already exists, skipping: ${errMsg}`);
                    } else if (errMsg.includes('already exists') && stmt.toUpperCase().includes('CREATE INDEX')) {
                        // Index already exists - this is fine
                        logger?.info('db', `Index already exists, skipping: ${errMsg}`);
                    } else {
                        // Re-throw unknown errors
                        throw stmtErr;
                    }
                }
            }

            await runAsync('INSERT INTO migrations (version) VALUES (?)', [version]);
            logger?.info('db', `Migration ${file} applied`);
        }
    }
}

module.exports = {
    init: async (modules) => {
        logger = modules.logger;

        const dbPath = path.join(PATHS.data, 'hermes.db');

        return new Promise((resolve, reject) => {
            db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, async (err) => {
                if (err) {
                    logger?.error('db', 'Failed to open database', { error: err.message });
                    return reject(err);
                }

                logger?.info('db', 'Database connected');

                try {
                    // Enable foreign key support for CASCADE deletes
                    await runAsync('PRAGMA foreign_keys = ON');
                    // Reduce lock contention for concurrent reads/writes
                    await runAsync('PRAGMA journal_mode = WAL');
                    await runAsync('PRAGMA synchronous = NORMAL');
                    await runAsync('PRAGMA busy_timeout = 5000');

                    await applyMigrations();
                    resolve();
                } catch (migrationErr) {
                    logger?.error('db', 'Migration failed', { error: migrationErr.message });
                    reject(migrationErr);
                }
            });
        });
    },

    shutdown: async () => {
        return new Promise((resolve) => {
            if (db) {
                db.close(() => {
                    logger?.info('db', 'Database closed');
                    resolve();
                });
            } else {
                resolve();
            }
        });
    },

    run: runAsync,
    get: getAsync,
    all: allAsync,

    // Helper to get raw db for complex operations
    raw: () => db
};
