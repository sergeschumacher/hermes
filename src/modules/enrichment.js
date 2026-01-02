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
    maxWorkers: 8,              // Concurrent workers (increased from 4)
    rateLimit: 38,              // TMDB allows 40, we use 38 for safety
    rateLimitWindow: 10000,     // 10 second window
    retryDelay: 500,            // Delay after error (reduced)
    maxRetries: 2,              // Max retry attempts per item (reduced)
    batchSize: 1000,            // Max items to queue at once (increased)
    skipSeasonFetch: true,      // Skip fetching season details in bulk mode (saves API calls)
    skipLlmInBulk: true,        // Skip LLM calls in bulk enrichment (saves tokens)
    propagateTmdbId: true       // Propagate TMDB ID to duplicate show_names
};

// Worker pool state
const workers = new Map();
let isRunning = false;
let rateLimiter = null;
let progressInterval = null;

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

/**
 * Generate cache key for enrichment lookup
 * Normalizes title to lowercase alphanumeric for fuzzy matching
 */
function generateCacheKey(title, year, mediaType) {
    const normalizedTitle = title?.toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .substring(0, 100) || '';
    return `${normalizedTitle}|${year || ''}|${mediaType}`;
}

/**
 * Lookup enrichment data from cache
 */
async function lookupEnrichmentCache(title, year, mediaType) {
    const cacheKey = generateCacheKey(title, year, mediaType);

    // Try exact match first
    let cached = await db.get(
        'SELECT * FROM enrichment_cache WHERE cache_key = ?',
        [cacheKey]
    );

    // If no exact match and we have a year, try without year
    if (!cached && year) {
        const noYearKey = generateCacheKey(title, null, mediaType);
        cached = await db.get(
            'SELECT * FROM enrichment_cache WHERE cache_key = ?',
            [noYearKey]
        );
    }

    // Also try lookup by tmdb_id if title matches closely
    if (!cached) {
        const normalizedTitle = title?.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 100) || '';
        cached = await db.get(`
            SELECT * FROM enrichment_cache
            WHERE cache_key LIKE ? || '|%'
            AND media_type = ?
            LIMIT 1
        `, [normalizedTitle, mediaType]);
    }

    return cached;
}

/**
 * Save enrichment data to cache for future provider changes
 */
async function saveToEnrichmentCache(title, year, mediaType, data) {
    const cacheKey = generateCacheKey(title, year, mediaType);

    try {
        await db.run(`
            INSERT OR REPLACE INTO enrichment_cache
            (cache_key, media_type, title, year, tmdb_id, poster, backdrop, rating, plot, tagline, genres, runtime, imdb_id, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `, [
            cacheKey,
            mediaType,
            title,
            year || null,
            data.tmdb_id || data.id,
            data.poster || data.poster_path,
            data.backdrop || data.backdrop_path,
            data.rating || data.vote_average,
            data.plot || data.overview,
            data.tagline,
            typeof data.genres === 'string' ? data.genres : JSON.stringify(data.genres || []),
            data.runtime,
            data.imdb_id
        ]);

        logger?.debug('enrichment', `Cached enrichment for: ${title} (${year || 'no year'})`);
    } catch (err) {
        logger?.warn('enrichment', `Failed to cache enrichment for ${title}: ${err.message}`);
    }
}

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
 * Fetch TMDB details by ID and apply to media record
 * Used when tmdb_id is already known (e.g., manually set or from cache)
 */
