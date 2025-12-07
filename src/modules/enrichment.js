/**
 * Enrichment Module - Background job queue with parallel workers
 *
 * Implements a worker pool pattern for parallel TMDB enrichment
 * while respecting rate limits (40 requests per 10 seconds).
 */

let logger = null;
let db = null;
let tmdb = null;
let settings = null;
let llm = null;  // LLM module for title translation
let allModules = null;  // Store modules ref for dynamic app access

// Helper to emit events via app module (which may load after us)
function emit(event, data) {
    allModules?.app?.emit(event, data);
}

// Configuration
const CONFIG = {
    maxWorkers: 4,              // Concurrent workers
    rateLimit: 35,              // TMDB allows 40, we use 35 for safety
    rateLimitWindow: 10000,     // 10 second window
    retryDelay: 1000,           // Delay after error
    maxRetries: 3,              // Max retry attempts per item
    batchSize: 500              // Max items to queue at once
};

// Worker pool state
const workers = new Map();
let isRunning = false;
let rateLimiter = null;
let progressInterval = null;

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

/**
 * Token Bucket Rate Limiter
 * Allows bursts while respecting overall rate limits
 */
class RateLimiter {
    constructor(tokensPerWindow, windowMs) {
        this.tokens = tokensPerWindow;
        this.maxTokens = tokensPerWindow;
        this.windowMs = windowMs;
        this.lastRefill = Date.now();
    }

    refill() {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        if (elapsed >= this.windowMs) {
            this.tokens = this.maxTokens;
            this.lastRefill = now;
        }
    }

    async acquire(count = 1) {
        return new Promise((resolve) => {
            const tryAcquire = () => {
                this.refill();
                if (this.tokens >= count) {
                    this.tokens -= count;
                    resolve(true);
                    return;
                }
                // Calculate wait time until next refill
                const waitTime = this.windowMs - (Date.now() - this.lastRefill) + 100;
                setTimeout(tryAcquire, Math.min(waitTime, 1000));
            };
            tryAcquire();
        });
    }

    getStatus() {
        this.refill();
        return {
            available: this.tokens,
            max: this.maxTokens,
            windowMs: this.windowMs
        };
    }
}

/**
 * Queue items for enrichment
 */
async function queueMediaForEnrichment(mediaIds, priority = 0) {
    let queued = 0;
    let skipped = 0;

    for (const mediaId of mediaIds) {
        try {
            // Check if not already in queue
            const existing = await db.get(
                'SELECT id FROM enrichment_queue WHERE media_id = ? AND status IN ("pending", "processing")',
                [mediaId]
            );

            if (!existing) {
                await db.run(`
                    INSERT INTO enrichment_queue (media_id, priority, status)
                    VALUES (?, ?, 'pending')
                `, [mediaId, priority]);
                queued++;
            } else {
                skipped++;
            }
        } catch (err) {
            skipped++;
            logger?.warn('enrichment', `Failed to queue media ${mediaId}: ${err.message}`);
        }
    }

    return { queued, skipped };
}

/**
 * Queue all unenriched media items
 */
async function queueUnenrichedMedia(mediaType = null, limit = null) {
    const actualLimit = limit || CONFIG.batchSize;

    let sql = `
        SELECT m.id FROM media m
        WHERE m.tmdb_id IS NULL
        AND (m.enrichment_attempted IS NULL OR m.enrichment_attempted < datetime('now', '-7 days'))
        AND m.media_type IN ('movie', 'series')
        AND m.title NOT LIKE '%####%'
        AND m.title NOT LIKE '## %'
        AND m.title NOT LIKE '%----- %'
        AND m.title NOT LIKE '%INFO%'
        AND m.title NOT LIKE '%MIX %'
        AND NOT EXISTS (
            SELECT 1 FROM enrichment_queue eq
            WHERE eq.media_id = m.id AND eq.status IN ('pending', 'processing')
        )
    `;
    const params = [];

    if (mediaType) {
        sql += ' AND m.media_type = ?';
        params.push(mediaType);
    }

    sql += ` ORDER BY
        CASE
            WHEN m.title LIKE '%24/7:%' THEN 0
            WHEN m.title LIKE '% 4K' OR m.title LIKE '% HD' THEN 1
            ELSE 2
        END,
        m.created_at DESC
    `;
    sql += ' LIMIT ?';
    params.push(actualLimit);

    const items = await db.all(sql, params);

    if (items.length === 0) {
        return { queued: 0, skipped: 0, total: 0 };
    }

    const result = await queueMediaForEnrichment(items.map(i => i.id));
    result.total = items.length;

    emit('enrichment:queued', result);
    logger?.info('enrichment', `Queued ${result.queued} items for enrichment`);

    return result;
}

