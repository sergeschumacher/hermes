const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');

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

    // API Routes
    setupApiRoutes();

    // Radarr-compatible API for Overseerr integration
    setupRadarrApi();
}

function setupApiRoutes() {
    const router = express.Router();

    // Stats
    router.get('/stats', async (req, res) => {
        try {
            const db = modules.db;
            const stats = {
                totalMovies: (await db.get('SELECT COUNT(*) as c FROM media WHERE media_type = ?', ['movie']))?.c || 0,
                totalSeries: (await db.get('SELECT COUNT(*) as c FROM media WHERE media_type = ?', ['series']))?.c || 0,
                totalLiveTV: (await db.get('SELECT COUNT(*) as c FROM media WHERE media_type = ?', ['live']))?.c || 0,
                totalDownloads: (await db.get('SELECT COUNT(*) as c FROM downloads WHERE status = ?', ['completed']))?.c || 0,
                activeDownloads: (await db.get('SELECT COUNT(*) as c FROM downloads WHERE status IN (?, ?)', ['queued', 'downloading']))?.c || 0,
                totalSources: (await db.get('SELECT COUNT(*) as c FROM sources'))?.c || 0
            };
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
            const languages = Array.from(langSet).sort((a, b) => {
                if (a === 'EN') return -1;
                if (b === 'EN') return 1;
                return a.localeCompare(b);
            });

            res.json({ years, languages });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Media endpoints
    router.get('/media', async (req, res) => {
        try {
            const { type, search, year, quality, language, genre, category, sort, order, limit, offset, dedupe } = req.query;

            // For movies, deduplicate by title (keeping best version with TMDB poster)
            const shouldDedupe = dedupe !== 'false' && (type === 'movie');

            let sql;
            if (shouldDedupe) {
                // Use subquery to get one entry per title, preferring items with TMDB posters
                sql = `SELECT * FROM (
                    SELECT *,
                           ROW_NUMBER() OVER (PARTITION BY title ORDER BY
                               CASE WHEN poster LIKE '%image.tmdb.org%' THEN 0 ELSE 1 END,
                               CASE WHEN tmdb_id IS NOT NULL THEN 0 ELSE 1 END,
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
            res.json(media);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/media/:id', async (req, res) => {
        try {
            const media = await modules.db.get('SELECT * FROM media WHERE id = ?', [req.params.id]);
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
            const { name, type, url, username, password, user_agent, spoofed_mac, spoofed_device_key, simulate_playback, playback_speed_multiplier } = req.body;
            const result = await modules.db.run(
                'INSERT INTO sources (name, type, url, username, password, user_agent, spoofed_mac, spoofed_device_key, simulate_playback, playback_speed_multiplier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [name, type || 'xtream', url, username, password, user_agent || 'IBOPlayer', spoofed_mac || null, spoofed_device_key || null, simulate_playback !== undefined ? simulate_playback : 1, playback_speed_multiplier !== undefined ? playback_speed_multiplier : 1.5]
            );
            res.json({ id: result.lastID, message: 'Source added' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.put('/sources/:id', async (req, res) => {
        try {
            const { name, type, url, username, password, user_agent, active, spoofed_mac, spoofed_device_key, simulate_playback, playback_speed_multiplier } = req.body;
            await modules.db.run(
                'UPDATE sources SET name=?, type=?, url=?, username=?, password=?, user_agent=?, active=?, spoofed_mac=?, spoofed_device_key=?, simulate_playback=?, playback_speed_multiplier=? WHERE id=?',
                [name, type, url, username, password, user_agent, active !== false ? 1 : 0, spoofed_mac || null, spoofed_device_key || null, simulate_playback !== undefined ? simulate_playback : 1, playback_speed_multiplier !== undefined ? playback_speed_multiplier : 1.5, req.params.id]
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

    // Downloads endpoints
    router.get('/downloads', async (req, res) => {
        try {
            const downloads = await modules.db.all(`
                SELECT d.*, m.title, m.poster, m.media_type, e.title as episode_title,
                       e.season as ep_season, e.episode as ep_episode
                FROM downloads d
                LEFT JOIN media m ON d.media_id = m.id
                LEFT JOIN episodes e ON d.episode_id = e.id
                ORDER BY
                    CASE d.status
                        WHEN 'downloading' THEN 1
                        WHEN 'queued' THEN 2
                        WHEN 'completed' THEN 3
                        WHEN 'failed' THEN 4
                        WHEN 'cancelled' THEN 5
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
            const { media_id, episode_id, priority } = req.body;
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
            const years = await modules.db.all('SELECT DISTINCT year FROM media WHERE year IS NOT NULL ORDER BY year DESC');
            const qualities = await modules.db.all('SELECT DISTINCT quality FROM media WHERE quality IS NOT NULL');
            const languages = await modules.db.all('SELECT DISTINCT language FROM media WHERE language IS NOT NULL');
            const categories = await modules.db.all('SELECT DISTINCT category FROM media WHERE category IS NOT NULL ORDER BY category');

            res.json({
                years: years.map(y => y.year),
                qualities: qualities.map(q => q.quality),
                languages: languages.map(l => l.language),
                categories: categories.map(c => c.category)
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
    router.post('/enrich', async (req, res) => {
        try {
            const { type, limit } = req.body;
            if (modules.tmdb) {
                // Run in background
                modules.tmdb.batchEnrichPosters(type || null, limit || 500).catch(err => {
                    logger.error('api', `Enrichment failed: ${err.message}`);
                });
                res.json({ message: 'Enrichment started' });
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
                needsEnrichment: (await db.get(`
                    SELECT COUNT(*) as c FROM media
                    WHERE poster IS NULL OR poster LIKE '%wikipedia%' OR poster LIKE '%stalker_portal%' OR poster LIKE '%icon-tmdb%'
                `))?.c || 0,
                enriched: (await db.get(`
                    SELECT COUNT(*) as c FROM media WHERE poster LIKE '%image.tmdb.org%'
                `))?.c || 0
            };
            res.json(stats);
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
            const { search, quality, year, language, sort, order, limit, offset } = req.query;
            const db = modules.db;

            let sql = `
                SELECT
                    show_name,
                    COUNT(*) as episode_count,
                    COUNT(DISTINCT season_number) as season_count,
                    GROUP_CONCAT(DISTINCT show_language) as languages,
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
                sql += ' AND show_language = ?';
                params.push(language);
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

            // Get all episodes for this show
            const episodes = await db.all(`
                SELECT *
                FROM media
                WHERE media_type = 'series'
                  AND show_name = ?
                ORDER BY show_language, season_number, episode_number
            `, [showName]);

            if (episodes.length === 0) {
                return res.status(404).json({ error: 'Show not found' });
            }

            // Group by language
            const languageGroups = {};
            let poster = null;
            let backdrop = null;
            let rating = null;
            let year = null;
            let plot = null;
            let genres = null;
            let tmdbId = null;

            for (const ep of episodes) {
                const lang = ep.show_language || 'Unknown';
                if (!languageGroups[lang]) {
                    languageGroups[lang] = { seasons: {} };
                }

                const season = ep.season_number || 0;
                if (!languageGroups[lang].seasons[season]) {
                    languageGroups[lang].seasons[season] = [];
                }

                languageGroups[lang].seasons[season].push(ep);

                // Get best poster (prefer TMDB)
                if (ep.poster && ep.poster.includes('image.tmdb.org')) {
                    poster = ep.poster;
                } else if (!poster && ep.poster) {
                    poster = ep.poster;
                }
                if (ep.backdrop && ep.backdrop.includes('image.tmdb.org')) backdrop = ep.backdrop;
                if (ep.rating && (!rating || ep.rating > rating)) rating = ep.rating;
                if (ep.year && (!year || ep.year < year)) year = ep.year;
                if (ep.plot && !plot) plot = ep.plot;
                if (ep.genres && !genres) genres = ep.genres;
                if (ep.tmdb_id && !tmdbId) tmdbId = ep.tmdb_id;
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
                languages: Object.keys(languageGroups).sort(),
                totalEpisodes: episodes.length,
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

    // Root folders
    router.get('/rootfolder', (req, res) => {
        const downloadPath = settings.get('downloadPath') || '/downloads';
        res.json([
            {
                id: 1,
                path: path.join(downloadPath, 'movies'),
                accessible: true,
                freeSpace: 100000000000,
                unmappedFolders: []
            }
        ]);
    });

    // Movie lookup by TMDB ID
    router.get('/movie/lookup', async (req, res) => {
        try {
            const { term, tmdbId } = req.query;

            if (tmdbId) {
                // Direct TMDB lookup
                if (modules.tmdb) {
                    const tmdbData = await modules.tmdb.getMovie(tmdbId);
                    if (tmdbData) {
                        res.json([formatAsRadarrMovie(tmdbData)]);
                        return;
                    }
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
            if (server) {
                server.close(() => {
                    logger?.info('app', 'Server closed');
                    resolve();
                });
            } else {
                resolve();
            }
        });
    },

    io: () => io,
    emit: (event, data) => io?.emit(event, data)
};
