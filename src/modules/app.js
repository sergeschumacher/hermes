const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const { spawn } = require('child_process');

let app = null;
let server = null;
let io = null;
let logger = null;
let settings = null;
let modules = null;

// Image cache directory
const IMAGE_CACHE_DIR = path.join(PATHS.data, 'cache', 'images');

// Parse series title to extract show name, season, episode, language
// Examples: "DE - The King of Queens S01 E01", "FR - Sam S03 E03", "EN - ER (1994) S04 E20"
function parseSeriesTitle(title) {
    const result = {
        showName: null,
        seasonNumber: null,
        episodeNumber: null,
        showLanguage: null,
        year: null
    };

    if (!title) return result;

    let workingTitle = title.trim();

    // Extract language prefix (2-3 letter code followed by " - ")
    const langMatch = workingTitle.match(/^([A-Z]{2,3})\s*-\s*/i);
    if (langMatch) {
        result.showLanguage = langMatch[1].toUpperCase();
        workingTitle = workingTitle.slice(langMatch[0].length);
    }

    // Extract season and episode (multiple formats)
    // S01 E01, S01E01, S1 E1, S1E1, Season 1 Episode 1
    const seMatch = workingTitle.match(/\s*S(\d{1,2})\s*E(\d{1,3})\s*$/i) ||
                    workingTitle.match(/\s*S(\d{1,2})E(\d{1,3})\s*$/i) ||
                    workingTitle.match(/\s*Season\s*(\d{1,2})\s*Episode\s*(\d{1,3})\s*$/i);

    if (seMatch) {
        result.seasonNumber = parseInt(seMatch[1], 10);
        result.episodeNumber = parseInt(seMatch[2], 10);
        workingTitle = workingTitle.slice(0, workingTitle.lastIndexOf(seMatch[0])).trim();
    }

    // Extract year if present (in parentheses)
    const yearMatch = workingTitle.match(/\((\d{4})\)/);
    if (yearMatch) {
        result.year = parseInt(yearMatch[1], 10);
    }

    // Remove year and country codes from show name for cleaner grouping
    // e.g., "CSI: Vegas (2021) (US)" -> "CSI: Vegas"
    let showName = workingTitle
        .replace(/\s*\(\d{4}\)/g, '')  // Remove (2024)
        .replace(/\s*\([A-Z]{2}\)/g, '') // Remove (US), (UK), etc.
        .trim();

    // Clean up any double spaces
    showName = showName.replace(/\s+/g, ' ').trim();

    result.showName = showName || null;
    return result;
}

// Ensure cache directory exists
function ensureCacheDir() {
    if (!fs.existsSync(IMAGE_CACHE_DIR)) {
        fs.mkdirSync(IMAGE_CACHE_DIR, { recursive: true });
    }
}

// Get cache filename from URL
function getCacheFilename(url) {
    const hash = crypto.createHash('md5').update(url).digest('hex');
    const ext = path.extname(new URL(url).pathname) || '.jpg';
    return hash + ext;
}

// Enrich media for a specific source (uses cache first)
async function enrichSourceMedia(sourceId, modules) {
    const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';
    const db = modules.db;
    const tmdb = modules.tmdb;

    // Get items that need enrichment for this source
    const items = await db.all(`
        SELECT id, title, media_type, year, poster
        FROM media
        WHERE source_id = ?
        AND tmdb_id IS NULL
        AND (enrichment_attempted IS NULL OR enrichment_attempted < datetime('now', '-7 days'))
        AND media_type IN ('movie', 'series')
        ORDER BY created_at DESC
        LIMIT 500
    `, [sourceId]);

    if (items.length === 0) {
        logger?.info('enrich', `No items to enrich for source ${sourceId}`);
        io?.emit('enrich:source:complete', { sourceId, success: 0, failed: 0, total: 0 });
        return { success: 0, failed: 0, total: 0 };
    }

    logger?.info('enrich', `Starting enrichment for source ${sourceId}: ${items.length} items`);
    io?.emit('enrich:source:start', { sourceId, total: items.length });

    let success = 0;
    let failed = 0;

    for (let i = 0; i < items.length; i++) {
        const item = items[i];

        try {
            // Mark as attempted
            await db.run('UPDATE media SET enrichment_attempted = CURRENT_TIMESTAMP WHERE id = ?', [item.id]);

            // Extract clean title
            const extracted = tmdb.extractCleanTitle(item.title);
            if (!extracted || extracted.skip || !extracted.title || extracted.title.length < 2) {
                failed++;
                continue;
            }

            const { title: cleanTitle, year: extractedYear } = extracted;
            const year = item.year || extractedYear;

            // Search TMDB (cache is checked automatically in searchMovie/searchTv)
            let searchResults;
            if (item.media_type === 'movie') {
                searchResults = await tmdb.searchMovie(cleanTitle, year);
            } else {
                searchResults = await tmdb.searchTv(cleanTitle, year);
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
                } else {
                    failed++;
                }
            } else {
                failed++;
            }

            // Rate limiting
            await new Promise(r => setTimeout(r, 250));

            // Progress update every 10 items
            if ((i + 1) % 10 === 0 || i === items.length - 1) {
                io?.emit('enrich:source:progress', {
                    sourceId,
                    current: i + 1,
                    total: items.length,
                    success,
                    failed,
                    percent: Math.round(((i + 1) / items.length) * 100)
                });
            }

        } catch (err) {
            failed++;
            logger?.warn('enrich', `Failed to enrich "${item.title}": ${err.message}`);
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    logger?.info('enrich', `Enrichment complete for source ${sourceId}: ${success} success, ${failed} failed`);
    io?.emit('enrich:source:complete', { sourceId, success, failed, total: items.length });

    return { success, failed, total: items.length };
}

function setupRoutes() {
    // Static files
    app.use('/static', express.static(PATHS.static));

    // Image cache - serve cached images with long cache headers
    app.use('/cache/images', express.static(IMAGE_CACHE_DIR, {
        maxAge: '30d',
        immutable: true
    }));

    // JSON body parser
    app.use(express.json());

    // Image proxy endpoint - caches remote images locally
    app.get('/img', async (req, res) => {
        const url = req.query.url;
        if (!url) {
            return res.status(400).send('Missing url parameter');
        }

        try {
            ensureCacheDir();
            const filename = getCacheFilename(url);
            const cachePath = path.join(IMAGE_CACHE_DIR, filename);

            // Check if already cached
            if (fs.existsSync(cachePath)) {
                // Serve from cache with long expiry
                res.set('Cache-Control', 'public, max-age=2592000, immutable');
                res.set('X-Cache', 'HIT');
                return res.sendFile(cachePath);
            }

            // Download and cache the image
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; Hermes/1.0)'
                }
            });

            // Determine content type
            const contentType = response.headers['content-type'] || 'image/jpeg';

            // Save to cache
            fs.writeFileSync(cachePath, response.data);

            // Serve the image
            res.set('Content-Type', contentType);
            res.set('Cache-Control', 'public, max-age=2592000, immutable');
            res.set('X-Cache', 'MISS');
            res.send(response.data);

        } catch (err) {
            logger?.warn('app', `Image proxy error for ${url}: ${err.message}`);
            // Return a placeholder or redirect to original
            res.redirect(url);
        }
    });

    // View routes
    app.get('/', (req, res) => res.render('index', { page: 'dashboard' }));
    app.get('/movies', (req, res) => res.render('movies', { page: 'movies' }));
    app.get('/series', (req, res) => res.render('series', { page: 'series' }));
    app.get('/livetv', (req, res) => res.render('livetv', { page: 'livetv' }));
    app.get('/downloads', (req, res) => res.render('downloads', { page: 'downloads' }));
    app.get('/settings', (req, res) => res.render('settings', { page: 'settings' }));
    app.get('/media/:id', (req, res) => res.render('media-detail', { page: 'media', mediaId: req.params.id }));
    app.get('/person/:id', (req, res) => res.render('person', { page: 'person', personId: req.params.id }));
    app.get('/show/:name', (req, res) => res.render('show-detail', { page: 'series', showName: decodeURIComponent(req.params.name) }));
    app.get('/series/:name/season/:season', (req, res) => res.render('season-detail', { page: 'series', showName: decodeURIComponent(req.params.name), seasonNumber: parseInt(req.params.season) }));
    app.get('/requests', (req, res) => res.render('requests', { page: 'requests' }));
    app.get('/logs', (req, res) => res.render('logs', { page: 'logs' }));
    app.get('/epg', (req, res) => res.render('epg', { page: 'epg' }));

    // API Routes
    setupApiRoutes();

    // Radarr-compatible API for Overseerr integration
    setupRadarrApi();
}

