const axios = require('axios');

let logger = null;
let db = null;
let settings = null;
let app = null;

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

// Cache durations in days
const CACHE_DURATION = {
    movie: 7,           // Full movie details - 7 days
    tv: 7,              // Full TV details - 7 days
    season: 7,          // Season details - 7 days
    person: 30,         // Person details - 30 days
    search_movie: 1,    // Movie search results - 1 day
    search_tv: 1        // TV search results - 1 day
};

// Get cached TMDB response
async function getCached(cacheKey, cacheType) {
    if (!db) return null;
    try {
        const cached = await db.get(
            'SELECT data FROM tmdb_cache WHERE cache_key = ? AND expires_at > datetime("now")',
            [cacheKey]
        );
        if (cached) {
            logger?.debug('tmdb', `Cache HIT: ${cacheKey}`);
            return JSON.parse(cached.data);
        }
    } catch (err) {
        logger?.warn('tmdb', `Cache read error: ${err.message}`);
    }
    return null;
}

// Store TMDB response in cache
async function setCache(cacheKey, cacheType, tmdbId, data) {
    if (!db) return;
    try {
        const days = CACHE_DURATION[cacheType] || 7;
        await db.run(`
            INSERT OR REPLACE INTO tmdb_cache (cache_key, cache_type, tmdb_id, data, expires_at)
            VALUES (?, ?, ?, ?, datetime('now', '+' || ? || ' days'))
        `, [cacheKey, cacheType, tmdbId, JSON.stringify(data), days]);
        logger?.debug('tmdb', `Cache SET: ${cacheKey} (expires in ${days} days)`);
    } catch (err) {
        logger?.warn('tmdb', `Cache write error: ${err.message}`);
    }
}

// Clean expired cache entries
async function cleanExpiredCache() {
    if (!db) return;
    try {
        const result = await db.run('DELETE FROM tmdb_cache WHERE expires_at < datetime("now")');
        if (result.changes > 0) {
            logger?.info('tmdb', `Cleaned ${result.changes} expired cache entries`);
        }
    } catch (err) {
        logger?.warn('tmdb', `Cache cleanup error: ${err.message}`);
    }
}