async function fetchAndApplyTmdbDetails(media, tmdbId, options = {}) {
    const { highPriority = false } = options;
    const fetchFullDetails = highPriority || !CONFIG.skipSeasonFetch;

    // Create rate limiter if needed
    if (!rateLimiter) {
        rateLimiter = new RateLimiter(CONFIG.rateLimit, CONFIG.rateLimitWindow);
    }

    await rateLimiter.acquire(1);
    let details;
    if (media.media_type === 'movie') {
        details = await tmdb.getMovie(tmdbId);
    } else {
        details = await tmdb.getTv(tmdbId);
    }

    if (!details || !details.id) {
        throw new Error(`TMDB ID ${tmdbId} not found`);
    }

    // Update media record with fetched details
    const posterPath = details.poster_path;
    const backdropPath = details.backdrop_path;

    await db.run(`
        UPDATE media SET
            tmdb_id = ?,
            tagline = COALESCE(?, tagline),
            plot = COALESCE(?, plot),
            poster = COALESCE(?, poster),
            backdrop = COALESCE(?, backdrop),
            rating = COALESCE(?, rating),
            genres = COALESCE(?, genres),
            year = COALESCE(?, year),
            runtime = COALESCE(?, runtime),
            imdb_id = COALESCE(?, imdb_id),
            number_of_seasons = COALESCE(?, number_of_seasons),
            number_of_episodes = COALESCE(?, number_of_episodes),
            enrichment_attempted = CURRENT_TIMESTAMP,
            last_updated = CURRENT_TIMESTAMP
        WHERE id = ?
    `, [
        details.id, details.tagline, details.overview,
        posterPath, backdropPath,
        details.vote_average, details.genres, details.year, details.runtime,
        details.imdb_id, details.number_of_seasons || null, details.number_of_episodes || null,
        media.id
    ]);

    // Handle trailers, seasons, cast in high priority mode
    let trailerCount = 0;
    let seasonCount = 0;
    let episodeCount = 0;

    if (fetchFullDetails) {
        // Store trailers
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
                } catch (err) { /* ignore duplicates */ }
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
                } catch (err) { /* ignore errors */ }
            }
        }

        // Fetch seasons for TV shows
        if (media.media_type === 'series' && details.seasons && details.seasons.length > 0) {
            for (const season of details.seasons) {
                if (season.season_number === 0) continue;
                try {
                    await db.run(`
                        INSERT OR REPLACE INTO seasons
                        (media_id, tmdb_id, season_number, name, overview, poster, air_date, episode_count, vote_average)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `, [
                        media.id, season.id, season.season_number, season.name,
                        season.overview, season.poster_path, season.air_date,
                        season.episode_count, season.vote_average
                    ]);
                    seasonCount++;

                    // Fetch episode details
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
                                    media.id, episode.id, season.season_number, episode.episode_number,
                                    episode.name, episode.overview, episode.air_date, episode.runtime,
                                    episode.still_path, episode.vote_average, episode.vote_count || 0
                                ]);
                                episodeCount++;
                            } catch (epErr) { /* ignore */ }
                        }
                    }
                } catch (seasonErr) {
                    logger?.warn('enrichment', `Failed to store season ${season.season_number}: ${seasonErr.message}`);
                }
            }
        }
    }

    // Propagate to other entries with same show_name
    if (CONFIG.propagateTmdbId && media.media_type === 'series' && media.show_name) {
        await db.run(`
            UPDATE media SET
                tmdb_id = ?,
                poster = COALESCE(?, poster),
                backdrop = COALESCE(?, backdrop),
                plot = COALESCE(?, plot),
                rating = COALESCE(?, rating),
                enrichment_attempted = CURRENT_TIMESTAMP
            WHERE show_name = ?
            AND id != ?
            AND tmdb_id IS NULL
        `, [details.id, posterPath, backdropPath, details.overview, details.vote_average, media.show_name, media.id]);
    }

    // Cache the enrichment data
    const extracted = tmdb.extractCleanTitle(media.title);
    const cleanTitle = extracted?.title || media.title;
    const year = media.year || extracted?.year;

    await saveToEnrichmentCache(cleanTitle, year, media.media_type, {
        id: details.id,
        poster: posterPath,
        backdrop: backdropPath,
        rating: details.vote_average,
        plot: details.overview,
        tagline: details.tagline,
        genres: details.genres,
        runtime: details.runtime,
        imdb_id: details.imdb_id
    });

    return { tmdbId: details.id, trailerCount, seasonCount, episodeCount };
}