/**
 * Claim a job from the queue (atomic operation)
 */
async function claimJob(workerId) {
    // Use a transaction-like approach for SQLite
    const job = await db.get(`
        SELECT * FROM enrichment_queue
        WHERE status = 'pending'
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
    `);

    if (!job) return null;

    // Try to claim it
    const result = await db.run(`
        UPDATE enrichment_queue
        SET status = 'processing', worker_id = ?, started_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'pending'
    `, [workerId, job.id]);

    if (result.changes === 0) {
        // Another worker got it first, try again
        return claimJob(workerId);
    }

    return { ...job, status: 'processing', worker_id: workerId };
}

/**
 * Complete a job successfully
 */
async function completeJob(jobId) {
    await db.run(`
        UPDATE enrichment_queue
        SET status = 'completed', completed_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `, [jobId]);
}

/**
 * Mark a job as failed
 */
async function failJob(jobId, errorMessage, retryCount) {
    if (retryCount < CONFIG.maxRetries) {
        // Retry later
        await db.run(`
            UPDATE enrichment_queue
            SET status = 'pending', worker_id = NULL, retry_count = retry_count + 1,
                error_message = ?
            WHERE id = ?
        `, [errorMessage, jobId]);
    } else {
        // Max retries reached
        await db.run(`
            UPDATE enrichment_queue
            SET status = 'failed', error_message = ?, completed_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [errorMessage, jobId]);
    }
}

/**
 * Find best matching result from TMDB search results
 * Uses year proximity and title similarity to pick the best match
 */
function findBestMatch(results, targetTitle, targetYear, mediaType) {
    if (!results || results.length === 0) return null;
    if (results.length === 1) return results[0];

    const normalizeTitle = (t) => t?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';
    const targetNorm = normalizeTitle(targetTitle);

    // Score each result
    const scored = results.map(r => {
        let score = 0;
        const title = r.title || r.name || '';
        const origTitle = r.original_title || r.original_name || '';
        const titleNorm = normalizeTitle(title);
        const origNorm = normalizeTitle(origTitle);

        // Exact title match (big bonus)
        if (titleNorm === targetNorm || origNorm === targetNorm) {
            score += 100;
        } else if (titleNorm.includes(targetNorm) || targetNorm.includes(titleNorm)) {
            score += 50;
        }

        // Year matching
        const resultYear = r.release_date?.substring(0, 4) || r.first_air_date?.substring(0, 4);
        if (resultYear && targetYear) {
            const yearDiff = Math.abs(parseInt(resultYear) - targetYear);
            if (yearDiff === 0) score += 30;
            else if (yearDiff <= 1) score += 20;
            else if (yearDiff <= 3) score += 10;
            // Penalty for very different years
            else if (yearDiff > 10) score -= 20;
        }

        // Popularity boost (TMDB popularity score)
        score += Math.min(r.popularity || 0, 50) / 5;

        // Vote count boost (more votes = more reliable)
        score += Math.min((r.vote_count || 0) / 100, 10);

        return { result: r, score };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    return scored[0].result;
}

/**
 * Search with fallback strategy
 */
async function searchWithFallback(cleanTitle, year, language, mediaType) {
    const searchFn = mediaType === 'movie' ? tmdb.searchMovie : tmdb.searchTv;

    // Strategy 1: Search WITHOUT year first (often more reliable for older content)
    // This helps with cases like "Zorro (1957)" where year might limit results
    await rateLimiter.acquire(1);
    let results = await searchFn(cleanTitle, null, null);
    if (results.length > 0) {
        const bestMatch = findBestMatch(results, cleanTitle, year, mediaType);
        if (bestMatch) return [bestMatch, ...results.filter(r => r.id !== bestMatch.id)];
    }

    // Strategy 2: Search with year (if provided and no results yet)
    if (year && results.length === 0) {
        await rateLimiter.acquire(1);
        results = await searchFn(cleanTitle, year, null);
        if (results.length > 0) return results;
    }

    // Strategy 3: Search with language hint (for foreign titles)
    if (language) {
        await rateLimiter.acquire(1);
        results = await searchFn(cleanTitle, null, language);
        if (results.length > 0) {
            const bestMatch = findBestMatch(results, cleanTitle, year, mediaType);
            if (bestMatch) return [bestMatch, ...results.filter(r => r.id !== bestMatch.id)];
        }
    }

    return [];
}

/**
 * Process a single media item
 */
async function processMediaItem(media) {
    // Extract clean title with language hint
    const extracted = tmdb.extractCleanTitle(media.title);
    if (!extracted || extracted.skip || !extracted.title || extracted.title.length < 1) {
        throw new Error('Invalid title for enrichment');
    }

    const { title: cleanTitle, year: extractedYear, language } = extracted;
    const year = media.year || extractedYear;

    // Mark as attempted
    await db.run('UPDATE media SET enrichment_attempted = CURRENT_TIMESTAMP WHERE id = ?', [media.id]);

    // Search TMDB with fallback strategies
    let searchResults = await searchWithFallback(cleanTitle, year, language, media.media_type);

    // LLM Fallback: If no results and LLM is configured, try identifying the media
    let translatedTitle = null;
    let llmIdentified = null;
    if (searchResults.length === 0 && llm?.isConfigured()) {
        try {
            // First try the new identifyMedia function which can return TMDB IDs directly
            llmIdentified = await llm.identifyMedia(cleanTitle, year, media.media_type, language || 'unknown');

            if (llmIdentified && llmIdentified.englishTitle) {
                translatedTitle = llmIdentified.englishTitle;
                logger?.info('enrichment', `LLM identified: "${cleanTitle}" -> "${translatedTitle}" (confidence: ${llmIdentified.confidence})`);

                // If LLM provided a TMDB ID with reasonable confidence, verify it directly
                if (llmIdentified.tmdbId && llmIdentified.confidence >= 0.75) {
                    logger?.info('enrichment', `LLM provided TMDB ID: ${llmIdentified.tmdbId}, verifying...`);
                    try {
                        await rateLimiter.acquire(1);
                        let verifiedDetails;
                        if (media.media_type === 'movie' || llmIdentified.tmdbType === 'movie') {
                            verifiedDetails = await tmdb.getMovie(llmIdentified.tmdbId);
                        } else {
                            verifiedDetails = await tmdb.getTv(llmIdentified.tmdbId);
                        }

                        if (verifiedDetails && verifiedDetails.id) {
                            // LLM TMDB ID is valid - use it directly
                            searchResults = [{ id: verifiedDetails.id, ...verifiedDetails }];
                            logger?.info('enrichment', `LLM TMDB ID verified: ${verifiedDetails.id} - "${verifiedDetails.title || verifiedDetails.name}"`);
                        }
                    } catch (verifyError) {
                        logger?.warn('enrichment', `LLM TMDB ID verification failed: ${verifyError.message}`);
                    }
                }

                // If still no results, search with the translated/identified title
                if (searchResults.length === 0) {
                    searchResults = await searchWithFallback(translatedTitle, llmIdentified.year || year, 'en', media.media_type);
                }

                if (searchResults.length > 0) {
                    // Store the translated title
                    await db.run(
                        'UPDATE media SET translated_title = ?, translation_source = ? WHERE id = ?',
                        [translatedTitle, settings.get('llmProvider'), media.id]
                    );
                }
            } else {
                // Fall back to simple title translation
                translatedTitle = await llm.translateTitle(cleanTitle, language || 'unknown');
                if (translatedTitle && translatedTitle.toLowerCase() !== cleanTitle.toLowerCase()) {
                    logger?.info('enrichment', `LLM translated: "${cleanTitle}" -> "${translatedTitle}"`);
                    searchResults = await searchWithFallback(translatedTitle, year, 'en', media.media_type);

                    if (searchResults.length > 0) {
                        await db.run(
                            'UPDATE media SET translated_title = ?, translation_source = ? WHERE id = ?',
                            [translatedTitle, settings.get('llmProvider'), media.id]
                        );
                    }
                }
            }
        } catch (llmError) {
            logger?.warn('enrichment', `LLM identification failed: ${llmError.message}`);
        }
    }

    if (searchResults.length === 0) {
        throw new Error(`No TMDB results for: ${cleanTitle}${translatedTitle ? ` / ${translatedTitle}` : ''}${language ? ` (${language})` : ''}`);
    }

    // Get full details (1 API call, may be cached)
    await rateLimiter.acquire(1);

    const match = searchResults[0];
    let details;
    if (media.media_type === 'movie') {
        details = await tmdb.getMovie(match.id);
    } else {
        details = await tmdb.getTv(match.id);
    }

    // Update media record with all enriched data
    const posterPath = details.poster_path || (match.poster_path ? `${TMDB_IMAGE_BASE}/w500${match.poster_path}` : null);
    const backdropPath = details.backdrop_path || (match.backdrop_path ? `${TMDB_IMAGE_BASE}/w1280${match.backdrop_path}` : null);

    await db.run(`
        UPDATE media SET
            tmdb_id = ?,
            tagline = ?,
            plot = COALESCE(?, plot),
            poster = COALESCE(?, poster),
            backdrop = COALESCE(?, backdrop),
            rating = COALESCE(?, rating),
            genres = COALESCE(?, genres),
            year = COALESCE(?, year),
            runtime = COALESCE(?, runtime),
            imdb_id = COALESCE(?, imdb_id),
            number_of_seasons = ?,
            number_of_episodes = ?,
            last_updated = CURRENT_TIMESTAMP
        WHERE id = ?
    `, [
        details.id, details.tagline, details.overview,
        posterPath, backdropPath,
        details.vote_average, details.genres, details.year, details.runtime,
        details.imdb_id, details.number_of_seasons || null, details.number_of_episodes || null,
        media.id
    ]);

    // Store trailers
    let trailerCount = 0;
    if (details.trailers && details.trailers.length > 0) {
        for (const trailer of details.trailers.slice(0, 5)) {
            try {
                await db.run(`
                    INSERT OR IGNORE INTO media_trailers
                    (media_id, youtube_key, name, type, official, published_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                `, [
                    media.id, trailer.youtube_key, trailer.name,
                    trailer.type, trailer.official, trailer.published_at
                ]);
                trailerCount++;
            } catch (err) {
                // Ignore duplicate trailers
            }
        }
    }

    // Store cast/crew
    if (details.cast || details.crew) {
        for (const person of [...(details.cast || []), ...(details.crew || [])]) {
            try {
                await db.run(`
                    INSERT OR REPLACE INTO people (tmdb_id, name, profile_path, known_for)
                    VALUES (?, ?, ?, ?)
                `, [person.id, person.name, person.profile_path, person.job || 'Acting']);

                const personRecord = await db.get('SELECT id FROM people WHERE tmdb_id = ?', [person.id]);
                if (personRecord) {
                    const role = person.job ? 'crew' : 'cast';
                    await db.run(`
                        INSERT OR IGNORE INTO media_people (media_id, person_id, role, character, credit_order)
                        VALUES (?, ?, ?, ?, ?)
                    `, [media.id, personRecord.id, role, person.character || person.job, person.order || 999]);
                }
            } catch (err) {
                // Ignore people insert errors
            }
        }
    }

    // Store seasons and episodes for TV shows
    let seasonCount = 0;
    let episodeCount = 0;
    if (media.media_type === 'series' && details.seasons && details.seasons.length > 0) {
        for (const season of details.seasons) {
            // Skip "Specials" (season 0) for now, or include based on preference
            if (season.season_number === 0) continue;

            try {
                // Store season metadata
                await db.run(`
                    INSERT OR REPLACE INTO seasons
                    (media_id, tmdb_id, season_number, name, overview, poster, air_date, episode_count, vote_average)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    media.id,
                    season.id,
                    season.season_number,
                    season.name,
                    season.overview,
                    season.poster_path,
                    season.air_date,
                    season.episode_count,
                    season.vote_average
                ]);
                seasonCount++;

                // Fetch full season details with episodes (rate limited)
                await rateLimiter.acquire(1);
                const seasonDetails = await tmdb.getSeason(details.id, season.season_number);

                if (seasonDetails && seasonDetails.episodes) {
                    for (const episode of seasonDetails.episodes) {
                        try {
                            await db.run(`
                                INSERT OR REPLACE INTO episodes
                                (media_id, tmdb_id, season, episode, title, overview, air_date, runtime, still_path, vote_average, vote_count)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            `, [
                                media.id,
                                episode.id,
                                season.season_number,
                                episode.episode_number,
                                episode.name,
                                episode.overview,
                                episode.air_date,
                                episode.runtime,
                                episode.still_path,
                                episode.vote_average,
                                episode.vote_count || 0
                            ]);
                            episodeCount++;
                        } catch (epErr) {
                            // Ignore episode insert errors
                        }
                    }
                }
            } catch (seasonErr) {
                logger?.warn('enrichment', `Failed to store season ${season.season_number}: ${seasonErr.message}`);
            }
        }

        if (seasonCount > 0) {
            logger?.debug('enrichment', `Stored ${seasonCount} seasons, ${episodeCount} episodes for: ${media.title}`);
        }
    }

    return { tmdbId: details.id, trailerCount, seasonCount, episodeCount };
}

