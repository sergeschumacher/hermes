const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { execSync } = require('child_process');

let logger = null;
let db = null;
let settings = null;
let app = null;
let modulesRef = null;

function emitApp(event, data) {
    (modulesRef?.app || app)?.emit(event, data);
}

let plex = null;
let transcoder = null;
let usenet = null;
let newznab = null;

let activeDownloads = 0;
let downloadInterval = null;
let streamPauseLogged = false;
const activeTransfers = new Map();

function waitForStreamInactive() {
    const appRef = modulesRef?.app || app;
    if (!appRef?.isStreamActive?.() || appRef?.isStreamActive?.() === false) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        const handler = () => {
            appRef.off?.('stream:inactive', handler);
            resolve();
        };
        appRef.once?.('stream:inactive', handler);
    });
}

async function reconcileStuckDownloads() {
    if (!db || activeTransfers.size > 0) return;
    try {
        const row = await db.get("SELECT COUNT(*) as count FROM downloads WHERE status = 'downloading'");
        if (row?.count > 0) {
            await db.run("UPDATE downloads SET status = 'queued' WHERE status = 'downloading'");
            logger?.warn('download', `Requeued ${row.count} stuck downloads`);
        }
        if (activeDownloads > 0) {
            activeDownloads = 0;
        }
    } catch (err) {
        logger?.warn('download', `Failed to reconcile stuck downloads: ${err.message}`);
    }
}

function pauseActiveDownloads() {
    for (const [downloadId, transfer] of activeTransfers.entries()) {
        if (transfer.paused || !transfer.response) continue;
        transfer.paused = true;
        if (transfer.pauseState) {
            transfer.pauseState.paused = true;
            transfer.pauseState.reason = 'stream';
        }
        transfer.bumpActivity?.();
        transfer.abort?.('stream');
        transfer.response = null;
        transfer.throttle = null;
        logger?.info('download', `Paused active download ${downloadId}`);
    }
}

function resumeActiveDownloads() {
    for (const [downloadId, transfer] of activeTransfers.entries()) {
        if (!transfer.paused || !transfer.response) continue;
        transfer.paused = false;
        if (transfer.pauseState) transfer.pauseState.paused = false;
        transfer.bumpActivity?.();
        transfer.response.resume?.();
        transfer.throttle?.resume?.();
        logger?.info('download', `Resumed active download ${downloadId}`);
    }
}

// Default assumed video duration for bitrate calculation (in seconds)
// 90 minutes for movies, 45 minutes for episodes
const DEFAULT_MOVIE_DURATION = 90 * 60;
const DEFAULT_EPISODE_DURATION = 45 * 60;

// Convert SMB URLs to local mount paths
// smb://server/share/path -> /Volumes/share/path (macOS)
// Also handles smb://server._smb._tcp.local/share format
function resolveSmbPath(urlOrPath) {
    if (!urlOrPath) return urlOrPath;

    // Check if it's an SMB URL
    if (!urlOrPath.startsWith('smb://')) {
        return urlOrPath;
    }

    try {
        // Parse the SMB URL: smb://server/share/path
        // Handle both smb://server/share and smb://server._smb._tcp.local/share
        const url = new URL(urlOrPath);
        const hostname = url.hostname; // e.g., "BASE._smb._tcp.local" or "BASE"
        const pathname = url.pathname; // e.g., "/Movies/Shows"

        // Extract share name (first path component) and remaining path
        const pathParts = pathname.split('/').filter(p => p);
        if (pathParts.length === 0) {
            return urlOrPath; // Invalid path
        }

        const shareName = pathParts[0]; // e.g., "Movies"
        const subPath = pathParts.slice(1).join('/'); // e.g., "Shows"

        // On macOS, SMB shares are mounted under /Volumes/
        // The mount point name is usually the share name
        let mountPath = path.join('/Volumes', shareName);

        // Check if the share is already mounted
        if (fs.existsSync(mountPath)) {
            const fullPath = subPath ? path.join(mountPath, subPath) : mountPath;
            return fullPath;
        }

        // Try to mount the SMB share
        // First, check if we can find it via a different mount name
        const volumesDir = '/Volumes';
        if (fs.existsSync(volumesDir)) {
            const volumes = fs.readdirSync(volumesDir);
            // Look for a volume that might be our SMB share
            for (const vol of volumes) {
                // Check if volume name matches share name (case-insensitive)
                if (vol.toLowerCase() === shareName.toLowerCase()) {
                    const fullPath = subPath ? path.join(volumesDir, vol, subPath) : path.join(volumesDir, vol);
                    if (fs.existsSync(fullPath)) {
                        return fullPath;
                    }
                }
            }
        }

        // If not mounted, try to mount it using macOS's built-in mounting
        // This uses the "mount_smbfs" command or "open" to trigger Finder mounting
        const serverName = hostname.replace(/\._smb\._tcp\.local$/, '');
        const mountUrl = `smb://${serverName}/${shareName}`;

        try {
            // Try to open/mount the share via AppleScript (triggers Finder mount)
            execSync(`osascript -e 'tell application "Finder" to mount volume "${mountUrl}"'`, {
                timeout: 30000,
                stdio: 'ignore'
            });

            // Wait a moment for mount to complete
            let attempts = 0;
            while (attempts < 10 && !fs.existsSync(mountPath)) {
                execSync('sleep 0.5');
                attempts++;
            }

            if (fs.existsSync(mountPath)) {
                const fullPath = subPath ? path.join(mountPath, subPath) : mountPath;
                return fullPath;
            }
        } catch (mountErr) {
            // Mount failed, log but continue
            if (logger) {
                logger.warn('download', `Failed to mount SMB share ${mountUrl}: ${mountErr.message}`);
            }
        }

        // Return the expected mount path even if mount failed
        // This allows the user to manually mount and retry
        const fullPath = subPath ? path.join(mountPath, subPath) : mountPath;
        return fullPath;

    } catch (err) {
        // URL parsing failed, return original
        if (logger) {
            logger.warn('download', `Failed to parse SMB URL ${urlOrPath}: ${err.message}`);
        }
        return urlOrPath;
    }
}

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

