const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let logger = null;
let db = null;
let app = null;
let settings = null;
let epg = null;
let iptv = null;

// Active recordings (recordingId -> process info)
const activeRecordings = new Map();

// Scheduler interval handle
let schedulerInterval = null;

// Task execution lock to prevent concurrent runs
let isProcessing = false;

/**
 * Initialize scheduler tasks on startup
 * Sets up periodic tasks like EPG sync, source refresh
 */
async function initSchedulerTasks() {
    // Check if we have EPG sync task
    const epgTask = await db.get("SELECT * FROM scheduler_tasks WHERE task_type = 'epg_sync' AND status = 'active'");

    if (!epgTask) {
        // Create daily EPG sync task at configured hour (default 4am)
        const syncHour = settings.get('epgSyncHour') || 4;
        const now = new Date();
        const nextRun = new Date(now);
        nextRun.setHours(syncHour, 0, 0, 0);

        // If already past the sync hour, schedule for tomorrow
        if (nextRun <= now) {
            nextRun.setDate(nextRun.getDate() + 1);
        }

        await db.run(`
            INSERT INTO scheduler_tasks (task_type, next_run, interval_minutes, status)
            VALUES ('epg_sync', ?, 1440, 'active')
        `, [nextRun.toISOString()]);

        logger.info('scheduler', `Created EPG sync task for ${nextRun.toISOString()}`);
    }

    // Check if we have source sync task
    const sourceTask = await db.get("SELECT * FROM scheduler_tasks WHERE task_type = 'source_sync' AND status = 'active'");

    if (!sourceTask) {
        // Create source sync task based on settings
        const intervalHours = settings.get('sourceSyncIntervalHours') || 24;
        const now = new Date();
        const nextRun = new Date(now.getTime() + intervalHours * 60 * 60 * 1000);

        await db.run(`
            INSERT INTO scheduler_tasks (task_type, next_run, interval_minutes, status)
            VALUES ('source_sync', ?, ?, 'active')
        `, [nextRun.toISOString(), intervalHours * 60]);

        logger.info('scheduler', `Created source sync task with ${intervalHours}h interval`);
    }

    // Check if we have cleanup task
    const cleanupTask = await db.get("SELECT * FROM scheduler_tasks WHERE task_type = 'cleanup' AND status = 'active'");

    if (!cleanupTask) {
        // Create daily cleanup task at 3am
        const now = new Date();
        const nextRun = new Date(now);
        nextRun.setHours(3, 0, 0, 0);

        if (nextRun <= now) {
            nextRun.setDate(nextRun.getDate() + 1);
        }

        await db.run(`
            INSERT INTO scheduler_tasks (task_type, next_run, interval_minutes, status)
            VALUES ('cleanup', ?, 1440, 'active')
        `, [nextRun.toISOString()]);

        logger.info('scheduler', `Created cleanup task for ${nextRun.toISOString()}`);
    }
}

/**
 * Start the scheduler loop
 * Checks every minute for tasks to run
 */
function startScheduler() {
    if (schedulerInterval) {
        clearInterval(schedulerInterval);
    }

    // Check every 30 seconds for tasks
    schedulerInterval = setInterval(async () => {
        if (isProcessing) return;

        isProcessing = true;
        try {
            await processScheduledTasks();
            await processScheduledRecordings();
        } catch (err) {
            logger.error('scheduler', `Scheduler error: ${err.message}`);
        } finally {
            isProcessing = false;
        }
    }, 30000);

    logger.info('scheduler', 'Scheduler started (30s interval)');

    // Run immediately on start
    processScheduledTasks().catch(err => {
        logger.error('scheduler', `Initial task check failed: ${err.message}`);
    });
}

/**
 * Stop the scheduler
 */
function stopScheduler() {
    if (schedulerInterval) {
        clearInterval(schedulerInterval);
        schedulerInterval = null;
    }
    logger.info('scheduler', 'Scheduler stopped');
}

/**
 * Process all pending scheduled tasks
 */