/**
 * Worker function - processes jobs from the queue
 */
async function runWorker(workerId) {
    logger?.debug('enrichment', `Worker ${workerId} started`);
    workers.set(workerId, { status: 'idle', currentJob: null, processed: 0, failed: 0 });

    while (isRunning) {
        try {
            const job = await claimJob(workerId);

            if (!job) {
                workers.get(workerId).status = 'idle';
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }

            workers.get(workerId).status = 'processing';
            workers.get(workerId).currentJob = job;

            // Get media details
            const media = await db.get('SELECT * FROM media WHERE id = ?', [job.media_id]);

            if (!media) {
                await failJob(job.id, 'Media not found', CONFIG.maxRetries);
                continue;
            }

            try {
                const result = await processMediaItem(media);
                await completeJob(job.id);
                workers.get(workerId).processed++;

                emit('enrichment:item:complete', {
                    mediaId: media.id,
                    tmdbId: result.tmdbId,
                    title: media.title,
                    trailerCount: result.trailerCount,
                    workerId
                });

                logger?.debug('enrichment', `Worker ${workerId} enriched: ${media.title} (TMDB: ${result.tmdbId})`);

            } catch (err) {
                await failJob(job.id, err.message, job.retry_count);
                workers.get(workerId).failed++;

                emit('enrichment:item:failed', {
                    mediaId: media.id,
                    title: media.title,
                    error: err.message,
                    workerId
                });

                logger?.debug('enrichment', `Worker ${workerId} failed: ${media.title} - ${err.message}`);

                // Small delay after error
                await new Promise(r => setTimeout(r, CONFIG.retryDelay));
            }

            workers.get(workerId).currentJob = null;

        } catch (err) {
            logger?.error('enrichment', `Worker ${workerId} error: ${err.message}`);
            await new Promise(r => setTimeout(r, CONFIG.retryDelay));
        }
    }

    logger?.debug('enrichment', `Worker ${workerId} stopped`);
}