// Extract clean title from 24/7 channel names
function extractCleanTitle(title) {
    if (!title) return null;

    let clean = title;

    // Skip category headers (items with multiple # signs)
    if (/^#{2,}|#{2,}$/.test(clean)) {
        return { title: null, year: null, skip: true };
    }

    // Remove everything after tvg-logo or group-title (M3U metadata)
    clean = clean.replace(/"\s*tvg-logo=.*$/i, '');
    clean = clean.replace(/"\s*group-title=.*$/i, '');
    clean = clean.replace(/\s*tvg-logo=.*$/i, '');

    // Remove common prefixes
    clean = clean.replace(/^24\/7:\s*/i, '');
    clean = clean.replace(/^24\/7\s+/i, '');
    clean = clean.replace(/^\d+\/\d+\s*/i, '');

    // Remove country/language prefixes like "UK:", "DE:", "IT|", "PRIME:", "EN -", "NL -"
    clean = clean.replace(/^[A-Z]{2,5}[:|]\s*/i, '');
    clean = clean.replace(/^[A-Z]{2}\s*-\s*/i, '');

    // Remove quality indicators
    clean = clean.replace(/\s*(HD|4K|FHD|UHD|SD|\d{3,4}p)\s*/gi, ' ');

    // Remove special characters at start and markers
    clean = clean.replace(/^[*#,.'"\s]+/, '');
    clean = clean.replace(/[ᴿᴬᵂᴴᴰᶠ◉●★☆\[\]{}|⁶⁰ᶠᵖˢ]+/g, '');
    clean = clean.replace(/\s*[-_]\s*$/g, '');

    // Remove year in parentheses but capture it
    const yearMatch = clean.match(/\((\d{4})\)/);
    const year = yearMatch ? parseInt(yearMatch[1]) : null;
    clean = clean.replace(/\s*\(\d{4}\)\s*/g, ' ');

    // Clean up whitespace
    clean = clean.replace(/\s+/g, ' ').trim();

    // Skip if the result is a generic channel name (not a movie/series title)
    const genericPatterns = [
        /^sky\s+(cinema|movies?|atlantic|showcase)/i,
        /^(hbo|cinemax|showtime|starz|encore)\s*(max|hits|family|edge|comedy|action)?$/i,
        /^(netflix|disney\+?|amazon|prime|apple\s*tv)\s*(action|comedy|drama|romance|horror|sci-?fi|documentary|kids)?$/i,
        /^(cinema|movie|film|kino)\s*(action|comedy|drama|romance|horror|sci-?fi|documentary|kids|\d+)?$/i,
        /^(channel|kanal)\s*\d+$/i,
        /^(bbc|itv|channel|e4|sky)\s*\d*$/i,
        /^(mix|info|box\s*office|ppv|event)/i,
        /^\d+$/,  // Just numbers
        /^.{0,2}$/  // Too short
    ];

    for (const pattern of genericPatterns) {
        if (pattern.test(clean)) {
            return { title: null, year: null, skip: true };
        }
    }

    return { title: clean, year, skip: false };
}

async function request(endpoint, params = {}) {
    const apiKey = settings.get('tmdbApiKey');
    if (!apiKey) {
        throw new Error('TMDB API key not configured');
    }

    const response = await axios.get(`${TMDB_BASE_URL}${endpoint}`, {
        params: { api_key: apiKey, ...params },
        timeout: 10000
    });

    return response.data;
}

module.exports = {
    init: async (modules) => {
        logger = modules.logger;
        db = modules.db;
        settings = modules.settings;
        app = modules.app;

        // Clean expired cache entries on startup
        await cleanExpiredCache();

        // Schedule periodic cache cleanup (every 6 hours)
        setInterval(cleanExpiredCache, 6 * 60 * 60 * 1000);
    },

    // Export cache cleanup function
    cleanExpiredCache,

    // Find media by external ID (TVDB, IMDB, etc.)
    findByExternalId: async (externalId, source = 'tvdb_id') => {
        const cacheKey = `find:${source}:${externalId}`;
        const cached = await getCached(cacheKey, 'search_tv');
        if (cached) return cached;

        const data = await request(`/find/${externalId}`, { external_source: source });
        await setCache(cacheKey, 'search_tv', null, data);
        return data;
    },

    // Search for a movie by title and year
    searchMovie: async (title, year = null) => {
        const cacheKey = `search_movie:${title}:${year || ''}`;
        const cached = await getCached(cacheKey, 'search_movie');
        if (cached) return cached;

        const params = { query: title };
        if (year) params.year = year;

        const data = await request('/search/movie', params);
        const results = data.results || [];

        await setCache(cacheKey, 'search_movie', null, results);
        return results;
    },

    // Search for a TV show by title
    searchTv: async (title, year = null) => {
        const cacheKey = `search_tv:${title}:${year || ''}`;
        const cached = await getCached(cacheKey, 'search_tv');
        if (cached) return cached;

        const params = { query: title };
        if (year) params.first_air_date_year = year;

        const data = await request('/search/tv', params);
        const results = data.results || [];

        await setCache(cacheKey, 'search_tv', null, results);
        return results;
    },

    // Get movie details with credits
    getMovie: async (tmdbId) => {
        const cacheKey = `movie:${tmdbId}`;
        const cached = await getCached(cacheKey, 'movie');
        if (cached) return cached;

        const data = await request(`/movie/${tmdbId}`, { append_to_response: 'credits,videos,releases' });
        const result = {
            id: data.id,
            title: data.title,
            original_title: data.original_title,
            overview: data.overview,
            tagline: data.tagline,
            poster_path: data.poster_path ? `${TMDB_IMAGE_BASE}/w500${data.poster_path}` : null,
            backdrop_path: data.backdrop_path ? `${TMDB_IMAGE_BASE}/w1280${data.backdrop_path}` : null,
            release_date: data.release_date,
            year: data.release_date ? parseInt(data.release_date.substring(0, 4)) : null,
            runtime: data.runtime,
            vote_average: data.vote_average,
            vote_count: data.vote_count,
            status: data.status,
            budget: data.budget,
            revenue: data.revenue,
            original_language: data.original_language,
            production_countries: data.production_countries,
            production_companies: data.production_companies?.map(c => ({
                id: c.id,
                name: c.name,
                logo_path: c.logo_path ? `${TMDB_IMAGE_BASE}/w92${c.logo_path}` : null
            })),
            genres: data.genres?.map(g => g.name).join(', '),
            imdb_id: data.imdb_id,
            videos: data.videos?.results || [],
            releases: data.releases,
            cast: data.credits?.cast?.slice(0, 20).map(p => ({
                id: p.id,
                name: p.name,
                character: p.character,
                profile_path: p.profile_path ? `${TMDB_IMAGE_BASE}/w185${p.profile_path}` : null,
                order: p.order
            })) || [],
            crew: data.credits?.crew?.filter(p => ['Director', 'Writer', 'Screenplay', 'Editor', 'Producer'].includes(p.job)).map(p => ({
                id: p.id,
                name: p.name,
                job: p.job,
                profile_path: p.profile_path ? `${TMDB_IMAGE_BASE}/w185${p.profile_path}` : null
            })) || []
        };

        await setCache(cacheKey, 'movie', tmdbId, result);
        return result;
    },

    // Get TV show details with credits
    getTv: async (tmdbId) => {
        const cacheKey = `tv:${tmdbId}`;
        const cached = await getCached(cacheKey, 'tv');
        if (cached) return cached;

        const data = await request(`/tv/${tmdbId}`, { append_to_response: 'credits,videos,content_ratings,external_ids' });
        const result = {
            id: data.id,
            title: data.name,
            original_title: data.original_name,
            overview: data.overview,
            tagline: data.tagline,
            poster_path: data.poster_path ? `${TMDB_IMAGE_BASE}/w500${data.poster_path}` : null,
            backdrop_path: data.backdrop_path ? `${TMDB_IMAGE_BASE}/w1280${data.backdrop_path}` : null,
            first_air_date: data.first_air_date,
            year: data.first_air_date ? parseInt(data.first_air_date.substring(0, 4)) : null,
            vote_average: data.vote_average,
            vote_count: data.vote_count,
            status: data.status,
            original_language: data.original_language,
            production_countries: data.production_countries,
            production_companies: data.production_companies?.map(c => ({
                id: c.id,
                name: c.name,
                logo_path: c.logo_path ? `${TMDB_IMAGE_BASE}/w92${c.logo_path}` : null
            })),
            networks: data.networks?.map(n => ({
                id: n.id,
                name: n.name,
                logo_path: n.logo_path ? `${TMDB_IMAGE_BASE}/w92${n.logo_path}` : null
            })),
            genres: data.genres?.map(g => g.name).join(', '),
            number_of_seasons: data.number_of_seasons,
            number_of_episodes: data.number_of_episodes,
            videos: data.videos?.results || [],
            content_ratings: data.content_ratings,
            seasons: data.seasons?.map(s => ({
                id: s.id,
                season_number: s.season_number,
                name: s.name,
                overview: s.overview,
                poster_path: s.poster_path ? `${TMDB_IMAGE_BASE}/w185${s.poster_path}` : null,
                air_date: s.air_date,
                year: s.air_date ? parseInt(s.air_date.substring(0, 4)) : null,
                episode_count: s.episode_count,
                vote_average: s.vote_average
            })) || [],
            cast: data.credits?.cast?.slice(0, 20).map(p => ({
                id: p.id,
                name: p.name,
                character: p.character,
                profile_path: p.profile_path ? `${TMDB_IMAGE_BASE}/w185${p.profile_path}` : null,
                order: p.order
            })) || [],
            crew: data.credits?.crew?.filter(p => ['Creator', 'Executive Producer', 'Director'].includes(p.job)).map(p => ({
                id: p.id,
                name: p.name,
                job: p.job,
                profile_path: p.profile_path ? `${TMDB_IMAGE_BASE}/w185${p.profile_path}` : null
            })) || [],
            external_ids: data.external_ids || {}
        };

        await setCache(cacheKey, 'tv', tmdbId, result);
        return result;
    },

    // Get TV season details with episodes
    getSeason: async (tvId, seasonNumber) => {
        const cacheKey = `season:${tvId}:${seasonNumber}`;
        const cached = await getCached(cacheKey, 'season');
        if (cached) return cached;

        const data = await request(`/tv/${tvId}/season/${seasonNumber}`);
        const result = {
            id: data.id,
            season_number: data.season_number,
            name: data.name,
            overview: data.overview,
            poster_path: data.poster_path ? `${TMDB_IMAGE_BASE}/w185${data.poster_path}` : null,
            air_date: data.air_date,
            episodes: data.episodes?.map(ep => ({
                id: ep.id,
                episode_number: ep.episode_number,
                name: ep.name,
                overview: ep.overview,
                still_path: ep.still_path ? `${TMDB_IMAGE_BASE}/w300${ep.still_path}` : null,
                air_date: ep.air_date,
                runtime: ep.runtime,
                vote_average: ep.vote_average
            })) || []
        };

        await setCache(cacheKey, 'season', tvId, result);
        return result;
    },

    // Get person details
    getPerson: async (tmdbId) => {
        const cacheKey = `person:${tmdbId}`;
        const cached = await getCached(cacheKey, 'person');
        if (cached) return cached;

        const data = await request(`/person/${tmdbId}`);
        const result = {
            id: data.id,
            name: data.name,
            biography: data.biography,
            birthday: data.birthday,
            place_of_birth: data.place_of_birth,
            profile_path: data.profile_path ? `${TMDB_IMAGE_BASE}/w500${data.profile_path}` : null,
            known_for_department: data.known_for_department
        };

        await setCache(cacheKey, 'person', tmdbId, result);
        return result;
    },

    // Enrich media with TMDB data
    enrichMedia: async (mediaId) => {
        const media = await db.get('SELECT * FROM media WHERE id = ?', [mediaId]);
        if (!media) return null;

        try {
            let tmdbData;

            if (media.tmdb_id) {
                // Fetch directly by TMDB ID
                tmdbData = media.media_type === 'movie'
                    ? await module.exports.getMovie(media.tmdb_id)
                    : await module.exports.getTv(media.tmdb_id);
            } else {
                // Search by title
                const searchResults = media.media_type === 'movie'
                    ? await module.exports.searchMovie(media.title, media.year)
                    : await module.exports.searchTv(media.title, media.year);

                if (searchResults.length === 0) return null;

                const bestMatch = searchResults[0];
                tmdbData = media.media_type === 'movie'
                    ? await module.exports.getMovie(bestMatch.id)
                    : await module.exports.getTv(bestMatch.id);
            }

            // Update media record
            await db.run(`
                UPDATE media SET
                    tmdb_id = ?,
                    plot = COALESCE(?, plot),
                    poster = COALESCE(?, poster),
                    backdrop = COALESCE(?, backdrop),
                    rating = COALESCE(?, rating),
                    genres = COALESCE(?, genres),
                    imdb_id = COALESCE(?, imdb_id),
                    year = COALESCE(?, year),
                    runtime = COALESCE(?, runtime),
                    last_updated = CURRENT_TIMESTAMP
                WHERE id = ?
            `, [
                tmdbData.id, tmdbData.overview, tmdbData.poster_path, tmdbData.backdrop_path,
                tmdbData.vote_average, tmdbData.genres, tmdbData.imdb_id, tmdbData.year,
                tmdbData.runtime, mediaId
            ]);

            // Add cast/crew to people and media_people
            for (const person of [...tmdbData.cast, ...tmdbData.crew]) {
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
                    `, [mediaId, personRecord.id, role, person.character || person.job, person.order || 999]);
                }
            }

            logger.info('tmdb', `Enriched media: ${media.title}`);
            return tmdbData;
        } catch (err) {
            logger.warn('tmdb', `Failed to enrich media ${mediaId}: ${err.message}`);
            return null;
        }
    },

    // Batch enrich media that's missing posters
    batchEnrichPosters: async (mediaType = null, limit = 100) => {
        const apiKey = settings.get('tmdbApiKey');
        if (!apiKey) {
            throw new Error('TMDB API key not configured');
        }

        // Find media items that need poster enrichment
        // Exclude category headers (titles with ## or ####) and generic channel names
        let sql = `
            SELECT id, title, media_type, year, poster
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

        // Order to prioritize likely movie/series titles first
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
            return { processed: 0, success: 0, failed: 0 };
        }

        logger.info('tmdb', `Starting batch enrichment for ${items.length} items`);
        app?.emit('enrich:start', { total: items.length });

        let success = 0;
        let failed = 0;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];

            try {
                // Extract clean title from channel name
                const extracted = extractCleanTitle(item.title);

                if (!extracted || extracted.skip || !extracted.title || extracted.title.length < 2) {
                    failed++;
                    continue;
                }

                const { title: cleanTitle, year: extractedYear } = extracted;

                const year = item.year || extractedYear;

                // Search TMDB
                let searchResults;
                if (item.media_type === 'movie') {
                    searchResults = await module.exports.searchMovie(cleanTitle, year);
                } else if (item.media_type === 'series') {
                    searchResults = await module.exports.searchTv(cleanTitle, year);
                } else {
                    // For live channels, try both movie and TV search
                    searchResults = await module.exports.searchMovie(cleanTitle, year);
                    if (searchResults.length === 0) {
                        searchResults = await module.exports.searchTv(cleanTitle, year);
                    }
                }

                if (searchResults.length > 0) {
                    const match = searchResults[0];
                    const posterPath = match.poster_path
                        ? `${TMDB_IMAGE_BASE}/w500${match.poster_path}`
                        : null;
                    const backdropPath = match.backdrop_path
                        ? `${TMDB_IMAGE_BASE}/w1280${match.backdrop_path}`
                        : null;

                    if (posterPath) {
                        await db.run(`
                            UPDATE media SET
                                poster = ?,
                                backdrop = COALESCE(?, backdrop),
                                tmdb_id = ?,
                                plot = COALESCE(?, plot),
                                rating = COALESCE(?, rating),
                                year = COALESCE(?, year),
                                last_updated = CURRENT_TIMESTAMP
                            WHERE id = ?
                        `, [
                            posterPath, backdropPath, match.id,
                            match.overview, match.vote_average,
                            match.release_date?.substring(0, 4) || match.first_air_date?.substring(0, 4),
                            item.id
                        ]);

                        success++;
                        logger.debug('tmdb', `Enriched: "${item.title}" -> "${cleanTitle}" (TMDB: ${match.id})`);
                    } else {
                        failed++;
                    }
                } else {
                    failed++;
                    logger.debug('tmdb', `No match found for: "${cleanTitle}"`);
                }

                // Rate limiting - TMDB allows 40 requests per 10 seconds
                await new Promise(r => setTimeout(r, 300));

                // Progress update
                if ((i + 1) % 10 === 0 || i === items.length - 1) {
                    app?.emit('enrich:progress', {
                        current: i + 1,
                        total: items.length,
                        success,
                        failed,
                        message: `Processing ${i + 1}/${items.length}...`
                    });
                }

            } catch (err) {
                failed++;
                logger.warn('tmdb', `Failed to enrich "${item.title}": ${err.message}`);
                // Continue on error, but add delay
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        logger.info('tmdb', `Batch enrichment complete: ${success} success, ${failed} failed`);
        app?.emit('enrich:complete', { success, failed, total: items.length });

        return { processed: items.length, success, failed };
    },

    // Deep enrich media that has TMDB posters but no tmdb_id stored
    deepEnrichMedia: async (mediaType = null, limit = 100) => {
        const apiKey = settings.get('tmdbApiKey');
        if (!apiKey) {
            throw new Error('TMDB API key not configured');
        }

        // Find media with TMDB posters but no tmdb_id
        let sql = `
            SELECT id, title, media_type, year, poster
            FROM media
            WHERE poster LIKE '%image.tmdb.org%'
            AND tmdb_id IS NULL
        `;
        const params = [];

        if (mediaType) {
            sql += ' AND media_type = ?';
            params.push(mediaType);
        }

        sql += ' ORDER BY created_at DESC LIMIT ?';
        params.push(limit);

        const items = await db.all(sql, params);

        if (items.length === 0) {
            return { processed: 0, success: 0, failed: 0 };
        }

        logger.info('tmdb', `Starting deep enrichment for ${items.length} items`);
        app?.emit('enrich:start', { total: items.length, type: 'deep' });

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

                // Search and get full details
                let tmdbData = null;
                if (item.media_type === 'movie') {
                    const searchResults = await module.exports.searchMovie(cleanTitle, year);
                    if (searchResults.length > 0) {
                        tmdbData = await module.exports.getMovie(searchResults[0].id);
                    }
                } else if (item.media_type === 'series') {
                    const searchResults = await module.exports.searchTv(cleanTitle, year);
                    if (searchResults.length > 0) {
                        tmdbData = await module.exports.getTv(searchResults[0].id);
                    }
                }

                if (tmdbData) {
                    // Update with full TMDB data
                    await db.run(`
                        UPDATE media SET
                            tmdb_id = ?,
                            original_title = COALESCE(?, original_title),
                            plot = COALESCE(?, plot),
                            poster = COALESCE(?, poster),
                            backdrop = COALESCE(?, backdrop),
                            rating = COALESCE(?, rating),
                            genres = COALESCE(?, genres),
                            imdb_id = COALESCE(?, imdb_id),
                            year = COALESCE(?, year),
                            runtime = COALESCE(?, runtime),
                            last_updated = CURRENT_TIMESTAMP
                        WHERE id = ?
                    `, [
                        tmdbData.id, tmdbData.original_title, tmdbData.overview,
                        tmdbData.poster_path, tmdbData.backdrop_path, tmdbData.vote_average,
                        tmdbData.genres, tmdbData.imdb_id, tmdbData.year, tmdbData.runtime,
                        item.id
                    ]);

                    success++;
                    logger.debug('tmdb', `Deep enriched: "${item.title}" -> TMDB ID ${tmdbData.id}`);
                } else {
                    failed++;
                }

                // Rate limiting
                await new Promise(r => setTimeout(r, 300));

                // Progress update
                if ((i + 1) % 10 === 0 || i === items.length - 1) {
                    app?.emit('enrich:progress', {
                        current: i + 1,
                        total: items.length,
                        success,
                        failed,
                        message: `Deep enriching ${i + 1}/${items.length}...`
                    });
                }

            } catch (err) {
                failed++;
                logger.warn('tmdb', `Failed to deep enrich "${item.title}": ${err.message}`);
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        logger.info('tmdb', `Deep enrichment complete: ${success} success, ${failed} failed`);
        app?.emit('enrich:complete', { success, failed, total: items.length, type: 'deep' });

        return { processed: items.length, success, failed };
    },

    extractCleanTitle
};
