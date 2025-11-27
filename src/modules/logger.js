// Logger module with persistent storage (72-hour retention)
const levels = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
};

let currentLevel = levels.info;
let io = null;
let db = null;
let cleanupInterval = null;

// 72 hours in milliseconds
const LOG_RETENTION_MS = 72 * 60 * 60 * 1000;

function formatTime() {
    return new Date().toISOString().slice(11, 19);
}

async function persistLog(level, module, message, data) {
    if (!db) return;

    try {
        await db.run(
            'INSERT INTO logs (level, module, message, data) VALUES (?, ?, ?, ?)',
            [level, module, message, data ? JSON.stringify(data) : null]
        );
    } catch (err) {
        // Don't log this error to avoid infinite loop, just output to console
        console.error(`[Logger] Failed to persist log: ${err.message}`);
    }
}

async function cleanupOldLogs() {
    if (!db) return;

    try {
        const cutoff = new Date(Date.now() - LOG_RETENTION_MS).toISOString();
        const result = await db.run('DELETE FROM logs WHERE created_at < ?', [cutoff]);
        if (result.changes > 0) {
            console.log(`[Logger] Cleaned up ${result.changes} old log entries`);
        }
    } catch (err) {
        console.error(`[Logger] Failed to cleanup old logs: ${err.message}`);
    }
}

function log(level, module, message, data = null) {
    if (levels[level] < currentLevel) return;

    const prefix = `[${formatTime()}] [${level.toUpperCase()}] [${module}]`;
    const fullMessage = data ? `${prefix} ${message} ${JSON.stringify(data)}` : `${prefix} ${message}`;

    switch (level) {
        case 'error':
            console.error(fullMessage);
            break;
        case 'warn':
            console.warn(fullMessage);
            break;
        default:
            console.log(fullMessage);
    }

    // Persist to database (async, don't wait)
    persistLog(level, module, message, data);

    // Emit to connected clients
    if (io) {
        io.emit('log', { level, module, message, data, timestamp: Date.now() });
    }
}

module.exports = {
    init: async (modules) => {
        currentLevel = levels[process.env.LOG_LEVEL || 'info'];
        db = modules.db;

        // Cleanup old logs on startup and every hour
        if (db) {
            await cleanupOldLogs();
            cleanupInterval = setInterval(cleanupOldLogs, 60 * 60 * 1000); // Every hour
        }
    },

    shutdown: async () => {
        if (cleanupInterval) {
            clearInterval(cleanupInterval);
        }
    },

    setIO: (socketIO) => {
        io = socketIO;
    },

    setLevel: (level) => {
        if (levels[level] !== undefined) {
            currentLevel = levels[level];
        }
    },

    // Get logs from database with optional filters
    getLogs: async (options = {}) => {
        if (!db) return [];

        const { level, module, limit = 1000, offset = 0, since } = options;
        let sql = 'SELECT * FROM logs WHERE 1=1';
        const params = [];

        if (level) {
            sql += ' AND level = ?';
            params.push(level);
        }
        if (module) {
            sql += ' AND module = ?';
            params.push(module);
        }
        if (since) {
            sql += ' AND created_at >= ?';
            params.push(new Date(since).toISOString());
        }

        sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        return await db.all(sql, params);
    },

    debug: (module, message, data) => log('debug', module, message, data),
    info: (module, message, data) => log('info', module, message, data),
    warn: (module, message, data) => log('warn', module, message, data),
    error: (module, message, data) => log('error', module, message, data)
};
