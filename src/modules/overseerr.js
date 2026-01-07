const axios = require('axios');

let logger = null;
let db = null;
let settings = null;
let download = null;
let tmdb = null;
let app = null;
let modulesRef = null;

function emitApp(event, data) {
    (modulesRef?.app || app)?.emit(event, data);
}


const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

async function overseerrRequest(endpoint, method = 'GET', data = null) {
    const url = settings.get('overseerrUrl');
    const apiKey = settings.get('overseerrApiKey');

    if (!url || !apiKey) {
        throw new Error('Overseerr not configured');
    }

    const response = await axios({
        url: `${url.replace(/\/$/, '')}/api/v1${endpoint}`,
        method,
        headers: {
            'X-Api-Key': apiKey,
            'Content-Type': 'application/json'
        },
        data,
        timeout: 10000
    });

    return response.data;
}

// Extract clean title from channel names (same as tmdb.js)
function extractCleanTitle(title) {
    if (!title) return null;

    let clean = title;

    // Skip category headers
    if (/^#{2,}|#{2,}$/.test(clean)) {
        return { title: null, year: null, skip: true };
    }

    // Remove M3U metadata
    clean = clean.replace(/"\s*tvg-logo=.*$/i, '');
    clean = clean.replace(/"\s*group-title=.*$/i, '');
    clean = clean.replace(/\s*tvg-logo=.*$/i, '');

    // Remove common prefixes
    clean = clean.replace(/^24\/7:\s*/i, '');
    clean = clean.replace(/^24\/7\s+/i, '');
    clean = clean.replace(/^\d+\/\d+\s*/i, '');

    // Remove country/language prefixes
    clean = clean.replace(/^[A-Z]{2,5}[:|]\s*/i, '');
    clean = clean.replace(/^[A-Z]{2}\s*-\s*/i, '');

    // Remove quality indicators
    clean = clean.replace(/\s*(HD|4K|FHD|UHD|SD|\d{3,4}p)\s*/gi, ' ');

    // Remove special characters
    clean = clean.replace(/^[*#,.'"\s]+/, '');
    clean = clean.replace(/[ᴿᴬᵂᴴᴰᶠ◉●★☆\[\]{}|⁶⁰ᶠᵖˢ]+/g, '');
    clean = clean.replace(/\s*[-_]\s*$/g, '');

    // Extract year
    const yearMatch = clean.match(/\((\d{4})\)/);
    const year = yearMatch ? parseInt(yearMatch[1]) : null;
    clean = clean.replace(/\s*\(\d{4}\)\s*/g, ' ');

    // Clean whitespace
    clean = clean.replace(/\s+/g, ' ').trim();

    // Skip generic names
    const genericPatterns = [
        /^sky\s+(cinema|movies?|atlantic|showcase)/i,
        /^(hbo|cinemax|showtime|starz|encore)\s*(max|hits|family|edge|comedy|action)?$/i,
        /^(netflix|disney\+?|amazon|prime|apple\s*tv)\s*(action|comedy|drama|romance|horror|sci-?fi|documentary|kids)?$/i,
        /^(cinema|movie|film|kino)\s*(action|comedy|drama|romance|horror|sci-?fi|documentary|kids|\d+)?$/i,
        /^(channel|kanal)\s*\d+$/i,
        /^(bbc|itv|channel|e4|sky)\s*\d*$/i,
        /^(mix|info|box\s*office|ppv|event)/i,
        /^\d+$/,
        /^.{0,2}$/
    ];

    for (const pattern of genericPatterns) {
        if (pattern.test(clean)) {
            return { title: null, year: null, skip: true };
        }
    }

    return { title: clean, year, skip: false };
}

module.exports = {
    init: async (modules) => {
        logger = modules.logger;
        db = modules.db;
        settings = modules.settings;
        download = modules.download;
        tmdb = modules.tmdb;
        modulesRef = modules;
        app = modules.app;
    },

    // Handle incoming webhook from Overseerr
    handleWebhook: async (payload) => {
        const { notification_type, media, request, subject } = payload;

        logger.info('overseerr', `Received webhook: ${notification_type} for "${subject}"`);

        switch (notification_type) {
            case 'MEDIA_PENDING':
                logger.info('overseerr', `Media pending approval: ${subject}`);
                break;

            case 'MEDIA_APPROVED':
            case 'MEDIA_AUTO_APPROVED':
                await handleApproved(media, request);
                break;

            case 'MEDIA_AVAILABLE':
                logger.info('overseerr', `Media available: ${subject}`);
                break;

            case 'MEDIA_DECLINED':
                logger.info('overseerr', `Media declined: ${subject}`);
                break;

            default:
                logger.debug('overseerr', `Unhandled notification type: ${notification_type}`);
        }
    },

    // Get pending requests from Overseerr
    getRequests: async (status = 'pending') => {
        try {
            const data = await overseerrRequest(`/request?filter=${status}`);
            return data.results || [];
        } catch (err) {
            logger?.error('overseerr', `Failed to get requests: ${err.message}`);
            return [];
        }
    },

    // Update request status
    updateRequest: async (requestId, status) => {
        try {
            await overseerrRequest(`/request/${requestId}/${status}`, 'POST');
            logger?.info('overseerr', `Updated request ${requestId} to ${status}`);
            return { success: true };
        } catch (err) {
            logger?.error('overseerr', `Failed to update request: ${err.message}`);
            return { success: false, error: err.message };
        }
    },

    // Search for media via Overseerr (proxies TMDB)
    searchMedia: async (query, page = 1) => {
        try {
            const data = await overseerrRequest(`/search?query=${encodeURIComponent(query)}&page=${page}`);
            return data.results || [];
        } catch (err) {
            logger?.warn('overseerr', `Search failed: ${err.message}`);
            return [];
        }
    },

    // Get movie details from Overseerr
    getMovie: async (tmdbId) => {
        try {
            const data = await overseerrRequest(`/movie/${tmdbId}`);
            return {
                id: data.id,
                title: data.title,
                original_title: data.originalTitle,
                overview: data.overview,
                tagline: data.tagline,
                poster_path: data.posterPath ? `${TMDB_IMAGE_BASE}/w500${data.posterPath}` : null,
                backdrop_path: data.backdropPath ? `${TMDB_IMAGE_BASE}/w1280${data.backdropPath}` : null,
                release_date: data.releaseDate,
                year: data.releaseDate ? parseInt(data.releaseDate.substring(0, 4)) : null,
                runtime: data.runtime,
                vote_average: data.voteAverage,
                vote_count: data.voteCount,
                status: data.status,
                budget: data.budget,
                revenue: data.revenue,
                original_language: data.originalLanguage,
                genres: data.genres?.map(g => g.name).join(', '),
                imdb_id: data.externalIds?.imdbId,
                mediaInfo: data.mediaInfo // Overseerr request status
            };
        } catch (err) {
            logger?.warn('overseerr', `Get movie failed: ${err.message}`);
            return null;
        }
    },

    // Get TV show details from Overseerr
    getTv: async (tmdbId) => {
        try {
            const data = await overseerrRequest(`/tv/${tmdbId}`);
            return {
                id: data.id,
                title: data.name,
                original_title: data.originalName,
                overview: data.overview,
                tagline: data.tagline,
                poster_path: data.posterPath ? `${TMDB_IMAGE_BASE}/w500${data.posterPath}` : null,
                backdrop_path: data.backdropPath ? `${TMDB_IMAGE_BASE}/w1280${data.backdropPath}` : null,
                first_air_date: data.firstAirDate,
                year: data.firstAirDate ? parseInt(data.firstAirDate.substring(0, 4)) : null,
                vote_average: data.voteAverage,
                vote_count: data.voteCount,
                status: data.status,
                original_language: data.originalLanguage,
                genres: data.genres?.map(g => g.name).join(', '),
                number_of_seasons: data.numberOfSeasons,
                number_of_episodes: data.numberOfEpisodes,
                mediaInfo: data.mediaInfo // Overseerr request status
            };
        } catch (err) {
            logger?.warn('overseerr', `Get TV failed: ${err.message}`);
            return null;
        }
    },

    // Check if Overseerr is configured and reachable
    isConfigured: () => {
        const url = settings?.get('overseerrUrl');
        const apiKey = settings?.get('overseerrApiKey');
        return !!(url && apiKey);
    },

    // Batch enrich media using Overseerr (falls back to TMDB if not configured)
    batchEnrichMedia: async (mediaType = null, limit = 100) => {
        // Check if Overseerr is configured
        const overseerrConfigured = module.exports.isConfigured();

        if (!overseerrConfigured) {
            logger?.info('overseerr', 'Overseerr not configured, falling back to TMDB enrichment');
            if (tmdb) {
                return await tmdb.batchEnrichPosters(mediaType, limit);
            }
            throw new Error('Neither Overseerr nor TMDB is configured');
        }

        // Find media items that need enrichment
        let sql = `
            SELECT id, title, media_type, year, poster, tmdb_id
            FROM media
            WHERE (poster IS NULL OR poster LIKE '%wikipedia%' OR poster LIKE '%stalker_portal%' OR poster LIKE '%icon-tmdb%')
            AND title NOT LIKE '%####%'
            AND title NOT LIKE '## %'
            AND title NOT LIKE '%----- %'
            AND title NOT LIKE '%INFO%'
            AND title NOT LIKE '%MIX %'
        `;
        const params = [];

        if (mediaType) {
            sql += ' AND media_type = ?';
            params.push(mediaType);
        }

        sql += ` ORDER BY
            CASE
                WHEN title LIKE '%24/7:%' THEN 0
                WHEN title LIKE '% 4K' OR title LIKE '% HD' THEN 1
                ELSE 2
            END,
            title
        `;
        sql += ' LIMIT ?';
        params.push(limit);

        const items = await db.all(sql, params);

        if (items.length === 0) {
            return { processed: 0, success: 0, failed: 0, source: 'overseerr' };
        }

        logger?.info('overseerr', `Starting Overseerr enrichment for ${items.length} items`);
        emitApp('enrich:start', { total: items.length, source: 'overseerr' });

        let success = 0;
        let failed = 0;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];

            try {
                const extracted = extractCleanTitle(item.title);

                if (!extracted || extracted.skip || !extracted.title || extracted.title.length < 2) {
                    failed++;
                    continue;
                }

                const { title: cleanTitle, year: extractedYear } = extracted;
                const year = item.year || extractedYear;

                let overseerrData = null;

                // If we have a TMDB ID, fetch directly
                if (item.tmdb_id) {
                    overseerrData = item.media_type === 'movie'
                        ? await module.exports.getMovie(item.tmdb_id)
                        : await module.exports.getTv(item.tmdb_id);
                } else {
                    // Try searching via Overseerr first
                    let searchResults = [];
                    try {
                        searchResults = await module.exports.searchMedia(cleanTitle);
                    } catch (searchErr) {
                        logger?.debug('overseerr', `Overseerr search failed for "${cleanTitle}", trying TMDB`);
                    }

                    if (searchResults.length > 0) {
                        // Find best match - prefer matching media type and year
                        let bestMatch = searchResults.find(r => {
                            const isMovie = r.mediaType === 'movie';
                            const matchesType = (item.media_type === 'movie' && isMovie) ||
                                              (item.media_type === 'series' && !isMovie);
                            const resultYear = isMovie ? r.releaseDate?.substring(0, 4) : r.firstAirDate?.substring(0, 4);
                            const matchesYear = !year || resultYear === String(year);
                            return matchesType && matchesYear;
                        }) || searchResults[0];

                        const isMovie = bestMatch.mediaType === 'movie';
                        overseerrData = isMovie
                            ? await module.exports.getMovie(bestMatch.id)
                            : await module.exports.getTv(bestMatch.id);
                    } else if (tmdb) {
                        // Fallback to TMDB search if Overseerr search returns no results
                        let tmdbResults = item.media_type === 'movie'
                            ? await tmdb.searchMovie(cleanTitle, year)
                            : await tmdb.searchTv(cleanTitle, year);

                        if (tmdbResults.length > 0) {
                            const match = tmdbResults[0];
                            // Try to get from Overseerr first (for request status), fall back to TMDB
                            const isMovie = item.media_type === 'movie';
                            overseerrData = isMovie
                                ? await module.exports.getMovie(match.id)
                                : await module.exports.getTv(match.id);

                            // If Overseerr fails, use TMDB data directly
                            if (!overseerrData) {
                                overseerrData = isMovie
                                    ? await tmdb.getMovie(match.id)
                                    : await tmdb.getTv(match.id);
                            }
                        }
                    }
                }

                // If Overseerr returned data, update the database (preserve original_title as raw source title)
                if (overseerrData && overseerrData.poster_path) {
                    await db.run(`
                        UPDATE media SET
                            tmdb_id = COALESCE(?, tmdb_id),
                            plot = COALESCE(?, plot),
                            poster = ?,
                            backdrop = COALESCE(?, backdrop),
                            rating = COALESCE(?, rating),
                            genres = COALESCE(?, genres),
                            imdb_id = COALESCE(?, imdb_id),
                            year = COALESCE(?, year),
                            runtime = COALESCE(?, runtime),
                            last_updated = CURRENT_TIMESTAMP
                        WHERE id = ?
                    `, [
                        overseerrData.id, overseerrData.overview,
                        overseerrData.poster_path, overseerrData.backdrop_path, overseerrData.vote_average,
                        overseerrData.genres, overseerrData.imdb_id, overseerrData.year,
                        overseerrData.runtime, item.id
                    ]);

                    success++;
                    logger?.debug('overseerr', `Enriched: "${item.title}" -> "${cleanTitle}" (TMDB: ${overseerrData.id})`);
                } else if (tmdb) {
                    // Fallback to TMDB for this item
                    const tmdbResult = await tmdb.enrichMedia(item.id);
                    if (tmdbResult) {
                        success++;
                        logger?.debug('overseerr', `Enriched via TMDB fallback: "${item.title}"`);
                    } else {
                        failed++;
                    }
                } else {
                    failed++;
                    logger?.debug('overseerr', `No match found for: "${cleanTitle}"`);
                }

                // Rate limiting
                await new Promise(r => setTimeout(r, 300));

                // Progress update
                if ((i + 1) % 10 === 0 || i === items.length - 1) {
                    emitApp('enrich:progress', {
                        current: i + 1,
                        total: items.length,
                        success,
                        failed,
                        source: 'overseerr',
                        message: `Processing ${i + 1}/${items.length}...`
                    });
                }

            } catch (err) {
                failed++;
                logger?.warn('overseerr', `Failed to enrich "${item.title}": ${err.message}`);
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        logger?.info('overseerr', `Overseerr enrichment complete: ${success} success, ${failed} failed`);
        emitApp('enrich:complete', { success, failed, total: items.length, source: 'overseerr' });

        return { processed: items.length, success, failed, source: 'overseerr' };
    }
};

async function handleApproved(media, request) {
    if (!media) {
        logger.warn('overseerr', 'No media info in webhook');
        return;
    }

    const { media_type, tmdbId } = media;
    const requestId = request?.id;

    // Debug: log full request payload for troubleshooting
    logger.debug('overseerr', `Request payload: ${JSON.stringify(request)}`);
    logger.info('overseerr', `Processing approved request: ${media_type} TMDB ID ${tmdbId}`);

    // Find matching media in our database
    let localMedia = await db.get(
        'SELECT * FROM media WHERE tmdb_id = ? AND media_type = ?',
        [tmdbId, media_type === 'movie' ? 'movie' : 'series']
    );

    if (!localMedia) {
        // Try to fetch from TMDB and find by title
        try {
            const tmdbData = media_type === 'movie'
                ? await tmdb.getMovie(tmdbId)
                : await tmdb.getTv(tmdbId);

            if (tmdbData) {
                // Search by title
                localMedia = await db.get(
                    'SELECT * FROM media WHERE title LIKE ? AND media_type = ?',
                    [`%${tmdbData.title}%`, media_type === 'movie' ? 'movie' : 'series']
                );
            }
        } catch (err) {
            logger.warn('overseerr', `Failed to fetch from TMDB: ${err.message}`);
        }
    }

    if (!localMedia) {
        logger.warn('overseerr', `No matching media found for TMDB ID ${tmdbId}`);
        return;
    }

    // Queue download
    if (media_type === 'movie') {
        const result = await download.queue(localMedia.id, null);
        if (result.success) {
            // Store Overseerr request ID for status updates
            await db.run('UPDATE downloads SET overseerr_request_id = ? WHERE id = ?',
                [requestId, result.id]);
            logger.info('overseerr', `Queued movie download: ${localMedia.title}`);
        }
    } else {
        // For series, check which seasons were requested
        const requestedSeasons = request?.seasons || [];
        logger.info('overseerr', `Requested seasons from Overseerr: ${JSON.stringify(requestedSeasons)}`);

        let episodes;
        if (requestedSeasons.length > 0) {
            // Get episodes for specific seasons
            const seasonNumbers = requestedSeasons.map(s => s.seasonNumber || s);
            const placeholders = seasonNumbers.map(() => '?').join(',');
            logger.info('overseerr', `Looking for episodes in season(s): ${seasonNumbers.join(', ')}`);

            episodes = await db.all(
                `SELECT * FROM episodes WHERE media_id = ? AND season IN (${placeholders}) ORDER BY season, episode`,
                [localMedia.id, ...seasonNumbers]
            );
            logger.info('overseerr', `Found ${episodes.length} episodes in database for season(s) ${seasonNumbers.join(', ')}`);
        } else {
            // Queue all episodes if no specific seasons requested
            logger.info('overseerr', `No specific seasons requested, queuing all episodes`);
            episodes = await db.all('SELECT * FROM episodes WHERE media_id = ? ORDER BY season, episode', [localMedia.id]);
            logger.info('overseerr', `Found ${episodes.length} total episodes in database`);
        }

        // Queue each episode
        let queuedCount = 0;
        let skippedCount = 0;
        for (const ep of episodes) {
            const result = await download.queue(localMedia.id, ep.id);
            if (result.success) {
                queuedCount++;
                logger.debug('overseerr', `Queued S${ep.season}E${ep.episode}: ${ep.title || 'Untitled'}`);
            } else {
                skippedCount++;
                logger.debug('overseerr', `Skipped S${ep.season}E${ep.episode}: ${result.message}`);
            }
        }
        logger.info('overseerr', `Queued ${queuedCount} episodes, skipped ${skippedCount} (already in queue) for: ${localMedia.title}`);
    }
}