async function processScheduledTasks() {
    const now = new Date().toISOString();

    // Get tasks that are due
    const dueTasks = await db.all(`
        SELECT * FROM scheduler_tasks
        WHERE status = 'active' AND next_run <= ?
        ORDER BY next_run ASC
    `, [now]);

    for (const task of dueTasks) {
        try {
            logger.info('scheduler', `Running task: ${task.task_type} (id: ${task.id})`);

            await executeTask(task);

            // Update last_run and calculate next_run
            if (task.interval_minutes) {
                const nextRun = new Date(Date.now() + task.interval_minutes * 60 * 1000);
                await db.run(`
                    UPDATE scheduler_tasks
                    SET last_run = ?, next_run = ?, error_message = NULL
                    WHERE id = ?
                `, [now, nextRun.toISOString(), task.id]);
            } else {
                // One-time task, mark as completed
                await db.run(`
                    UPDATE scheduler_tasks
                    SET last_run = ?, status = 'completed', error_message = NULL
                    WHERE id = ?
                `, [now, task.id]);
            }

        } catch (err) {
            logger.error('scheduler', `Task ${task.id} failed: ${err.message}`);

            await db.run(`
                UPDATE scheduler_tasks
                SET error_message = ?
                WHERE id = ?
            `, [err.message, task.id]);
        }
    }
}

/**
 * Execute a specific task
 */
async function executeTask(task) {
    const taskData = task.task_data ? JSON.parse(task.task_data) : {};

    switch (task.task_type) {
        case 'epg_sync':
            await epg.syncGlobalEpg();
            break;

        case 'source_sync':
            // Refresh all IPTV sources
            const sources = await db.all("SELECT * FROM sources WHERE enabled = 1");
            for (const source of sources) {
                try {
                    await iptv.refreshSource(source.id);
                } catch (err) {
                    logger.error('scheduler', `Failed to refresh source ${source.id}: ${err.message}`);
                }
            }
            break;

        case 'cleanup':
            await runCleanup();
            break;

        case 'recording':
            // Handle recording task (start/stop)
            if (taskData.action === 'start') {
                await startRecording(taskData.recordingId);
            } else if (taskData.action === 'stop') {
                await stopRecording(taskData.recordingId);
            }
            break;

        default:
            logger.warn('scheduler', `Unknown task type: ${task.task_type}`);
    }
}

/**
 * Run cleanup tasks
 */
async function runCleanup() {
    const now = new Date();

    // Delete old EPG data (programs that ended more than 7 days ago)
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const result = await db.run(`
        DELETE FROM epg_programs WHERE end_time < ?
    `, [weekAgo.toISOString()]);

    logger.info('scheduler', `Cleanup: removed ${result.changes || 0} old EPG entries`);

    // Clean temp files older than 24 hours
    const tempPath = settings.get('tempPath');
    if (tempPath && fs.existsSync(tempPath)) {
        const dayAgo = now.getTime() - 24 * 60 * 60 * 1000;

        try {
            const files = fs.readdirSync(tempPath);
            let cleaned = 0;

            for (const file of files) {
                const filePath = path.join(tempPath, file);
                const stat = fs.statSync(filePath);

                if (stat.isFile() && stat.mtimeMs < dayAgo) {
                    fs.unlinkSync(filePath);
                    cleaned++;
                }
            }

            if (cleaned > 0) {
                logger.info('scheduler', `Cleanup: removed ${cleaned} temp files`);
            }
        } catch (err) {
            logger.warn('scheduler', `Cleanup temp files error: ${err.message}`);
        }
    }
}

/**
 * Process scheduled recordings
 */
async function processScheduledRecordings() {
    const now = new Date();
    const nowIso = now.toISOString();

    // Check for recordings that should start
    const toStart = await db.all(`
        SELECT * FROM scheduled_recordings
        WHERE status = 'scheduled' AND start_time <= ?
        ORDER BY start_time ASC
    `, [nowIso]);

    for (const recording of toStart) {
        // Check if already past end time
        if (new Date(recording.end_time) <= now) {
            await db.run(`
                UPDATE scheduled_recordings
                SET status = 'failed', error_message = 'Missed scheduled start time'
                WHERE id = ?
            `, [recording.id]);
            continue;
        }

        await startRecording(recording.id);
    }

    // Check for recordings that should stop
    const toStop = await db.all(`
        SELECT * FROM scheduled_recordings
        WHERE status = 'recording' AND end_time <= ?
        ORDER BY end_time ASC
    `, [nowIso]);

    for (const recording of toStop) {
        await stopRecording(recording.id);
    }
}