/**
 * Progress reporter - emits queue status periodically
 */
function startProgressReporter() {
    if (progressInterval) return;

    progressInterval = setInterval(async () => {
        if (!isRunning) {
            clearInterval(progressInterval);
            progressInterval = null;
            return;
        }

        try {
            const status = await getQueueStatus();
            const workerStatus = getWorkerStatus();

            emit('enrichment:progress', {
                queue: status,
                workers: workerStatus,
                rateLimit: rateLimiter?.getStatus()
            });
        } catch (err) {
            logger?.warn('enrichment', `Progress reporter error: ${err.message}`);
        }
    }, 2000);
}

/**
 * Start worker pool
 */
async function startWorkers() {
    if (isRunning) {
        logger?.info('enrichment', 'Workers already running');
        return { message: 'Workers already running', count: CONFIG.maxWorkers };
    }

    isRunning = true;
    rateLimiter = new RateLimiter(CONFIG.rateLimit, CONFIG.rateLimitWindow);

    for (let i = 0; i < CONFIG.maxWorkers; i++) {
        const workerId = `worker-${i}`;
        runWorker(workerId);  // Don't await - run in background
    }

    logger?.info('enrichment', `Started ${CONFIG.maxWorkers} enrichment workers`);
    emit('enrichment:workers:started', { count: CONFIG.maxWorkers });

    // Start progress reporter
    startProgressReporter();

    return { message: 'Workers started', count: CONFIG.maxWorkers };
}