class SkipBytesStream extends Transform {
    constructor(skipBytes) {
        super();
        this.skipBytes = Math.max(0, skipBytes || 0);
    }

    _transform(chunk, encoding, callback) {
        if (this.skipBytes <= 0) {
            callback(null, chunk);
            return;
        }

        if (chunk.length <= this.skipBytes) {
            this.skipBytes -= chunk.length;
            callback();
            return;
        }

        const remaining = chunk.slice(this.skipBytes);
        this.skipBytes = 0;
        callback(null, remaining);
    }
}

async function getSourceSettings(mediaId) {
    // Get the source settings for this media item
    const media = await db.get(`
        SELECT m.source_id, s.simulate_playback, s.playback_speed_multiplier, s.name as source_name,
               s.spoofed_mac, s.spoofed_device_key
        FROM media m
        LEFT JOIN sources s ON m.source_id = s.id
        WHERE m.id = ?
    `, [mediaId]);

    // Get MAC/device info - priority: source-specific > global settings > defaults
    const spoofedMac = media?.spoofed_mac || settings.get('spoofedMac') || '77:f4:8b:a4:ed:10';
    const spoofedDeviceKey = media?.spoofed_device_key || settings.get('spoofedDeviceKey') || '006453';

    return {
        simulatePlayback: media?.simulate_playback ?? 1,
        speedMultiplier: media?.playback_speed_multiplier ?? 1.5,
        sourceName: media?.source_name || 'Unknown',
        spoofedMac,
        spoofedDeviceKey
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
    const slowDiskMode = settings.get('slowDiskMode');
    const pauseOnStream = settings.get('pauseDownloadsOnStream') !== false;
    const streamActive = modulesRef?.app?.isStreamActive?.() === true;

    await reconcileStuckDownloads();

    if (pauseOnStream && streamActive) {
        if (!streamPauseLogged) {
            logger?.info('download', 'Stream active, pausing new downloads');
            streamPauseLogged = true;
        }
        pauseActiveDownloads();
        return;
    }
    if (streamPauseLogged) {
        logger?.info('download', 'Stream ended, resuming downloads');
        streamPauseLogged = false;
    }
    resumeActiveDownloads();

    if (slowDiskMode) {
        // Slow disk mode: strictly sequential - one operation at a time
        // Don't start if ANY download is in progress
        if (activeDownloads > 0) return;

        // Don't start if transcoding is active
        if (transcoder) {
            const transcoderStatus = transcoder.getStatus();
            if (transcoderStatus.isProcessing) return;
        }

        // Don't start if there are items waiting for transcode to complete
        const pendingTranscode = await db.get(
            "SELECT COUNT(*) as count FROM downloads WHERE status = 'transcoding'"
        );
        if (pendingTranscode?.count > 0) return;
    } else {
        // Normal mode: respect maxConcurrentDownloads
        const maxConcurrent = settings.get('maxConcurrentDownloads') || 2;
        if (activeDownloads >= maxConcurrent) return;
    }

    const download = await db.get(`
        SELECT d.*, m.stream_url, m.title, m.media_type, m.source_id,
               m.poster,
               e.stream_url as episode_url, e.external_id as episode_external_id,
               e.container as episode_container, e.title as episode_title,
               s.type as source_type
        FROM downloads d
        LEFT JOIN media m ON d.media_id = m.id
        LEFT JOIN episodes e ON d.episode_id = e.id
        LEFT JOIN sources s ON m.source_id = s.id
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
    // Check if this is a usenet download (has nzb_url set or source is newznab type)
    if (download.nzb_url) {
        return processUsenetDownload(download);
    }

    let streamUrl = (download.episode_url || download.stream_url || '').trim();
    if (!streamUrl) {
        await db.run('UPDATE downloads SET status = ?, error_message = ? WHERE id = ?',
            ['failed', 'No stream URL', download.id]);
        return;
    }

    // For episodes, build full URL ONLY if needed (Xtream API style base URLs)
    // M3U sources already have complete episode URLs, don't modify them
    if (download.episode_id && download.episode_external_id) {
        // Check if URL already looks complete (don't modify M3U-style complete URLs)
        const hasExtension = /\.(mkv|mp4|avi|ts|m3u8|flv|webm)(\?|$)/i.test(streamUrl);
        const hasQueryParams = streamUrl.includes('?');
        const endsWithNumber = /\/\d+\/?$/.test(streamUrl); // URLs like /live/123 or /stream/456
        const looksComplete = hasExtension || hasQueryParams || endsWithNumber;

        if (!looksComplete) {
            // Build full episode URL for Xtream API sources: base_url/episode_id.extension
            const ext = (download.episode_container || 'mkv').trim();
            const baseUrl = streamUrl.replace(/[\s\/]+$/, ''); // Remove trailing slashes and whitespace
            const episodeId = String(download.episode_external_id).trim();
            streamUrl = `${baseUrl}/${episodeId}.${ext}`;
            logger?.debug('download', `Built episode URL: ${streamUrl}`);
        } else {
            logger?.debug('download', `Using episode URL as-is (complete): ${streamUrl.substring(0, 80)}...`);
        }
    }

    const tempPath = settings.get('tempPath');

    // Get type-specific download path, with fallback to legacy downloadPath
    const isMovie = download.media_type === 'movie';
    const isEpisode = !!download.episode_id;
    let downloadPathSetting;

    if (isMovie) {
        downloadPathSetting = settings.get('movieDownloadPath') || settings.get('downloadPath');
    } else if (isEpisode) {
        downloadPathSetting = settings.get('seriesDownloadPath') || settings.get('downloadPath');
    } else {
        downloadPathSetting = settings.get('downloadPath');
    }

    // Resolve SMB paths to local mount points
    const downloadPath = resolveSmbPath(downloadPathSetting);

    if (downloadPath !== downloadPathSetting) {
        logger?.info('download', `Resolved SMB path: ${downloadPathSetting} -> ${downloadPath}`);
    }

    const displayTitle = download.episode_title || download.title || 'download';
    const filename = sanitizeFilename(displayTitle) + path.extname(streamUrl).split('?')[0];
    const tempFile = path.join(tempPath, `${download.id}_${filename}`);

    // Create directories if needed
    if (!fs.existsSync(tempPath)) fs.mkdirSync(tempPath, { recursive: true });
    if (!fs.existsSync(downloadPath)) {
        // For network paths, fail if not mounted rather than creating local folder
        if (downloadPathSetting.startsWith('smb://')) {
            await db.run('UPDATE downloads SET status = ?, error_message = ? WHERE id = ?',
                ['failed', `Network share not mounted: ${downloadPath}. Please mount the SMB share first.`, download.id]);
            return;
        }
        fs.mkdirSync(downloadPath, { recursive: true });
    }

    // Get source throttle settings
    const sourceSettings = await getSourceSettings(download.media_id);

    await db.run('UPDATE downloads SET status = ?, started_at = CURRENT_TIMESTAMP, temp_path = ? WHERE id = ?',
        ['downloading', tempFile, download.id]);

    emitApp('download:start', { id: download.id, title: download.title });

    try {
        const userAgent = settings.getRandomUserAgent();
        const retries = settings.get('downloadRetries') || 3;

        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const isEpisode = !!download.episode_url;
                let resumeFrom = 0;
                if (fs.existsSync(tempFile)) {
                    try {
                        const stats = fs.statSync(tempFile);
                        resumeFrom = stats.size || 0;
                    } catch (err) {
                        logger.warn('download', `Failed to stat temp file for resume: ${err.message}`);
                    }
                }
                await downloadFile(download.id, streamUrl, tempFile, userAgent, sourceSettings, isEpisode, resumeFrom);
                break;
            } catch (err) {
                if (err?.isPaused && settings.get('pauseDownloadsOnStream') !== false) {
                    await waitForStreamInactive();
                    await db.run('UPDATE downloads SET status = ? WHERE id = ? AND status = ?',
                        ['queued', download.id, 'downloading']);
                    return;
                }
                if (attempt === retries) throw err;

                logger.warn('download', `Retry ${attempt + 1}/${retries} for ${download.title}: ${err.message}`);
                await db.run('UPDATE downloads SET retry_count = ? WHERE id = ?', [attempt + 1, download.id]);

                // Exponential backoff with jitter
                const delay = Math.min(30000, 1000 * Math.pow(2, attempt)) + Math.random() * 1000;
                await new Promise(r => setTimeout(r, delay));
            }
        }

        // Move to final destination
        // If using type-specific paths, don't add subdirectories
        // If using legacy downloadPath, add movies/series subdirectories
        const hasTypeSpecificPath = isMovie
            ? !!settings.get('movieDownloadPath')
            : isEpisode ? !!settings.get('seriesDownloadPath') : false;

        let finalDir;
        if (isMovie) {
            finalDir = hasTypeSpecificPath ? downloadPath : path.join(downloadPath, 'movies');
        } else if (isEpisode) {
            // For series, always create show subfolder
            finalDir = hasTypeSpecificPath
                ? path.join(downloadPath, sanitizeFilename(download.title))
                : path.join(downloadPath, 'series', sanitizeFilename(download.title));
        } else {
            finalDir = downloadPath;
        }

        if (!fs.existsSync(finalDir)) fs.mkdirSync(finalDir, { recursive: true });

        const finalPath = path.join(finalDir, filename);

        // Check if transcoding is enabled
        const shouldTranscode = settings.get('transcodeFilesEnabled') && transcoder;

        if (shouldTranscode) {
            // Queue for transcoding - file stays in temp location
            await transcoder.queue(download.id, tempFile, finalDir, filename, download.media_type);

            // Update download status to 'transcoding'
            await db.run('UPDATE downloads SET status = ? WHERE id = ?', ['transcoding', download.id]);

            logger.info('download', `Queued for transcoding: ${download.title}`);
            emitApp('download:transcoding', { id: download.id, title: download.title });

            // Note: Plex scan and final completion happen after transcoding completes (in transcoder module)

        } else {
            // No transcoding - original behavior: move directly to final destination
            try {
                fs.renameSync(tempFile, finalPath);
            } catch (renameErr) {
                if (renameErr.code === 'EXDEV') {
                    // Cross-device link: need to copy then delete
                    logger.info('download', `Cross-device move detected, copying to ${finalPath}`);
                    fs.copyFileSync(tempFile, finalPath);
                    fs.unlinkSync(tempFile);
                } else {
                    throw renameErr;
                }
            }

            await db.run(`
                UPDATE downloads SET status = ?, final_path = ?, progress = 100, completed_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `, ['completed', finalPath, download.id]);

            logger.info('download', `Completed: ${download.title}`);
            emitApp('download:complete', { id: download.id, title: download.title, path: finalPath });

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
        }

    } catch (err) {
        logger.error('download', `Failed: ${download.title} - ${err.message}`);

        // Cleanup temp file
        if (fs.existsSync(tempFile)) {
            try { fs.unlinkSync(tempFile); } catch (e) {}
        }

        await db.run('UPDATE downloads SET status = ?, error_message = ? WHERE id = ?',
            ['failed', err.message, download.id]);

        emitApp('download:failed', { id: download.id, title: download.title, error: err.message });
    }
}

async function downloadFile(downloadId, url, destPath, userAgent, sourceSettings, isEpisode, resumeFrom = 0) {
    // Build headers mimicking IPTV player (IBU Player Pro style)
    const spoofedMac = sourceSettings.spoofedMac || '77:f4:8b:a4:ed:10';
    const spoofedDeviceKey = sourceSettings.spoofedDeviceKey || '006453';

    let response;
    try {
        const headers = {
            'User-Agent': userAgent,
            'X-Device-MAC': spoofedMac,
            'X-Forwarded-For': spoofedMac,
            'X-Device-Key': spoofedDeviceKey,
            'X-Device-ID': spoofedMac.replace(/:/g, ''),
            'Accept': '*/*',
            'Connection': 'keep-alive'
        };
        if (resumeFrom > 0) {
            headers['Range'] = `bytes=${resumeFrom}-`;
        }
        response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            timeout: 60000,
            headers,
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
        throw new Error(errorMsg);
    }

    // Handle redirects (3xx) - axios should handle these automatically, but log them
    if (statusCode >= 300 && statusCode < 400) {
        logger.warn('download', `Download ${downloadId} received redirect ${statusCode}`);
    }

    const contentLength = parseInt(response.headers['content-length'], 10) || 0;
    const contentRange = response.headers['content-range'];
    let totalLength = 0;
    if (contentRange) {
        const match = contentRange.match(/\/(\d+)$/);
        totalLength = match ? parseInt(match[1], 10) : 0;
    } else if (statusCode === 206 && resumeFrom > 0) {
        totalLength = resumeFrom + contentLength;
    } else {
        totalLength = contentLength;
    }

    let discardBytes = 0;
    const maxResumeDiscardBytes = settings?.get?.('resumeDiscardLimitBytes') || (10 * 1024 * 1024);
    if (resumeFrom > 0 && statusCode === 200) {
        if (resumeFrom > maxResumeDiscardBytes) {
            logger.warn('download', `Server did not honor Range for download ${downloadId}, resume offset ${Math.round(resumeFrom / 1024 / 1024)} MB exceeds discard limit (${Math.round(maxResumeDiscardBytes / 1024 / 1024)} MB), restarting`);
            resumeFrom = 0;
        } else {
            discardBytes = resumeFrom;
            logger.warn('download', `Server did not honor Range for download ${downloadId}, discarding ${Math.round(resumeFrom / 1024 / 1024)} MB to resume`);
        }
    }

    const writer = fs.createWriteStream(destPath, { flags: resumeFrom > 0 ? 'a' : 'w' });

    let downloadedLength = resumeFrom;
    let lastUpdate = Date.now();
    let lastDataTime = Date.now();
    const pauseState = { paused: false, reason: null };

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
    if (resumeFrom > 0) {
        logger.info('download', `Download ${downloadId} resuming at ${(resumeFrom / 1024 / 1024).toFixed(2)} MB`);
    }

    // Create throttled stream if needed
    const throttle = new ThrottledStream({
        bytesPerSecond: bytesPerSecond,
        variationPercent: 0.20 // 20% random variation for natural look
    });

    return new Promise((resolve, reject) => {
        let settled = false;
        let stallTimeout = null;
        const makePausedError = () => {
            const err = new Error('paused');
            err.isPaused = true;
            err.reason = pauseState.reason || 'stream';
            return err;
        };
        const rejectOnce = (err) => {
            if (settled) return;
            settled = true;
            if (stallTimeout) {
                clearInterval(stallTimeout);
                stallTimeout = null;
            }
            reject(err);
        };
        const resolveOnce = () => {
            if (settled) return;
            settled = true;
            if (stallTimeout) {
                clearInterval(stallTimeout);
                stallTimeout = null;
            }
            resolve();
        };

        // Timeout for stalled downloads (no data received for 120 seconds when throttled, 60 when not)
        const stallTimeoutMs = throttleEnabled ? 120000 : 60000;
        stallTimeout = setInterval(() => {
            if (pauseState.paused) {
                lastDataTime = Date.now();
                return;
            }
            if (Date.now() - lastDataTime > stallTimeoutMs) {
                if (stallTimeout) {
                    clearInterval(stallTimeout);
                    stallTimeout = null;
                }
                writer.destroy();
                throttle.destroy();
                response.data.destroy();
                logger.error('download', `Download ${downloadId} stalled - no data for ${stallTimeoutMs/1000} seconds`);
                rejectOnce(new Error(`Download stalled - no data received for ${stallTimeoutMs/1000} seconds`));
            }
        }, 10000);

        function abort(reason) {
            pauseState.paused = true;
            pauseState.reason = reason || pauseState.reason || 'stream';
            if (stallTimeout) {
                clearInterval(stallTimeout);
                stallTimeout = null;
            }
            try { response.data.destroy(new Error('Paused')); } catch (err) {}
            try { throttle.destroy(); } catch (err) {}
            try { writer.destroy(); } catch (err) {}
            activeTransfers.delete(downloadId);
            rejectOnce(makePausedError());
        }

        const transferState = {
            response: response.data,
            throttle,
            paused: false,
            bumpActivity: () => { lastDataTime = Date.now(); },
            pauseState,
            abort,
            speedBps: 0,
            lastSpeedAt: null,
            lastSpeedBytes: 0
        };

        let lastNetAt = Date.now();
        let netBytesSince = 0;
        let lastNetLogAt = Date.now();
        let lastWriteLogAt = Date.now();
        response.data.on('data', (chunk) => {
            netBytesSince += chunk.length;
            const now = Date.now();
            if (now - lastNetLogAt >= 5000) {
                if (!settings?.get?.('downloadSpeedLogs')) {
                    lastNetAt = now;
                    netBytesSince = 0;
                    lastNetLogAt = now;
                    return;
                }
                const elapsed = (now - lastNetAt) / 1000;
                const netBps = elapsed > 0 ? Math.floor(netBytesSince / elapsed) : 0;
                const writeBps = transferState.speedBps || 0;
                logger?.debug('download', `Download ${downloadId} net=${Math.round(netBps / 1024)} KB/s write=${Math.round(writeBps / 1024)} KB/s`);
                lastNetAt = now;
                netBytesSince = 0;
                lastNetLogAt = now;
            }
        });

        // Track data through throttle
        throttle.on('data', async (chunk) => {
            downloadedLength += chunk.length;
            lastDataTime = Date.now();

            // Update progress periodically (every 2 seconds when throttled to reduce DB writes)
            const updateInterval = throttleEnabled ? 2000 : 1000;
            if (Date.now() - lastUpdate > updateInterval) {
                lastUpdate = Date.now();
                const progress = totalLength > 0 ? (downloadedLength / totalLength * 100) : 0;
                if (!transferState.lastSpeedAt) {
                    transferState.lastSpeedAt = Date.now();
                    transferState.lastSpeedBytes = downloadedLength;
                } else {
                    const now = Date.now();
                    const elapsed = (now - transferState.lastSpeedAt) / 1000;
                    if (elapsed >= 1) {
                        const deltaBytes = downloadedLength - transferState.lastSpeedBytes;
                        transferState.speedBps = elapsed > 0 ? Math.max(0, Math.floor(deltaBytes / elapsed)) : 0;
                        transferState.lastSpeedAt = now;
                        transferState.lastSpeedBytes = downloadedLength;
                    }
                }
                if (Date.now() - lastWriteLogAt >= 1000) {
                    lastWriteLogAt = Date.now();
                }

                await db.run('UPDATE downloads SET progress = ?, downloaded_size = ?, file_size = ? WHERE id = ?',
                    [progress, downloadedLength, totalLength, downloadId]);

                emitApp('download:progress', {
                    id: downloadId,
                    progress: progress.toFixed(1),
                    downloaded: downloadedLength,
                    total: totalLength,
                    throttled: throttleEnabled,
                    speedBps: transferState.speedBps
                });
            }
        });

        if (discardBytes > 0) {
            response.data.on('data', () => {
                lastDataTime = Date.now();
            });
        }

        throttle.on('end', () => {
            if (stallTimeout) {
                clearInterval(stallTimeout);
                stallTimeout = null;
            }
            logger.info('download', `Download ${downloadId} stream ended - ${(downloadedLength / 1024 / 1024).toFixed(2)} MB received`);
        });

        throttle.on('error', (err) => {
            if (stallTimeout) {
                clearInterval(stallTimeout);
                stallTimeout = null;
            }
            writer.destroy();
            if (pauseState.paused) {
                rejectOnce(makePausedError());
                return;
            }
            logger.error('download', `Download ${downloadId} throttle error: ${err.message}`);
            rejectOnce(err);
        });

        writer.on('finish', () => {
            resolveOnce();
        });

        writer.on('error', (err) => {
            if (stallTimeout) {
                clearInterval(stallTimeout);
                stallTimeout = null;
            }
            throttle.destroy();
            if (pauseState.paused) {
                rejectOnce(makePausedError());
                return;
            }
            logger.error('download', `Download ${downloadId} write error: ${err.message}`);
            rejectOnce(err);
        });

        response.data.on('error', (err) => {
            if (stallTimeout) {
                clearInterval(stallTimeout);
                stallTimeout = null;
            }
            writer.destroy();
            throttle.destroy();
            if (pauseState.paused) {
                rejectOnce(makePausedError());
                return;
            }
            logger.error('download', `Download ${downloadId} stream error: ${err.message}`);
            rejectOnce(err);
        });

        activeTransfers.set(downloadId, transferState);

        response.data.on('close', () => {
            activeTransfers.delete(downloadId);
            if (pauseState.paused) {
                rejectOnce(makePausedError());
            }
        });

        writer.on('close', () => {
            activeTransfers.delete(downloadId);
            if (pauseState.paused) {
                rejectOnce(makePausedError());
            }
        });

        // Pipe through optional skip and throttle to writer
        const skipStream = discardBytes > 0 ? new SkipBytesStream(discardBytes) : null;
        if (skipStream) {
            response.data.pipe(skipStream).pipe(throttle).pipe(writer);
        } else {
            response.data.pipe(throttle).pipe(writer);
        }
    });
}

/**
 * Process a usenet download using NZB
 */
async function processUsenetDownload(download) {
    if (!usenet || !newznab) {
        logger.error('download', 'Usenet modules not available');
        await db.run('UPDATE downloads SET status = ?, error_message = ? WHERE id = ?',
            ['failed', 'Usenet support not configured', download.id]);
        return;
    }

    const displayTitle = download.episode_title || download.title || 'download';
    logger.info('download', `Starting usenet download: ${displayTitle}`);

    await db.run('UPDATE downloads SET status = ?, started_at = CURRENT_TIMESTAMP, source_type = ? WHERE id = ?',
        ['downloading', 'usenet', download.id]);

    emitApp('download:start', { id: download.id, title: download.title });

    try {
        // Fetch NZB content
        const nzbContent = await newznab.fetchNzb(download.nzb_url);

        if (!nzbContent) {
            throw new Error('Failed to fetch NZB content');
        }

        // Create NZB download record
        await db.run(`
            INSERT INTO nzb_downloads (download_id, nzb_name, status)
            VALUES (?, ?, 'pending')
        `, [download.id, displayTitle]);

        // Queue for usenet download
        await usenet.queueNzb(download.id, nzbContent);

        logger.info('download', `Queued NZB download: ${displayTitle}`);

        // The rest happens via events:
        // - usenet:download:complete triggers post-processing
        // - usenet:postprocess:complete triggers file moving and completion

    } catch (err) {
        logger.error('download', `Usenet download failed: ${displayTitle} - ${err.message}`);

        await db.run('UPDATE downloads SET status = ?, error_message = ? WHERE id = ?',
            ['failed', err.message, download.id]);

        emitApp('download:failed', { id: download.id, title: download.title, error: err.message });
    }
}

/**
 * Handle usenet post-processing completion
 * Called by usenet-postprocess module when files are ready
 */
async function handleUsenetComplete(downloadId, tempDir, files) {
    const download = await db.get(`
        SELECT d.*, m.title, m.media_type,
               e.title as episode_title
        FROM downloads d
        LEFT JOIN media m ON d.media_id = m.id
        LEFT JOIN episodes e ON d.episode_id = e.id
        WHERE d.id = ?
    `, [downloadId]);

    if (!download) {
        logger.error('download', `Usenet complete but download ${downloadId} not found`);
        return;
    }

    const displayTitle = download.episode_title || download.title || 'download';

    try {
        // Get type-specific download path
        const isMovie = download.media_type === 'movie';
        const isEpisode = !!download.episode_id;
        let downloadPathSetting;

        if (isMovie) {
            downloadPathSetting = settings.get('movieDownloadPath') || settings.get('downloadPath');
        } else if (isEpisode) {
            downloadPathSetting = settings.get('seriesDownloadPath') || settings.get('downloadPath');
        } else {
            downloadPathSetting = settings.get('downloadPath');
        }

        const downloadPath = resolveSmbPath(downloadPathSetting);

        // Determine final directory
        const hasTypeSpecificPath = isMovie
            ? !!settings.get('movieDownloadPath')
            : isEpisode ? !!settings.get('seriesDownloadPath') : false;

        let finalDir;
        if (isMovie) {
            finalDir = hasTypeSpecificPath ? downloadPath : path.join(downloadPath, 'movies');
        } else if (isEpisode) {
            finalDir = hasTypeSpecificPath
                ? path.join(downloadPath, sanitizeFilename(download.title))
                : path.join(downloadPath, 'series', sanitizeFilename(download.title));
        } else {
            finalDir = downloadPath;
        }

        if (!fs.existsSync(finalDir)) fs.mkdirSync(finalDir, { recursive: true });

        // Find the main media file from extracted files
        const mediaFile = files.find(f => f.isMedia);
        if (!mediaFile) {
            throw new Error('No media file found after extraction');
        }

        const filename = sanitizeFilename(displayTitle) + path.extname(mediaFile.name);
        const finalPath = path.join(finalDir, filename);

        // Check if transcoding is enabled
        const shouldTranscode = settings.get('transcodeFilesEnabled') && transcoder;

        if (shouldTranscode) {
            // Queue for transcoding
            await transcoder.queue(downloadId, mediaFile.path, finalDir, filename, download.media_type);

            await db.run('UPDATE downloads SET status = ? WHERE id = ?', ['transcoding', downloadId]);

            logger.info('download', `Usenet download queued for transcoding: ${displayTitle}`);
            emitApp('download:transcoding', { id: downloadId, title: download.title });

        } else {
            // Move to final destination
            try {
                fs.renameSync(mediaFile.path, finalPath);
            } catch (renameErr) {
                if (renameErr.code === 'EXDEV') {
                    fs.copyFileSync(mediaFile.path, finalPath);
                    fs.unlinkSync(mediaFile.path);
                } else {
                    throw renameErr;
                }
            }

            // Get file size
            const fileStats = fs.statSync(finalPath);

            await db.run(`
                UPDATE downloads SET status = ?, final_path = ?, file_size = ?, progress = 100, completed_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `, ['completed', finalPath, fileStats.size, downloadId]);

            logger.info('download', `Usenet download completed: ${displayTitle}`);
            emitApp('download:complete', { id: downloadId, title: download.title, path: finalPath });

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
        }

        // Cleanup temp directory
        try {
            const fsp = require('fs').promises;
            await fsp.rm(tempDir, { recursive: true, force: true });
            logger.info('download', `Cleaned up usenet temp directory: ${tempDir}`);
        } catch (err) {
            logger.warn('download', `Failed to cleanup temp directory: ${err.message}`);
        }

    } catch (err) {
        logger.error('download', `Failed to process usenet completion: ${err.message}`);

        await db.run('UPDATE downloads SET status = ?, error_message = ? WHERE id = ?',
            ['failed', err.message, downloadId]);

        emitApp('download:failed', { id: downloadId, title: download.title, error: err.message });
    }
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
        modulesRef = modules;
        app = modules.app;
        plex = modules.plex;
        transcoder = modules.transcoder;
        usenet = modules.usenet;
        newznab = modules.newznab;

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

        // Listen for usenet post-processing completion
        if (app) {
            app.on('usenet:postprocess:complete', async (data) => {
                try {
                    await handleUsenetComplete(data.downloadId, data.tempDir, data.files);
                } catch (err) {
                    logger.error('download', `Failed to handle usenet completion: ${err.message}`);
                }
            });

            // Emit socket events for usenet progress
            app.on('usenet:download:progress', (data) => {
                app.emit('socket:broadcast', 'usenet:download:progress', data);
            });

            app.on('usenet:postprocess:status', (data) => {
                app.emit('socket:broadcast', 'usenet:postprocess:status', data);
            });

            app.on('stream:active', () => {
                if (settings.get('pauseDownloadsOnStream') === false) return;
                pauseActiveDownloads();
                if (!streamPauseLogged) {
                    logger?.info('download', 'Stream active, pausing downloads');
                    streamPauseLogged = true;
                }
            });

            app.on('stream:inactive', () => {
                if (settings.get('pauseDownloadsOnStream') === false) return;
                resumeActiveDownloads();
                if (streamPauseLogged) {
                    logger?.info('download', 'Stream ended, resuming downloads');
                    streamPauseLogged = false;
                }
                reconcileStuckDownloads().finally(() => {
                    processQueue();
                });
            });
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

    getActiveStats: () => {
        const stats = {};
        for (const [downloadId, transfer] of activeTransfers.entries()) {
            stats[downloadId] = {
                speedBps: transfer.speedBps || 0,
                paused: !!transfer.paused
            };
        }
        return stats;
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

        emitApp('download:queued', { id: result.lastID, mediaId, episodeId });
        return { success: true, id: result.lastID };
    },

    // Add usenet download to queue
    queueUsenet: async (mediaId, nzbUrl, nzbTitle, episodeId = null, priority = 50) => {
        const existing = await db.get(
            'SELECT id FROM downloads WHERE media_id = ? AND (episode_id = ? OR (episode_id IS NULL AND ? IS NULL)) AND status IN (?, ?, ?)',
            [mediaId, episodeId, episodeId, 'queued', 'downloading', 'transcoding']
        );

        if (existing) {
            return { success: false, message: 'Already in queue' };
        }

        const result = await db.run(
            'INSERT INTO downloads (media_id, episode_id, status, priority, nzb_url, nzb_title, source_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [mediaId, episodeId, 'queued', priority, nzbUrl, nzbTitle, 'usenet']
        );

        emitApp('download:queued', { id: result.lastID, mediaId, episodeId, type: 'usenet' });
        logger?.info('download', `Queued usenet download: ${nzbTitle}`);
        return { success: true, id: result.lastID };
    },

    // Cancel download
    cancel: async (downloadId) => {
        await db.run('UPDATE downloads SET status = ? WHERE id = ?', ['cancelled', downloadId]);
        emitApp('download:cancelled', { id: downloadId });
    },

    // Set priority for a download
    setPriority: async (downloadId, priority) => {
        const clampedPriority = Math.max(0, Math.min(100, priority));
        await db.run('UPDATE downloads SET priority = ? WHERE id = ? AND status = ?',
            [clampedPriority, downloadId, 'queued']);
        emitApp('download:priority', { id: downloadId, priority: clampedPriority });
        return { success: true, priority: clampedPriority };
    },

    // Move download up in queue (increase priority)
    moveUp: async (downloadId) => {
        const download = await db.get('SELECT priority FROM downloads WHERE id = ? AND status = ?',
            [downloadId, 'queued']);
        if (!download) return { success: false, message: 'Download not found or not queued' };

        const newPriority = Math.min(100, (download.priority || 50) + 10);
        await db.run('UPDATE downloads SET priority = ? WHERE id = ?', [newPriority, downloadId]);
        emitApp('download:priority', { id: downloadId, priority: newPriority });
        return { success: true, priority: newPriority };
    },

    // Move download down in queue (decrease priority)
    moveDown: async (downloadId) => {
        const download = await db.get('SELECT priority FROM downloads WHERE id = ? AND status = ?',
            [downloadId, 'queued']);
        if (!download) return { success: false, message: 'Download not found or not queued' };

        const newPriority = Math.max(0, (download.priority || 50) - 10);
        await db.run('UPDATE downloads SET priority = ? WHERE id = ?', [newPriority, downloadId]);
        emitApp('download:priority', { id: downloadId, priority: newPriority });
        return { success: true, priority: newPriority };
    },

    // Move to top of queue
    moveToTop: async (downloadId) => {
        await db.run('UPDATE downloads SET priority = 100 WHERE id = ? AND status = ?',
            [downloadId, 'queued']);
        emitApp('download:priority', { id: downloadId, priority: 100 });
        return { success: true, priority: 100 };
    },

    // Move to bottom of queue
    moveToBottom: async (downloadId) => {
        await db.run('UPDATE downloads SET priority = 0 WHERE id = ? AND status = ?',
            [downloadId, 'queued']);
        emitApp('download:priority', { id: downloadId, priority: 0 });
        return { success: true, priority: 0 };
    },

    // Retry a failed download
    retry: async (downloadId) => {
        await db.run(`
            UPDATE downloads
            SET status = 'queued', error_message = NULL, retry_count = 0, priority = 75
            WHERE id = ? AND status IN ('failed', 'cancelled')
        `, [downloadId]);
        emitApp('download:retry', { id: downloadId });
        return { success: true };
    },

    // Get active count
    getActiveCount: () => activeDownloads
};
