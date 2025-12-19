/**
 * Usenet Download Module
 * Orchestrates NZB downloads using NNTP providers
 */

const fs = require('fs').promises;
const path = require('path');
const { EventEmitter } = require('events');

const nzbParser = require('./nzb-parser');
const yenc = require('./yenc');
const { NNTPConnectionPool } = require('./nntp-client');

// Module references
const refs = {
    logger: null,
    db: null,
    settings: null,
    app: null
};

// Active download state
const state = {
    pools: new Map(),        // Provider ID -> Connection pool
    activeDownloads: new Map(), // Download ID -> Download state
    queue: [],               // Pending downloads
    isProcessing: false
};

/**
 * Initialize a connection pool for a provider
 */
async function initializePool(provider) {
    if (state.pools.has(provider.id)) {
        return state.pools.get(provider.id);
    }

    refs.logger?.info('usenet', `Initializing pool for ${provider.name} (${provider.connections} connections)`);

    const pool = new NNTPConnectionPool(provider, provider.connections);
    await pool.initialize();

    state.pools.set(provider.id, pool);
    return pool;
}

/**
 * Get all enabled providers sorted by priority
 */
async function getProviders() {
    const providers = await refs.db.all(
        'SELECT * FROM usenet_providers WHERE enabled = 1 ORDER BY priority DESC, name'
    );
    return providers;
}

/**
 * Test a provider connection
 */