/**
 * Stop worker pool gracefully
 */
async function stopWorkers() {
    isRunning = false;

    // Wait for workers to finish current jobs (max 30 seconds)
    const timeout = Date.now() + 30000;
    while (Date.now() < timeout) {
        const activeWorkers = Array.from(workers.values()).filter(w => w.status === 'processing');
        if (activeWorkers.length === 0) break;
        await new Promise(r => setTimeout(r, 500));
    }

    workers.clear();

    if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
    }

    logger?.info('enrichment', 'Enrichment workers stopped');
    emit('enrichment:workers:stopped', {});

    return { message: 'Workers stopped' };
}

/**
 * Get queue status
 */
async function getQueueStatus() {
    const stats = await db.get(`
        SELECT
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
            SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
        FROM enrichment_queue
    `);

    return {
        pending: stats?.pending || 0,
        processing: stats?.processing || 0,
        completed: stats?.completed || 0,
        failed: stats?.failed || 0,
        total: (stats?.pending || 0) + (stats?.processing || 0) + (stats?.completed || 0) + (stats?.failed || 0)
    };
}

/**
 * Get worker status
 */
function getWorkerStatus() {
    const result = [];
    for (const [id, state] of workers) {
        result.push({
            id,
            status: state.status,
            currentMediaId: state.currentJob?.media_id,
            processed: state.processed,
            failed: state.failed
        });
    }
    return result;
}