/**
 * Start a recording
 */
async function startRecording(recordingId) {
    const recording = await db.get('SELECT * FROM scheduled_recordings WHERE id = ?', [recordingId]);

    if (!recording) {
        logger.error('scheduler', `Recording ${recordingId} not found`);
        return;
    }

    if (recording.status !== 'scheduled') {
        logger.warn('scheduler', `Recording ${recordingId} is not scheduled (status: ${recording.status})`);
        return;
    }

    // Get the media item (channel)
    const channel = await db.get('SELECT * FROM media WHERE id = ?', [recording.media_id]);

    if (!channel || !channel.stream_url) {
        await db.run(`
            UPDATE scheduled_recordings
            SET status = 'failed', error_message = 'Channel not found or no stream URL'
            WHERE id = ?
        `, [recordingId]);
        return;
    }

    // Create recordings directory if needed
    const recordingsPath = settings.get('recordingsPath');
    if (!fs.existsSync(recordingsPath)) {
        fs.mkdirSync(recordingsPath, { recursive: true });
    }

    // Generate output filename
    const safeTitle = recording.title.replace(/[^a-z0-9]/gi, '_').substring(0, 50);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${safeTitle}_${timestamp}.ts`;
    const outputPath = path.join(recordingsPath, filename);

    logger.info('scheduler', `Starting recording: ${recording.title} -> ${filename}`);

    try {
        // Check if ffmpeg is available
        const ffmpegPath = await findFfmpeg();

        if (!ffmpegPath) {
            throw new Error('ffmpeg not found. Please install ffmpeg for recording support.');
        }

        // Build ffmpeg command
        const args = [
            '-y',                    // Overwrite output
            '-i', channel.stream_url,
            '-c', 'copy',            // Copy streams without re-encoding
            '-f', 'mpegts',          // Output format
            outputPath
        ];

        // Add timeout if we know the end time
        const endTime = new Date(recording.end_time);
        const durationSeconds = Math.ceil((endTime.getTime() - Date.now()) / 1000);

        if (durationSeconds > 0) {
            args.splice(0, 0, '-t', String(durationSeconds));
        }

        // Start ffmpeg process
        const ffmpegProcess = spawn(ffmpegPath, args, {
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        // Store process info
        activeRecordings.set(recordingId, {
            process: ffmpegProcess,
            outputPath,
            startTime: new Date()
        });

        // Update database
        await db.run(`
            UPDATE scheduled_recordings
            SET status = 'recording', output_path = ?, pid = ?
            WHERE id = ?
        `, [outputPath, ffmpegProcess.pid, recordingId]);

        app?.emit('recording:started', {
            id: recordingId,
            title: recording.title,
            outputPath
        });

        // Handle process completion
        ffmpegProcess.on('exit', async (code) => {
            const info = activeRecordings.get(recordingId);
            activeRecordings.delete(recordingId);

            if (code === 0 || code === 255) {
                // Success or killed (which is expected when we stop it)
                const stats = fs.existsSync(outputPath) ? fs.statSync(outputPath) : null;

                await db.run(`
                    UPDATE scheduled_recordings
                    SET status = 'completed', file_size = ?, pid = NULL
                    WHERE id = ?
                `, [stats?.size || 0, recordingId]);

                logger.info('scheduler', `Recording completed: ${recording.title}`);
                app?.emit('recording:completed', {
                    id: recordingId,
                    title: recording.title,
                    outputPath,
                    fileSize: stats?.size
                });
            } else {
                await db.run(`
                    UPDATE scheduled_recordings
                    SET status = 'failed', error_message = ?, pid = NULL
                    WHERE id = ?
                `, [`ffmpeg exited with code ${code}`, recordingId]);

                logger.error('scheduler', `Recording failed: ${recording.title} (code: ${code})`);
                app?.emit('recording:failed', {
                    id: recordingId,
                    title: recording.title,
                    error: `ffmpeg exited with code ${code}`
                });
            }
        });

        ffmpegProcess.stderr.on('data', (data) => {
            // Log ffmpeg output at debug level
            logger.debug('scheduler', `ffmpeg [${recordingId}]: ${data.toString().trim()}`);
        });

    } catch (err) {
        logger.error('scheduler', `Failed to start recording: ${err.message}`);

        await db.run(`
            UPDATE scheduled_recordings
            SET status = 'failed', error_message = ?
            WHERE id = ?
        `, [err.message, recordingId]);

        app?.emit('recording:failed', {
            id: recordingId,
            title: recording.title,
            error: err.message
        });
    }
}

/**
 * Stop a recording
 */
async function stopRecording(recordingId) {
    const info = activeRecordings.get(recordingId);

    if (info && info.process) {
        logger.info('scheduler', `Stopping recording ${recordingId}`);

        // Send SIGTERM to stop ffmpeg gracefully
        info.process.kill('SIGTERM');

        // Give it a few seconds, then force kill if needed
        setTimeout(() => {
            if (info.process && !info.process.killed) {
                info.process.kill('SIGKILL');
            }
        }, 5000);
    } else {
        // Process not running, check if we need to update status
        const recording = await db.get('SELECT * FROM scheduled_recordings WHERE id = ?', [recordingId]);

        if (recording && recording.status === 'recording') {
            // Might have been stopped externally
            const stats = recording.output_path && fs.existsSync(recording.output_path)
                ? fs.statSync(recording.output_path)
                : null;

            await db.run(`
                UPDATE scheduled_recordings
                SET status = 'completed', file_size = ?, pid = NULL
                WHERE id = ?
            `, [stats?.size || 0, recordingId]);
        }
    }
}

/**
 * Cancel a scheduled recording
 */
async function cancelRecording(recordingId) {
    const recording = await db.get('SELECT * FROM scheduled_recordings WHERE id = ?', [recordingId]);

    if (!recording) {
        throw new Error('Recording not found');
    }

    if (recording.status === 'recording') {
        await stopRecording(recordingId);
    }

    await db.run(`
        UPDATE scheduled_recordings
        SET status = 'cancelled'
        WHERE id = ?
    `, [recordingId]);

    logger.info('scheduler', `Recording ${recordingId} cancelled`);

    app?.emit('recording:cancelled', {
        id: recordingId,
        title: recording.title
    });
}

/**
 * Schedule a new recording
 */
async function scheduleRecording(mediaId, title, startTime, endTime, options = {}) {
    // Validate media exists
    const media = await db.get('SELECT * FROM media WHERE id = ?', [mediaId]);

    if (!media) {
        throw new Error('Channel not found');
    }

    if (media.media_type !== 'live') {
        throw new Error('Can only record live TV channels');
    }

    // Validate times
    const start = new Date(startTime);
    const end = new Date(endTime);
    const now = new Date();

    if (start >= end) {
        throw new Error('End time must be after start time');
    }

    if (end <= now) {
        throw new Error('End time is in the past');
    }

    // Create the recording
    const result = await db.run(`
        INSERT INTO scheduled_recordings (media_id, title, channel_name, start_time, end_time, recurrence, epg_program_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
        mediaId,
        title,
        media.title,
        start.toISOString(),
        end.toISOString(),
        options.recurrence || null,
        options.epgProgramId || null
    ]);

    logger.info('scheduler', `Scheduled recording: ${title} on ${media.title} from ${start.toISOString()} to ${end.toISOString()}`);

    app?.emit('recording:scheduled', {
        id: result.lastID,
        title,
        channel: media.title,
        startTime: start,
        endTime: end
    });

    return {
        id: result.lastID,
        mediaId,
        title,
        channelName: media.title,
        startTime: start,
        endTime: end
    };
}