async function testProvider(provider) {
    const pool = new NNTPConnectionPool(provider, 1);

    try {
        await pool.initialize(1);
        await pool.close();
        return { success: true, message: 'Connection successful' };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * Queue an NZB for download
 */
async function queueNzb(downloadId, nzbContent) {
    refs.logger?.info('usenet', `Queuing NZB for download ${downloadId}`);

    try {
        // Parse NZB
        const parsedNzb = nzbParser.parse(nzbContent);

        refs.logger?.info('usenet', `Parsed NZB: ${parsedNzb.totalFiles} files, ${parsedNzb.totalSegments} segments, ${formatBytes(parsedNzb.totalSize)}`);

        // Update nzb_downloads record
        await refs.db.run(`
            UPDATE nzb_downloads
            SET total_files = ?, total_segments = ?, total_bytes = ?
            WHERE download_id = ?
        `, [parsedNzb.totalFiles, parsedNzb.totalSegments, parsedNzb.totalSize, downloadId]);

        // Create segment records for resumable downloads
        const nzbDownload = await refs.db.get(
            'SELECT id FROM nzb_downloads WHERE download_id = ?',
            [downloadId]
        );

        if (!nzbDownload) {
            throw new Error('NZB download record not found');
        }

        // Insert all segments
        for (const file of parsedNzb.files) {
            for (const segment of file.segments) {
                await refs.db.run(`
                    INSERT INTO nzb_segments (nzb_download_id, file_name, file_index, segment_number, message_id, bytes, status)
                    VALUES (?, ?, ?, ?, ?, ?, 'pending')
                `, [nzbDownload.id, file.filename, file.index, segment.number, segment.messageId, segment.bytes]);
            }
        }

        // Add to queue
        state.queue.push({
            downloadId,
            nzbDownloadId: nzbDownload.id,
            parsedNzb
        });

        // Start processing if not already running
        processQueue();

        return { success: true, files: parsedNzb.totalFiles, segments: parsedNzb.totalSegments };
    } catch (err) {
        refs.logger?.error('usenet', `Failed to queue NZB: ${err.message}`);
        throw err;
    }
}

/**
 * Process the download queue
 */
async function processQueue() {
    if (state.isProcessing || state.queue.length === 0) {
        return;
    }

    state.isProcessing = true;

    try {
        // Get providers
        const providers = await getProviders();
        if (providers.length === 0) {
            refs.logger?.warn('usenet', 'No usenet providers configured');
            state.isProcessing = false;
            return;
        }

        // Initialize pools for all providers
        for (const provider of providers) {
            try {
                await initializePool(provider);
            } catch (err) {
                refs.logger?.error('usenet', `Failed to initialize pool for ${provider.name}: ${err.message}`);
            }
        }

        // Process queue
        while (state.queue.length > 0) {
            const item = state.queue.shift();

            try {
                await downloadNzb(item, providers);
            } catch (err) {
                refs.logger?.error('usenet', `Download failed: ${err.message}`);

                // Update download status
                await refs.db.run(
                    'UPDATE downloads SET status = ?, error_message = ? WHERE id = ?',
                    ['failed', err.message, item.downloadId]
                );
            }
        }
    } finally {
        state.isProcessing = false;
    }
}

/**
 * Download an NZB
 */
async function downloadNzb(item, providers) {
    const { downloadId, nzbDownloadId, parsedNzb } = item;

    refs.logger?.info('usenet', `Starting download ${downloadId}`);

    // Update status
    await refs.db.run(
        'UPDATE downloads SET status = ? WHERE id = ?',
        ['downloading', downloadId]
    );

    // Create temp directory
    const tempDir = path.join(refs.settings.get('usenetTempPath'), `nzb_${downloadId}`);
    await fs.mkdir(tempDir, { recursive: true });

    // Update temp path
    await refs.db.run(
        'UPDATE nzb_downloads SET temp_path = ? WHERE id = ?',
        [tempDir, nzbDownloadId]
    );

    // Track progress
    const downloadState = {
        downloadId,
        nzbDownloadId,
        totalSegments: parsedNzb.totalSegments,
        completedSegments: 0,
        failedSegments: 0,
        downloadedBytes: 0,
        totalBytes: parsedNzb.totalSize,
        startTime: Date.now()
    };

    state.activeDownloads.set(downloadId, downloadState);

    try {
        // Download files in priority order
        const files = nzbParser.getPriorityOrder(parsedNzb);

        for (const file of files) {
            await downloadFile(file, nzbDownloadId, tempDir, providers, downloadState);
        }

        // Check for failures
        const failedCount = await refs.db.get(
            'SELECT COUNT(*) as count FROM nzb_segments WHERE nzb_download_id = ? AND status = ?',
            [nzbDownloadId, 'failed']
        );

        if (failedCount.count > parsedNzb.totalSegments * 0.1) {
            throw new Error(`Too many failed segments: ${failedCount.count}/${parsedNzb.totalSegments}`);
        }

        // Update completion
        await refs.db.run(`
            UPDATE nzb_downloads
            SET completed_files = ?, completed_segments = ?, downloaded_bytes = ?
            WHERE id = ?
        `, [parsedNzb.totalFiles, downloadState.completedSegments, downloadState.downloadedBytes, nzbDownloadId]);

        // Emit completion
        refs.app?.emit('usenet:download:complete', {
            downloadId,
            tempDir,
            files: parsedNzb.totalFiles
        });

        refs.logger?.info('usenet', `Download ${downloadId} complete`);

    } finally {
        state.activeDownloads.delete(downloadId);
    }
}

/**
 * Download a single file from an NZB
 */
async function downloadFile(file, nzbDownloadId, tempDir, providers, downloadState) {
    refs.logger?.debug('usenet', `Downloading file: ${file.filename}`);

    const filePath = path.join(tempDir, file.filename);
    const segments = [];

    // Get pending segments for this file
    const pendingSegments = await refs.db.all(`
        SELECT * FROM nzb_segments
        WHERE nzb_download_id = ? AND file_index = ? AND status = 'pending'
        ORDER BY segment_number
    `, [nzbDownloadId, file.index]);

    // Download segments in parallel (using connection pool)
    const concurrency = 10; // Max concurrent segment downloads per file
    const segmentQueue = [...pendingSegments];
    const activePromises = [];

    while (segmentQueue.length > 0 || activePromises.length > 0) {
        // Start new downloads up to concurrency limit
        while (activePromises.length < concurrency && segmentQueue.length > 0) {
            const segment = segmentQueue.shift();
            const promise = downloadSegment(segment, providers, downloadState)
                .then(data => {
                    segments[segment.segment_number - 1] = data;
                })
                .catch(err => {
                    refs.logger?.warn('usenet', `Segment ${segment.message_id} failed: ${err.message}`);
                })
                .finally(() => {
                    const index = activePromises.indexOf(promise);
                    if (index !== -1) activePromises.splice(index, 1);
                });

            activePromises.push(promise);
        }

        // Wait for at least one to complete
        if (activePromises.length > 0) {
            await Promise.race(activePromises);
        }
    }

    // Assemble file from segments
    const validSegments = segments.filter(s => s !== undefined);
    if (validSegments.length > 0) {
        const fileData = Buffer.concat(validSegments);
        await fs.writeFile(filePath, fileData);
        refs.logger?.debug('usenet', `Assembled file: ${file.filename} (${formatBytes(fileData.length)})`);
    }

    // Update file completion
    await refs.db.run(`
        UPDATE nzb_downloads
        SET completed_files = completed_files + 1
        WHERE id = ?
    `, [nzbDownloadId]);
}

/**
 * Download a single segment
 */
async function downloadSegment(segment, providers, downloadState) {
    const maxRetries = refs.settings?.get('usenetRetryAttempts') || 3;
    let lastError = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        // Try each provider in priority order
        for (const provider of providers) {
            const pool = state.pools.get(provider.id);
            if (!pool) continue;

            let conn = null;
            try {
                // Acquire connection
                conn = await pool.acquire();

                // Download article body
                const articleData = await conn.body(segment.message_id);

                // Decode yEnc data
                const decoded = yenc.decode(articleData);

                // Verify CRC if available
                if (decoded.crcValid === false) {
                    throw new Error('CRC verification failed');
                }

                // Update segment status
                await refs.db.run(`
                    UPDATE nzb_segments
                    SET status = 'completed', provider_id = ?
                    WHERE id = ?
                `, [provider.id, segment.id]);

                // Update progress
                downloadState.completedSegments++;
                downloadState.downloadedBytes += decoded.data.length;

                // Emit progress
                emitProgress(downloadState);

                return decoded.data;

            } catch (err) {
                lastError = err;
                refs.logger?.debug('usenet', `Segment ${segment.message_id} failed on ${provider.name}: ${err.message}`);
            } finally {
                if (conn) {
                    pool.release(conn);
                }
            }
        }
    }

    // All retries failed
    downloadState.failedSegments++;

    await refs.db.run(`
        UPDATE nzb_segments
        SET status = 'failed', attempts = ?, error_message = ?
        WHERE id = ?
    `, [maxRetries, lastError?.message || 'Unknown error', segment.id]);

    emitProgress(downloadState);

    throw lastError || new Error('All providers failed');
}

/**
 * Emit download progress
 */
function emitProgress(downloadState) {
    const percent = Math.round((downloadState.completedSegments / downloadState.totalSegments) * 100);
    const elapsed = (Date.now() - downloadState.startTime) / 1000;
    const speed = downloadState.downloadedBytes / elapsed;

    refs.app?.emit('usenet:download:progress', {
        downloadId: downloadState.downloadId,
        completedSegments: downloadState.completedSegments,
        totalSegments: downloadState.totalSegments,
        failedSegments: downloadState.failedSegments,
        downloadedBytes: downloadState.downloadedBytes,
        totalBytes: downloadState.totalBytes,
        percent,
        speed: formatBytes(speed) + '/s'
    });

    // Update database periodically
    if (downloadState.completedSegments % 100 === 0) {
        refs.db.run(`
            UPDATE nzb_downloads
            SET completed_segments = ?, failed_segments = ?, downloaded_bytes = ?
            WHERE id = ?
        `, [downloadState.completedSegments, downloadState.failedSegments, downloadState.downloadedBytes, downloadState.nzbDownloadId])
            .catch(err => refs.logger?.error('usenet', `Failed to update progress: ${err.message}`));
    }
}

/**
 * Get download status
 */
function getDownloadStatus(downloadId) {
    const state = state.activeDownloads.get(downloadId);
    if (!state) return null;

    const percent = Math.round((state.completedSegments / state.totalSegments) * 100);
    const elapsed = (Date.now() - state.startTime) / 1000;
    const speed = state.downloadedBytes / elapsed;

    return {
        completedSegments: state.completedSegments,
        totalSegments: state.totalSegments,
        failedSegments: state.failedSegments,
        downloadedBytes: state.downloadedBytes,
        totalBytes: state.totalBytes,
        percent,
        speed: formatBytes(speed) + '/s',
        elapsed: Math.round(elapsed)
    };
}

/**
 * Cancel a download
 */
async function cancelDownload(downloadId) {
    const downloadState = state.activeDownloads.get(downloadId);
    if (downloadState) {
        downloadState.cancelled = true;
        state.activeDownloads.delete(downloadId);
    }

    // Remove from queue
    const queueIndex = state.queue.findIndex(q => q.downloadId === downloadId);
    if (queueIndex !== -1) {
        state.queue.splice(queueIndex, 1);
    }

    // Update status
    await refs.db.run(
        'UPDATE downloads SET status = ? WHERE id = ?',
        ['cancelled', downloadId]
    );
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Shutdown - close all connection pools
 */
async function shutdown() {
    refs.logger?.info('usenet', 'Shutting down usenet module');

    for (const [providerId, pool] of state.pools) {
        try {
            await pool.close();
        } catch (err) {
            refs.logger?.error('usenet', `Failed to close pool ${providerId}: ${err.message}`);
        }
    }

    state.pools.clear();
    state.activeDownloads.clear();
    state.queue = [];
}

module.exports = {
    init: async (modules) => {
        refs.logger = modules.logger;
        refs.db = modules.db;
        refs.settings = modules.settings;
        refs.app = modules.app;

        refs.logger?.info('usenet', 'Usenet module initialized');
    },

    shutdown,

    // Public API
    testProvider,
    queueNzb,
    processQueue,
    getDownloadStatus,
    cancelDownload,
    getProviders
};