/**
 * Process a single media item
 * @param {Object} media - The media item to process
 * @param {Object} options - Processing options
 * @param {boolean} options.highPriority - If true, fetch full details and use LLM fallback
 * @param {boolean} options.useExistingTmdbId - If true, use media.tmdb_id directly without searching
 */
async function processMediaItem(media, options = {}) {
    const { highPriority = false, useExistingTmdbId = true } = options;

    // If media already has a tmdb_id and we should use it, fetch details directly
    if (useExistingTmdbId && media.tmdb_id) {
        logger?.info('enrichment', `Using existing TMDB ID ${media.tmdb_id} for: ${media.title}`);
        return await fetchAndApplyTmdbDetails(media, media.tmdb_id, { highPriority });
    }

    // Extract clean title with language hint
    const extracted = tmdb.extractCleanTitle(media.title);
    if (!extracted || extracted.skip || !extracted.title || extracted.title.length < 1) {
        throw new Error('Invalid title for enrichment');
    }

    const { title: cleanTitle, year: extractedYear, language } = extracted;
    const year = media.year || extractedYear;

    // CHECK CACHE FIRST - avoid TMDB API call if we have cached enrichment data
    const cachedEnrichment = await lookupEnrichmentCache(cleanTitle, year, media.media_type);
    if (cachedEnrichment && cachedEnrichment.tmdb_id) {
        logger?.info('enrichment', `Cache hit for: ${cleanTitle} (TMDB: ${cachedEnrichment.tmdb_id})`);

        // Apply cached data to media record
        await db.run(`
            UPDATE media SET
                tmdb_id = ?,
                poster = COALESCE(?, poster),
                backdrop = COALESCE(?, backdrop),
                rating = COALESCE(?, rating),
                plot = COALESCE(?, plot),
                tagline = COALESCE(?, tagline),
                genres = COALESCE(?, genres),
                year = COALESCE(?, year),
                runtime = COALESCE(?, runtime),
                imdb_id = COALESCE(?, imdb_id),
                enrichment_attempted = CURRENT_TIMESTAMP,
                last_updated = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [
            cachedEnrichment.tmdb_id,
            cachedEnrichment.poster,
            cachedEnrichment.backdrop,
            cachedEnrichment.rating,
            cachedEnrichment.plot,
            cachedEnrichment.tagline,
            cachedEnrichment.genres,
            cachedEnrichment.year,
            cachedEnrichment.runtime,
            cachedEnrichment.imdb_id,
            media.id
        ]);

        // Propagate to other entries with same show_name (for series)
        if (CONFIG.propagateTmdbId && media.media_type === 'series' && media.show_name) {
            await db.run(`
                UPDATE media SET
                    tmdb_id = ?,
                    poster = COALESCE(?, poster),
                    backdrop = COALESCE(?, backdrop),
                    rating = COALESCE(?, rating),
                    enrichment_attempted = CURRENT_TIMESTAMP
                WHERE show_name = ? AND id != ? AND tmdb_id IS NULL
            `, [cachedEnrichment.tmdb_id, cachedEnrichment.poster, cachedEnrichment.backdrop,
                cachedEnrichment.rating, media.show_name, media.id]);
        }

        return {
            tmdbId: cachedEnrichment.tmdb_id,
            fromCache: true,
            trailerCount: 0,
            seasonCount: 0,
            episodeCount: 0
        };
    }

    // Mark as attempted
    await db.run('UPDATE media SET enrichment_attempted = CURRENT_TIMESTAMP WHERE id = ?', [media.id]);

    // Search TMDB with fallback strategies
    let searchResults = await searchWithFallback(cleanTitle, year, language, media.media_type);

    // LLM Fallback: Only use in high priority mode (single item enrichment) to save tokens
    let translatedTitle = null;
    let llmIdentified = null;
    const useLlm = highPriority || !CONFIG.skipLlmInBulk;

    if (searchResults.length === 0 && useLlm && llm?.isConfigured()) {
        try {
            llmIdentified = await llm.identifyMedia(cleanTitle, year, media.media_type, language || 'unknown');

            if (llmIdentified && llmIdentified.englishTitle) {
                translatedTitle = llmIdentified.englishTitle;
                logger?.info('enrichment', `LLM identified: "${cleanTitle}" -> "${translatedTitle}" (confidence: ${llmIdentified.confidence})`);

                if (llmIdentified.tmdbId && llmIdentified.confidence >= 0.75) {
                    try {
                        await rateLimiter.acquire(1);
                        let verifiedDetails;
                        if (media.media_type === 'movie' || llmIdentified.tmdbType === 'movie') {
                            verifiedDetails = await tmdb.getMovie(llmIdentified.tmdbId);
                        } else {
                            verifiedDetails = await tmdb.getTv(llmIdentified.tmdbId);
                        }

                        if (verifiedDetails && verifiedDetails.id) {
                            // Verify the returned title actually matches what LLM identified
                            const detailTitle = (verifiedDetails.title || verifiedDetails.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                            const expectedTitle = translatedTitle.toLowerCase().replace(/[^a-z0-9]/g, '');

                            if (detailTitle.includes(expectedTitle) || expectedTitle.includes(detailTitle) ||
                                (detailTitle.length > 3 && expectedTitle.length > 3 &&
                                 (detailTitle.startsWith(expectedTitle.substring(0, 5)) || expectedTitle.startsWith(detailTitle.substring(0, 5))))) {
                                searchResults = [{ id: verifiedDetails.id, ...verifiedDetails }];
                                logger?.info('enrichment', `LLM TMDB ID verified: ${llmIdentified.tmdbId} -> "${verifiedDetails.title || verifiedDetails.name}"`);
                            } else {
                                logger?.warn('enrichment', `LLM TMDB ID mismatch: expected "${translatedTitle}" but got "${verifiedDetails.title || verifiedDetails.name}" - will search instead`);
                            }
                        }
                    } catch (verifyError) {
                        logger?.warn('enrichment', `LLM TMDB ID verification failed: ${verifyError.message}`);
                    }
                }

                if (searchResults.length === 0) {
                    searchResults = await searchWithFallback(translatedTitle, llmIdentified.year || year, 'en', media.media_type);
                }

                if (searchResults.length > 0) {
                    await db.run(
                        'UPDATE media SET translated_title = ?, translation_source = ? WHERE id = ?',
                        [translatedTitle, settings.get('llmProvider'), media.id]
                    );
                }
            } else {
                translatedTitle = await llm.translateTitle(cleanTitle, language || 'unknown');
                if (translatedTitle && translatedTitle.toLowerCase() !== cleanTitle.toLowerCase()) {
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

    const match = searchResults[0];

    // OPTIMIZATION: In bulk mode, use search results directly without fetching full details
    // This saves 1 API call per item. Full details can be fetched on-demand when viewing.
    const fetchFullDetails = highPriority || !CONFIG.skipSeasonFetch;

    let details;
    if (fetchFullDetails) {
        // High priority: fetch full details including credits, trailers, etc.
        await rateLimiter.acquire(1);
        if (media.media_type === 'movie') {
            details = await tmdb.getMovie(match.id);
        } else {
            details = await tmdb.getTv(match.id);
        }
    } else {
        // Bulk mode: use search result data directly (poster, backdrop, overview are included)
        details = {
            id: match.id,
            overview: match.overview,
            poster_path: match.poster_path ? `${TMDB_IMAGE_BASE}/w500${match.poster_path}` : null,
            backdrop_path: match.backdrop_path ? `${TMDB_IMAGE_BASE}/w1280${match.backdrop_path}` : null,
            vote_average: match.vote_average,
            year: match.release_date?.substring(0, 4) || match.first_air_date?.substring(0, 4),
            genres: null,  // Not in search results
            tagline: null, // Not in search results
            runtime: null, // Not in search results
            imdb_id: null, // Not in search results
            trailers: [],
            cast: [],
            crew: [],
            seasons: [],
            number_of_seasons: null,
            number_of_episodes: null
        };
    }

    // Update media record
    const posterPath = details.poster_path || (match.poster_path ? `${TMDB_IMAGE_BASE}/w500${match.poster_path}` : null);
    const backdropPath = details.backdrop_path || (match.backdrop_path ? `${TMDB_IMAGE_BASE}/w1280${match.backdrop_path}` : null);

    await db.run(`
        UPDATE media SET
            tmdb_id = ?,
            tagline = COALESCE(?, tagline),
            plot = COALESCE(?, plot),
            poster = COALESCE(?, poster),
            backdrop = COALESCE(?, backdrop),
            rating = COALESCE(?, rating),
            genres = COALESCE(?, genres),
            year = COALESCE(?, year),
            runtime = COALESCE(?, runtime),
            imdb_id = COALESCE(?, imdb_id),
            number_of_seasons = COALESCE(?, number_of_seasons),
            number_of_episodes = COALESCE(?, number_of_episodes),
            last_updated = CURRENT_TIMESTAMP
        WHERE id = ?
    `, [
        details.id, details.tagline, details.overview,
        posterPath, backdropPath,
        details.vote_average, details.genres, details.year, details.runtime,
        details.imdb_id, details.number_of_seasons || null, details.number_of_episodes || null,
        media.id
    ]);

    // OPTIMIZATION: Propagate TMDB ID to other entries with same show_name (for series)
    // This avoids re-searching for "Breaking Bad DE", "Breaking Bad EN", etc.
    if (CONFIG.propagateTmdbId && media.media_type === 'series' && media.show_name) {
        const propagated = await db.run(`
            UPDATE media SET
                tmdb_id = ?,
                poster = COALESCE(?, poster),
                backdrop = COALESCE(?, backdrop),
                plot = COALESCE(?, plot),
                rating = COALESCE(?, rating),
                enrichment_attempted = CURRENT_TIMESTAMP
            WHERE show_name = ?
            AND id != ?
            AND tmdb_id IS NULL
        `, [details.id, posterPath, backdropPath, details.overview, details.vote_average, media.show_name, media.id]);

        if (propagated.changes > 0) {
            logger?.debug('enrichment', `Propagated TMDB ID ${details.id} to ${propagated.changes} other "${media.show_name}" entries`);
        }
    }

    // Only store trailers, cast, seasons in high priority mode
    let trailerCount = 0;
    let seasonCount = 0;
    let episodeCount = 0;

    if (fetchFullDetails) {
        // Store trailers
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

        // Store seasons and episodes for TV shows (only in high priority mode)
        if (media.media_type === 'series' && details.seasons && details.seasons.length > 0) {
            for (const season of details.seasons) {
                if (season.season_number === 0) continue;

                try {
                    await db.run(`
                        INSERT OR REPLACE INTO seasons
                        (media_id, tmdb_id, season_number, name, overview, poster, air_date, episode_count, vote_average)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `, [
                        media.id, season.id, season.season_number, season.name,
                        season.overview, season.poster_path, season.air_date,
                        season.episode_count, season.vote_average
                    ]);
                    seasonCount++;

                    // Fetch episode details (rate limited)
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
                                    media.id, episode.id, season.season_number, episode.episode_number,
                                    episode.name, episode.overview, episode.air_date, episode.runtime,
                                    episode.still_path, episode.vote_average, episode.vote_count || 0
                                ]);
                                episodeCount++;
                            } catch (epErr) {}
                        }
                    }
                } catch (seasonErr) {
                    logger?.warn('enrichment', `Failed to store season ${season.season_number}: ${seasonErr.message}`);
                }
            }
        }
    }

    // SAVE TO ENRICHMENT CACHE for future provider changes
    await saveToEnrichmentCache(cleanTitle, year, media.media_type, {
        id: details.id,
        poster: posterPath,
        backdrop: backdropPath,
        rating: details.vote_average,
        plot: details.overview,
        tagline: details.tagline,
        genres: details.genres,
        runtime: details.runtime,
        imdb_id: details.imdb_id
    });

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
                // High priority jobs (priority >= 100) get full enrichment with LLM fallback
                const highPriority = job.priority >= 100;
                const result = await processMediaItem(media, { highPriority });
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
 * NOTE: Auto-queue is DISABLED - enrichment is now on-demand only
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

            // AUTO-QUEUE DISABLED: Enrichment is now on-demand only
            // Items are queued when:
            // 1. User views a page (thumbnail enrichment)
            // 2. User opens detail page (full enrichment)
        } catch (err) {
            logger?.warn('enrichment', `Progress reporter error: ${err.message}`);
        }
    }, 5000);  // Check every 5 seconds
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

/**
 * Enrich a single item synchronously (for on-demand enrichment)
 * Returns the enriched data immediately without using the queue
 */
async function enrichItemSync(mediaId, options = {}) {
    const { highPriority = false } = options;

    const media = await db.get('SELECT * FROM media WHERE id = ?', [mediaId]);
    if (!media) {
        throw new Error('Media not found');
    }

    // Skip if already enriched (unless force refresh)
    if (media.tmdb_id && !options.forceRefresh) {
        return {
            success: true,
            skipped: true,
            tmdbId: media.tmdb_id,
            poster: media.poster,
            backdrop: media.backdrop,
            rating: media.rating,
            year: media.year,
            plot: media.plot
        };
    }

    // Create a simple rate limiter for sync requests if not exists
    if (!rateLimiter) {
        rateLimiter = new RateLimiter(CONFIG.rateLimit, CONFIG.rateLimitWindow);
    }

    try {
        const result = await processMediaItem(media, { highPriority });

        // Fetch the updated media record
        const updated = await db.get('SELECT * FROM media WHERE id = ?', [mediaId]);

        return {
            success: true,
            tmdbId: result.tmdbId,
            poster: updated.poster,
            backdrop: updated.backdrop,
            rating: updated.rating,
            year: updated.year,
            plot: updated.plot,
            trailerCount: result.trailerCount,
            seasonCount: result.seasonCount
        };
    } catch (err) {
        logger?.warn('enrichment', `Sync enrichment failed for ${media.title}: ${err.message}`);
        return {
            success: false,
            error: err.message
        };
    }
}

/**
 * Batch enrich multiple items (for visible page enrichment)
 * Processes items in parallel with rate limiting
 */
async function enrichBatch(mediaIds, options = {}) {
    const { highPriority = false, concurrency = 4 } = options;
    const results = [];

    // Create rate limiter if not exists
    if (!rateLimiter) {
        rateLimiter = new RateLimiter(CONFIG.rateLimit, CONFIG.rateLimitWindow);
    }

    // Filter out already enriched items
    const items = await db.all(`
        SELECT id, title, tmdb_id, poster, rating
        FROM media
        WHERE id IN (${mediaIds.map(() => '?').join(',')})
    `, mediaIds);

    const needsEnrichment = items.filter(i => !i.tmdb_id);
    const alreadyEnriched = items.filter(i => i.tmdb_id);

    // Add already enriched to results (include poster/rating for UI updates)
    for (const item of alreadyEnriched) {
        results.push({
            mediaId: item.id,
            success: true,
            skipped: true,
            poster: item.poster,
            rating: item.rating
        });
    }

    // Process in batches with concurrency limit
    for (let i = 0; i < needsEnrichment.length; i += concurrency) {
        const batch = needsEnrichment.slice(i, i + concurrency);
        const batchPromises = batch.map(async (item) => {
            try {
                const result = await enrichItemSync(item.id, { highPriority });
                return { mediaId: item.id, ...result };
            } catch (err) {
                return { mediaId: item.id, success: false, error: err.message };
            }
        });

        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);

        // Emit progress
        emit('enrichment:batch:progress', {
            processed: results.length,
            total: mediaIds.length,
            current: batch.map(b => b.title)
        });
    }

    return {
        total: mediaIds.length,
        enriched: results.filter(r => r.success && !r.skipped).length,
        skipped: results.filter(r => r.skipped).length,
        failed: results.filter(r => !r.success).length,
        results
    };
}

/**
 * Populate enrichment cache from existing enriched media
 * This backups current enrichment data so it persists across provider changes
 */
async function populateEnrichmentCache() {
    logger?.info('enrichment', 'Populating enrichment cache from existing data...');

    // Get all enriched media
    const enrichedMedia = await db.all(`
        SELECT DISTINCT
            title, year, media_type, tmdb_id, poster, backdrop,
            rating, plot, tagline, genres, runtime, imdb_id
        FROM media
        WHERE tmdb_id IS NOT NULL
        AND media_type IN ('movie', 'series')
    `);

    let saved = 0;
    let skipped = 0;

    for (const media of enrichedMedia) {
        try {
            // Extract clean title
            const extracted = tmdb.extractCleanTitle(media.title);
            const cleanTitle = extracted?.title || media.title;
            const year = media.year || extracted?.year;

            // Check if already in cache
            const cacheKey = generateCacheKey(cleanTitle, year, media.media_type);
            const existing = await db.get(
                'SELECT id FROM enrichment_cache WHERE cache_key = ?',
                [cacheKey]
            );

            if (existing) {
                skipped++;
                continue;
            }

            // Save to cache
            await saveToEnrichmentCache(cleanTitle, year, media.media_type, {
                id: media.tmdb_id,
                poster: media.poster,
                backdrop: media.backdrop,
                rating: media.rating,
                plot: media.plot,
                tagline: media.tagline,
                genres: media.genres,
                runtime: media.runtime,
                imdb_id: media.imdb_id
            });
            saved++;

        } catch (err) {
            logger?.warn('enrichment', `Failed to cache ${media.title}: ${err.message}`);
        }
    }

    logger?.info('enrichment', `Cache populated: ${saved} saved, ${skipped} already cached`);
    return { saved, skipped, total: enrichedMedia.length };
}

/**
 * Get enrichment cache statistics
 */
async function getCacheStats() {
    const stats = await db.get(`
        SELECT
            COUNT(*) as total,
            SUM(CASE WHEN media_type = 'movie' THEN 1 ELSE 0 END) as movies,
            SUM(CASE WHEN media_type = 'series' THEN 1 ELSE 0 END) as series
        FROM enrichment_cache
    `);

    return {
        total: stats?.total || 0,
        movies: stats?.movies || 0,
        series: stats?.series || 0
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

        // Auto-populate enrichment cache on startup (runs in background)
        setTimeout(async () => {
            try {
                const cacheStats = await getCacheStats();
                if (cacheStats.total === 0) {
                    logger?.info('enrichment', 'First run: populating enrichment cache from existing data');
                    await populateEnrichmentCache();
                }
            } catch (err) {
                logger?.warn('enrichment', `Failed to auto-populate cache: ${err.message}`);
            }
        }, 5000);

        logger?.info('enrichment', 'Enrichment module initialized (on-demand only)');

        // Auto-enrichment after sync is DISABLED
        // Enrichment now happens on-demand when user clicks on content
        // The /api/enrich/instant/:id endpoint is used for this
    },

    // Public API - Queue-based (background)
    queueMediaForEnrichment,
    queueUnenrichedMedia,
    startWorkers,
    stopWorkers,
    getQueueStatus,
    getWorkerStatus,
    clearQueue,
    retryFailedJobs,
    getStats,

    // Public API - On-demand (synchronous)
    enrichItemSync,
    enrichBatch,
    processMediaItem,

    // Check if workers are running
    isRunning: () => isRunning,

    // Get config
    getConfig: () => ({ ...CONFIG }),

    // Enrichment cache management
    populateEnrichmentCache,
    getCacheStats,
    lookupEnrichmentCache
};