/**
 * Get all scheduled recordings
 */
async function getRecordings(filter = {}) {
    let sql = 'SELECT * FROM scheduled_recordings';
    const params = [];
    const conditions = [];

    if (filter.status) {
        conditions.push('status = ?');
        params.push(filter.status);
    }

    if (filter.mediaId) {
        conditions.push('media_id = ?');
        params.push(filter.mediaId);
    }

    if (filter.upcoming) {
        conditions.push("(status = 'scheduled' OR status = 'recording')");
    }

    if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY start_time DESC';

    if (filter.limit) {
        sql += ' LIMIT ?';
        params.push(filter.limit);
    }

    return db.all(sql, params);
}

/**
 * Get a single recording by ID
 */
async function getRecording(recordingId) {
    return db.get('SELECT * FROM scheduled_recordings WHERE id = ?', [recordingId]);
}

/**
 * Delete a recording (and its file if completed)
 */
async function deleteRecording(recordingId, deleteFile = false) {
    const recording = await db.get('SELECT * FROM scheduled_recordings WHERE id = ?', [recordingId]);

    if (!recording) {
        throw new Error('Recording not found');
    }

    if (recording.status === 'recording') {
        await stopRecording(recordingId);
    }

    // Delete the file if requested and it exists
    if (deleteFile && recording.output_path && fs.existsSync(recording.output_path)) {
        fs.unlinkSync(recording.output_path);
        logger.info('scheduler', `Deleted recording file: ${recording.output_path}`);
    }

    await db.run('DELETE FROM scheduled_recordings WHERE id = ?', [recordingId]);

    logger.info('scheduler', `Deleted recording ${recordingId}`);
}

