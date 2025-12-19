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

async function applyMigrations() {
    // Create migrations table if not exists
    await runAsync(`
        CREATE TABLE IF NOT EXISTS migrations (
            id INTEGER PRIMARY KEY,
            version INTEGER UNIQUE,
            applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Get current version
    const current = await getAsync('SELECT MAX(version) as version FROM migrations');
    const currentVersion = current?.version || 0;

    // Get SQL files
    const sqlFiles = fs.readdirSync(PATHS.sql)
        .filter(f => f.endsWith('.sql'))
        .sort();

    for (const file of sqlFiles) {
        const version = parseInt(file.split('_')[0]);
        if (version > currentVersion) {
            logger?.info('db', `Applying migration: ${file}`);
            const sql = fs.readFileSync(path.join(PATHS.sql, file), 'utf8');

            // Split by semicolons and execute each statement
            // Filter out empty statements and comment-only statements
            const statements = sql.split(';')
                .map(s => s.trim())
                .filter(s => s && !s.split('\n').every(line => !line.trim() || line.trim().startsWith('--')));
            for (const stmt of statements) {
                await runAsync(stmt);
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
