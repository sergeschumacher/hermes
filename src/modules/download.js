const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');

let logger = null;
let db = null;
let settings = null;
let app = null;
let plex = null;

let activeDownloads = 0;
let downloadInterval = null;

// Default assumed video duration for bitrate calculation (in seconds)
// 90 minutes for movies, 45 minutes for episodes
const DEFAULT_MOVIE_DURATION = 90 * 60;
const DEFAULT_EPISODE_DURATION = 45 * 60;

// Throttled stream that limits download speed to simulate playback
class ThrottledStream extends Transform {
    constructor(options = {}) {
        super();
        this.bytesPerSecond = options.bytesPerSecond || Infinity;
        this.bucket = 0;
        this.lastRefill = Date.now();
        this.chunkQueue = [];
        this.processing = false;
        this.variationPercent = options.variationPercent || 0.15; // 15% random variation
    }

    // Add random variation to make it look more natural
    getEffectiveBytesPerSecond() {
        const variation = 1 + (Math.random() * 2 - 1) * this.variationPercent;
        return Math.floor(this.bytesPerSecond * variation);
    }

    _transform(chunk, encoding, callback) {
        if (this.bytesPerSecond === Infinity) {
            // No throttling
            callback(null, chunk);
            return;
        }

        this.chunkQueue.push({ chunk, callback });
        this.processQueue();
    }

    processQueue() {
        if (this.processing || this.chunkQueue.length === 0) return;
        this.processing = true;

        const now = Date.now();
        const elapsed = now - this.lastRefill;
        const effectiveBps = this.getEffectiveBytesPerSecond();

        // Refill bucket based on time elapsed
        this.bucket += (elapsed / 1000) * effectiveBps;
        this.bucket = Math.min(this.bucket, effectiveBps * 2); // Cap at 2 seconds worth
        this.lastRefill = now;

        const { chunk, callback } = this.chunkQueue[0];

        if (this.bucket >= chunk.length) {
            // Enough tokens, send immediately
            this.bucket -= chunk.length;
            this.chunkQueue.shift();
            this.processing = false;
            callback(null, chunk);
            this.processQueue();
        } else {
            // Need to wait for more tokens
            const bytesNeeded = chunk.length - this.bucket;
            const waitTime = Math.ceil((bytesNeeded / effectiveBps) * 1000);

            setTimeout(() => {
                this.bucket = 0; // Use all tokens
                this.chunkQueue.shift();
                this.processing = false;
                callback(null, chunk);
                this.processQueue();
            }, waitTime);
        }
    }

    _flush(callback) {
        // Process any remaining chunks
        if (this.chunkQueue.length > 0) {
            const processRemaining = () => {
                if (this.chunkQueue.length === 0) {
                    callback();
                    return;
                }
                setTimeout(processRemaining, 100);
            };
            processRemaining();
        } else {
            callback();
        }
    }
}

async function getSourceSettings(mediaId) {
    // Get the source settings for this media item
    const media = await db.get(`
        SELECT m.source_id, s.simulate_playback, s.playback_speed_multiplier, s.name as source_name
        FROM media m
        LEFT JOIN sources s ON m.source_id = s.id
        WHERE m.id = ?
    `, [mediaId]);

    return {
        simulatePlayback: media?.simulate_playback ?? 1,
        speedMultiplier: media?.playback_speed_multiplier ?? 1.5,
        sourceName: media?.source_name || 'Unknown'
    };
}

function calculateTargetBytesPerSecond(fileSize, isEpisode, speedMultiplier) {
    if (!fileSize || speedMultiplier === 0) {
        return Infinity; // No throttling
    }

    // Estimate video duration based on type
    const estimatedDuration = isEpisode ? DEFAULT_EPISODE_DURATION : DEFAULT_MOVIE_DURATION;

    // Calculate bitrate: fileSize / duration = bytes per second for 1x playback
    const baseBytesPerSecond = fileSize / estimatedDuration;

    // Apply speed multiplier
    return Math.floor(baseBytesPerSecond * speedMultiplier);
}

async function processQueue() {
    const maxConcurrent = settings.get('maxConcurrentDownloads') || 2;

    if (activeDownloads >= maxConcurrent) return;

    const download = await db.get(`
        SELECT d.*, m.stream_url, m.title, m.media_type, m.source_id, e.stream_url as episode_url
        FROM downloads d
        LEFT JOIN media m ON d.media_id = m.id
        LEFT JOIN episodes e ON d.episode_id = e.id
        WHERE d.status = 'queued'
        ORDER BY d.priority DESC, d.created_at ASC
        LIMIT 1
    `);

    if (!download) return;

    activeDownloads++;
    processDownload(download).finally(() => {
        activeDownloads--;
    });
}