/**
 * Find ffmpeg binary
 */
async function findFfmpeg() {
    const { execSync } = require('child_process');

    // Common ffmpeg locations
    const paths = [
        'ffmpeg',
        '/usr/bin/ffmpeg',
        '/usr/local/bin/ffmpeg',
        '/opt/homebrew/bin/ffmpeg',
        'C:\\ffmpeg\\bin\\ffmpeg.exe'
    ];

    for (const ffmpegPath of paths) {
        try {
            execSync(`"${ffmpegPath}" -version`, { stdio: 'ignore' });
            return ffmpegPath;
        } catch (err) {
            // Not found at this path
        }
    }

    return null;
}

/**
 * Check if ffmpeg is available
 */
async function checkFfmpeg() {
    const ffmpegPath = await findFfmpeg();
    return {
        available: !!ffmpegPath,
        path: ffmpegPath
    };
}

/**
 * Get scheduler status and active tasks
 */
async function getStatus() {
    const tasks = await db.all(`
        SELECT * FROM scheduler_tasks
        WHERE status = 'active'
        ORDER BY next_run ASC
    `);

    const upcomingRecordings = await db.all(`
        SELECT * FROM scheduled_recordings
        WHERE status IN ('scheduled', 'recording')
        ORDER BY start_time ASC
        LIMIT 10
    `);

    return {
        running: !!schedulerInterval,
        activeRecordings: activeRecordings.size,
        tasks,
        upcomingRecordings
    };
}

/**
 * Trigger a task manually
 */
async function triggerTask(taskType) {
    let task;

    switch (taskType) {
        case 'epg_sync':
            await epg.syncGlobalEpg();
            break;

        case 'source_sync':
            const sources = await db.all("SELECT * FROM sources WHERE enabled = 1");
            for (const source of sources) {
                try {
                    await iptv.refreshSource(source.id);
                } catch (err) {
                    logger.error('scheduler', `Failed to refresh source ${source.id}: ${err.message}`);
                }
            }
            break;

        case 'cleanup':
            await runCleanup();
            break;

        default:
            throw new Error(`Unknown task type: ${taskType}`);
    }

    logger.info('scheduler', `Manually triggered task: ${taskType}`);
}

module.exports = {
    init: async (modules) => {
        logger = modules.logger;
        db = modules.db;
        app = modules.app;
        settings = modules.settings;
        epg = modules.epg;
        iptv = modules.iptv;

        // Initialize scheduler tasks
        await initSchedulerTasks();

        // Start the scheduler
        startScheduler();
    },

    shutdown: async () => {
        stopScheduler();

        // Stop all active recordings
        for (const [recordingId, info] of activeRecordings) {
            if (info.process) {
                info.process.kill('SIGTERM');
            }
        }
    },

    // Recording management
    scheduleRecording,
    getRecordings,
    getRecording,
    cancelRecording,
    deleteRecording,
    startRecording,
    stopRecording,

    // Scheduler management
    getStatus,
    triggerTask,

    // Utilities
    checkFfmpeg
};