/**
 * Clear completed/failed jobs from queue
 */
async function clearQueue(status = null) {
    if (status) {
        const result = await db.run('DELETE FROM enrichment_queue WHERE status = ?', [status]);
        return { cleared: result.changes };
    } else {
        const result = await db.run('DELETE FROM enrichment_queue WHERE status IN ("completed", "failed")');
        return { cleared: result.changes };
    }
}

/**
 * Retry failed jobs
 */
async function retryFailedJobs() {
    const result = await db.run(`
        UPDATE enrichment_queue
        SET status = 'pending', retry_count = 0, error_message = NULL, worker_id = NULL
        WHERE status = 'failed'
    `);
    return { retried: result.changes };
}

/**
 * Get enrichment statistics
 */
async function getStats() {
    const queueStats = await getQueueStatus();

    const mediaStats = await db.get(`
        SELECT
            SUM(CASE WHEN tmdb_id IS NOT NULL THEN 1 ELSE 0 END) as enriched,
            SUM(CASE WHEN tmdb_id IS NULL AND enrichment_attempted IS NOT NULL THEN 1 ELSE 0 END) as attempted,
            SUM(CASE WHEN tmdb_id IS NULL AND enrichment_attempted IS NULL THEN 1 ELSE 0 END) as pending,
            COUNT(*) as total
        FROM media
        WHERE media_type IN ('movie', 'series')
    `);

    return {
        queue: queueStats,
        media: {
            enriched: mediaStats?.enriched || 0,
            attempted: mediaStats?.attempted || 0,
            pending: mediaStats?.pending || 0,
            total: mediaStats?.total || 0
        },
        workers: {
            running: isRunning,
            count: workers.size,
            status: getWorkerStatus()
        }
    };
}

module.exports = {
    init: async (modules) => {
        logger = modules.logger;
        db = modules.db;
        tmdb = modules.tmdb;
        settings = modules.settings;
        llm = modules.llm;  // LLM module for title translation
        allModules = modules;  // Store ref for dynamic app access

        // Reset any processing jobs from previous run
        await db.run(`
            UPDATE enrichment_queue
            SET status = 'pending', worker_id = NULL
            WHERE status = 'processing'
        `);

        logger?.info('enrichment', 'Enrichment module initialized');

        // Auto-resume: start workers if there are pending jobs
        const pending = await db.get('SELECT COUNT(*) as count FROM enrichment_queue WHERE status = "pending"');
        if (pending?.count > 0) {
            logger?.info('enrichment', `Auto-resuming: ${pending.count} pending jobs found`);
            // Delay start to ensure app module is loaded (for Socket.io)
            setTimeout(() => {
                startWorkers().catch(err => {
                    logger?.error('enrichment', `Auto-resume failed: ${err.message}`);
                });
            }, 2000);
        }
    },

    // Public API
    queueMediaForEnrichment,
    queueUnenrichedMedia,
    startWorkers,
    stopWorkers,
    getQueueStatus,
    getWorkerStatus,
    clearQueue,
    retryFailedJobs,
    getStats,

    // Check if workers are running
    isRunning: () => isRunning,

    // Get config
    getConfig: () => ({ ...CONFIG })
};