async function processDownload(download) {
    const streamUrl = download.episode_url || download.stream_url;
    if (!streamUrl) {
        await db.run('UPDATE downloads SET status = ?, error_message = ? WHERE id = ?',
            ['failed', 'No stream URL', download.id]);
        return;
    }

    const tempPath = settings.get('tempPath');
    const downloadPath = settings.get('downloadPath');
    const filename = sanitizeFilename(download.title || 'download') + path.extname(streamUrl).split('?')[0];
    const tempFile = path.join(tempPath, `${download.id}_${filename}`);

    // Create directories if needed
    if (!fs.existsSync(tempPath)) fs.mkdirSync(tempPath, { recursive: true });
    if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath, { recursive: true });

    // Get source throttle settings
    const sourceSettings = await getSourceSettings(download.media_id);

    await db.run('UPDATE downloads SET status = ?, started_at = CURRENT_TIMESTAMP, temp_path = ? WHERE id = ?',
        ['downloading', tempFile, download.id]);

    app?.emit('download:start', { id: download.id, title: download.title });

    try {
        const userAgent = settings.getRandomUserAgent();
        const retries = settings.get('downloadRetries') || 3;

        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const isEpisode = !!download.episode_url;
                await downloadFile(download.id, streamUrl, tempFile, userAgent, sourceSettings, isEpisode);
                break;
            } catch (err) {
                if (attempt === retries) throw err;

                logger.warn('download', `Retry ${attempt + 1}/${retries} for ${download.title}: ${err.message}`);
                await db.run('UPDATE downloads SET retry_count = ? WHERE id = ?', [attempt + 1, download.id]);

                // Exponential backoff with jitter
                const delay = Math.min(30000, 1000 * Math.pow(2, attempt)) + Math.random() * 1000;
                await new Promise(r => setTimeout(r, delay));
            }
        }

        // Move to final destination
        const finalDir = download.media_type === 'movie'
            ? path.join(downloadPath, 'movies')
            : path.join(downloadPath, 'series', sanitizeFilename(download.title));

        if (!fs.existsSync(finalDir)) fs.mkdirSync(finalDir, { recursive: true });

        const finalPath = path.join(finalDir, filename);
        fs.renameSync(tempFile, finalPath);

        await db.run(`
            UPDATE downloads SET status = ?, final_path = ?, progress = 100, completed_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, ['completed', finalPath, download.id]);

        logger.info('download', `Completed: ${download.title}`);
        app?.emit('download:complete', { id: download.id, title: download.title, path: finalPath });

        // Trigger Plex scan
        if (plex) {
            const libraryId = download.media_type === 'movie'
                ? settings.get('plexMovieLibraryId')
                : settings.get('plexTvLibraryId');

            if (libraryId) {
                try {
                    await plex.scanLibrary(libraryId, finalDir);
                } catch (err) {
                    logger.warn('download', `Failed to trigger Plex scan: ${err.message}`);
                }
            }
        }

    } catch (err) {
        logger.error('download', `Failed: ${download.title} - ${err.message}`);

        // Cleanup temp file
        if (fs.existsSync(tempFile)) {
            try { fs.unlinkSync(tempFile); } catch (e) {}
        }

        await db.run('UPDATE downloads SET status = ?, error_message = ? WHERE id = ?',
            ['failed', err.message, download.id]);

        app?.emit('download:failed', { id: download.id, title: download.title, error: err.message });
    }
}

async function downloadFile(downloadId, url, destPath, userAgent, sourceSettings, isEpisode) {
    const writer = fs.createWriteStream(destPath);

    let response;
    try {
        response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            timeout: 60000,
            headers: {
                'User-Agent': userAgent,
                'Accept': '*/*',
                'Connection': 'keep-alive'
            },
            validateStatus: null // Allow us to handle all status codes
        });
    } catch (err) {
        logger.error('download', `HTTP request failed for download ${downloadId}: ${err.message}`);
        throw err;
    }

    // Log HTTP status code
    const statusCode = response.status;
    logger.info('download', `HTTP ${statusCode} for download ${downloadId} - URL: ${url.substring(0, 100)}...`);

    // Check for non-success status codes
    if (statusCode >= 400) {
        const errorMsg = `HTTP ${statusCode} ${response.statusText || 'Error'}`;
        logger.error('download', `Download ${downloadId} failed: ${errorMsg}`);
        writer.destroy();
        throw new Error(errorMsg);
    }

    // Handle redirects (3xx) - axios should handle these automatically, but log them
    if (statusCode >= 300 && statusCode < 400) {
        logger.warn('download', `Download ${downloadId} received redirect ${statusCode}`);
    }

    const totalLength = parseInt(response.headers['content-length'], 10) || 0;
    let downloadedLength = 0;
    let lastUpdate = Date.now();
    let lastDataTime = Date.now();

    // Calculate throttle settings
    let bytesPerSecond = Infinity;
    let throttleEnabled = false;

    if (sourceSettings.simulatePlayback && sourceSettings.speedMultiplier > 0 && totalLength > 0) {
        bytesPerSecond = calculateTargetBytesPerSecond(totalLength, isEpisode, sourceSettings.speedMultiplier);
        throttleEnabled = true;

        const estimatedMinutes = Math.ceil(totalLength / bytesPerSecond / 60);
        const speedMbps = (bytesPerSecond * 8 / 1024 / 1024).toFixed(2);

        logger.info('download', `Download ${downloadId} - Player simulation ENABLED`);
        logger.info('download', `  Source: ${sourceSettings.sourceName}, Multiplier: ${sourceSettings.speedMultiplier}x`);
        logger.info('download', `  Target speed: ${speedMbps} Mbps (~${(bytesPerSecond / 1024).toFixed(0)} KB/s)`);
        logger.info('download', `  Estimated time: ~${estimatedMinutes} minutes for ${(totalLength / 1024 / 1024).toFixed(0)} MB`);
    } else {
        logger.info('download', `Download ${downloadId} - Full speed (no throttling)`);
    }

    // Log content-length info
    if (totalLength > 0) {
        logger.info('download', `Download ${downloadId} starting - Size: ${(totalLength / 1024 / 1024).toFixed(2)} MB`);
    } else {
        logger.warn('download', `Download ${downloadId} starting - Unknown size (no Content-Length header)`);
    }

    // Create throttled stream if needed
    const throttle = new ThrottledStream({
        bytesPerSecond: bytesPerSecond,
        variationPercent: 0.20 // 20% random variation for natural look
    });

    return new Promise((resolve, reject) => {
        // Timeout for stalled downloads (no data received for 120 seconds when throttled, 60 when not)
        const stallTimeoutMs = throttleEnabled ? 120000 : 60000;
        const stallTimeout = setInterval(() => {
            if (Date.now() - lastDataTime > stallTimeoutMs) {
                clearInterval(stallTimeout);
                writer.destroy();
                throttle.destroy();
                response.data.destroy();
                logger.error('download', `Download ${downloadId} stalled - no data for ${stallTimeoutMs/1000} seconds`);
                reject(new Error(`Download stalled - no data received for ${stallTimeoutMs/1000} seconds`));
            }
        }, 10000);

        // Track data through throttle
        throttle.on('data', async (chunk) => {
            downloadedLength += chunk.length;
            lastDataTime = Date.now();

            // Update progress periodically (every 2 seconds when throttled to reduce DB writes)
            const updateInterval = throttleEnabled ? 2000 : 1000;
            if (Date.now() - lastUpdate > updateInterval) {
                lastUpdate = Date.now();
                const progress = totalLength > 0 ? (downloadedLength / totalLength * 100) : 0;

                await db.run('UPDATE downloads SET progress = ?, downloaded_size = ?, file_size = ? WHERE id = ?',
                    [progress, downloadedLength, totalLength, downloadId]);

                app?.emit('download:progress', {
                    id: downloadId,
                    progress: progress.toFixed(1),
                    downloaded: downloadedLength,
                    total: totalLength,
                    throttled: throttleEnabled
                });
            }
        });

        throttle.on('end', () => {
            clearInterval(stallTimeout);
            logger.info('download', `Download ${downloadId} stream ended - ${(downloadedLength / 1024 / 1024).toFixed(2)} MB received`);
        });

        throttle.on('error', (err) => {
            clearInterval(stallTimeout);
            writer.destroy();
            logger.error('download', `Download ${downloadId} throttle error: ${err.message}`);
            reject(err);
        });

        writer.on('finish', () => {
            resolve();
        });

        writer.on('error', (err) => {
            clearInterval(stallTimeout);
            throttle.destroy();
            logger.error('download', `Download ${downloadId} write error: ${err.message}`);
            reject(err);
        });

        response.data.on('error', (err) => {
            clearInterval(stallTimeout);
            writer.destroy();
            throttle.destroy();
            logger.error('download', `Download ${downloadId} stream error: ${err.message}`);
            reject(err);
        });

        // Pipe through throttle to writer
        response.data.pipe(throttle).pipe(writer);
    });
}

function sanitizeFilename(name) {
    return name
        .replace(/[<>:"/\\|?*]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 200);
}

module.exports = {
    init: async (modules) => {
        logger = modules.logger;
        db = modules.db;
        settings = modules.settings;
        app = modules.app;
        plex = modules.plex;

        // Reset any downloads that were stuck in "downloading" status from a previous crash/restart
        const stuckDownloads = await db.all(
            'SELECT id, media_id, temp_path FROM downloads WHERE status = ?',
            ['downloading']
        );

        if (stuckDownloads.length > 0) {
            logger.warn('download', `Found ${stuckDownloads.length} stuck downloads from previous session, resetting to queued`);

            for (const download of stuckDownloads) {
                // Cleanup partial temp file if exists
                if (download.temp_path && fs.existsSync(download.temp_path)) {
                    try {
                        fs.unlinkSync(download.temp_path);
                        logger.info('download', `Cleaned up partial temp file: ${download.temp_path}`);
                    } catch (err) {
                        logger.warn('download', `Failed to cleanup temp file: ${err.message}`);
                    }
                }

                // Reset to queued with high priority so it resumes soon
                await db.run(
                    'UPDATE downloads SET status = ?, progress = 0, downloaded_size = 0, temp_path = NULL, started_at = NULL, retry_count = 0, priority = 80 WHERE id = ?',
                    ['queued', download.id]
                );
            }

            logger.info('download', `Reset ${stuckDownloads.length} stuck downloads to queued status`);
        }

        // Start processing queue
        downloadInterval = setInterval(processQueue, 5000);
        logger.info('download', 'Download engine started');
    },

    shutdown: async () => {
        if (downloadInterval) {
            clearInterval(downloadInterval);
        }
    },

    // Add to queue
    queue: async (mediaId, episodeId = null, priority = 50) => {
        const existing = await db.get(
            'SELECT id FROM downloads WHERE media_id = ? AND (episode_id = ? OR (episode_id IS NULL AND ? IS NULL)) AND status IN (?, ?)',
            [mediaId, episodeId, episodeId, 'queued', 'downloading']
        );

        if (existing) {
            return { success: false, message: 'Already in queue' };
        }

        const result = await db.run(
            'INSERT INTO downloads (media_id, episode_id, status, priority) VALUES (?, ?, ?, ?)',
            [mediaId, episodeId, 'queued', priority]
        );

        app?.emit('download:queued', { id: result.lastID, mediaId, episodeId });
        return { success: true, id: result.lastID };
    },

    // Cancel download
    cancel: async (downloadId) => {
        await db.run('UPDATE downloads SET status = ? WHERE id = ?', ['cancelled', downloadId]);
        app?.emit('download:cancelled', { id: downloadId });
    },

    // Set priority for a download
    setPriority: async (downloadId, priority) => {
        const clampedPriority = Math.max(0, Math.min(100, priority));
        await db.run('UPDATE downloads SET priority = ? WHERE id = ? AND status = ?',
            [clampedPriority, downloadId, 'queued']);
        app?.emit('download:priority', { id: downloadId, priority: clampedPriority });
        return { success: true, priority: clampedPriority };
    },

    // Move download up in queue (increase priority)
    moveUp: async (downloadId) => {
        const download = await db.get('SELECT priority FROM downloads WHERE id = ? AND status = ?',
            [downloadId, 'queued']);
        if (!download) return { success: false, message: 'Download not found or not queued' };

        const newPriority = Math.min(100, (download.priority || 50) + 10);
        await db.run('UPDATE downloads SET priority = ? WHERE id = ?', [newPriority, downloadId]);
        app?.emit('download:priority', { id: downloadId, priority: newPriority });
        return { success: true, priority: newPriority };
    },

    // Move download down in queue (decrease priority)
    moveDown: async (downloadId) => {
        const download = await db.get('SELECT priority FROM downloads WHERE id = ? AND status = ?',
            [downloadId, 'queued']);
        if (!download) return { success: false, message: 'Download not found or not queued' };

        const newPriority = Math.max(0, (download.priority || 50) - 10);
        await db.run('UPDATE downloads SET priority = ? WHERE id = ?', [newPriority, downloadId]);
        app?.emit('download:priority', { id: downloadId, priority: newPriority });
        return { success: true, priority: newPriority };
    },

    // Move to top of queue
    moveToTop: async (downloadId) => {
        await db.run('UPDATE downloads SET priority = 100 WHERE id = ? AND status = ?',
            [downloadId, 'queued']);
        app?.emit('download:priority', { id: downloadId, priority: 100 });
        return { success: true, priority: 100 };
    },

    // Move to bottom of queue
    moveToBottom: async (downloadId) => {
        await db.run('UPDATE downloads SET priority = 0 WHERE id = ? AND status = ?',
            [downloadId, 'queued']);
        app?.emit('download:priority', { id: downloadId, priority: 0 });
        return { success: true, priority: 0 };
    },

    // Retry a failed download
    retry: async (downloadId) => {
        await db.run(`
            UPDATE downloads
            SET status = 'queued', error_message = NULL, retry_count = 0, priority = 75
            WHERE id = ? AND status IN ('failed', 'cancelled')
        `, [downloadId]);
        app?.emit('download:retry', { id: downloadId });
        return { success: true };
    },

    // Get active count
    getActiveCount: () => activeDownloads
};