function setupApiRoutes() {
    const router = express.Router();

    // Stats - filtered by preferred languages
    router.get('/stats', async (req, res) => {
        try {
            const db = modules.db;
            const preferredLangs = modules.settings?.get('preferredLanguages') || [];

            let stats;
            if (preferredLangs.length > 0) {
                // Build language filter for SQL (matches 'de', 'en', etc.)
                const langPlaceholders = preferredLangs.map(() => '?').join(',');
                const langParams = preferredLangs;

                stats = {
                    totalMovies: (await db.get(`
                        SELECT COUNT(*) as c FROM media
                        WHERE media_type = 'movie' AND language IN (${langPlaceholders})
                    `, langParams))?.c || 0,
                    totalSeries: (await db.get(`
                        SELECT COUNT(*) as c FROM media
                        WHERE media_type = 'series' AND language IN (${langPlaceholders})
                    `, langParams))?.c || 0,
                    totalLiveTV: (await db.get(`
                        SELECT COUNT(*) as c FROM media
                        WHERE media_type = 'live' AND language IN (${langPlaceholders})
                    `, langParams))?.c || 0,
                    totalDownloads: (await db.get('SELECT COUNT(*) as c FROM downloads WHERE status = ?', ['completed']))?.c || 0,
                    activeDownloads: (await db.get('SELECT COUNT(*) as c FROM downloads WHERE status IN (?, ?)', ['queued', 'downloading']))?.c || 0,
                    totalSources: (await db.get('SELECT COUNT(*) as c FROM sources'))?.c || 0
                };
            } else {
                // No language filter - show all
                stats = {
                    totalMovies: (await db.get('SELECT COUNT(*) as c FROM media WHERE media_type = ?', ['movie']))?.c || 0,
                    totalSeries: (await db.get('SELECT COUNT(*) as c FROM media WHERE media_type = ?', ['series']))?.c || 0,
                    totalLiveTV: (await db.get('SELECT COUNT(*) as c FROM media WHERE media_type = ?', ['live']))?.c || 0,
                    totalDownloads: (await db.get('SELECT COUNT(*) as c FROM downloads WHERE status = ?', ['completed']))?.c || 0,
                    activeDownloads: (await db.get('SELECT COUNT(*) as c FROM downloads WHERE status IN (?, ?)', ['queued', 'downloading']))?.c || 0,
                    totalSources: (await db.get('SELECT COUNT(*) as c FROM sources'))?.c || 0
                };
            }
            res.json(stats);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Filters endpoint - extract available years and languages
    router.get('/filters', async (req, res) => {
        try {
            const db = modules.db;

            // Get distinct years from year column or extract from title
            const yearsResult = await db.all(`
                SELECT DISTINCT
                    CASE
                        WHEN year IS NOT NULL AND year > 1900 AND year < 2100 THEN year
                        ELSE CAST(SUBSTR(title, INSTR(title, '(') + 1, 4) AS INTEGER)
                    END as extracted_year
                FROM media
                WHERE media_type IN ('movie', 'series')
                AND (
                    (year IS NOT NULL AND year > 1900 AND year < 2100)
                    OR (title GLOB '*([0-9][0-9][0-9][0-9])*')
                )
                ORDER BY extracted_year DESC
            `);
            const years = yearsResult
                .map(r => r.extracted_year)
                .filter(y => y && y > 1900 && y < 2100);

            // Extract languages from category field (format: "VOD - NAME [XX]")
            const categoriesResult = await db.all(`
                SELECT DISTINCT category FROM media
                WHERE category LIKE '%[%]%' AND media_type IN ('movie', 'series')
            `);

            const langSet = new Set();
            const langRegex = /\[([A-Z]{2,10})\]/g;
            for (const row of categoriesResult) {
                let match;
                while ((match = langRegex.exec(row.category)) !== null) {
                    langSet.add(match[1]);
                }
            }

            // Also extract languages from title prefixes (format: "XX - Title")
            const titlePrefixResult = await db.all(`
                SELECT DISTINCT SUBSTR(title, 1, 2) as prefix FROM media
                WHERE title GLOB '[A-Z][A-Z] - *' AND media_type IN ('movie', 'series')
            `);
            for (const row of titlePrefixResult) {
                if (row.prefix && row.prefix.length === 2) {
                    langSet.add(row.prefix);
                }
            }

            // Sort languages alphabetically, but put EN first
            let languages = Array.from(langSet).sort((a, b) => {
                if (a === 'EN') return -1;
                if (b === 'EN') return 1;
                return a.localeCompare(b);
            });

            // Filter languages by preferred settings if configured
            const preferredLangs = modules.settings?.get('preferredLanguages') || [];
            if (preferredLangs.length > 0) {
                const preferredUpper = preferredLangs.map(l => l.toUpperCase());
                languages = languages.filter(lang =>
                    lang && preferredUpper.includes(lang.toUpperCase())
                );
            }

            // Get active sources
            const sources = await db.all('SELECT id, name FROM sources WHERE active = 1 ORDER BY name');

            // Get live TV categories
            const liveCategoriesResult = await db.all(`
                SELECT DISTINCT category FROM media
                WHERE media_type = 'live' AND category IS NOT NULL AND category != ''
                ORDER BY category
            `);
            const categories = liveCategoriesResult.map(r => r.category);

            res.json({ years, languages, sources, categories });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Stream proxy for CORS bypass - pipes IPTV streams through server
    // For HLS streams (.m3u8), proxy directly
    // For MPEG-TS streams, transcode to HLS on-the-fly with FFmpeg
    router.get('/stream/proxy', async (req, res) => {
        try {
            const url = req.query.url;
            if (!url) {
                return res.status(400).json({ error: 'URL parameter required' });
            }

            const isHls = url.includes('.m3u8');
            logger?.info('stream', `Proxying stream: ${url} (HLS: ${isHls})`);

            // Set CORS headers
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
            res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');

            // Handle OPTIONS preflight
            if (req.method === 'OPTIONS') {
                return res.status(204).end();
            }

            if (isHls) {
                // Direct proxy for HLS streams
                const headers = {};
                if (req.headers.range) {
                    headers['Range'] = req.headers.range;
                }

                const response = await axios({
                    method: 'get',
                    url: url,
                    responseType: 'stream',
                    headers: headers,
                    timeout: 30000,
                    maxRedirects: 5
                });

                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                if (response.headers['content-length']) {
                    res.setHeader('Content-Length', response.headers['content-length']);
                }
                res.status(response.status);
                response.data.pipe(res);

                response.data.on('error', (err) => {
                    logger?.error('stream', `Stream error: ${err.message}`);
                    if (!res.headersSent) res.status(500).json({ error: 'Stream error' });
                });

                req.on('close', () => response.data.destroy());
            } else {
                // For non-HLS streams, we need to transcode to browser-playable format
                // Use FFmpeg to convert to fragmented MP4 which browsers can play directly
                logger?.info('stream', 'Starting FFmpeg transcode to fMP4...');

                res.setHeader('Content-Type', 'video/mp4');
                res.setHeader('Transfer-Encoding', 'chunked');

                // FFmpeg: input TS stream -> output fragmented MP4 for browser playback
                const ffmpeg = spawn('ffmpeg', [
                    '-re',                     // Read input at native frame rate
                    '-i', url,
                    '-c:v', 'copy',           // Copy video codec (no re-encode for speed)
                    '-c:a', 'aac',            // Transcode audio to AAC (browser compatible)
                    '-b:a', '128k',
                    '-movflags', 'frag_keyframe+empty_moov+faststart',
                    '-f', 'mp4',
                    '-'                        // Output to stdout
                ], { stdio: ['ignore', 'pipe', 'pipe'] });

                ffmpeg.stdout.pipe(res);

                ffmpeg.stderr.on('data', (data) => {
                    // FFmpeg logs to stderr - only log errors
                    const msg = data.toString();
                    if (msg.includes('Error') || msg.includes('error')) {
                        logger?.error('stream', `FFmpeg: ${msg}`);
                    }
                });

                ffmpeg.on('error', (err) => {
                    logger?.error('stream', `FFmpeg spawn error: ${err.message}`);
                    if (!res.headersSent) res.status(500).json({ error: 'Transcoding error' });
                });

                ffmpeg.on('close', (code) => {
                    if (code !== 0 && code !== null) {
                        logger?.info('stream', `FFmpeg closed with code ${code}`);
                    }
                });

                req.on('close', () => {
                    logger?.info('stream', 'Client disconnected, killing FFmpeg');
                    ffmpeg.kill('SIGTERM');
                });
            }

        } catch (err) {
            logger?.error('stream', `Proxy error: ${err.message}`);
            if (!res.headersSent) {
                res.status(500).json({ error: err.message });
            }
        }
    });

    // Media endpoints
    router.get('/media', async (req, res) => {
        try {
            const { type, search, year, quality, language, genre, category, source, sort, order, limit, offset, dedupe } = req.query;

            // For movies, deduplicate by normalized title (keeping best version with TMDB poster)
            const shouldDedupe = dedupe !== 'false' && (type === 'movie');

            let sql;
            if (shouldDedupe) {
                // Normalize titles by:
                // 1. Removing language prefixes like "DE - ", "EN - ", etc.
                // 2. Extracting year from title if present
                // 3. Trimming and lowercasing for consistent comparison
                sql = `SELECT * FROM (
                    SELECT *,
                           ROW_NUMBER() OVER (
                               PARTITION BY
                                   -- Normalize title: remove language prefix, extract base title
                                   LOWER(TRIM(
                                       CASE
                                           -- Remove 2-3 letter language prefix with dash (e.g., "DE - ", "EN - ", "GER - ")
                                           WHEN title GLOB '[A-Z][A-Z] - *' THEN SUBSTR(title, 6)
                                           WHEN title GLOB '[A-Z][A-Z][A-Z] - *' THEN SUBSTR(title, 7)
                                           ELSE title
                                       END
                                   )),
                                   -- Also partition by year (from year column or extracted from title)
                                   COALESCE(year,
                                       CASE
                                           WHEN title GLOB '*([0-9][0-9][0-9][0-9])*'
                                           THEN CAST(SUBSTR(title, INSTR(title, '(') + 1, 4) AS INTEGER)
                                           ELSE NULL
                                       END
                                   )
                               ORDER BY
                                   -- Prefer entries with TMDB posters
                                   CASE WHEN poster LIKE '%image.tmdb.org%' THEN 0 ELSE 1 END,
                                   -- Then prefer entries with TMDB ID
                                   CASE WHEN tmdb_id IS NOT NULL THEN 0 ELSE 1 END,
                                   -- Then prefer entries with higher rating
                                   CASE WHEN rating IS NOT NULL THEN 0 ELSE 1 END,
                                   id
                           ) as rn
                    FROM media WHERE 1=1`;
            } else {
                sql = 'SELECT * FROM media WHERE 1=1';
            }
            const params = [];

            if (type) {
                sql += ' AND media_type = ?';
                params.push(type);

                // For movie/series views, filter out category headers and info channels
                if (type === 'movie' || type === 'series') {
                    sql += ` AND title NOT LIKE '%###%'
                             AND title NOT LIKE '## %'
                             AND title NOT LIKE '%----- %'
                             AND title NOT LIKE '%INFO%'
                             AND title NOT GLOB '*[#][#]*'`;
                }
            }
            if (search) {
                sql += ' AND (title LIKE ? OR original_title LIKE ?)';
                params.push(`%${search}%`, `%${search}%`);
            }
            if (year) {
                // Filter by year column or year in title like "(2024)"
                sql += ' AND (year = ? OR title LIKE ?)';
                params.push(parseInt(year), `%(${year})%`);
            }
            if (quality) {
                sql += ' AND quality = ?';
                params.push(quality);
            }
            if (language) {
                // Filter by language in category [XX] or title prefix "XX - "
                sql += ' AND (category LIKE ? OR title LIKE ?)';
                params.push(`%[${language}]%`, `${language} - %`);
            }
            if (genre) {
                sql += ' AND genres LIKE ?';
                params.push(`%${genre}%`);
            }
            if (category) {
                sql += ' AND category = ?';
                params.push(category);
            }
            if (source) {
                sql += ' AND source_id = ?';
                params.push(parseInt(source));
            }

            // Close the subquery and filter for dedupe
            if (shouldDedupe) {
                sql += `) WHERE rn = 1`;
            }

            // Sorting - show enriched items (with TMDB posters) first when sorting by title
            const sortField = ['title', 'year', 'rating', 'created_at'].includes(sort) ? sort : 'title';
            const sortOrder = order === 'desc' ? 'DESC' : 'ASC';

            if (sortField === 'title' && (type === 'movie' || type === 'series')) {
                // Prioritize items with TMDB posters, then sort by title
                sql += ` ORDER BY
                    CASE WHEN poster LIKE '%image.tmdb.org%' THEN 0 ELSE 1 END,
                    ${sortField} ${sortOrder}`;
            } else {
                sql += ` ORDER BY ${sortField} ${sortOrder}`;
            }

            // Pagination
            const limitNum = Math.min(parseInt(limit) || 50, 100);
            const offsetNum = parseInt(offset) || 0;
            sql += ' LIMIT ? OFFSET ?';
            params.push(limitNum, offsetNum);

            const media = await modules.db.all(sql, params);

            // Add source name to each media item
            if (media.length > 0) {
                const sourceIds = [...new Set(media.filter(m => m.source_id).map(m => m.source_id))];
                if (sourceIds.length > 0) {
                    const placeholders = sourceIds.map(() => '?').join(',');
                    const sources = await modules.db.all(
                        `SELECT id, name FROM sources WHERE id IN (${placeholders})`,
                        sourceIds
                    );
                    const sourceMap = {};
                    for (const s of sources) {
                        sourceMap[s.id] = s.name;
                    }
                    for (const m of media) {
                        m.source_name = sourceMap[m.source_id] || null;
                    }
                }
            }

            res.json(media);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/media/:id', async (req, res) => {
        try {
            const media = await modules.db.get(`
                SELECT m.*, s.name as source_name
                FROM media m
                LEFT JOIN sources s ON m.source_id = s.id
                WHERE m.id = ?
            `, [req.params.id]);
            if (!media) return res.status(404).json({ error: 'Not found' });

            // Get episodes if series
            if (media.media_type === 'series') {
                media.episodes = await modules.db.all(
                    'SELECT * FROM episodes WHERE media_id = ? ORDER BY season, episode',
                    [media.id]
                );
            }

            // Get cast/crew
            media.cast = await modules.db.all(`
                SELECT p.*, mp.role, mp.character, mp.credit_order
                FROM people p
                JOIN media_people mp ON p.id = mp.person_id
                WHERE mp.media_id = ?
                ORDER BY mp.credit_order
            `, [media.id]);

            res.json(media);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get all versions of a movie (different languages) for language selector
    router.get('/media/:id/versions', async (req, res) => {
        try {
            // First get the base media to find normalized title
            const baseMedia = await modules.db.get('SELECT * FROM media WHERE id = ?', [req.params.id]);
            if (!baseMedia) return res.status(404).json({ error: 'Not found' });

            // Normalize the title (remove language prefix)
            let normalizedTitle = baseMedia.title;
            if (/^[A-Z]{2,3}\s*-\s*/.test(normalizedTitle)) {
                normalizedTitle = normalizedTitle.replace(/^[A-Z]{2,3}\s*-\s*/, '');
            }

            // Extract year if present
            const yearMatch = normalizedTitle.match(/\((\d{4})\)/);
            const targetYear = baseMedia.year || (yearMatch ? parseInt(yearMatch[1]) : null);

            // Find all versions with similar normalized titles
            const versions = await modules.db.all(`
                SELECT m.*, s.name as source_name,
                    COALESCE(
                        -- First try to extract from title prefix (e.g., "DE - Title")
                        CASE
                            WHEN m.title GLOB '[A-Z][A-Z] - *' THEN SUBSTR(m.title, 1, 2)
                            WHEN m.title GLOB '[A-Z][A-Z][A-Z] - *' THEN SUBSTR(m.title, 1, 3)
                            ELSE NULL
                        END,
                        -- Then try to extract from category (e.g., "VOD - Movies [DE]")
                        CASE
                            WHEN m.category LIKE '%[__]%' THEN SUBSTR(m.category, INSTR(m.category, '[') + 1, 2)
                            WHEN m.category LIKE '%[___]%' THEN SUBSTR(m.category, INSTR(m.category, '[') + 1, 3)
                            ELSE NULL
                        END
                    ) as language_code
                FROM media m
                LEFT JOIN sources s ON m.source_id = s.id
                WHERE m.media_type = ?
                  AND (
                      -- Match by TMDB ID if available
                      (m.tmdb_id IS NOT NULL AND m.tmdb_id = ?)
                      OR
                      -- Match by normalized title and year
                      (
                          LOWER(TRIM(
                              CASE
                                  WHEN m.title GLOB '[A-Z][A-Z] - *' THEN SUBSTR(m.title, 6)
                                  WHEN m.title GLOB '[A-Z][A-Z][A-Z] - *' THEN SUBSTR(m.title, 7)
                                  ELSE m.title
                              END
                          )) = LOWER(TRIM(?))
                          AND (m.year = ? OR m.year IS NULL OR ? IS NULL)
                      )
                  )
                ORDER BY
                    CASE WHEN m.id = ? THEN 0 ELSE 1 END,
                    language_code
            `, [baseMedia.media_type, baseMedia.tmdb_id, normalizedTitle, targetYear, targetYear, req.params.id]);

            res.json(versions);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Sources endpoints
    router.get('/sources', async (req, res) => {
        try {
            const sources = await modules.db.all('SELECT * FROM sources ORDER BY name');
            res.json(sources);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/sources', async (req, res) => {
        try {
            const { name, type, url, username, password, user_agent, spoofed_mac, spoofed_device_key, simulate_playback, playback_speed_multiplier, m3u_parser_config } = req.body;
            const result = await modules.db.run(
                'INSERT INTO sources (name, type, url, username, password, user_agent, spoofed_mac, spoofed_device_key, simulate_playback, playback_speed_multiplier, m3u_parser_config) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [name, type || 'xtream', url, username, password, user_agent || 'IBOPlayer', spoofed_mac || null, spoofed_device_key || null, simulate_playback !== undefined ? simulate_playback : 1, playback_speed_multiplier !== undefined ? playback_speed_multiplier : 1.5, m3u_parser_config || null]
            );
            res.json({ id: result.lastID, message: 'Source added' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.put('/sources/:id', async (req, res) => {
        try {
            const { name, type, url, username, password, user_agent, active, spoofed_mac, spoofed_device_key, simulate_playback, playback_speed_multiplier, m3u_parser_config } = req.body;
            await modules.db.run(
                'UPDATE sources SET name=?, type=?, url=?, username=?, password=?, user_agent=?, active=?, spoofed_mac=?, spoofed_device_key=?, simulate_playback=?, playback_speed_multiplier=?, m3u_parser_config=? WHERE id=?',
                [name, type, url, username, password, user_agent, active !== false ? 1 : 0, spoofed_mac || null, spoofed_device_key || null, simulate_playback !== undefined ? simulate_playback : 1, playback_speed_multiplier !== undefined ? playback_speed_multiplier : 1.5, m3u_parser_config || null, req.params.id]
            );
            res.json({ message: 'Source updated' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.delete('/sources/:id', async (req, res) => {
        try {
            await modules.db.run('DELETE FROM sources WHERE id = ?', [req.params.id]);
            res.json({ message: 'Source deleted' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/sources/:id/toggle', async (req, res) => {
        try {
            const { active } = req.body;
            await modules.db.run('UPDATE sources SET active = ? WHERE id = ?', [active ? 1 : 0, req.params.id]);
            logger?.info('sources', `Source ${req.params.id} ${active ? 'enabled' : 'disabled'}`);
            res.json({ success: true, active: active ? 1 : 0 });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/sources/:id/sync', async (req, res) => {
        try {
            const source = await modules.db.get('SELECT * FROM sources WHERE id = ?', [req.params.id]);
            if (!source) return res.status(404).json({ error: 'Source not found' });

            // Start sync in background
            if (modules.iptv) {
                modules.iptv.syncSource(source).catch(err => {
                    logger.error('api', `Sync failed for source ${source.id}`, { error: err.message });
                });
            }

            res.json({ message: 'Sync started' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/sources/:id/test', async (req, res) => {
        try {
            const source = await modules.db.get('SELECT * FROM sources WHERE id = ?', [req.params.id]);
            if (!source) return res.status(404).json({ error: 'Source not found' });

            if (modules.iptv) {
                const result = await modules.iptv.testSource(source);
                res.json(result);
            } else {
                res.json({ success: false, message: 'IPTV module not loaded' });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get sync status for all sources (for page reload persistence)
    router.get('/sources/sync-status', async (req, res) => {
        try {
            if (modules.iptv && modules.iptv.getAllSyncStatus) {
                res.json(modules.iptv.getAllSyncStatus());
            } else {
                res.json({});
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get per-source stats (downloads and enrichment)
    router.get('/sources/:id/stats', async (req, res) => {
        try {
            const sourceId = req.params.id;
            const db = modules.db;

            // Get media type counts for this source
            const mediaCounts = await db.get(`
                SELECT
                    SUM(CASE WHEN media_type = 'movie' THEN 1 ELSE 0 END) as movies,
                    SUM(CASE WHEN media_type = 'series' THEN 1 ELSE 0 END) as series,
                    COUNT(*) as total
                FROM media
                WHERE source_id = ?
            `, [sourceId]);

            // Get download stats for this source
            const downloadStats = await db.get(`
                SELECT
                    COUNT(*) as total,
                    SUM(CASE WHEN d.status = 'completed' THEN 1 ELSE 0 END) as completed
                FROM downloads d
                JOIN media m ON d.media_id = m.id
                WHERE m.source_id = ?
            `, [sourceId]);

            // Get enrichment stats for this source
            const enrichmentStats = await db.get(`
                SELECT
                    COUNT(*) as total,
                    SUM(CASE WHEN tmdb_id IS NOT NULL THEN 1 ELSE 0 END) as enriched
                FROM media
                WHERE source_id = ? AND media_type IN ('movie', 'series')
            `, [sourceId]);

            res.json({
                movies: mediaCounts?.movies || 0,
                series: mediaCounts?.series || 0,
                total: mediaCounts?.total || 0,
                downloaded: downloadStats?.completed || 0,
                enriched: enrichmentStats?.enriched || 0
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Enrich media for a specific source
    router.post('/sources/:id/enrich', async (req, res) => {
        try {
            const sourceId = parseInt(req.params.id);
            if (!modules.tmdb) {
                return res.status(400).json({ error: 'TMDB module not loaded' });
            }

            // Start enrichment in background for this source only
            enrichSourceMedia(sourceId, modules).catch(err => {
                logger.error('api', `Source enrichment failed: ${err.message}`);
            });

            res.json({ message: 'Enrichment started for source', sourceId });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // M3U Parser configuration endpoints
    router.get('/sources/parser-config/default', async (req, res) => {
        try {
            if (modules.iptv && modules.iptv.getDefaultParserConfig) {
                res.json(modules.iptv.getDefaultParserConfig());
            } else {
                res.status(500).json({ error: 'IPTV module not loaded' });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/sources/:id/parser-preview', async (req, res) => {
        try {
            const source = await modules.db.get('SELECT * FROM sources WHERE id = ?', [req.params.id]);
            if (!source) return res.status(404).json({ error: 'Source not found' });
            if (source.type !== 'm3u') return res.status(400).json({ error: 'Parser preview only works for M3U sources' });

            const { parserConfig } = req.body;

            // Get sample M3U content from history
            const history = await modules.db.get(
                'SELECT content FROM m3u_history WHERE source_id = ? ORDER BY fetched_at DESC LIMIT 1',
                [source.id]
            );

            if (!history || !history.content) {
                return res.status(400).json({ error: 'No M3U content available. Please sync the source first.' });
            }

            // Preview parsing with provided config
            if (modules.iptv && modules.iptv.previewM3UParser) {
                const results = modules.iptv.previewM3UParser(history.content, parserConfig);
                res.json({ results, sampleCount: results.length });
            } else {
                res.status(500).json({ error: 'IPTV module not loaded' });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // EPG (Electronic Program Guide) endpoints
    router.post('/sources/:id/sync-epg', async (req, res) => {
        try {
            const source = await db.get('SELECT * FROM sources WHERE id = ?', [req.params.id]);
            if (!source) return res.status(404).json({ error: 'Source not found' });
            if (!source.epg_url) return res.status(400).json({ error: 'No EPG URL configured for this source' });

            if (modules.epg) {
                // Sync EPG in background
                modules.epg.syncEpg(source).catch(err => {
                    logger.error('app', `EPG sync failed for ${source.name}: ${err.message}`);
                });
                res.json({ success: true, message: 'EPG sync started' });
            } else {
                res.status(500).json({ error: 'EPG module not loaded' });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get EPG for a specific channel
    router.get('/epg/channel/:channelId', async (req, res) => {
        try {
            if (!modules.epg) return res.status(500).json({ error: 'EPG module not loaded' });

            const current = await modules.epg.getCurrentProgram(req.params.channelId);
            const upcoming = await modules.epg.getUpcomingPrograms(req.params.channelId, 5);

            res.json({ current, upcoming });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get EPG for multiple channels at once (batch)
    router.post('/epg/channels', async (req, res) => {
        try {
            if (!modules.epg) return res.status(500).json({ error: 'EPG module not loaded' });

            const { channelIds } = req.body;
            if (!channelIds || !Array.isArray(channelIds)) {
                return res.status(400).json({ error: 'channelIds array required' });
            }

            const epgData = await modules.epg.getEpgForChannels(channelIds);
            res.json(epgData);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get EPG sync status
    router.get('/epg/status', async (req, res) => {
        try {
            const syncInfo = await db.all(`
                SELECT es.*, s.name as source_name
                FROM epg_sync es
                JOIN sources s ON es.source_id = s.id
            `);
            res.json(syncInfo);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get available EPG countries
    router.get('/epg/countries', (req, res) => {
        if (!modules.epg) return res.status(500).json({ error: 'EPG module not loaded' });
        res.json(modules.epg.getAvailableCountries());
    });

    // Get EPG channels (filtered by language + IPTV availability by default)
    router.get('/epg/channels', async (req, res) => {
        try {
            if (!modules.epg) return res.status(500).json({ error: 'EPG module not loaded' });

            // By default, return filtered channels (only preferred languages + available in IPTV)
            // Use ?all=true to get all channels (old behavior)
            const showAll = req.query.all === 'true';

            if (showAll) {
                const country = req.query.country || null;
                const channels = await modules.epg.getChannelsWithEpg(country);
                res.json(channels);
            } else {
                const channels = await modules.epg.getFilteredEpgChannels();
                res.json(channels);
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Rebuild EPG channel cache (after sync or IPTV refresh)
    router.post('/epg/rebuild-cache', async (req, res) => {
        try {
            if (!modules.epg) return res.status(500).json({ error: 'EPG module not loaded' });
            const result = await modules.epg.rebuildChannelCache();
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Sync global EPG
    router.post('/epg/sync-global', async (req, res) => {
        try {
            if (!modules.epg) return res.status(500).json({ error: 'EPG module not loaded' });

            const { countries } = req.body;
            io?.emit('epg:start', { countries: countries || settings.get('epgCountries') });

            // Run sync in background
            modules.epg.syncGlobalEpg(countries).then(async result => {
                // Rebuild channel cache after sync
                try {
                    await modules.epg.rebuildChannelCache();
                } catch (err) {
                    logger?.warn('app', `Failed to rebuild EPG cache: ${err.message}`);
                }
                io?.emit('epg:complete', result);
            }).catch(err => {
                io?.emit('epg:error', { error: err.message });
            });

            res.json({ success: true, message: 'Global EPG sync started' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get EPG program guide for a time range
    router.get('/epg/guide', async (req, res) => {
        try {
            if (!modules.epg) return res.status(500).json({ error: 'EPG module not loaded' });

            const start = req.query.start ? new Date(req.query.start) : new Date();
            const end = req.query.end ? new Date(req.query.end) : new Date(start.getTime() + 6 * 60 * 60 * 1000);
            const channelIds = req.query.channels ? req.query.channels.split(',') : null;

            const programs = await modules.epg.getProgramGuide(start, end, channelIds);
            res.json(programs);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get EPG program by ID
    router.get('/epg/program/:id', async (req, res) => {
        try {
            if (!modules.epg) return res.status(500).json({ error: 'EPG module not loaded' });
            const program = await modules.epg.getProgramById(parseInt(req.params.id));
            if (!program) return res.status(404).json({ error: 'Program not found' });
            res.json(program);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // AI Channel matching (EPG to IPTV sources)
    router.post('/epg/match-channels', async (req, res) => {
        try {
            if (!modules.epg) return res.status(500).json({ error: 'EPG module not loaded' });
            const result = await modules.epg.matchChannelsWithAI();
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Rebuild EPG channel cache (for filtering by IPTV availability)
    router.post('/epg/rebuild-cache', async (req, res) => {
        try {
            if (!modules.epg) return res.status(500).json({ error: 'EPG module not loaded' });
            io?.emit('epg:progress', { message: 'Rebuilding channel cache...' });
            const result = await modules.epg.rebuildChannelCache();
            io?.emit('epg:progress', { message: `Cache rebuilt: ${result.matched} of ${result.total} channels matched` });
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get channel mappings
    router.get('/epg/mappings', async (req, res) => {
        try {
            if (!modules.epg) return res.status(500).json({ error: 'EPG module not loaded' });
            const mappings = await modules.epg.getChannelMappings();
            res.json(mappings);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // LLM endpoints
    router.post('/llm/test', async (req, res) => {
        try {
            if (!modules.llm) return res.status(500).json({ error: 'LLM module not loaded', success: false });
            const result = await modules.llm.testConnection();
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message, success: false });
        }
    });

    router.get('/llm/status', async (req, res) => {
        try {
            if (!modules.llm) return res.json({ configured: false, provider: 'none' });
            res.json({
                configured: modules.llm.isConfigured(),
                provider: modules.llm.getProvider()
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Recordings endpoints
    router.get('/recordings', async (req, res) => {
        try {
            if (!modules.scheduler) return res.status(500).json({ error: 'Scheduler module not loaded' });
            const filter = {};
            if (req.query.status) filter.status = req.query.status;
            if (req.query.upcoming) filter.upcoming = true;
            if (req.query.limit) filter.limit = parseInt(req.query.limit);
            const recordings = await modules.scheduler.getRecordings(filter);
            res.json(recordings);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/recordings/:id', async (req, res) => {
        try {
            if (!modules.scheduler) return res.status(500).json({ error: 'Scheduler module not loaded' });
            const recording = await modules.scheduler.getRecording(parseInt(req.params.id));
            if (!recording) return res.status(404).json({ error: 'Recording not found' });
            res.json(recording);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/recordings', async (req, res) => {
        try {
            if (!modules.scheduler) return res.status(500).json({ error: 'Scheduler module not loaded' });
            const { mediaId, title, startTime, endTime, recurrence, epgProgramId } = req.body;
            const recording = await modules.scheduler.scheduleRecording(
                mediaId, title, startTime, endTime,
                { recurrence, epgProgramId }
            );
            res.json(recording);
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    router.delete('/recordings/:id', async (req, res) => {
        try {
            if (!modules.scheduler) return res.status(500).json({ error: 'Scheduler module not loaded' });
            const deleteFile = req.query.deleteFile === 'true';
            await modules.scheduler.deleteRecording(parseInt(req.params.id), deleteFile);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/recordings/:id/cancel', async (req, res) => {
        try {
            if (!modules.scheduler) return res.status(500).json({ error: 'Scheduler module not loaded' });
            await modules.scheduler.cancelRecording(parseInt(req.params.id));
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/recordings/:id/stop', async (req, res) => {
        try {
            if (!modules.scheduler) return res.status(500).json({ error: 'Scheduler module not loaded' });
            await modules.scheduler.stopRecording(parseInt(req.params.id));
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Scheduler status
    router.get('/scheduler/status', async (req, res) => {
        try {
            if (!modules.scheduler) return res.status(500).json({ error: 'Scheduler module not loaded' });
            const status = await modules.scheduler.getStatus();
            res.json(status);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/scheduler/trigger/:taskType', async (req, res) => {
        try {
            if (!modules.scheduler) return res.status(500).json({ error: 'Scheduler module not loaded' });
            await modules.scheduler.triggerTask(req.params.taskType);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Check ffmpeg availability
    router.get('/scheduler/ffmpeg', async (req, res) => {
        try {
            if (!modules.scheduler) return res.status(500).json({ error: 'Scheduler module not loaded' });
            const ffmpeg = await modules.scheduler.checkFfmpeg();
            res.json(ffmpeg);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Transcoder endpoints
    router.get('/transcoder/status', async (req, res) => {
        try {
            if (!modules.transcoder) return res.json({ available: false });
            const status = modules.transcoder.getStatus();
            const queueCount = await modules.db.get(
                'SELECT COUNT(*) as count FROM transcode_queue WHERE status = ?',
                ['pending']
            );
            res.json({
                available: true,
                ...status,
                queueCount: queueCount?.count || 0
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/transcoder/hw-status', async (req, res) => {
        try {
            if (!modules.transcoder) {
                return res.json({ available: false, type: 'unavailable', encoders: {} });
            }
            const hwStatus = await modules.transcoder.detectHardwareAcceleration();
            res.json({
                available: hwStatus.type !== 'software' && hwStatus.type !== 'unavailable',
                type: hwStatus.type,
                encoders: hwStatus.encoders
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/transcoder/queue', async (req, res) => {
        try {
            const queue = await modules.db.all(`
                SELECT tq.*,
                       COALESCE(m.title, tq.filename) as title,
                       m.poster
                FROM transcode_queue tq
                LEFT JOIN downloads d ON tq.download_id = d.id
                LEFT JOIN media m ON d.media_id = m.id
                ORDER BY
                    CASE tq.status
                        WHEN 'transcoding' THEN 1
                        WHEN 'pending' THEN 2
                        WHEN 'failed' THEN 3
                        ELSE 4
                    END,
                    tq.created_at DESC
                LIMIT 50
            `);
            res.json(queue);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/transcoder/:id/retry', async (req, res) => {
        try {
            if (!modules.transcoder) return res.status(500).json({ error: 'Transcoder not available' });
            await modules.transcoder.retryJob(parseInt(req.params.id));
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/transcoder/cancel', async (req, res) => {
        try {
            if (!modules.transcoder) return res.status(500).json({ error: 'Transcoder not available' });
            await modules.transcoder.cancelActive();
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Clear completed/skipped items from transcode queue
    router.post('/transcoder/clear', async (req, res) => {
        try {
            const result = await modules.db.run(`
                DELETE FROM transcode_queue
                WHERE status IN ('completed', 'skipped')
            `);
            res.json({ success: true, deleted: result.changes });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Clear failed items from transcode queue
    router.post('/transcoder/clear-failed', async (req, res) => {
        try {
            const result = await modules.db.run(`
                DELETE FROM transcode_queue
                WHERE status = 'failed'
            `);
            res.json({ success: true, deleted: result.changes });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Delete a specific transcode queue item
    router.delete('/transcoder/:id', async (req, res) => {
        try {
            const job = await modules.db.get('SELECT status FROM transcode_queue WHERE id = ?', [req.params.id]);
            if (!job) {
                return res.status(404).json({ error: 'Job not found' });
            }
            // Don't allow deleting active job
            if (job.status === 'transcoding') {
                return res.status(400).json({ error: 'Cannot delete active job. Cancel it first.' });
            }
            await modules.db.run('DELETE FROM transcode_queue WHERE id = ?', [req.params.id]);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Downloads endpoints
    router.get('/downloads', async (req, res) => {
        try {
            // Auto-clean orphaned downloads (where media no longer exists)
            await modules.db.run(`
                DELETE FROM downloads
                WHERE media_id NOT IN (SELECT id FROM media)
            `);

            const downloads = await modules.db.all(`
                SELECT d.*, m.title, m.poster, m.media_type, e.title as episode_title,
                       e.season as ep_season, e.episode as ep_episode
                FROM downloads d
                INNER JOIN media m ON d.media_id = m.id
                LEFT JOIN episodes e ON d.episode_id = e.id
                ORDER BY
                    CASE d.status
                        WHEN 'downloading' THEN 1
                        WHEN 'transcoding' THEN 2
                        WHEN 'queued' THEN 3
                        WHEN 'completed' THEN 4
                        WHEN 'failed' THEN 5
                        WHEN 'cancelled' THEN 6
                    END,
                    d.priority DESC,
                    d.created_at DESC
            `);
            res.json(downloads);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/downloads', async (req, res) => {
        try {
            let { media_id, episode_id, priority } = req.body;

            // If episode_id is provided, ensure media_id is correct (get it from the episode)
            if (episode_id) {
                const episode = await modules.db.get('SELECT media_id FROM episodes WHERE id = ?', [episode_id]);
                if (episode) {
                    media_id = episode.media_id;
                }
            }

            if (modules.download) {
                const result = await modules.download.queue(media_id, episode_id || null, priority || 50);
                res.json(result);
            } else {
                const result = await modules.db.run(
                    'INSERT INTO downloads (media_id, episode_id, status, priority) VALUES (?, ?, ?, ?)',
                    [media_id, episode_id || null, 'queued', priority || 50]
                );
                res.json({ success: true, id: result.lastID });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.delete('/downloads/:id', async (req, res) => {
        try {
            await modules.db.run('DELETE FROM downloads WHERE id = ?', [req.params.id]);
            io?.emit('download:removed', { id: parseInt(req.params.id) });
            res.json({ message: 'Download removed' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Priority management endpoints
    router.put('/downloads/:id/priority', async (req, res) => {
        try {
            const { priority } = req.body;
            if (modules.download) {
                const result = await modules.download.setPriority(parseInt(req.params.id), priority);
                res.json(result);
            } else {
                const clampedPriority = Math.max(0, Math.min(100, priority));
                await modules.db.run('UPDATE downloads SET priority = ? WHERE id = ? AND status = ?',
                    [clampedPriority, req.params.id, 'queued']);
                res.json({ success: true, priority: clampedPriority });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/downloads/:id/move-up', async (req, res) => {
        try {
            if (modules.download) {
                const result = await modules.download.moveUp(parseInt(req.params.id));
                res.json(result);
            } else {
                res.status(400).json({ error: 'Download module not loaded' });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/downloads/:id/move-down', async (req, res) => {
        try {
            if (modules.download) {
                const result = await modules.download.moveDown(parseInt(req.params.id));
                res.json(result);
            } else {
                res.status(400).json({ error: 'Download module not loaded' });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/downloads/:id/move-top', async (req, res) => {
        try {
            if (modules.download) {
                const result = await modules.download.moveToTop(parseInt(req.params.id));
                res.json(result);
            } else {
                res.status(400).json({ error: 'Download module not loaded' });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/downloads/:id/move-bottom', async (req, res) => {
        try {
            if (modules.download) {
                const result = await modules.download.moveToBottom(parseInt(req.params.id));
                res.json(result);
            } else {
                res.status(400).json({ error: 'Download module not loaded' });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/downloads/:id/retry', async (req, res) => {
        try {
            if (modules.download) {
                const result = await modules.download.retry(parseInt(req.params.id));
                res.json(result);
            } else {
                await modules.db.run(`
                    UPDATE downloads
                    SET status = 'queued', error_message = NULL, retry_count = 0, priority = 75
                    WHERE id = ? AND status IN ('failed', 'cancelled')
                `, [req.params.id]);
                res.json({ success: true });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/downloads/:id/cancel', async (req, res) => {
        try {
            if (modules.download) {
                await modules.download.cancel(parseInt(req.params.id));
            } else {
                await modules.db.run('UPDATE downloads SET status = ? WHERE id = ?', ['cancelled', req.params.id]);
            }
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Settings endpoints
    router.get('/settings', (req, res) => {
        res.json(settings.getAll());
    });

    router.put('/settings', (req, res) => {
        const updated = settings.update(req.body);
        res.json(updated);
    });

    // People endpoints
    router.get('/people/:id', async (req, res) => {
        try {
            const person = await modules.db.get('SELECT * FROM people WHERE id = ?', [req.params.id]);
            if (!person) return res.status(404).json({ error: 'Not found' });

            // Get filmography
            person.credits = await modules.db.all(`
                SELECT m.*, mp.role, mp.character
                FROM media m
                JOIN media_people mp ON m.id = mp.media_id
                WHERE mp.person_id = ?
                ORDER BY m.year DESC
            `, [person.id]);

            res.json(person);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Filters data
    router.get('/filters', async (req, res) => {
        try {
            const { type } = req.query;
            const typeFilter = type ? 'AND media_type = ?' : '';
            const typeParam = type ? [type] : [];

            const years = await modules.db.all(`SELECT DISTINCT year FROM media WHERE year IS NOT NULL ${typeFilter} ORDER BY year DESC`, typeParam);
            const qualities = await modules.db.all(`SELECT DISTINCT quality FROM media WHERE quality IS NOT NULL ${typeFilter}`, typeParam);
            const languages = await modules.db.all(`SELECT DISTINCT language FROM media WHERE language IS NOT NULL ${typeFilter}`, typeParam);
            const categories = await modules.db.all(`SELECT DISTINCT category FROM media WHERE category IS NOT NULL ${typeFilter} ORDER BY category`, typeParam);
            const sources = await modules.db.all('SELECT id, name FROM sources ORDER BY name');

            // Filter languages by preferred settings if configured
            const preferredLangs = modules.settings?.get('preferredLanguages') || [];
            let filteredLanguages = languages.map(l => l.language);
            if (preferredLangs.length > 0) {
                const preferredUpper = preferredLangs.map(l => l.toUpperCase());
                filteredLanguages = filteredLanguages.filter(lang =>
                    lang && preferredUpper.includes(lang.toUpperCase())
                );
            }

            res.json({
                years: years.map(y => y.year),
                qualities: qualities.map(q => q.quality),
                languages: filteredLanguages,
                categories: categories.map(c => c.category),
                sources
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Webhooks
    router.post('/webhooks/overseerr', async (req, res) => {
        logger.info('api', `Overseerr webhook received`, { body: JSON.stringify(req.body).substring(0, 200) });
        try {
            if (modules.overseerr) {
                await modules.overseerr.handleWebhook(req.body);
            }
            res.json({ success: true });
        } catch (err) {
            logger.error('api', 'Overseerr webhook error', { error: err.message });
            res.status(500).json({ error: err.message });
        }
    });

    // Test endpoint for webhook connectivity
    router.get('/webhooks/overseerr/test', (req, res) => {
        logger.info('api', 'Overseerr webhook test endpoint hit');
        res.json({ status: 'ok', message: 'Webhook endpoint is reachable' });
    });

    // Plex endpoints
    router.get('/plex/libraries', async (req, res) => {
        try {
            if (modules.plex) {
                const libraries = await modules.plex.getLibraries();
                res.json(libraries);
            } else {
                res.json([]);
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/plex/scan', async (req, res) => {
        try {
            if (modules.plex) {
                await modules.plex.scanLibrary(req.body.libraryId, req.body.path);
                res.json({ message: 'Scan triggered' });
            } else {
                res.status(400).json({ error: 'Plex not configured' });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // TMDB enrichment endpoint
    // continuous=true will process ALL items without needing multiple clicks
    router.post('/enrich', async (req, res) => {
        try {
            const { type, limit, continuous } = req.body;
            if (modules.tmdb) {
                // Run in background with continuous mode enabled by default
                const isContinuous = continuous !== false; // Default to true
                modules.tmdb.batchEnrichPosters(type || null, limit || 500, isContinuous).catch(err => {
                    logger.error('api', `Enrichment failed: ${err.message}`);
                });
                res.json({ message: 'Enrichment started', continuous: isContinuous });
            } else {
                res.status(400).json({ error: 'TMDB module not loaded' });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Deep enrichment - re-enriches media with TMDB posters but no tmdb_id
    router.post('/enrich/deep', async (req, res) => {
        try {
            const { type, limit } = req.body;
            if (modules.tmdb) {
                // Run in background
                modules.tmdb.deepEnrichMedia(type || null, limit || 100).catch(err => {
                    logger.error('api', `Deep enrichment failed: ${err.message}`);
                });
                res.json({ message: 'Deep enrichment started' });
            } else {
                res.status(400).json({ error: 'TMDB module not loaded' });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Overseerr enrichment - uses Overseerr API (falls back to TMDB)
    router.post('/enrich/overseerr', async (req, res) => {
        try {
            const { type, limit } = req.body;
            if (modules.overseerr) {
                // Run in background
                modules.overseerr.batchEnrichMedia(type || null, limit || 500).catch(err => {
                    logger.error('api', `Overseerr enrichment failed: ${err.message}`);
                });
                res.json({ message: 'Overseerr enrichment started', source: modules.overseerr.isConfigured() ? 'overseerr' : 'tmdb_fallback' });
            } else {
                res.status(400).json({ error: 'Overseerr module not loaded' });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get enrichment stats
    router.get('/enrich/stats', async (req, res) => {
        try {
            const db = modules.db;
            const stats = {
                // Items that haven't been attempted yet (delta - new items)
                needsEnrichment: (await db.get(`
                    SELECT COUNT(*) as c FROM media
                    WHERE tmdb_id IS NULL
                    AND enrichment_attempted IS NULL
                    AND media_type IN ('movie', 'series')
                `))?.c || 0,
                // Items successfully enriched with TMDB
                enriched: (await db.get(`
                    SELECT COUNT(*) as c FROM media WHERE tmdb_id IS NOT NULL
                `))?.c || 0,
                // Items that were attempted but failed (can retry after 7 days)
                attempted: (await db.get(`
                    SELECT COUNT(*) as c FROM media
                    WHERE tmdb_id IS NULL AND enrichment_attempted IS NOT NULL
                `))?.c || 0,
                // Total media items
                total: (await db.get(`SELECT COUNT(*) as c FROM media WHERE media_type IN ('movie', 'series')`)?.c || 0)
            };
            res.json(stats);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ============================================
    // ENRICHMENT QUEUE ENDPOINTS (Parallel Workers)
    // ============================================

    // Start background enrichment with worker pool
    router.post('/enrich/start', async (req, res) => {
        try {
            const { type, limit, priority } = req.body;

            if (!modules.enrichment) {
                return res.status(400).json({ error: 'Enrichment module not loaded' });
            }

            // Queue items for enrichment
            const result = await modules.enrichment.queueUnenrichedMedia(type, limit);

            // Start workers if not already running
            if (!modules.enrichment.isRunning()) {
                await modules.enrichment.startWorkers();
            }

            res.json({
                message: 'Enrichment started',
                queued: result.queued,
                skipped: result.skipped,
                workersRunning: modules.enrichment.isRunning()
            });
        } catch (err) {
            logger.error('api', `Start enrichment failed: ${err.message}`);
            res.status(500).json({ error: err.message });
        }
    });

    // Stop enrichment workers
    router.post('/enrich/stop', async (req, res) => {
        try {
            if (modules.enrichment) {
                await modules.enrichment.stopWorkers();
            }
            res.json({ message: 'Enrichment workers stopped' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get enrichment queue status
    router.get('/enrich/queue', async (req, res) => {
        try {
            if (!modules.enrichment) {
                return res.status(400).json({ error: 'Enrichment module not loaded' });
            }

            const queue = await modules.enrichment.getQueueStatus();
            const workers = modules.enrichment.getWorkerStatus();
            const config = modules.enrichment.getConfig();

            res.json({
                queue,
                workers,
                config,
                isRunning: modules.enrichment.isRunning()
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Clear completed/failed jobs from queue
    router.post('/enrich/queue/clear', async (req, res) => {
        try {
            const { status } = req.body;  // 'completed', 'failed', or null for both
            if (modules.enrichment) {
                const result = await modules.enrichment.clearQueue(status);
                res.json({ message: 'Queue cleared', ...result });
            } else {
                res.status(400).json({ error: 'Enrichment module not loaded' });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Retry failed jobs
    router.post('/enrich/queue/retry', async (req, res) => {
        try {
            if (modules.enrichment) {
                const result = await modules.enrichment.retryFailedJobs();
                res.json({ message: 'Failed jobs retried', ...result });
            } else {
                res.status(400).json({ error: 'Enrichment module not loaded' });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get trailers for a media item
    router.get('/media/:id/trailers', async (req, res) => {
        try {
            const trailers = await modules.db.all(`
                SELECT
                    youtube_key,
                    'https://www.youtube.com/watch?v=' || youtube_key as youtube_url,
                    'https://img.youtube.com/vi/' || youtube_key || '/hqdefault.jpg' as thumbnail_url,
                    name, type, official, published_at
                FROM media_trailers
                WHERE media_id = ?
                ORDER BY official DESC,
                    CASE type
                        WHEN 'Trailer' THEN 1
                        WHEN 'Teaser' THEN 2
                        ELSE 3
                    END,
                    published_at DESC
            `, [req.params.id]);

            res.json(trailers);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // TMDB API endpoints - fetch full movie/TV data with caching
    router.get('/tmdb/movie/:id', async (req, res) => {
        try {
            const tmdbId = req.params.id;
            if (!modules.tmdb) {
                return res.status(400).json({ error: 'TMDB module not loaded' });
            }
            const data = await modules.tmdb.getMovie(tmdbId);
            res.json(data);
        } catch (err) {
            logger.warn('api', `TMDB movie fetch failed: ${err.message}`);
            res.status(err.response?.status || 500).json({ error: err.message });
        }
    });

    router.get('/tmdb/tv/:id', async (req, res) => {
        try {
            const tmdbId = req.params.id;
            if (!modules.tmdb) {
                return res.status(400).json({ error: 'TMDB module not loaded' });
            }
            const data = await modules.tmdb.getTv(tmdbId);
            res.json(data);
        } catch (err) {
            logger.warn('api', `TMDB TV fetch failed: ${err.message}`);
            res.status(err.response?.status || 500).json({ error: err.message });
        }
    });

    // TMDB Search endpoints
    router.get('/tmdb/search/movie', async (req, res) => {
        try {
            const { query, year } = req.query;
            if (!query) {
                return res.status(400).json({ error: 'Query parameter required' });
            }
            if (!modules.tmdb) {
                return res.status(400).json({ error: 'TMDB module not loaded' });
            }
            const results = await modules.tmdb.searchMovie(query, year || null);
            res.json(results);
        } catch (err) {
            logger.warn('api', `TMDB movie search failed: ${err.message}`);
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/tmdb/search/tv', async (req, res) => {
        try {
            const { query, year } = req.query;
            if (!query) {
                return res.status(400).json({ error: 'Query parameter required' });
            }
            if (!modules.tmdb) {
                return res.status(400).json({ error: 'TMDB module not loaded' });
            }
            const results = await modules.tmdb.searchTv(query, year || null);
            res.json(results);
        } catch (err) {
            logger.warn('api', `TMDB TV search failed: ${err.message}`);
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/tmdb/tv/:id/season/:season', async (req, res) => {
        try {
            const { id, season } = req.params;
            if (!modules.tmdb) {
                return res.status(400).json({ error: 'TMDB module not loaded' });
            }
            const data = await modules.tmdb.getSeason(id, parseInt(season));
            res.json(data);
        } catch (err) {
            logger.warn('api', `TMDB season fetch failed: ${err.message}`);
            res.status(err.response?.status || 500).json({ error: err.message });
        }
    });

    // Get grouped shows (for Netflix-style series view)
    router.get('/shows', async (req, res) => {
        try {
            const { search, quality, year, language, source, sort, order, limit, offset } = req.query;
            const db = modules.db;

            let sql = `
                SELECT
                    show_name,
                    COUNT(*) as episode_count,
                    COUNT(DISTINCT season_number) as season_count,
                    GROUP_CONCAT(DISTINCT COALESCE(show_language, language)) as languages,
                    MAX(poster) as poster,
                    MAX(rating) as rating,
                    MAX(year) as year,
                    MAX(quality) as quality
                FROM media
                WHERE media_type = 'series'
                  AND show_name IS NOT NULL
                  AND show_name != ''
            `;
            const params = [];

            if (search) {
                sql += ' AND show_name LIKE ?';
                params.push(`%${search}%`);
            }

            if (quality) {
                sql += ' AND quality = ?';
                params.push(quality);
            }

            if (year) {
                sql += ' AND (year = ? OR title LIKE ?)';
                params.push(parseInt(year), `%(${year})%`);
            }

            if (language) {
                // Check both show_language (from episodes) and language (from M3U sources)
                sql += ' AND (show_language = ? OR (show_language IS NULL AND language = ?))';
                params.push(language, language);
            }

            if (source) {
                sql += ' AND source_id = ?';
                params.push(parseInt(source));
            }

            sql += ' GROUP BY show_name';

            // Sorting
            const sortField = ['show_name', 'year', 'rating', 'episode_count'].includes(sort) ? sort : 'show_name';
            const sortOrder = order === 'desc' ? 'DESC' : 'ASC';

            if (sortField === 'show_name') {
                sql += ` ORDER BY
                    CASE WHEN poster LIKE '%image.tmdb.org%' THEN 0 ELSE 1 END,
                    ${sortField} ${sortOrder}`;
            } else {
                sql += ` ORDER BY ${sortField} ${sortOrder}`;
            }

            // Pagination
            const limitNum = Math.min(parseInt(limit) || 50, 100);
            const offsetNum = parseInt(offset) || 0;
            sql += ' LIMIT ? OFFSET ?';
            params.push(limitNum, offsetNum);

            const shows = await db.all(sql, params);
            res.json(shows);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get single show details with episodes grouped by language and season
    router.get('/shows/:name', async (req, res) => {
        try {
            const db = modules.db;
            const showName = decodeURIComponent(req.params.name);

            // Get all series entries for this show (parent entries from Xtream API)
            const seriesEntries = await db.all(`
                SELECT m.*, s.name as source_name
                FROM media m
                LEFT JOIN sources s ON m.source_id = s.id
                WHERE m.media_type = 'series'
                  AND m.show_name = ?
            `, [showName]);

            if (seriesEntries.length === 0) {
                return res.status(404).json({ error: 'Show not found' });
            }

            // Group by language
            const languageGroups = {};
            const sourceNames = new Set();
            let poster = null;
            let backdrop = null;
            let rating = null;
            let year = null;
            let plot = null;
            let genres = null;
            let tmdbId = null;
            let totalEpisodeCount = 0;

            for (const series of seriesEntries) {
                // Extract language from series entry (M3U uses 'language', Xtream uses 'show_language')
                const lang = series.show_language || series.language || 'Unknown';
                if (!languageGroups[lang]) {
                    languageGroups[lang] = { seasons: {} };
                }

                // Collect source names
                if (series.source_name) sourceNames.add(series.source_name);

                // Get best poster (prefer TMDB)
                if (series.poster && series.poster.includes('image.tmdb.org')) {
                    poster = series.poster;
                } else if (!poster && series.poster) {
                    poster = series.poster;
                }
                if (series.backdrop && series.backdrop.includes('image.tmdb.org')) backdrop = series.backdrop;
                if (series.rating && (!rating || series.rating > rating)) rating = series.rating;
                if (series.year && (!year || series.year < year)) year = series.year;
                if (series.plot && !plot) plot = series.plot;
                if (series.genres && !genres) genres = series.genres;
                if (series.tmdb_id && !tmdbId) tmdbId = series.tmdb_id;

                // Check if this is a parent series with episodes in episodes table
                // (Xtream API sources store episodes separately)
                if (series.season_number === null || series.season_number === undefined) {
                    // Fetch episodes from episodes table
                    const episodes = await db.all(`
                        SELECT e.*, m.show_language
                        FROM episodes e
                        JOIN media m ON e.media_id = m.id
                        WHERE e.media_id = ?
                        ORDER BY e.season, e.episode
                    `, [series.id]);

                    for (const ep of episodes) {
                        const epLang = ep.show_language || lang;
                        if (!languageGroups[epLang]) {
                            languageGroups[epLang] = { seasons: {} };
                        }

                        const season = ep.season || 0;
                        if (!languageGroups[epLang].seasons[season]) {
                            languageGroups[epLang].seasons[season] = [];
                        }

                        languageGroups[epLang].seasons[season].push({
                            id: ep.id,
                            media_id: ep.media_id,
                            title: ep.title,
                            plot: ep.plot,
                            air_date: ep.air_date,
                            runtime: ep.runtime,
                            stream_url: ep.stream_url,
                            container: ep.container,
                            season_number: ep.season,
                            episode_number: ep.episode,
                            source_name: series.source_name
                        });
                        totalEpisodeCount++;
                    }
                } else {
                    // This is an M3U-style entry with season/episode in media table
                    const season = series.season_number || 0;
                    if (!languageGroups[lang].seasons[season]) {
                        languageGroups[lang].seasons[season] = [];
                    }

                    languageGroups[lang].seasons[season].push(series);
                    totalEpisodeCount++;
                }
            }

            res.json({
                showName,
                poster,
                backdrop,
                rating,
                year,
                plot,
                genres,
                tmdbId,
                sources: Array.from(sourceNames),
                languages: Object.keys(languageGroups).sort(),
                totalEpisodes: totalEpisodeCount,
                languageGroups
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Fetch TMDB data for a show by name
    router.get('/shows/:name/tmdb', async (req, res) => {
        try {
            const showName = decodeURIComponent(req.params.name);

            if (!modules.tmdb) {
                return res.status(400).json({ error: 'TMDB module not loaded' });
            }

            // Search TMDB for the show
            const searchResults = await modules.tmdb.searchTv(showName);

            if (searchResults.length === 0) {
                return res.status(404).json({ error: 'Show not found on TMDB' });
            }

            // Get full details for the best match
            const tmdbData = await modules.tmdb.getTv(searchResults[0].id);

            res.json(tmdbData);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Fetch TMDB season details with episodes
    router.get('/tmdb/tv/:id/season/:season', async (req, res) => {
        try {
            if (!modules.tmdb) {
                return res.status(400).json({ error: 'TMDB module not loaded' });
            }

            const seasonData = await modules.tmdb.getSeason(req.params.id, req.params.season);
            res.json(seasonData);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Parse all series titles and update the database
    router.post('/series/parse', async (req, res) => {
        try {
            const db = modules.db;

            // Get all series that haven't been parsed yet
            const series = await db.all(`
                SELECT id, title FROM media
                WHERE media_type = 'series'
                  AND (show_name IS NULL OR show_name = '')
            `);

            logger?.info('api', `Parsing ${series.length} series titles...`);

            let updated = 0;
            let failed = 0;

            for (const item of series) {
                const parsed = parseSeriesTitle(item.title);

                if (parsed.showName) {
                    await db.run(`
                        UPDATE media
                        SET show_name = ?, season_number = ?, episode_number = ?, show_language = ?
                        WHERE id = ?
                    `, [parsed.showName, parsed.seasonNumber, parsed.episodeNumber, parsed.showLanguage, item.id]);
                    updated++;
                } else {
                    failed++;
                }

                // Emit progress every 1000 items
                if ((updated + failed) % 1000 === 0) {
                    io?.emit('parse-progress', { updated, failed, total: series.length });
                }
            }

            logger?.info('api', `Series parsing complete: ${updated} updated, ${failed} failed`);
            res.json({ success: true, updated, failed, total: series.length });
        } catch (err) {
            logger?.error('api', `Series parsing failed: ${err.message}`);
            res.status(500).json({ error: err.message });
        }
    });

    // Get series parsing stats
    router.get('/series/parse/stats', async (req, res) => {
        try {
            const db = modules.db;
            const stats = {
                parsed: (await db.get(`SELECT COUNT(*) as c FROM media WHERE media_type = 'series' AND show_name IS NOT NULL AND show_name != ''`))?.c || 0,
                unparsed: (await db.get(`SELECT COUNT(*) as c FROM media WHERE media_type = 'series' AND (show_name IS NULL OR show_name = '')`))?.c || 0,
                uniqueShows: (await db.get(`SELECT COUNT(DISTINCT show_name) as c FROM media WHERE media_type = 'series' AND show_name IS NOT NULL`))?.c || 0
            };
            res.json(stats);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Requests endpoints
    router.get('/requests', async (req, res) => {
        try {
            const requests = await modules.db.all(`
                SELECT r.*, m.title as matched_title, m.poster as matched_poster
                FROM requests r
                LEFT JOIN media m ON r.matched_media_id = m.id
                ORDER BY r.created_at DESC
            `);
            res.json(requests);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/requests/:id/approve', async (req, res) => {
        try {
            const db = modules.db;
            const request = await db.get('SELECT * FROM requests WHERE id = ?', [req.params.id]);
            if (!request) return res.status(404).json({ error: 'Request not found' });

            if (request.matched_media_id) {
                const media = await db.get('SELECT * FROM media WHERE id = ?', [request.matched_media_id]);

                if (request.media_type === 'series' && media) {
                    // For series, queue all episodes from requested seasons
                    let requestedSeasons = [];
                    try {
                        requestedSeasons = request.seasons_requested ? JSON.parse(request.seasons_requested) : [];
                    } catch (e) {
                        requestedSeasons = [];
                    }

                    let episodes;
                    if (requestedSeasons.length > 0) {
                        // Queue episodes from specific seasons
                        const placeholders = requestedSeasons.map(() => '?').join(',');
                        episodes = await db.all(
                            `SELECT * FROM episodes WHERE media_id = ? AND season IN (${placeholders}) ORDER BY season, episode`,
                            [request.matched_media_id, ...requestedSeasons]
                        );
                        logger?.info('requests', `Found ${episodes.length} episodes for seasons ${requestedSeasons.join(', ')}`);
                    } else {
                        // Queue all episodes
                        episodes = await db.all(
                            'SELECT * FROM episodes WHERE media_id = ? ORDER BY season, episode',
                            [request.matched_media_id]
                        );
                        logger?.info('requests', `Found ${episodes.length} total episodes`);
                    }

                    if (episodes.length > 0) {
                        // Queue each episode
                        let queuedCount = 0;
                        for (const ep of episodes) {
                            // Check if already queued
                            const existing = await db.get(
                                'SELECT id FROM downloads WHERE media_id = ? AND episode_id = ? AND status IN (?, ?, ?)',
                                [request.matched_media_id, ep.id, 'queued', 'downloading', 'completed']
                            );
                            if (!existing) {
                                await db.run(
                                    'INSERT INTO downloads (media_id, episode_id, status) VALUES (?, ?, ?)',
                                    [request.matched_media_id, ep.id, 'queued']
                                );
                                queuedCount++;
                            }
                        }
                        logger?.info('requests', `Approved and queued ${queuedCount} episodes for: ${request.title}`);

                        await db.run(
                            'UPDATE requests SET status = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?',
                            ['approved', req.params.id]
                        );

                        io?.emit('request:approved', { id: request.id, title: request.title, episodesQueued: queuedCount });
                        res.json({ success: true, episodes_queued: queuedCount });
                    } else {
                        // No episodes found - maybe it's an old-style entry, queue the media directly
                        logger?.warn('requests', `No episodes found for series ${request.title}, queuing media directly`);
                        const result = await db.run(
                            'INSERT INTO downloads (media_id, status) VALUES (?, ?)',
                            [request.matched_media_id, 'queued']
                        );

                        await db.run(
                            'UPDATE requests SET status = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?',
                            ['approved', req.params.id]
                        );

                        io?.emit('request:approved', { id: request.id, title: request.title });
                        res.json({ success: true, download_id: result.lastID });
                    }
                } else {
                    // For movies, queue the media directly
                    const result = await db.run(
                        'INSERT INTO downloads (media_id, status) VALUES (?, ?)',
                        [request.matched_media_id, 'queued']
                    );

                    await db.run(
                        'UPDATE requests SET status = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?',
                        ['approved', req.params.id]
                    );

                    logger?.info('requests', `Approved and queued download for: ${request.title}`);
                    io?.emit('request:approved', { id: request.id, title: request.title });
                    res.json({ success: true, download_id: result.lastID });
                }
            } else {
                res.status(400).json({ error: 'No matching media found in database' });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/requests/:id/reject', async (req, res) => {
        try {
            await modules.db.run(
                'UPDATE requests SET status = ?, rejected_at = CURRENT_TIMESTAMP WHERE id = ?',
                ['rejected', req.params.id]
            );
            logger?.info('requests', `Rejected request: ${req.params.id}`);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.delete('/requests/:id', async (req, res) => {
        try {
            await modules.db.run('DELETE FROM requests WHERE id = ?', [req.params.id]);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Play stream in external player (VLC)
    router.post('/play', async (req, res) => {
        try {
            const { url } = req.body;
            if (!url) {
                return res.status(400).json({ error: 'URL is required' });
            }

            // Determine VLC path based on platform
            const platform = process.platform;
            let vlcPath;
            let args;

            if (platform === 'darwin') {
                // macOS - use open command to launch VLC
                vlcPath = 'open';
                args = ['-a', 'VLC', url];
            } else if (platform === 'win32') {
                // Windows
                vlcPath = 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe';
                args = [url];
            } else {
                // Linux
                vlcPath = 'vlc';
                args = [url];
            }

            // Spawn VLC process (detached so it doesn't block)
            const vlc = spawn(vlcPath, args, {
                detached: true,
                stdio: 'ignore'
            });
            vlc.unref();

            logger?.info('play', `Opening stream in VLC: ${url}`);
            res.json({ success: true, message: 'Opening in VLC...' });
        } catch (err) {
            logger?.error('play', `Failed to open VLC: ${err.message}`);
            res.status(500).json({ error: err.message });
        }
    });

    app.use('/api', router);
}

// Radarr-compatible API for Overseerr integration
function setupRadarrApi() {
    const router = express.Router();
    const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

    // Log all incoming requests to this API for debugging
    router.use((req, res, next) => {
        const apiKey = req.headers['x-api-key'] || req.query.apikey;
        const queryStr = Object.keys(req.query).length > 0 ? ` - Query: ${JSON.stringify(req.query)}` : '';
        logger?.info('radarr-api', `${req.method} ${req.path}${queryStr} - API Key: ${apiKey ? 'present' : 'none'} - Body: ${JSON.stringify(req.body || {}).substring(0, 500)}`);
        next();
    });

    // API key endpoint - Overseerr uses this to validate the connection
    router.get('/api', (req, res) => {
        res.json({
            current: 'v3',
            deprecated: []
        });
    });

    // System status - Overseerr calls this to test connection
    router.get('/system/status', (req, res) => {
        res.json({
            version: '3.0.0.0',
            buildTime: new Date().toISOString(),
            isDebug: false,
            isProduction: true,
            isAdmin: true,
            isUserInteractive: false,
            startupPath: '/app',
            appData: '/config',
            osName: 'linux',
            osVersion: '5.0',
            isNetCore: true,
            isMono: false,
            isLinux: true,
            isOsx: false,
            isWindows: false,
            branch: 'master',
            authentication: 'none',
            sqliteVersion: '3.35.0',
            migrationVersion: 1,
            urlBase: '',
            runtimeVersion: '6.0.0',
            runtimeName: 'hermes'
        });
    });

    // Quality profiles
    router.get('/qualityprofile', (req, res) => {
        res.json([
            { id: 1, name: 'Any', cutoff: { id: 1, name: 'Any' }, items: [] },
            { id: 2, name: '4K', cutoff: { id: 2, name: '4K' }, items: [] },
            { id: 3, name: '1080p', cutoff: { id: 3, name: '1080p' }, items: [] },
            { id: 4, name: '720p', cutoff: { id: 4, name: '720p' }, items: [] }
        ]);
    });

    // Root folders - returns both movie and series paths for Radarr/Sonarr compatibility
    router.get('/rootfolder', (req, res) => {
        const moviePath = settings.get('movieDownloadPath') || settings.get('downloadPath') || '/downloads/movies';
        const seriesPath = settings.get('seriesDownloadPath') || settings.get('downloadPath') || '/downloads/series';
        res.json([
            {
                id: 1,
                path: moviePath,
                accessible: true,
                freeSpace: 100000000000,
                unmappedFolders: []
            },
            {
                id: 2,
                path: seriesPath,
                accessible: true,
                freeSpace: 100000000000,
                unmappedFolders: []
            }
        ]);
    });

    // Movie lookup by TMDB ID
    router.get('/movie/lookup', async (req, res) => {
        try {
            let { term, tmdbId } = req.query;

            // Overseerr sends TMDB ID in term as "tmdb:12345" format
            if (term && term.startsWith('tmdb:')) {
                tmdbId = term.replace('tmdb:', '');
                term = null;
            }

            // Also handle "imdb:tt1234567" format
            let imdbId = null;
            if (term && term.startsWith('imdb:')) {
                imdbId = term.replace('imdb:', '');
                term = null;
            }

            logger?.info('radarr-api', `Movie lookup - term: ${term}, tmdbId: ${tmdbId}, imdbId: ${imdbId}`);

            if (tmdbId) {
                // Direct TMDB lookup
                if (modules.tmdb) {
                    const tmdbData = await modules.tmdb.getMovie(tmdbId);
                    if (tmdbData) {
                        res.json([formatAsRadarrMovie(tmdbData)]);
                        return;
                    }
                }
            } else if (imdbId && modules.tmdb) {
                // IMDB lookup via TMDB
                try {
                    const findResult = await modules.tmdb.findByExternalId(imdbId, 'imdb_id');
                    if (findResult?.movie_results?.length > 0) {
                        const movie = findResult.movie_results[0];
                        const fullData = await modules.tmdb.getMovie(movie.id);
                        res.json([formatAsRadarrMovie(fullData || movie)]);
                        return;
                    }
                } catch (e) {
                    logger?.warn('radarr-api', `IMDB lookup failed: ${e.message}`);
                }
            } else if (term) {
                // Search by title
                if (modules.tmdb) {
                    const results = await modules.tmdb.searchMovie(term);
                    res.json(results.slice(0, 10).map(r => formatAsRadarrMovie(r)));
                    return;
                }
            }

            res.json([]);
        } catch (err) {
            logger?.error('radarr-api', `Lookup error: ${err.message}`);
            res.json([]);
        }
    });

    // Get all movies (Overseerr checks existing library)
    router.get('/movie', async (req, res) => {
        try {
            const tmdbId = req.query.tmdbId;
            const db = modules.db;

            if (tmdbId) {
                // Check if we have this movie
                const movie = await db.get(
                    'SELECT * FROM media WHERE tmdb_id = ? AND media_type = ?',
                    [tmdbId, 'movie']
                );

                if (movie) {
                    res.json([formatLocalMovieAsRadarr(movie)]);
                } else {
                    res.json([]);
                }
            } else {
                // Return all movies
                const movies = await db.all(
                    'SELECT * FROM media WHERE media_type = ? AND tmdb_id IS NOT NULL LIMIT 1000',
                    ['movie']
                );
                res.json(movies.map(formatLocalMovieAsRadarr));
            }
        } catch (err) {
            logger?.error('radarr-api', `Get movies error: ${err.message}`);
            res.json([]);
        }
    });

    // Add movie - this is what Overseerr calls when requesting a movie
    router.post('/movie', async (req, res) => {
        try {
            const { title, tmdbId, year, qualityProfileId, rootFolderPath } = req.body;
            const db = modules.db;

            logger?.info('radarr-api', `Received movie request: ${title} (TMDB: ${tmdbId})`);

            // Get full TMDB data
            let tmdbData = null;
            let poster = null;
            if (modules.tmdb && tmdbId) {
                try {
                    tmdbData = await modules.tmdb.getMovie(tmdbId);
                    poster = tmdbData?.poster_path;
                } catch (e) {
                    logger?.warn('radarr-api', `Failed to fetch TMDB data: ${e.message}`);
                }
            }

            // Check if movie exists in our library
            let matchedMedia = await db.get(
                'SELECT * FROM media WHERE tmdb_id = ? AND media_type = ?',
                [tmdbId, 'movie']
            );

            // If not found by TMDB ID, search by title
            if (!matchedMedia && title) {
                matchedMedia = await db.get(
                    'SELECT * FROM media WHERE title LIKE ? AND media_type = ?',
                    [`%${title}%`, 'movie']
                );
            }

            // Create request record
            const result = await db.run(`
                INSERT INTO requests (tmdb_id, media_type, title, year, poster, status, matched_media_id, source)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                tmdbId,
                'movie',
                title,
                year,
                poster,
                'pending',
                matchedMedia?.id || null,
                'overseerr'
            ]);

            logger?.info('radarr-api', `Created request ${result.lastID} for: ${title}` +
                (matchedMedia ? ` (matched to media ID ${matchedMedia.id})` : ' (no match found)'));

            // Emit event for real-time updates
            io?.emit('request:new', {
                id: result.lastID,
                title,
                tmdbId,
                matched: !!matchedMedia
            });

            // Return Radarr-formatted response
            res.json({
                id: result.lastID,
                title: title,
                tmdbId: tmdbId,
                year: year,
                monitored: true,
                hasFile: !!matchedMedia,
                added: new Date().toISOString(),
                qualityProfileId: qualityProfileId || 1,
                rootFolderPath: rootFolderPath || '/downloads/movies'
            });
        } catch (err) {
            logger?.error('radarr-api', `Add movie error: ${err.message}`);
            res.status(500).json({ error: err.message });
        }
    });

    // Get single movie by ID
    router.get('/movie/:id', async (req, res) => {
        try {
            const db = modules.db;
            const id = req.params.id;

            // Check requests table first
            const request = await db.get('SELECT * FROM requests WHERE id = ?', [id]);
            if (request) {
                res.json({
                    id: request.id,
                    title: request.title,
                    tmdbId: request.tmdb_id,
                    year: request.year,
                    monitored: true,
                    hasFile: !!request.matched_media_id,
                    status: request.status === 'approved' ? 'downloaded' : 'missing',
                    images: request.poster ? [{ coverType: 'poster', url: request.poster }] : []
                });
                return;
            }

            // Fall back to media table
            const movie = await db.get('SELECT * FROM media WHERE id = ? AND media_type = ?', [id, 'movie']);
            if (movie) {
                res.json(formatLocalMovieAsRadarr(movie));
            } else {
                res.status(404).json({ error: 'Movie not found' });
            }
        } catch (err) {
            logger?.error('radarr-api', `Get movie error: ${err.message}`);
            res.status(500).json({ error: err.message });
        }
    });

    // Update movie (Overseerr may call this)
    router.put('/movie/:id', async (req, res) => {
        try {
            // Just return what was sent - we track via requests table
            res.json({
                id: parseInt(req.params.id),
                ...req.body,
                monitored: true
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Delete movie
    router.delete('/movie/:id', async (req, res) => {
        try {
            // Just acknowledge - we don't actually delete
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Tags (Overseerr may request these)
    router.get('/tag', (req, res) => {
        res.json([]);
    });

    // ============== SONARR API ENDPOINTS FOR TV SERIES ==============

    // Language profiles (Sonarr v3)
    router.get('/languageprofile', (req, res) => {
        res.json([
            { id: 1, name: 'English', cutoff: { id: 1, name: 'English' }, languages: [{ language: { id: 1, name: 'English' } }] },
            { id: 2, name: 'Any', cutoff: { id: 2, name: 'Any' }, languages: [{ language: { id: -1, name: 'Any' } }] }
        ]);
    });

    // Series lookup by TVDB ID or search term
    router.get('/series/lookup', async (req, res) => {
        try {
            let { term, tvdbId } = req.query;

            // Overseerr sends TVDB ID in term as "tvdb:12345" format
            if (term && term.startsWith('tvdb:')) {
                tvdbId = term.replace('tvdb:', '');
                term = null;
            }

            // Also handle "imdb:tt1234567" format
            let imdbId = null;
            if (term && term.startsWith('imdb:')) {
                imdbId = term.replace('imdb:', '');
                term = null;
            }

            logger?.info('sonarr-api', `Series lookup - term: ${term}, tvdbId: ${tvdbId}, imdbId: ${imdbId}`);

            if (modules.tmdb) {
                // If we have a TVDB ID, try to find via TMDB's external ID lookup
                if (tvdbId) {
                    try {
                        const tmdbResult = await modules.tmdb.findByExternalId(tvdbId, 'tvdb_id');
                        if (tmdbResult && tmdbResult.tv_results && tmdbResult.tv_results.length > 0) {
                            const series = tmdbResult.tv_results[0];
                            // Get full details
                            const fullData = await modules.tmdb.getTv(series.id);
                            res.json([formatAsSonarrSeries(fullData || series)]);
                            return;
                        }
                    } catch (e) {
                        logger?.warn('sonarr-api', `TVDB lookup failed: ${e.message}`);
                    }
                }

                // If we have an IMDB ID, try to find via TMDB's external ID lookup
                if (imdbId) {
                    try {
                        const tmdbResult = await modules.tmdb.findByExternalId(imdbId, 'imdb_id');
                        if (tmdbResult && tmdbResult.tv_results && tmdbResult.tv_results.length > 0) {
                            const series = tmdbResult.tv_results[0];
                            const fullData = await modules.tmdb.getTv(series.id);
                            res.json([formatAsSonarrSeries(fullData || series)]);
                            return;
                        }
                    } catch (e) {
                        logger?.warn('sonarr-api', `IMDB lookup failed: ${e.message}`);
                    }
                }

                // Search by term
                if (term) {
                    const results = await modules.tmdb.searchTv(term);
                    res.json(results.slice(0, 10).map(r => formatAsSonarrSeries(r)));
                    return;
                }
            }

            res.json([]);
        } catch (err) {
            logger?.error('sonarr-api', `Series lookup error: ${err.message}`);
            res.json([]);
        }
    });

    // Get all series (Overseerr checks existing library)
    router.get('/series', async (req, res) => {
        try {
            const tvdbId = req.query.tvdbId;
            const tmdbId = req.query.tmdbId;
            const db = modules.db;

            if (tvdbId || tmdbId) {
                // Check if we have this series
                let series;
                if (tmdbId) {
                    series = await db.get(
                        'SELECT * FROM media WHERE tmdb_id = ? AND media_type = ?',
                        [tmdbId, 'series']
                    );
                }

                if (series) {
                    res.json([formatLocalSeriesAsSonarr(series)]);
                } else {
                    res.json([]);
                }
            } else {
                // Return all series
                const series = await db.all(
                    'SELECT * FROM media WHERE media_type = ? AND tmdb_id IS NOT NULL LIMIT 1000',
                    ['series']
                );
                res.json(series.map(formatLocalSeriesAsSonarr));
            }
        } catch (err) {
            logger?.error('sonarr-api', `Get series error: ${err.message}`);
            res.json([]);
        }
    });

    // Add series - this is what Overseerr calls when requesting a TV show
    router.post('/series', async (req, res) => {
        try {
            const { title, tvdbId, tmdbId, year, qualityProfileId, languageProfileId, rootFolderPath, seasons } = req.body;
            const db = modules.db;

            logger?.info('sonarr-api', `Received series request: ${title} (TMDB: ${tmdbId}, TVDB: ${tvdbId})`);

            // Get full TMDB data - try TMDB ID first, then lookup by TVDB ID
            let tmdbData = null;
            let poster = null;
            let actualTmdbId = tmdbId || req.body.tmdbId;

            if (modules.tmdb) {
                // If we have TVDB ID but no TMDB ID, look it up
                if (!actualTmdbId && tvdbId) {
                    try {
                        const findResult = await modules.tmdb.findByExternalId(tvdbId, 'tvdb_id');
                        if (findResult?.tv_results?.length > 0) {
                            actualTmdbId = findResult.tv_results[0].id;
                            logger?.info('sonarr-api', `Found TMDB ID ${actualTmdbId} for TVDB ID ${tvdbId}`);
                        }
                    } catch (e) {
                        logger?.warn('sonarr-api', `TVDB to TMDB lookup failed: ${e.message}`);
                    }
                }

                // Now get full TMDB data
                if (actualTmdbId) {
                    try {
                        tmdbData = await modules.tmdb.getTv(actualTmdbId);
                        poster = tmdbData?.poster_path;
                    } catch (e) {
                        logger?.warn('sonarr-api', `Failed to fetch TMDB data: ${e.message}`);
                    }
                }
            }

            // Check if series exists in our library - prefer grouped series with episodes
            let matchedMedia = null;
            if (actualTmdbId) {
                matchedMedia = await db.get(
                    'SELECT * FROM media WHERE tmdb_id = ? AND media_type = ?',
                    [actualTmdbId, 'series']
                );
            }

            // If not found by TMDB ID, search by title
            // Prefer grouped series (external_id starts with 'm3u_series_') that have episodes
            if (!matchedMedia && title) {
                // Clean the title for better matching
                const cleanTitle = title.replace(/\s*\(\d{4}\)\s*/g, '').trim();

                // First try to find a grouped series with episodes
                matchedMedia = await db.get(`
                    SELECT m.*, (SELECT COUNT(*) FROM episodes e WHERE e.media_id = m.id) as ep_count
                    FROM media m
                    WHERE m.media_type = 'series'
                    AND m.external_id LIKE 'm3u_series_%'
                    AND m.title LIKE ?
                    AND EXISTS (SELECT 1 FROM episodes e WHERE e.media_id = m.id)
                    ORDER BY ep_count DESC
                    LIMIT 1
                `, [`%${cleanTitle}%`]);

                // If not found, try any series with episodes
                if (!matchedMedia) {
                    matchedMedia = await db.get(`
                        SELECT m.*, (SELECT COUNT(*) FROM episodes e WHERE e.media_id = m.id) as ep_count
                        FROM media m
                        WHERE m.media_type = 'series'
                        AND m.title LIKE ?
                        AND EXISTS (SELECT 1 FROM episodes e WHERE e.media_id = m.id)
                        ORDER BY ep_count DESC
                        LIMIT 1
                    `, [`%${cleanTitle}%`]);
                }

                // Last resort: any series matching the title
                if (!matchedMedia) {
                    matchedMedia = await db.get(
                        'SELECT * FROM media WHERE title LIKE ? AND media_type = ? LIMIT 1',
                        [`%${cleanTitle}%`, 'series']
                    );
                }
            }

            // Extract requested seasons from the request
            const requestedSeasons = (seasons || [])
                .filter(s => s.monitored)
                .map(s => s.seasonNumber)
                .filter(s => s > 0); // Filter out season 0 (specials)

            logger?.info('sonarr-api', `Requested seasons: ${requestedSeasons.join(', ') || 'all'}`);

            // Create request record (store seasons as JSON)
            const result = await db.run(`
                INSERT INTO requests (tmdb_id, media_type, title, year, poster, status, matched_media_id, source, seasons_requested)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                actualTmdbId,
                'series',
                title,
                year,
                poster,
                'pending',
                matchedMedia?.id || null,
                'overseerr',
                requestedSeasons.length > 0 ? JSON.stringify(requestedSeasons) : null
            ]);

            logger?.info('sonarr-api', `Created request ${result.lastID} for: ${title}` +
                (matchedMedia ? ` (matched to media ID ${matchedMedia.id})` : ' (no match found)'));

            // Emit event for real-time updates
            io?.emit('request:new', {
                id: result.lastID,
                title,
                tmdbId: actualTmdbId,
                matched: !!matchedMedia
            });

            // Return Sonarr-formatted response
            res.json({
                id: result.lastID,
                title: title,
                tvdbId: tvdbId || 0,
                tmdbId: actualTmdbId || 0,
                year: year,
                monitored: true,
                hasFile: !!matchedMedia,
                added: new Date().toISOString(),
                qualityProfileId: qualityProfileId || 1,
                languageProfileId: languageProfileId || 1,
                rootFolderPath: rootFolderPath || '/downloads/series',
                seasons: seasons || []
            });
        } catch (err) {
            logger?.error('sonarr-api', `Add series error: ${err.message}`);
            res.status(500).json({ error: err.message });
        }
    });

    // Get single series by ID
    router.get('/series/:id', async (req, res) => {
        try {
            const db = modules.db;
            const id = req.params.id;

            // Check requests table first
            const request = await db.get('SELECT * FROM requests WHERE id = ? AND media_type = ?', [id, 'series']);
            if (request) {
                res.json({
                    id: request.id,
                    title: request.title,
                    tmdbId: request.tmdb_id,
                    tvdbId: 0,
                    year: request.year,
                    monitored: true,
                    hasFile: !!request.matched_media_id,
                    status: request.status === 'approved' ? 'continuing' : 'upcoming',
                    images: request.poster ? [{ coverType: 'poster', url: request.poster }] : [],
                    seasons: []
                });
                return;
            }

            // Fall back to media table
            const series = await db.get('SELECT * FROM media WHERE id = ? AND media_type = ?', [id, 'series']);
            if (series) {
                res.json(formatLocalSeriesAsSonarr(series));
            } else {
                res.status(404).json({ error: 'Series not found' });
            }
        } catch (err) {
            logger?.error('sonarr-api', `Get series error: ${err.message}`);
            res.status(500).json({ error: err.message });
        }
    });

    // Update series (Overseerr may call this)
    router.put('/series/:id', async (req, res) => {
        try {
            res.json({
                id: parseInt(req.params.id),
                ...req.body,
                monitored: true
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Delete series
    router.delete('/series/:id', async (req, res) => {
        try {
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Command endpoint - for triggering scans, etc.
    router.post('/command', async (req, res) => {
        try {
            const { name, movieIds, seriesId } = req.body;
            logger?.info('radarr-api', `Command received: ${name}`, { movieIds, seriesId });

            // Return success - Hermes handles downloads differently
            res.json({
                id: Date.now(),
                name: name,
                commandName: name,
                status: 'completed',
                queued: new Date().toISOString(),
                started: new Date().toISOString(),
                ended: new Date().toISOString(),
                trigger: 'manual'
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Queue endpoint
    router.get('/queue', (req, res) => {
        res.json({ records: [], page: 1, pageSize: 10, totalRecords: 0 });
    });

    // Play stream in external player (VLC)
    router.post('/play', async (req, res) => {
        try {
            const { url } = req.body;
            if (!url) {
                return res.status(400).json({ error: 'URL is required' });
            }

            // Determine VLC path based on platform
            const platform = process.platform;
            let vlcPath;
            let args;

            if (platform === 'darwin') {
                // macOS - use open command to launch VLC
                vlcPath = 'open';
                args = ['-a', 'VLC', url];
            } else if (platform === 'win32') {
                // Windows
                vlcPath = 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe';
                args = [url];
            } else {
                // Linux
                vlcPath = 'vlc';
                args = [url];
            }

            // Spawn VLC process (detached so it doesn't block)
            const vlc = spawn(vlcPath, args, {
                detached: true,
                stdio: 'ignore'
            });
            vlc.unref();

            logger?.info('play', `Opening stream in VLC: ${url}`);
            res.json({ success: true, message: 'Opening in VLC...' });
        } catch (err) {
            logger?.error('play', `Failed to open VLC: ${err.message}`);
            res.status(500).json({ error: err.message });
        }
    });

    // Helper function to format TMDB data as Sonarr series
    function formatAsSonarrSeries(tmdbData) {
        const posterUrl = tmdbData.poster_path
            ? (tmdbData.poster_path.startsWith('http') ? tmdbData.poster_path : `${TMDB_IMAGE_BASE}/w500${tmdbData.poster_path}`)
            : null;
        const fanartUrl = tmdbData.backdrop_path
            ? (tmdbData.backdrop_path.startsWith('http') ? tmdbData.backdrop_path : `${TMDB_IMAGE_BASE}/w1280${tmdbData.backdrop_path}`)
            : null;

        return {
            id: 0,
            title: tmdbData.name || tmdbData.title,
            sortTitle: (tmdbData.name || tmdbData.title)?.toLowerCase() || '',
            tvdbId: tmdbData.external_ids?.tvdb_id || 0,
            tmdbId: tmdbData.id,
            imdbId: tmdbData.external_ids?.imdb_id || tmdbData.imdb_id || '',
            overview: tmdbData.overview || '',
            year: tmdbData.first_air_date ? parseInt(tmdbData.first_air_date.substring(0, 4)) : (tmdbData.year || 0),
            seasonCount: tmdbData.number_of_seasons || 0,
            images: [
                ...(posterUrl ? [{ coverType: 'poster', url: posterUrl }] : []),
                ...(fanartUrl ? [{ coverType: 'fanart', url: fanartUrl }] : [])
            ],
            seasons: (tmdbData.seasons || []).map(s => ({
                seasonNumber: s.season_number,
                monitored: true
            })),
            monitored: false,
            hasFile: false,
            status: tmdbData.status === 'Ended' ? 'ended' : 'continuing',
            ratings: { value: tmdbData.vote_average || 0 },
            genres: tmdbData.genres ? (Array.isArray(tmdbData.genres) ? tmdbData.genres : tmdbData.genres.split(', ').map(g => ({ name: g }))) : [],
            network: tmdbData.networks?.[0]?.name || ''
        };
    }

    // Helper function to format local series as Sonarr format
    function formatLocalSeriesAsSonarr(series) {
        return {
            id: series.id,
            title: series.title,
            sortTitle: series.title?.toLowerCase() || '',
            tvdbId: 0,
            tmdbId: series.tmdb_id,
            overview: series.plot || '',
            year: series.year || 0,
            images: series.poster ? [
                { coverType: 'poster', url: series.poster }
            ] : [],
            monitored: true,
            hasFile: true,
            status: 'continuing',
            ratings: { value: series.rating || 0 },
            path: series.stream_url || ''
        };
    }

    // Helper function to format TMDB data as Radarr movie
    function formatAsRadarrMovie(tmdbData) {
        return {
            id: 0,
            title: tmdbData.title,
            sortTitle: tmdbData.title?.toLowerCase() || '',
            tmdbId: tmdbData.id,
            imdbId: tmdbData.imdb_id || '',
            overview: tmdbData.overview || '',
            year: tmdbData.year || parseInt(tmdbData.release_date?.substring(0, 4)) || 0,
            images: tmdbData.poster_path ? [
                {
                    coverType: 'poster',
                    url: tmdbData.poster_path.startsWith('http')
                        ? tmdbData.poster_path
                        : `${TMDB_IMAGE_BASE}/w500${tmdbData.poster_path}`
                }
            ] : [],
            monitored: false,
            hasFile: false,
            isAvailable: true,
            status: 'released',
            ratings: { value: tmdbData.vote_average || 0 }
        };
    }

    // Helper function to format local movie as Radarr format
    function formatLocalMovieAsRadarr(movie) {
        return {
            id: movie.id,
            title: movie.title,
            sortTitle: movie.title?.toLowerCase() || '',
            tmdbId: movie.tmdb_id,
            imdbId: movie.imdb_id || '',
            overview: movie.plot || '',
            year: movie.year || 0,
            images: movie.poster ? [
                { coverType: 'poster', url: movie.poster }
            ] : [],
            monitored: true,
            hasFile: true,
            isAvailable: true,
            status: 'released',
            ratings: { value: movie.rating || 0 },
            path: movie.stream_url || ''
        };
    }

    app.use('/api/v3', router);

    logger?.info('app', 'Radarr/Sonarr-compatible API enabled at /api/v3');
}

function setupSocket() {
    io.on('connection', (socket) => {
        logger?.debug('app', `Client connected: ${socket.id}`);

        socket.on('disconnect', () => {
            logger?.debug('app', `Client disconnected: ${socket.id}`);
        });
    });

    // Make io available to other modules
    if (modules.logger) {
        modules.logger.setIO(io);
    }
}

module.exports = {
    init: async (mods) => {
        modules = mods;
        logger = mods.logger;
        settings = mods.settings;

        app = express();
        app.set('view engine', 'ejs');
        app.set('views', PATHS.views);

        server = createServer(app);
        io = new Server(server);

        setupRoutes();
        setupSocket();

        const port = settings.get('port');
        return new Promise((resolve) => {
            server.listen(port, '0.0.0.0', () => {
                logger.info('app', `Server running on http://0.0.0.0:${port}`);
                resolve();
            });
        });
    },

    shutdown: async () => {
        return new Promise((resolve) => {
            // Close Socket.IO connections first
            if (io) {
                io.close();
            }
            if (server) {
                server.close(() => {
                    logger?.info('app', 'Server closed');
                    resolve();
                });
                // Force resolve after 2 seconds if server doesn't close
                setTimeout(() => {
                    logger?.warn('app', 'Server close timeout, forcing shutdown');
                    resolve();
                }, 2000);
            } else {
                resolve();
            }
        });
    },

    io: () => io,
    emit: (event, data) => io?.emit(event, data)
};
