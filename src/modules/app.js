const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');

let app = null;
let server = null;
let io = null;
let logger = null;
let settings = null;
let modules = null;
let activeStreamSessions = new Map(); // sessionId -> { title, startedAt }
const STREAM_SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes - sessions older than this are auto-cleaned
let streamSessionCleanupInterval = null;

// Image cache directory
const IMAGE_CACHE_DIR = path.join(PATHS.data, 'cache', 'images');
const SESSION_COOKIE = 'recostream_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const SESSION_GRACE_MS = 1000 * 60 * 5;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const MFA_ENABLED_ENV = process.env.MFA_ENABLED;
const WEBHOOK_URLS_ENV = process.env.WEBHOOK_URLS || process.env.WEBHOOK_URL || '';
const WEBHOOK_TIMEOUT_MS = parseInt(process.env.WEBHOOK_TIMEOUT_MS || '5000', 10);

let userCountCache = { count: null, loadedAt: 0 };
let adminSeedAttempted = false;

function isMfaEnabled() {
    if (MFA_ENABLED_ENV === undefined || MFA_ENABLED_ENV === null || MFA_ENABLED_ENV === '') return true;
    const normalized = String(MFA_ENABLED_ENV).trim().toLowerCase();
    return !['0', 'false', 'off', 'no'].includes(normalized);
}

function getWebhookUrls() {
    const urls = new Set();
    if (WEBHOOK_URLS_ENV) {
        WEBHOOK_URLS_ENV.split(',').map((url) => url.trim()).filter(Boolean).forEach((url) => {
            urls.add(url);
        });
    }
    const settingsUrl = settings?.get?.('webhookUrl');
    if (settingsUrl) {
        String(settingsUrl).split(',').map((url) => url.trim()).filter(Boolean).forEach((url) => {
            urls.add(url);
        });
    }
    return Array.from(urls);
}

async function sendWebhook(event, payload) {
    const urls = getWebhookUrls();
    if (!urls.length) {
        logger?.info('webhook', `No webhook URLs configured for event ${event}`);
        return;
    }

    const body = {
        event,
        timestamp: new Date().toISOString(),
        ...payload
    };

    await Promise.all(urls.map(async (url) => {
        try {
            logger?.info('webhook', `Sending ${event} to ${url}`);
            const response = await axios.post(url, body, {
                timeout: WEBHOOK_TIMEOUT_MS,
                headers: { 'User-Agent': 'RecoStream/1.0' }
            });
            logger?.info('webhook', `Webhook ${event} delivered to ${url} (${response.status})`);
        } catch (err) {
            const status = err.response?.status;
            logger?.warn('webhook', `Failed to send ${event} webhook to ${url}${status ? ` (${status})` : ''}: ${err.message}`);
        }
    }));
}

function getActiveStreamCount() {
    return activeStreamSessions.size;
}

function isStreamActive() {
    return getActiveStreamCount() > 0;
}

function getActivePreviewTitle() {
    if (activeStreamSessions.size === 0) return null;
    const sessions = Array.from(activeStreamSessions.values());
    sessions.sort((a, b) => b.startedAt - a.startedAt);
    return sessions[0]?.title || 'another stream';
}

function cleanupStaleSessions() {
    const now = Date.now();
    let cleaned = 0;
    const wasActive = isStreamActive();

    for (const [sessionId, session] of activeStreamSessions.entries()) {
        if (now - session.startedAt > STREAM_SESSION_TIMEOUT_MS) {
            activeStreamSessions.delete(sessionId);
            logger?.info('stream', `Cleaned up stale session: ${sessionId} - "${session.title}" (was ${Math.round((now - session.startedAt) / 60000)} minutes old)`);
            cleaned++;
        }
    }

    if (cleaned > 0) {
        logger?.info('stream', `Cleaned up ${cleaned} stale stream session(s), active: ${getActiveStreamCount()}`);
        // Emit stream:inactive if we went from active to inactive
        if (wasActive && !isStreamActive()) {
            app?.emit('stream:inactive', { active: 0, reason: 'session_cleanup' });
        }
    }
}

function getTelegramConfig() {
    return {
        enabled: settings?.get?.('telegramEnabled') === true,
        botToken: settings?.get?.('telegramBotToken') || '',
        chatId: settings?.get?.('telegramChatId') || ''
    };
}

function formatTelegramMessage(event, payload) {
    if (event === 'download_complete') {
        if (payload.media_type === 'series') {
            const seriesName = payload.series_name || payload.title || 'Unknown';
            const season = String(payload.season ?? '').padStart(2, '0');
            const episode = String(payload.episode ?? '').padStart(2, '0');
            const episodeTitle = payload.title ? ` - ${payload.title}` : '';
            return `Download complete: ${seriesName} S${season}E${episode}${episodeTitle}`;
        }
        return `Download complete: ${payload.title || 'Unknown'}`;
    }
    if (event === 'recording_finished') {
        return `Recording finished: ${payload.title || 'Unknown'}`;
    }
    return null;
}

async function sendTelegramMessage(text) {
    const { enabled, botToken, chatId } = getTelegramConfig();
    if (!enabled || !botToken || !chatId) return false;

    try {
        logger?.info('telegram', 'Sending test notification');
        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            chat_id: chatId,
            text
        }, { timeout: 10000 });
        logger?.info('telegram', 'Telegram notification delivered');
        return true;
    } catch (err) {
        const status = err.response?.status;
        logger?.warn('telegram', `Failed to send Telegram notification${status ? ` (${status})` : ''}: ${err.message}`);
        return false;
    }
}

async function sendTelegramNotification(event, payload) {
    const { enabled, botToken, chatId } = getTelegramConfig();
    if (!enabled || !botToken || !chatId) return;

    const message = formatTelegramMessage(event, payload);
    if (!message) return;

    try {
        logger?.info('telegram', `Sending ${event} notification`);
        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            chat_id: chatId,
            text: message
        }, { timeout: 10000 });
        logger?.info('telegram', `Telegram notification delivered (${event})`);
    } catch (err) {
        const status = err.response?.status;
        logger?.warn('telegram', `Failed to send Telegram notification${status ? ` (${status})` : ''}: ${err.message}`);
    }
}

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

function parseCookies(cookieHeader) {
    if (!cookieHeader) return {};
    return cookieHeader.split(';').reduce((acc, part) => {
        const [key, ...valParts] = part.trim().split('=');
        if (!key) return acc;
        acc[key] = decodeURIComponent(valParts.join('='));
        return acc;
    }, {});
}

function getCookieValue(req, name) {
    const cookies = parseCookies(req.headers.cookie || '');
    return cookies[name];
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function normalizeTotpToken(token) {
    return String(token || '').replace(/[^0-9]/g, '');
}

async function getUserCount() {
    const now = Date.now();
    if (userCountCache.count !== null && now - userCountCache.loadedAt < 3000) {
        return userCountCache.count;
    }
    const row = await modules.db.get('SELECT COUNT(*) as count FROM users');
    userCountCache = { count: row?.count || 0, loadedAt: now };
    return userCountCache.count;
}

async function ensureAdminUser() {
    if (adminSeedAttempted) return;
    adminSeedAttempted = true;

    if (!ADMIN_USERNAME || !ADMIN_PASSWORD) return;

    const existingCount = await getUserCount();
    if (existingCount > 0) return;

    const existingUser = await modules.db.get('SELECT id FROM users WHERE username = ?', [ADMIN_USERNAME]);
    if (existingUser) return;

    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    await modules.db.run(
        'INSERT INTO users (username, password_hash) VALUES (?, ?)',
        [ADMIN_USERNAME, passwordHash]
    );

    userCountCache = { count: null, loadedAt: 0 };
    logger?.info('auth', `Seeded admin user: ${ADMIN_USERNAME}`);
}

async function getSessionUserByToken(token) {
    if (!token) return null;
    const tokenHash = hashToken(token);
    const session = await modules.db.get(`
        SELECT s.id as session_id, s.expires_at as expires_at, s.last_used_at as last_used_at,
               u.id as user_id, u.username as username, u.totp_enabled as totp_enabled
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?
    `, [tokenHash]);

    if (!session) return null;

    const expiresAt = new Date(session.expires_at).getTime();
    if (Number.isNaN(expiresAt) || expiresAt <= Date.now() - SESSION_GRACE_MS) {
        await modules.db.run('DELETE FROM sessions WHERE id = ?', [session.session_id]);
        return null;
    }

    const lastUsedAt = new Date(session.last_used_at).getTime();
    if (Number.isNaN(lastUsedAt) || lastUsedAt <= Date.now() - 1000 * 60 * 5) {
        await modules.db.run('UPDATE sessions SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?', [session.session_id]);
    }
    return session;
}

function buildSessionCookie(token, req, maxAgeSeconds) {
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const parts = [
        `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax'
    ];
    if (secure) parts.push('Secure');
    if (typeof maxAgeSeconds === 'number') parts.push(`Max-Age=${maxAgeSeconds}`);
    return parts.join('; ');
}

async function createSession(res, req, userId) {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

    await modules.db.run(`
        INSERT INTO sessions (user_id, token_hash, expires_at)
        VALUES (?, ?, ?)
    `, [userId, tokenHash, expiresAt]);

    res.setHeader('Set-Cookie', buildSessionCookie(token, req, Math.floor(SESSION_TTL_MS / 1000)));
    return token;
}

async function clearSession(req, res) {
    const token = getCookieValue(req, SESSION_COOKIE);
    if (token) {
        const tokenHash = hashToken(token);
        await modules.db.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
    }
    res.setHeader('Set-Cookie', buildSessionCookie('', req, 0));
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
    app.use(express.json({ limit: '5mb' }));
    app.use(express.urlencoded({ extended: true, limit: '5mb' }));

    // Auth middleware
    app.use(async (req, res, next) => {
        try {
            const path = req.path;
            if (path.startsWith('/static') ||
                path.startsWith('/cache/images') ||
                path.startsWith('/img') ||
                path.startsWith('/socket.io')) {
                return next();
            }

            const usersCount = await getUserCount();

            if (usersCount === 0) {
                if (path.startsWith('/setup') || path.startsWith('/api/auth/setup')) {
                    return next();
                }
                return res.redirect('/setup');
            }

            if (path.startsWith('/setup') || path.startsWith('/api/auth/setup')) {
                return res.redirect('/login');
            }

            if (path.startsWith('/login') || path.startsWith('/api/auth/login')) {
                const existing = await getSessionUserByToken(getCookieValue(req, SESSION_COOKIE));
                if (existing) return res.redirect('/');
                return next();
            }

            if (path.startsWith('/logout')) {
                return next();
            }

            const session = await getSessionUserByToken(getCookieValue(req, SESSION_COOKIE));
            if (!session) {
                if (path.startsWith('/api')) {
                    return res.status(401).json({ error: 'Unauthorized' });
                }
                return res.redirect('/login');
            }

            req.user = session;
            res.locals.user = session;
            return next();
        } catch (err) {
            logger?.error('auth', `Auth middleware failed: ${err.message}`);
            if (req.path.startsWith('/api')) {
                return res.status(500).json({ error: 'Auth error' });
            }
            return res.status(500).send('Auth error');
        }
    });

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

            // Check if already cached (and not empty)
            if (fs.existsSync(cachePath)) {
                const stats = fs.statSync(cachePath);
                if (stats.size > 0) {
                    // Serve from cache with long expiry
                    res.set('Cache-Control', 'public, max-age=2592000, immutable');
                    res.set('X-Cache', 'HIT');
                    return res.sendFile(cachePath);
                } else {
                    // Delete empty cache file
                    fs.unlinkSync(cachePath);
                }
            }

            // Download and cache the image
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; RecoStream/1.0)'
                }
            });

            // Determine content type
            const contentType = response.headers['content-type'] || 'image/jpeg';

            // Only cache if we got data
            if (response.data && response.data.length > 0) {
                fs.writeFileSync(cachePath, response.data);
            }

            // Serve the image
            res.set('Content-Type', contentType);
            res.set('Cache-Control', 'public, max-age=2592000, immutable');
            res.set('X-Cache', 'MISS');
            res.send(response.data);

        } catch (err) {
            logger?.warn('app', `Image proxy error for ${url}: ${err.message}`);
            // Return placeholder image instead of redirecting (prevents flickering from failed loads)
            const placeholderPath = path.join(__dirname, '../../web/static/images/no-poster.svg');
            if (fs.existsSync(placeholderPath)) {
                // File is SVG despite .png extension, so set correct content type
                res.set('Content-Type', 'image/svg+xml');
                res.set('Cache-Control', 'public, max-age=300'); // Cache for 5 min to reduce retry spam
                return res.sendFile(placeholderPath);
            }
            res.status(404).send('Image not found');
        }
    });

    // Logo endpoint - serves and caches channel logos persistently
    // Unlike /img proxy, logos are cached by media ID and persist across EPG refreshes
    const LOGO_CACHE_DIR = path.join(PATHS.data, 'cache', 'logos');

    function ensureLogoCacheDir() {
        if (!fs.existsSync(LOGO_CACHE_DIR)) {
            fs.mkdirSync(LOGO_CACHE_DIR, { recursive: true });
        }
    }

    app.get('/logo/:mediaId', async (req, res) => {
        const mediaId = parseInt(req.params.mediaId);
        if (!mediaId || isNaN(mediaId)) {
            return res.status(400).send('Invalid media ID');
        }

        let media = null;

        // Helper to try downloading and caching a logo from a URL
        async function tryDownloadLogo(url, source) {
            try {
                const response = await axios.get(url, {
                    responseType: 'arraybuffer',
                    timeout: 5000,
                    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RecoStream/1.0)' }
                });

                if (response.data && response.data.length > 0) {
                    const contentType = response.headers['content-type'] || 'image/png';
                    let ext = '.png';
                    if (contentType.includes('jpeg') || contentType.includes('jpg')) ext = '.jpg';
                    else if (contentType.includes('svg')) ext = '.svg';
                    else if (contentType.includes('webp')) ext = '.webp';
                    else if (contentType.includes('gif')) ext = '.gif';

                    const filename = `${mediaId}${ext}`;
                    const cachePath = path.join(LOGO_CACHE_DIR, filename);

                    fs.writeFileSync(cachePath, response.data);
                    await modules.db.run('UPDATE media SET cached_logo = ? WHERE id = ?', [filename, mediaId]);
                    logger?.debug('app', `Cached logo for media ${mediaId} from ${source}: ${filename}`);

                    return { data: response.data, contentType, filename };
                }
            } catch (err) {
                logger?.debug('app', `Logo download failed from ${source} for media ${mediaId}: ${err.message}`);
            }
            return null;
        }

        // Helper to serve placeholder
        function servePlaceholder() {
            const placeholderPath = path.join(__dirname, '../../web/static/img/no-logo.svg');
            if (fs.existsSync(placeholderPath)) {
                res.set('Content-Type', 'image/svg+xml');
                res.set('Cache-Control', 'public, max-age=300');
                return res.sendFile(placeholderPath);
            }
            res.status(404).send('No logo available');
        }

        try {
            // Get media record with all logo sources
            media = await modules.db.get('SELECT id, poster, cached_logo, epg_icon FROM media WHERE id = ?', [mediaId]);
            if (!media) {
                return res.status(404).send('Media not found');
            }

            ensureLogoCacheDir();

            // 1. CACHED LOGO - Check if we have a cached logo file
            if (media.cached_logo) {
                const cachedPath = path.join(LOGO_CACHE_DIR, media.cached_logo);
                if (fs.existsSync(cachedPath)) {
                    const stats = fs.statSync(cachedPath);
                    if (stats.size > 0) {
                        res.set('Cache-Control', 'public, max-age=2592000, immutable');
                        res.set('X-Cache', 'HIT');
                        return res.sendFile(cachedPath);
                    }
                }
            }

            // 2. EPG ICON - Try EPG icon URL first (often more reliable)
            if (media.epg_icon) {
                const result = await tryDownloadLogo(media.epg_icon, 'epg_icon');
                if (result) {
                    res.set('Content-Type', result.contentType);
                    res.set('Cache-Control', 'public, max-age=2592000, immutable');
                    res.set('X-Cache', 'MISS-EPG');
                    return res.send(result.data);
                }
            }

            // 3. POSTER URL - Try M3U poster/stream_icon URL
            if (media.poster) {
                const result = await tryDownloadLogo(media.poster, 'poster');
                if (result) {
                    res.set('Content-Type', result.contentType);
                    res.set('Cache-Control', 'public, max-age=2592000, immutable');
                    res.set('X-Cache', 'MISS-POSTER');
                    return res.send(result.data);
                }
            }

            // 4. FALLBACK - No logo sources available or all failed
            return servePlaceholder();

        } catch (err) {
            logger?.warn('app', `Logo fetch error for media ${mediaId}: ${err.message}`);

            // If we have a cached logo (even if outdated), serve it
            if (media?.cached_logo) {
                const cachedPath = path.join(LOGO_CACHE_DIR, media.cached_logo);
                if (fs.existsSync(cachedPath)) {
                    res.set('Cache-Control', 'public, max-age=300');
                    res.set('X-Cache', 'STALE');
                    return res.sendFile(cachedPath);
                }
            }

            // Return placeholder
            return servePlaceholder();
        }
    });

    function renderLogin(res, data = {}) {
        res.render('login', {
            error: data.error || null,
            mfaRequired: !!data.mfaRequired,
            username: data.username || ''
        });
    }

    function renderSetup(res, data = {}) {
        res.render('setup', {
            error: data.error || null,
            username: data.username || ''
        });
    }

    async function handleLogin(req, res) {
        const wantsJson = (req.headers.accept || '').includes('application/json') || req.is('application/json');
        const username = (req.body.username || '').trim();
        const password = req.body.password || '';
        const token = normalizeTotpToken(req.body.token);

        if (!username || !password) {
            if (wantsJson) return res.status(400).json({ error: 'Username and password are required' });
            return renderLogin(res, { error: 'Username and password are required', username });
        }

        const user = await modules.db.get('SELECT * FROM users WHERE username = ?', [username]);
        if (!user) {
            if (wantsJson) return res.status(401).json({ error: 'Invalid credentials' });
            return renderLogin(res, { error: 'Invalid credentials', username });
        }

        const passwordOk = await bcrypt.compare(password, user.password_hash);
        if (!passwordOk) {
            if (wantsJson) return res.status(401).json({ error: 'Invalid credentials' });
            return renderLogin(res, { error: 'Invalid credentials', username });
        }

        if (isMfaEnabled() && user.totp_enabled) {
            if (!token) {
                if (wantsJson) return res.status(401).json({ error: 'MFA required', mfaRequired: true });
                return renderLogin(res, { error: 'MFA code required', username, mfaRequired: true });
            }
            const verified = speakeasy.totp.verify({
                secret: user.totp_secret,
                encoding: 'base32',
                token,
                window: 2
            });
            if (!verified) {
                if (wantsJson) return res.status(401).json({ error: 'Invalid MFA code', mfaRequired: true });
                return renderLogin(res, { error: 'Invalid MFA code', username, mfaRequired: true });
            }
        }

        await createSession(res, req, user.id);
        if (wantsJson) return res.json({ success: true });
        return res.redirect('/');
    }

    async function handleSetup(req, res) {
        const wantsJson = (req.headers.accept || '').includes('application/json') || req.is('application/json');
        const usersCount = await getUserCount();
        if (usersCount > 0) {
            if (wantsJson) return res.status(400).json({ error: 'Setup already completed' });
            return res.redirect('/login');
        }

        const username = (req.body.username || '').trim();
        const password = req.body.password || '';
        const confirm = req.body.passwordConfirm || req.body.password || '';

        if (!username || !password) {
            if (wantsJson) return res.status(400).json({ error: 'Username and password are required' });
            return renderSetup(res, { error: 'Username and password are required', username });
        }

        if (password !== confirm) {
            if (wantsJson) return res.status(400).json({ error: 'Passwords do not match' });
            return renderSetup(res, { error: 'Passwords do not match', username });
        }

        const existing = await modules.db.get('SELECT id FROM users WHERE username = ?', [username]);
        if (existing) {
            if (wantsJson) return res.status(400).json({ error: 'Username already exists' });
            return renderSetup(res, { error: 'Username already exists', username });
        }

        const passwordHash = await bcrypt.hash(password, 12);
        await modules.db.run(
            'INSERT INTO users (username, password_hash) VALUES (?, ?)',
            [username, passwordHash]
        );

        userCountCache = { count: null, loadedAt: 0 };
        if (wantsJson) return res.json({ success: true });
        return res.redirect('/login');
    }

    app.get('/login', (req, res) => renderLogin(res));
    app.post('/login', (req, res) => handleLogin(req, res));
    app.post('/api/auth/login', (req, res) => handleLogin(req, res));

    app.get('/setup', (req, res) => renderSetup(res));
    app.post('/setup', (req, res) => handleSetup(req, res));
    app.post('/api/auth/setup', (req, res) => handleSetup(req, res));

    app.post('/logout', async (req, res) => {
        await clearSession(req, res);
        res.redirect('/login');
    });
    app.get('/logout', async (req, res) => {
        await clearSession(req, res);
        res.redirect('/login');
    });

    app.get('/api/auth/status', async (req, res) => {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
        res.json({
            user: {
                username: req.user.username,
                totpEnabled: isMfaEnabled() && !!req.user.totp_enabled
            },
            mfaEnabled: isMfaEnabled()
        });
    });

    app.post('/api/webhook/test', async (req, res) => {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
        const event = (req.body.event || 'test').trim();
        const payload = req.body.payload && typeof req.body.payload === 'object' ? req.body.payload : {};
        await sendWebhook(event, { test: true, ...payload });
        res.json({ success: true });
    });

    app.post('/api/stream/session', async (req, res) => {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
        const action = (req.body.action || '').trim().toLowerCase();
        const sessionId = (req.body.sessionId || '').trim();
        const title = (req.body.title || '').trim();
        if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

        if (action === 'start') {
            const wasActive = isStreamActive();
            activeStreamSessions.set(sessionId, { title: title || 'Preview', startedAt: Date.now() });
            logger?.info('stream', `Session started: ${sessionId} - "${title || 'Preview'}" (active: ${getActiveStreamCount()})`);
            if (!wasActive && isStreamActive()) {
                app?.emit('stream:active', { active: getActiveStreamCount(), sessionId, title: title || 'Preview' });
            }
            return res.json({ success: true, active: getActiveStreamCount() });
        }
        if (action === 'stop') {
            const wasActive = isStreamActive();
            activeStreamSessions.delete(sessionId);
            logger?.info('stream', `Session ended: ${sessionId} (active: ${getActiveStreamCount()})`);
            if (wasActive && !isStreamActive()) {
                app?.emit('stream:inactive', { active: getActiveStreamCount(), sessionId });
            }
            return res.json({ success: true, active: getActiveStreamCount() });
        }
        return res.status(400).json({ error: 'Invalid action' });
    });

    // Clear all stream sessions (useful if sessions get stuck)
    app.post('/api/stream/sessions/clear', async (req, res) => {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
        const wasActive = isStreamActive();
        const count = activeStreamSessions.size;
        activeStreamSessions.clear();
        logger?.info('stream', `Manually cleared ${count} stream session(s)`);
        if (wasActive) {
            app?.emit('stream:inactive', { active: 0, reason: 'manual_clear' });
        }
        res.json({ success: true, cleared: count });
    });

    // Get current stream session status
    app.get('/api/stream/sessions', async (req, res) => {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
        const sessions = Array.from(activeStreamSessions.entries()).map(([id, s]) => ({
            id,
            title: s.title,
            startedAt: s.startedAt,
            ageMinutes: Math.round((Date.now() - s.startedAt) / 60000)
        }));
        res.json({ active: isStreamActive(), count: sessions.length, sessions });
    });

    app.post('/api/telegram/test', async (req, res) => {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
        const ok = await sendTelegramMessage('RecoStream test notification');
        if (!ok) return res.status(400).json({ error: 'Telegram not configured' });
        res.json({ success: true });
    });

    app.post('/api/auth/totp/setup', async (req, res) => {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
        if (!isMfaEnabled()) return res.status(403).json({ error: 'MFA is disabled by configuration' });
        const secret = speakeasy.generateSecret({ name: `RecoStream (${req.user.username})` });
        const qrDataUrl = await qrcode.toDataURL(secret.otpauth_url);
        await modules.db.run(
            'UPDATE users SET totp_secret = ?, totp_enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [secret.base32, req.user.user_id]
        );
        res.json({ secret: secret.base32, otpauthUrl: secret.otpauth_url, qrDataUrl });
    });

    app.post('/api/auth/totp/enable', async (req, res) => {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
        if (!isMfaEnabled()) return res.status(403).json({ error: 'MFA is disabled by configuration' });
        const token = normalizeTotpToken(req.body.token);
        if (!token) return res.status(400).json({ error: 'Token is required' });

        const user = await modules.db.get('SELECT totp_secret FROM users WHERE id = ?', [req.user.user_id]);
        if (!user?.totp_secret) return res.status(400).json({ error: 'No TOTP secret found. Generate one first.' });

        const verified = speakeasy.totp.verify({
            secret: user.totp_secret,
            encoding: 'base32',
            token,
            window: 2
        });

        if (!verified) return res.status(400).json({ error: 'Invalid token' });

        await modules.db.run(
            'UPDATE users SET totp_enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [req.user.user_id]
        );
        res.json({ success: true });
    });

    app.post('/api/auth/totp/disable', async (req, res) => {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
        const password = req.body.password || '';
        const token = normalizeTotpToken(req.body.token);

        if (!password) return res.status(400).json({ error: 'Password is required' });

        const user = await modules.db.get('SELECT password_hash, totp_enabled, totp_secret FROM users WHERE id = ?', [req.user.user_id]);
        const passwordOk = await bcrypt.compare(password, user.password_hash);
        if (!passwordOk) return res.status(400).json({ error: 'Invalid password' });

        if (user.totp_enabled) {
            if (!token) return res.status(400).json({ error: 'Token is required' });
            const verified = speakeasy.totp.verify({
                secret: user.totp_secret,
                encoding: 'base32',
                token,
                window: 2
            });
            if (!verified) return res.status(400).json({ error: 'Invalid token' });
        }

        await modules.db.run(
            'UPDATE users SET totp_enabled = 0, totp_secret = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [req.user.user_id]
        );
        res.json({ success: true });
    });

    app.post('/api/auth/password', async (req, res) => {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
        const currentPassword = req.body.currentPassword || '';
        const newPassword = req.body.newPassword || '';
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current and new password are required' });
        }

        const user = await modules.db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.user_id]);
        const passwordOk = await bcrypt.compare(currentPassword, user.password_hash);
        if (!passwordOk) return res.status(400).json({ error: 'Invalid current password' });

        const newHash = await bcrypt.hash(newPassword, 12);
        await modules.db.run(
            'UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [newHash, req.user.user_id]
        );
        res.json({ success: true });
    });

    // View routes
    app.get('/', (req, res) => res.render('index', { page: 'dashboard' }));
    app.get('/movies', (req, res) => res.render('movies', { page: 'movies' }));
    app.get('/series', (req, res) => res.render('series', { page: 'series' }));
    app.get('/livetv', (req, res) => res.render('livetv', { page: 'livetv' }));
    app.get('/downloads', (req, res) => res.render('downloads', { page: 'downloads' }));
    app.get('/settings', (req, res) => res.render('settings', { page: 'settings' }));
    app.get('/media/:id', (req, res) => res.render('media-detail', { page: 'media', mediaId: req.params.id }));
    app.get('/movies/:id', (req, res) => res.render('media-detail', { page: 'movies', mediaId: req.params.id }));
    app.get('/series/:name', (req, res) => res.render('show-detail', { page: 'series', showName: decodeURIComponent(req.params.name) }));
    app.get('/person/:id', (req, res) => res.render('person', { page: 'person', personId: req.params.id }));
    app.get('/show/:name', (req, res) => res.render('show-detail', { page: 'series', showName: decodeURIComponent(req.params.name) }));
    app.get('/series/:name/season/:season', (req, res) => res.render('season-detail', { page: 'series', showName: decodeURIComponent(req.params.name), seasonNumber: parseInt(req.params.season) }));
    app.get('/requests', (req, res) => res.render('requests', { page: 'requests' }));
    app.get('/logs', (req, res) => res.render('logs', { page: 'logs' }));
    app.get('/epg', (req, res) => res.render('epg', { page: 'epg' }));
    app.get('/player', (req, res) => res.render('player', { page: 'player', streamUrl: req.query.url || '' }));

    // API Routes
    setupApiRoutes();

    // Radarr-compatible API for Overseerr integration
    setupRadarrApi();
}

function setupApiRoutes() {
    const router = express.Router();
    const tmdbRateWindowMs = 10000;
    const tmdbRateLimit = 40;
    const tmdbRequestBuckets = new Map();
    const languageAliases = new Map([
        ['EN', ['EN', 'ENG', 'ENGLISH', 'US', 'UK', 'CA', 'AU', 'NZ']]
    ]);

    function expandPreferredLanguages(preferredLangs) {
        const expanded = new Set();
        preferredLangs.forEach((lang) => {
            if (!lang) return;
            const upper = lang.toString().trim().toUpperCase();
            if (!upper) return;
            expanded.add(upper);
            const aliases = languageAliases.get(upper);
            if (aliases) {
                aliases.forEach((alias) => expanded.add(alias));
            }
        });
        return Array.from(expanded);
    }

    function tmdbRateLimiter(req, res, next) {
        const ip = req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
        const now = Date.now();
        let bucket = tmdbRequestBuckets.get(ip);
        if (!bucket) {
            bucket = [];
            tmdbRequestBuckets.set(ip, bucket);
        }

        // Drop timestamps outside window
        while (bucket.length && now - bucket[0] > tmdbRateWindowMs) {
            bucket.shift();
        }

        if (bucket.length >= tmdbRateLimit) {
            const retryAfterMs = tmdbRateWindowMs - (now - bucket[0]);
            res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000));
            res.setHeader('X-RateLimit-Limit', tmdbRateLimit);
            res.setHeader('X-RateLimit-Remaining', 0);
            return res.status(429).json({ error: 'TMDB rate limit exceeded' });
        }

        bucket.push(now);
        res.setHeader('X-RateLimit-Limit', tmdbRateLimit);
        res.setHeader('X-RateLimit-Remaining', Math.max(0, tmdbRateLimit - bucket.length));
        return next();
    }

    // Stats - filtered by preferred languages
    router.get('/stats', async (req, res) => {
        try {
            const db = modules.db;
            const preferredLangs = expandPreferredLanguages(modules.settings?.get('preferredLanguages') || []);

            let stats;
            if (preferredLangs.length > 0) {
                // Build language filter for SQL - case insensitive, also include NULL (undetected) languages
                const langPlaceholders = preferredLangs.map(() => '?').join(',');
                const langParamsUpper = preferredLangs.map(l => l.toUpperCase());

                stats = {
                    totalMovies: (await db.get(`
                        SELECT COUNT(*) as c FROM media m
                        JOIN sources s ON m.source_id = s.id
                        WHERE m.media_type = 'movie' AND m.is_active = 1 AND s.active = 1
                        AND (UPPER(m.language) IN (${langPlaceholders}) OR m.language IS NULL)
                    `, langParamsUpper))?.c || 0,
                    totalSeries: (await db.get(`
                        SELECT COUNT(*) as c FROM media m
                        JOIN sources s ON m.source_id = s.id
                        WHERE m.media_type = 'series' AND m.is_active = 1 AND s.active = 1
                        AND (UPPER(m.language) IN (${langPlaceholders}) OR m.language IS NULL)
                    `, langParamsUpper))?.c || 0,
                    totalLiveTV: (await db.get(`
                        SELECT COUNT(*) as c FROM media m
                        JOIN sources s ON m.source_id = s.id
                        WHERE m.media_type = 'live' AND m.is_active = 1 AND s.active = 1
                        AND (UPPER(m.language) IN (${langPlaceholders}) OR m.language IS NULL)
                    `, langParamsUpper))?.c || 0,
                    totalDownloads: (await db.get('SELECT COUNT(*) as c FROM downloads WHERE status = ?', ['completed']))?.c || 0,
                    activeDownloads: (await db.get('SELECT COUNT(*) as c FROM downloads WHERE status IN (?, ?)', ['queued', 'downloading']))?.c || 0,
                    totalSources: (await db.get('SELECT COUNT(*) as c FROM sources'))?.c || 0
                };
            } else {
                // No language filter - show all active from active sources
                stats = {
                    totalMovies: (await db.get('SELECT COUNT(*) as c FROM media m JOIN sources s ON m.source_id = s.id WHERE m.media_type = ? AND m.is_active = 1 AND s.active = 1', ['movie']))?.c || 0,
                    totalSeries: (await db.get('SELECT COUNT(*) as c FROM media m JOIN sources s ON m.source_id = s.id WHERE m.media_type = ? AND m.is_active = 1 AND s.active = 1', ['series']))?.c || 0,
                    totalLiveTV: (await db.get('SELECT COUNT(*) as c FROM media m JOIN sources s ON m.source_id = s.id WHERE m.media_type = ? AND m.is_active = 1 AND s.active = 1', ['live']))?.c || 0,
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

    // Search API
    router.get('/search', async (req, res) => {
        try {
            const query = req.query.q || '';
            const limit = parseInt(req.query.limit) || 50;
            const type = req.query.type;

            if (!query || query.length < 2) {
                return res.json([]);
            }

            const results = await modules.search.search(query, { type, limit });
            res.json(results);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Featured content for hero carousel
    router.get('/featured', async (req, res) => {
        try {
            const db = modules.db;
            const preferredLangs = expandPreferredLanguages(modules.settings?.get('preferredLanguages') || []);
            const limit = parseInt(req.query.limit) || 8;

            let langFilter = '';
            let langParams = [];
            if (preferredLangs.length > 0) {
                const langPlaceholders = preferredLangs.map(() => '?').join(',');
                langFilter = `AND UPPER(m.language) IN (${langPlaceholders})`;
                langParams = preferredLangs.map(l => l.toUpperCase());
            }

            // Get top-rated content with backdrop images (from active sources only)
            const featured = await db.all(`
                SELECT
                    m.id, m.title, m.media_type, m.year, m.rating, m.plot as overview, m.runtime,
                    m.poster as poster_url, m.backdrop as backdrop_url, m.genres,
                    (SELECT 'https://www.youtube.com/watch?v=' || mt.youtube_key
                     FROM media_trailers mt
                     WHERE mt.media_id = m.id
                     ORDER BY mt.official DESC, mt.type = 'Trailer' DESC
                     LIMIT 1) as trailer_url
                FROM media m
                JOIN sources s ON m.source_id = s.id
                WHERE m.is_active = 1 AND s.active = 1
                    AND m.media_type IN ('movie', 'series')
                    AND m.backdrop IS NOT NULL
                    AND m.backdrop != ''
                    ${langFilter}
                ORDER BY
                    CASE WHEN m.rating IS NOT NULL AND m.rating > 0 THEN 0 ELSE 1 END,
                    m.rating DESC,
                    m.created_at DESC
                LIMIT ?
            `, [...langParams, limit]);

            res.json(featured);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Content rows for homepage
    router.get('/content/rows', async (req, res) => {
        try {
            const db = modules.db;
            const preferredLangs = expandPreferredLanguages(modules.settings?.get('preferredLanguages') || []);
            const mediaType = req.query.type; // 'movie' or 'series' or undefined for both

            let langFilter = '';
            let langParams = [];
            if (preferredLangs.length > 0) {
                const langPlaceholders = preferredLangs.map(() => '?').join(',');
                langFilter = `AND UPPER(language) IN (${langPlaceholders})`;
                langParams = preferredLangs.map(l => l.toUpperCase());
            }

            let typeFilter = '';
            if (mediaType === 'movie' || mediaType === 'series') {
                typeFilter = `AND media_type = '${mediaType}'`;
            } else {
                typeFilter = `AND media_type IN ('movie', 'series')`;
            }

            const rows = [];

            // Recently Added
            const recentlyAdded = await db.all(`
                SELECT m.id, m.title, m.media_type, m.year, m.rating, m.poster as poster_url, m.quality
                FROM media m
                JOIN sources s ON m.source_id = s.id
                WHERE m.is_active = 1 AND s.active = 1 ${typeFilter.replace(/media_type/g, 'm.media_type')} ${langFilter.replace(/language/g, 'm.language')}
                ORDER BY m.created_at DESC
                LIMIT 20
            `, langParams);
            if (recentlyAdded.length > 0) {
                rows.push({ title: 'Recently Added', items: recentlyAdded, link: mediaType ? `/${mediaType}s?sort=newest` : null });
            }

            // Top Rated
            const topRated = await db.all(`
                SELECT m.id, m.title, m.media_type, m.year, m.rating, m.poster as poster_url, m.quality
                FROM media m
                JOIN sources s ON m.source_id = s.id
                WHERE m.is_active = 1 AND s.active = 1 ${typeFilter.replace(/media_type/g, 'm.media_type')} ${langFilter.replace(/language/g, 'm.language')}
                    AND m.rating IS NOT NULL AND m.rating > 0
                ORDER BY m.rating DESC
                LIMIT 20
            `, langParams);
            if (topRated.length > 0) {
                rows.push({ title: 'Top Rated', items: topRated, link: mediaType ? `/${mediaType}s?sort=rating` : null });
            }

            // Get genres and create rows for popular ones
            const genres = ['Action', 'Comedy', 'Drama', 'Thriller', 'Sci-Fi', 'Horror', 'Romance', 'Documentary'];
            for (const genre of genres) {
                const genreItems = await db.all(`
                    SELECT m.id, m.title, m.media_type, m.year, m.rating, m.poster as poster_url, m.quality
                    FROM media m
                    JOIN sources s ON m.source_id = s.id
                    WHERE m.is_active = 1 AND s.active = 1 ${typeFilter.replace(/media_type/g, 'm.media_type')} ${langFilter.replace(/language/g, 'm.language')}
                        AND m.genres LIKE ?
                    ORDER BY m.rating DESC NULLS LAST, m.created_at DESC
                    LIMIT 20
                `, [...langParams, `%${genre}%`]);

                if (genreItems.length >= 5) {
                    rows.push({
                        title: genre,
                        items: genreItems,
                        link: mediaType ? `/${mediaType}s?genre=${encodeURIComponent(genre)}` : null
                    });
                }
            }

            res.json(rows);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });


    // Live TV channel counts per category
    router.get('/livetv/counts', async (req, res) => {
        try {
            const db = modules.db;
            const result = await db.all(`
                SELECT m.category, COUNT(*) as count
                FROM media m
                JOIN sources s ON m.source_id = s.id
                WHERE m.media_type = 'live' AND m.category IS NOT NULL AND m.category != '' AND s.active = 1
                GROUP BY m.category
            `);

            const counts = {};
            for (const row of result) {
                counts[row.category] = row.count;
            }
            res.json(counts);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Stream proxy for CORS bypass - pipes IPTV streams through server
    // For HLS streams (.m3u8), rewrite URLs to proxy segments
    // For TS segments, proxy directly
    // For other streams, transcode to fMP4 with FFmpeg
    router.get('/stream/proxy', async (req, res) => {
        try {
            const url = req.query.url;
            if (!url) {
                return res.status(400).json({ error: 'URL parameter required' });
            }

            const isHls = url.includes('.m3u8');
            // Only treat as segment if explicitly marked (from HLS playlist rewrite) or is .aac/.m4s
            // Standalone .ts URLs (live TV) need transcoding, not direct piping
            const isSegment = req.query.segment === 'true' || url.includes('.aac') || url.includes('.m4s');
            logger?.info('stream', `Proxying stream: ${url} (HLS: ${isHls}, Segment: ${isSegment})`);

            // Set CORS headers
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
            res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');

            // Handle OPTIONS preflight
            if (req.method === 'OPTIONS') {
                return res.status(204).end();
            }

            const streamHeaders = {
                'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
                'Referer': new URL(url).origin + '/'
            };

            if (isHls) {
                // For HLS playlists, fetch as text and rewrite URLs to go through proxy
                const response = await axios({
                    method: 'get',
                    url: url,
                    responseType: 'text',
                    headers: streamHeaders,
                    timeout: 30000,
                    maxRedirects: 5
                });

                let playlist = response.data;
                // Use the final URL after any redirects for calculating base URL
                // This is critical for streams that redirect to different servers
                const finalUrl = response.request.res?.responseUrl || url;
                const baseUrl = finalUrl.substring(0, finalUrl.lastIndexOf('/') + 1);

                // Rewrite all URLs in the playlist to go through our proxy
                // Handle both relative and absolute URLs
                playlist = playlist.split('\n').map(line => {
                    line = line.trim();
                    // Skip empty lines and comments (except URI in EXT-X-KEY etc)
                    if (!line || (line.startsWith('#') && !line.includes('URI="'))) {
                        // Check for URI= in tags like #EXT-X-KEY
                        if (line.includes('URI="')) {
                            return line.replace(/URI="([^"]+)"/, (match, uri) => {
                                const absoluteUri = uri.startsWith('http') ? uri : new URL(uri, baseUrl).href;
                                return `URI="/api/stream/proxy?url=${encodeURIComponent(absoluteUri)}&segment=true"`;
                            });
                        }
                        return line;
                    }
                    // This is a segment URL
                    if (!line.startsWith('#')) {
                        const absoluteUrl = line.startsWith('http') ? line : new URL(line, baseUrl).href;
                        return '/api/stream/proxy?url=' + encodeURIComponent(absoluteUrl) + '&segment=true';
                    }
                    return line;
                }).join('\n');

                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                res.send(playlist);

            } else if (isSegment) {
                // For TS/AAC segments, stream directly
                if (req.headers.range) {
                    streamHeaders['Range'] = req.headers.range;
                }

                const response = await axios({
                    method: 'get',
                    url: url,
                    responseType: 'stream',
                    headers: streamHeaders,
                    timeout: 30000,
                    maxRedirects: 5
                });

                // Set appropriate content type
                if (url.includes('.ts')) {
                    res.setHeader('Content-Type', 'video/mp2t');
                } else if (url.includes('.aac')) {
                    res.setHeader('Content-Type', 'audio/aac');
                } else if (url.includes('.m4s')) {
                    res.setHeader('Content-Type', 'video/iso.segment');
                }

                if (response.headers['content-length']) {
                    res.setHeader('Content-Length', response.headers['content-length']);
                }
                if (response.headers['content-range']) {
                    res.setHeader('Content-Range', response.headers['content-range']);
                }

                res.status(response.status);
                response.data.pipe(res);

                response.data.on('error', (err) => {
                    logger?.error('stream', `Segment error: ${err.message}`);
                    if (!res.headersSent) res.status(500).json({ error: 'Segment error' });
                });

                req.on('close', () => response.data.destroy());

            } else {
                // For non-HLS streams, check if stream transcoding is enabled
                const streamTranscodeEnabled = settings.get('transcodeStreamEnabled') !== false;
                const outputFormat = req.query.format || 'mp4';  // 'mp4' or 'hls' for Safari

                if (!streamTranscodeEnabled) {
                    // Pass through raw stream without transcoding
                    logger?.info('stream', 'Stream transcoding disabled, passing through raw stream');
                    const response = await axios({
                        method: 'get',
                        url: url,
                        responseType: 'stream',
                        headers: streamHeaders,
                        timeout: 30000,
                        maxRedirects: 5
                    });

                    res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp2t');
                    if (response.headers['content-length']) {
                        res.setHeader('Content-Length', response.headers['content-length']);
                    }
                    response.data.pipe(res);
                    response.data.on('error', (err) => {
                        logger?.error('stream', `Stream error: ${err.message}`);
                        if (!res.headersSent) res.status(500).json({ error: 'Stream error' });
                    });
                    req.on('close', () => response.data.destroy());
                    return;
                }

                // Transcode to browser-playable format
                // Use FFmpeg to convert to fragmented MP4 which browsers can play directly
                // Must transcode to H.264 since source may be H.265/HEVC which browsers don't support

                // Detect hardware acceleration for faster encoding
                let hwAccel = { type: 'software', encoders: { h264: 'libx264' } };
                if (modules.transcoder) {
                    try {
                        hwAccel = await modules.transcoder.detectHardwareAcceleration();
                    } catch (e) {
                        logger?.warn('stream', `HW detection failed: ${e.message}`);
                    }
                }
                // Safari needs software encoding (libx264) for compatible H.264 baseline profile
                // VAAPI produces profiles that Safari can't decode
                const useHlsFormat = outputFormat === 'hls';
                const encoder = useHlsFormat ? 'libx264' : (hwAccel.encoders.h264 || 'libx264');
                logger?.info('stream', `Starting FFmpeg transcode to H.264 ${useHlsFormat ? 'fMP4-Safari' : 'fMP4'} using ${encoder}...`);

                // Set headers - use MP4 for all browsers
                res.setHeader('Content-Type', 'video/mp4');
                if (useHlsFormat) {
                    // Safari needs Content-Length
                    res.setHeader('Content-Length', '999999999');
                } else {
                    res.setHeader('Transfer-Encoding', 'chunked');
                }
                res.setHeader('Accept-Ranges', 'none');
                res.setHeader('Cache-Control', 'no-cache, no-store');

                // If browser sends a Range header, ignore it
                if (req.headers.range) {
                    logger?.info('stream', `Ignoring Range header: ${req.headers.range} (transcoding doesn't support seeking)`);
                }

                // Build encoder-specific arguments - optimized for fast startup
                let ffmpegArgs = [
                    // Low-latency settings for fast preview startup
                    '-fflags', '+nobuffer+flush_packets+discardcorrupt+genpts',
                    '-flags', 'low_delay',
                    '-analyzeduration', '2000000',  // 2s max analysis (need time to find keyframe)
                    '-probesize', '5000000',        // 5MB max probe size
                    // Reconnect settings for IPTV streams
                    '-reconnect', '1',
                    '-reconnect_at_eof', '1',
                    '-reconnect_on_network_error', '1',
                    '-reconnect_streamed', '1',
                    '-reconnect_delay_max', '2',
                    '-headers', 'User-Agent: VLC/3.0.20 LibVLC/3.0.20\r\nReferer: ' + new URL(url).origin + '/\r\n',
                    // Seek to start for VOD content
                    '-ss', '0',
                ];

                // Add hardware decoding before input
                if (encoder === 'h264_vaapi') {
                    // VAAPI hardware decode + encode
                    ffmpegArgs.push('-hwaccel', 'vaapi');
                    ffmpegArgs.push('-hwaccel_device', '/dev/dri/renderD128');
                    ffmpegArgs.push('-hwaccel_output_format', 'vaapi');
                } else if (encoder === 'h264_nvenc') {
                    // NVENC hardware decode + encode
                    ffmpegArgs.push('-hwaccel', 'cuda');
                    ffmpegArgs.push('-hwaccel_output_format', 'cuda');
                }

                ffmpegArgs.push('-i', url);

                // Add encoder-specific video encoding args
                if (encoder === 'h264_nvenc') {
                    // NVIDIA NVENC - fastest hardware encoding
                    // Use scale_cuda filter for GPU-side format conversion (frames are in CUDA memory)
                    ffmpegArgs.push(
                        '-vf', 'scale_cuda=format=nv12',
                        '-c:v', 'h264_nvenc',
                        '-preset', 'p1',          // Fastest preset
                        '-tune', 'll',            // Low latency tuning
                        '-rc', 'constqp',         // Constant QP mode (works reliably with -cq)
                        '-cq', '28'               // Quality level
                    );
                } else if (encoder === 'h264_vaapi') {
                    // Intel/AMD VAAPI - frames already on GPU from hwaccel
                    // Use baseline profile (66) for Safari compatibility
                    ffmpegArgs.push(
                        '-vf', 'scale_vaapi=format=nv12',
                        '-c:v', 'h264_vaapi',
                        '-profile:v', '66',    // Baseline profile (Safari compatible)
                        '-level', '31',        // Level 3.1
                        '-bf', '0',            // No B-frames (required for baseline)
                        '-qp', '28'
                    );
                } else if (encoder === 'h264_videotoolbox') {
                    // Apple VideoToolbox
                    ffmpegArgs.push(
                        '-c:v', 'h264_videotoolbox',
                        '-realtime', 'true',
                        '-pix_fmt', 'yuv420p'
                    );
                } else {
                    // Software fallback (libx264) - tuned for fast preview
                    ffmpegArgs.push(
                        '-c:v', 'libx264',
                        '-preset', 'ultrafast',
                        '-tune', 'zerolatency',
                        '-crf', '30',               // Slightly lower quality for speed (was 28)
                        '-pix_fmt', 'yuv420p',
                        '-profile:v', 'baseline',   // Simpler profile for faster decode
                        '-level', '3.1',
                        '-x264-params', 'bframes=0:ref=1:me=dia:subme=0:trellis=0:weightp=0'  // Fastest x264 settings
                    );
                }

                // Common output args - optimized for fast first-frame delivery
                ffmpegArgs.push(
                    '-c:a', 'aac',
                    '-b:a', '128k',
                    '-g', '30',                     // Keyframe every 30 frames (~1 sec at 30fps)
                    '-keyint_min', '15',            // Min GOP size for faster seeking
                    '-sc_threshold', '0'            // Disable scene change detection
                );

                // Output format - fMP4 for all browsers
                ffmpegArgs.push(
                    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
                    '-frag_duration', '500000',     // 500ms fragments for faster start
                    '-f', 'mp4',
                    '-'
                );

                const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

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
            const { type, search, year, quality, language, genre, category, source, platform, sort, order, limit, offset, dedupe, recently_added, include_inactive } = req.query;

            // For movies, deduplicate by normalized title (keeping best version with TMDB poster)
            const shouldDedupe = dedupe !== 'false' && (type === 'movie');

            let sql;
            if (shouldDedupe) {
                // Normalize titles by:
                // 1. Removing language prefixes like "DE - ", "EN - ", etc.
                // 2. Extracting year from title if present
                // 3. Trimming and lowercasing for consistent comparison
                sql = `SELECT * FROM (
                    SELECT media.*,
                           ROW_NUMBER() OVER (
                               PARTITION BY
                                   -- Normalize title: remove language prefix, extract base title
                                   LOWER(TRIM(
                                       CASE
                                           -- Remove 2-3 letter language prefix with dash (e.g., "DE - ", "EN - ", "GER - ")
                                           WHEN media.title GLOB '[A-Z][A-Z] - *' THEN SUBSTR(media.title, 6)
                                           WHEN media.title GLOB '[A-Z][A-Z][A-Z] - *' THEN SUBSTR(media.title, 7)
                                           ELSE media.title
                                       END
                                   )),
                                   -- Also partition by year (from year column or extracted from title)
                                   COALESCE(media.year,
                                       CASE
                                           WHEN media.title GLOB '*([0-9][0-9][0-9][0-9])*'
                                           THEN CAST(SUBSTR(media.title, INSTR(media.title, '(') + 1, 4) AS INTEGER)
                                           ELSE NULL
                                       END
                                   )
                               ORDER BY
                                   -- Prefer entries with TMDB posters
                                   CASE WHEN media.poster LIKE '%image.tmdb.org%' THEN 0 ELSE 1 END,
                                   -- Then prefer entries with TMDB ID
                                   CASE WHEN media.tmdb_id IS NOT NULL THEN 0 ELSE 1 END,
                                   -- Then prefer entries with higher rating
                                   CASE WHEN media.rating IS NOT NULL THEN 0 ELSE 1 END,
                                   media.id
                           ) as rn
                    FROM media
                    JOIN sources ON media.source_id = sources.id
                    WHERE sources.active = 1`;
            } else {
                sql = 'SELECT media.* FROM media JOIN sources ON media.source_id = sources.id WHERE sources.active = 1';
            }
            const params = [];

            if (type) {
                sql += ' AND media.media_type = ?';
                params.push(type);

                // For movie/series views, filter out category headers and info channels
                if (type === 'movie' || type === 'series') {
                    sql += ` AND media.title NOT LIKE '%###%'
                             AND media.title NOT LIKE '## %'
                             AND media.title NOT LIKE '%----- %'
                             AND media.title NOT LIKE '%INFO%'
                             AND media.title NOT GLOB '*[#][#]*'`;
                }
            }
            if (search) {
                sql += ' AND (media.title LIKE ? OR media.original_title LIKE ?)';
                params.push(`%${search}%`, `%${search}%`);
            }
            if (year) {
                // Filter by year column or year in title like "(2024)"
                sql += ' AND (media.year = ? OR media.title LIKE ?)';
                params.push(parseInt(year), `%(${year})%`);
            }
            if (quality) {
                sql += ' AND media.quality = ?';
                params.push(quality);
            }
            if (language) {
                // Filter by language column (primary), or fallback to category [XX], category name, or title prefix "XX - " / "XX ★"
                sql += ' AND (UPPER(media.language) = ? OR media.category LIKE ? OR media.category LIKE ? OR media.title LIKE ? OR media.title LIKE ?)';
                params.push(language.toUpperCase(), `%[${language}]%`, `%${language} %`, `${language} - %`, `${language} ★%`);
            }
            if (genre) {
                sql += ' AND media.genres LIKE ?';
                params.push(`%${genre}%`);
            }
            if (category) {
                sql += ' AND media.category = ?';
                params.push(category);
            }
            if (source) {
                sql += ' AND media.source_id = ?';
                params.push(parseInt(source));
            }
            if (platform) {
                // Platform filter now uses category field
                sql += ' AND media.category = ?';
                params.push(platform);
            }

            // Filter by recently added (last 2 weeks by default, or custom days)
            if (recently_added) {
                const days = parseInt(recently_added) || 14;
                sql += ` AND media.created_at >= datetime('now', '-${days} days')`;
            }

            // Filter out inactive items unless explicitly requested
            if (include_inactive !== 'true') {
                sql += ' AND (media.is_active = 1 OR media.is_active IS NULL)';
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

            // Build count query before adding pagination
            // We need to count without the LIMIT/OFFSET
            let countSql = sql.replace(/SELECT \* FROM/, 'SELECT COUNT(*) as total FROM');
            if (shouldDedupe) {
                // For dedupe queries, wrap in subquery to count unique results
                countSql = `SELECT COUNT(*) as total FROM (${sql}) as deduped`;
            }
            const countParams = [...params];

            // Pagination
            const limitNum = Math.min(parseInt(limit) || 50, 100);
            const offsetNum = parseInt(offset) || 0;
            sql += ' LIMIT ? OFFSET ?';
            params.push(limitNum, offsetNum);

            const [media, countResult] = await Promise.all([
                modules.db.all(sql, params),
                modules.db.get(countSql, countParams)
            ]);
            const totalCount = countResult?.total || 0;

            // Add source name and is_new flag to each media item
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

                // Add is_new flag for items created in the last 14 days
                const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
                for (const m of media) {
                    m.is_new = m.created_at && m.created_at >= twoWeeksAgo;
                }

                // Add has_trailer flag for items with trailers
                const mediaIds = media.map(m => m.id);
                if (mediaIds.length > 0) {
                    const placeholders = mediaIds.map(() => '?').join(',');
                    const trailerMedia = await modules.db.all(
                        `SELECT DISTINCT media_id FROM media_trailers WHERE media_id IN (${placeholders})`,
                        mediaIds
                    );
                    const trailerSet = new Set(trailerMedia.map(t => t.media_id));
                    for (const m of media) {
                        m.has_trailer = trailerSet.has(m.id) ? 1 : 0;
                    }
                }
            }

            // Return with total count for proper pagination display
            res.json({ items: media, total: totalCount });
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
            const { name, type, url, username, password, user_agent, spoofed_mac, spoofed_device_key, simulate_playback, playback_speed_multiplier, m3u_parser_config, epg_url } = req.body;
            const result = await modules.db.run(
                'INSERT INTO sources (name, type, url, username, password, user_agent, spoofed_mac, spoofed_device_key, simulate_playback, playback_speed_multiplier, m3u_parser_config, epg_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [name, type || 'xtream', url, username, password, user_agent || 'IBOPlayer', spoofed_mac || null, spoofed_device_key || null, simulate_playback !== undefined ? simulate_playback : 1, playback_speed_multiplier !== undefined ? playback_speed_multiplier : 1.5, m3u_parser_config || null, epg_url || null]
            );
            res.json({ id: result.lastID, message: 'Source added' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.put('/sources/:id', async (req, res) => {
        try {
            const { name, type, url, username, password, user_agent, active, spoofed_mac, spoofed_device_key, simulate_playback, playback_speed_multiplier, m3u_parser_config, epg_url } = req.body;
            await modules.db.run(
                'UPDATE sources SET name=?, type=?, url=?, username=?, password=?, user_agent=?, active=?, spoofed_mac=?, spoofed_device_key=?, simulate_playback=?, playback_speed_multiplier=?, m3u_parser_config=?, epg_url=? WHERE id=?',
                [name, type, url, username, password, user_agent, active !== false ? 1 : 0, spoofed_mac || null, spoofed_device_key || null, simulate_playback !== undefined ? simulate_playback : 1, playback_speed_multiplier !== undefined ? playback_speed_multiplier : 1.5, m3u_parser_config || null, epg_url || null, req.params.id]
            );
            res.json({ message: 'Source updated' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.delete('/sources/:id', async (req, res) => {
        try {
            const sourceId = req.params.id;

            // Get count of media to be deleted
            const mediaCount = await modules.db.get(
                'SELECT COUNT(*) as count FROM media WHERE source_id = ?',
                [sourceId]
            );

            // Explicitly delete all media from this source (cascade should handle related tables)
            await modules.db.run('DELETE FROM media WHERE source_id = ?', [sourceId]);

            // Delete the source itself
            await modules.db.run('DELETE FROM sources WHERE id = ?', [sourceId]);

            logger?.info('sources', `Deleted source ${sourceId} and ${mediaCount?.count || 0} media entries`);
            res.json({
                message: 'Source deleted',
                mediaDeleted: mediaCount?.count || 0
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/sources/:id/toggle', async (req, res) => {
        try {
            // Toggle the active status (flip 0 to 1 or 1 to 0)
            const source = await modules.db.get('SELECT active FROM sources WHERE id = ?', [req.params.id]);
            if (!source) {
                return res.status(404).json({ error: 'Source not found' });
            }
            const newActive = source.active ? 0 : 1;
            await modules.db.run('UPDATE sources SET active = ? WHERE id = ?', [newActive, req.params.id]);
            logger?.info('sources', `Source ${req.params.id} ${newActive ? 'enabled' : 'disabled'}`);
            res.json({ success: true, active: newActive });
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
                    SUM(CASE WHEN media_type = 'live' THEN 1 ELSE 0 END) as live,
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
                live: mediaCounts?.live || 0,
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

    // Reprocess titles - apply parseOriginalTitle to all media for a source
    router.post('/sources/:id/reprocess-titles', async (req, res) => {
        try {
            const sourceId = parseInt(req.params.id);
            const db = modules.db;

            if (!modules.iptv?.parseOriginalTitle) {
                return res.status(400).json({ error: 'IPTV module not loaded or parseOriginalTitle not available' });
            }

            const parseOriginalTitle = modules.iptv.parseOriginalTitle;

            // Get all media for this source
            const mediaItems = await db.all(
                'SELECT id, original_title, media_type FROM media WHERE source_id = ?',
                [sourceId]
            );

            logger.info('api', `Reprocessing titles for ${mediaItems.length} items in source ${sourceId}`);

            let updated = 0;
            let skipped = 0;

            // Process in batches
            await db.run('BEGIN TRANSACTION');
            for (const item of mediaItems) {
                if (!item.original_title) {
                    skipped++;
                    continue;
                }

                const parsed = parseOriginalTitle(item.original_title);
                const cleanedTitle = parsed.title || item.original_title;

                // Update the media record with parsed values
                // Also update show_name for series (used for grouping)
                await db.run(`
                    UPDATE media SET
                        title = ?,
                        show_name = CASE WHEN media_type = 'series' THEN ? ELSE show_name END,
                        year = COALESCE(?, year),
                        quality = COALESCE(?, quality),
                        language = COALESCE(?, language),
                        platform = COALESCE(?, platform)
                    WHERE id = ?
                `, [
                    cleanedTitle,
                    cleanedTitle,
                    parsed.year,
                    parsed.quality,
                    parsed.language,
                    parsed.platform,
                    item.id
                ]);

                updated++;
            }
            await db.run('COMMIT');

            logger.info('api', `Reprocessed titles: ${updated} updated, ${skipped} skipped`);

            res.json({
                success: true,
                message: `Reprocessed ${updated} titles`,
                updated,
                skipped,
                total: mediaItems.length
            });
        } catch (err) {
            logger.error('api', `Reprocess titles failed: ${err.message}`);
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
            const source = await modules.db.get('SELECT * FROM sources WHERE id = ?', [req.params.id]);
            if (!source) return res.status(404).json({ error: 'Source not found' });

            // For Xtream sources, generate EPG URL if not set
            let epgUrl = source.epg_url;
            if (!epgUrl && source.type === 'xtream' && source.username && source.password) {
                epgUrl = `${source.url}/xmltv.php?username=${source.username}&password=${source.password}`;
            }

            if (!epgUrl) return res.status(400).json({ error: 'No EPG URL configured for this source' });

            if (modules.epg) {
                // Sync EPG in background with generated URL
                const sourceWithEpg = { ...source, epg_url: epgUrl };
                modules.epg.syncSourceEpg(sourceWithEpg).catch(err => {
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

    // Update tvg_id for live channels from Xtream API (faster than full re-sync)
    router.post('/sources/:id/update-tvg-ids', async (req, res) => {
        try {
            const source = await modules.db.get('SELECT * FROM sources WHERE id = ?', [req.params.id]);
            if (!source) return res.status(404).json({ error: 'Source not found' });

            if (source.type !== 'xtream') {
                return res.status(400).json({ error: 'Only Xtream sources support tvg_id update' });
            }

            // Fetch live channels from Xtream API
            const axios = require('axios');
            const baseUrl = source.url.replace(/\/+$/, '');
            const liveUrl = `${baseUrl}/player_api.php?username=${source.username}&password=${source.password}&action=get_live_streams`;

            logger.info('app', `Fetching live channels from ${source.name} to update tvg_ids...`);
            const response = await axios.get(liveUrl, { timeout: 60000 });
            const liveChannels = response.data || [];

            if (!Array.isArray(liveChannels)) {
                return res.status(500).json({ error: 'Invalid response from Xtream API' });
            }

            // Update tvg_id for each channel
            let updated = 0;
            for (const channel of liveChannels) {
                if (channel.epg_channel_id) {
                    const result = await modules.db.run(`
                        UPDATE media SET tvg_id = ?
                        WHERE source_id = ? AND external_id = ? AND tvg_id IS NULL
                    `, [channel.epg_channel_id, source.id, String(channel.stream_id)]);
                    if (result.changes > 0) updated++;
                }
            }

            logger.info('app', `Updated tvg_id for ${updated} channels in ${source.name}`);
            res.json({ success: true, updated, total: liveChannels.length });
        } catch (err) {
            logger.error('app', `Failed to update tvg_ids: ${err.message}`);
            res.status(500).json({ error: err.message });
        }
    });

    // Analyze source patterns
    router.post('/sources/:id/analyze', async (req, res) => {
        try {
            const db = modules.db;
            const source = await db.get('SELECT * FROM sources WHERE id = ?', [req.params.id]);
            if (!source) return res.status(404).json({ error: 'Source not found' });

            if (!modules['source-analyzer']) {
                return res.status(500).json({ error: 'Source analyzer module not loaded' });
            }

            // Run analysis
            const result = await modules['source-analyzer'].analyzeSource(source);

            // Include previously saved patterns if available
            if (source.m3u_parser_config) {
                try {
                    result.savedConfig = JSON.parse(source.m3u_parser_config);
                } catch (e) {}
            }

            // Update source with analysis status
            await db.run(`
                UPDATE sources
                SET analysis_status = ?, last_analyzed = CURRENT_TIMESTAMP, analysis_confidence = ?
                WHERE id = ?
            `, [result.success ? 'completed' : 'failed', result.patterns?.confidence || 0, source.id]);

            res.json(result);
        } catch (err) {
            logger.error('app', `Source analysis failed: ${err.message}`);
            res.status(500).json({ error: err.message });
        }
    });

    // Get channels/media from a source
    router.get('/sources/:id/channels', async (req, res) => {
        try {
            const db = modules.db;
            const sourceId = req.params.id;
            const mediaType = req.query.type || 'live'; // 'live', 'movie', 'series', or 'all'

            let query = `
                SELECT id, title, tvg_id, poster, category
                FROM media
                WHERE source_id = ?
            `;
            const params = [sourceId];

            if (mediaType !== 'all') {
                query += ' AND media_type = ?';
                params.push(mediaType);
            }

            query += ' ORDER BY title LIMIT 1000';

            const channels = await db.all(query, params);

            res.json({
                channels: channels.slice(0, 500),
                total: channels.length
            });
        } catch (err) {
            logger.error('app', `Failed to get channels: ${err.message}`);
            res.status(500).json({ error: err.message });
        }
    });

    // Preview patterns on sample data
    router.post('/sources/analyze-preview', async (req, res) => {
        try {
            const { patterns, samples } = req.body;

            if (!patterns || !samples) {
                return res.status(400).json({ error: 'patterns and samples are required' });
            }

            if (!modules['source-analyzer']) {
                return res.status(500).json({ error: 'Source analyzer module not loaded' });
            }

            const validation = modules['source-analyzer'].validatePatterns(patterns, samples);
            res.json(validation);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Fetch more random samples from source
    router.post('/sources/:id/fetch-samples', async (req, res) => {
        try {
            const db = modules.db;
            const source = await db.get('SELECT * FROM sources WHERE id = ?', [req.params.id]);
            if (!source) return res.status(404).json({ error: 'Source not found' });

            if (!modules['source-analyzer']) {
                return res.status(500).json({ error: 'Source analyzer module not loaded' });
            }

            const { type, count = 5 } = req.body; // type: 'movies', 'series', 'livetv', or 'all'

            // Fetch fresh samples
            const samples = await modules['source-analyzer'].fetchSamples(source, { type, count });

            res.json({
                success: true,
                samples: {
                    movies: samples.movies || [],
                    series: samples.series || [],
                    livetv: samples.livetv || [],
                    movieCount: samples.movies?.length || 0,
                    seriesCount: samples.series?.length || 0,
                    livetvCount: samples.livetv?.length || 0
                }
            });
        } catch (err) {
            logger.error('app', `Fetch samples failed: ${err.message}`);
            res.status(500).json({ error: err.message });
        }
    });

    // Apply analyzed patterns to source
    router.post('/sources/:id/apply-patterns', async (req, res) => {
        try {
            const db = modules.db;
            const { patterns } = req.body;
            const source = await db.get('SELECT * FROM sources WHERE id = ?', [req.params.id]);

            if (!source) return res.status(404).json({ error: 'Source not found' });
            if (!patterns) return res.status(400).json({ error: 'patterns are required' });

            if (!modules['source-analyzer']) {
                return res.status(500).json({ error: 'Source analyzer module not loaded' });
            }

            // Convert patterns to parser config format
            const parserConfig = modules['source-analyzer'].patternsToParserConfig(patterns);

            // Update source with new parser config
            await db.run(`
                UPDATE sources
                SET m3u_parser_config = ?
                WHERE id = ?
            `, [JSON.stringify(parserConfig), source.id]);

            res.json({ success: true, parserConfig });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Reprocess all entries with current patterns
    router.post('/sources/:id/reprocess', async (req, res) => {
        try {
            const db = modules.db;
            const source = await db.get('SELECT * FROM sources WHERE id = ?', [req.params.id]);
            if (!source) return res.status(404).json({ error: 'Source not found' });

            const parserConfig = source.m3u_parser_config ? JSON.parse(source.m3u_parser_config) : null;
            if (!parserConfig || !parserConfig.titlePatterns) {
                return res.status(400).json({ error: 'No patterns configured for this source. Use the Pattern Analyzer first.' });
            }

            // Get all media entries for this source (use original_title if available, fallback to title)
            const entries = await db.all('SELECT id, title, original_title, category FROM media WHERE source_id = ?', [source.id]);

            if (entries.length === 0) {
                return res.json({ success: true, processed: 0, message: 'No entries to process' });
            }

            let processed = 0;
            const langPattern = parserConfig.titlePatterns.language;
            const yearPattern = parserConfig.titlePatterns.year;
            const qualityPattern = parserConfig.titlePatterns.quality;

            for (const entry of entries) {
                // Use original_title if available (has the raw title from source), otherwise use current title
                const sourceTitle = entry.original_title || entry.title;
                if (!sourceTitle) continue;

                let cleanTitle = sourceTitle;
                let year = null;
                let language = null;
                let quality = null;

                // Extract language
                if (langPattern) {
                    try {
                        const regex = new RegExp(langPattern, 'i');
                        const match = cleanTitle.match(regex);
                        if (match && match[1]) {
                            language = match[1].toUpperCase();
                            cleanTitle = cleanTitle.replace(regex, '');
                        }
                    } catch (e) {}
                }

                // Extract year
                if (yearPattern) {
                    try {
                        const regex = new RegExp(yearPattern);
                        const match = cleanTitle.match(regex);
                        if (match && match[1]) {
                            year = parseInt(match[1], 10);
                            cleanTitle = cleanTitle.replace(regex, '');
                        }
                    } catch (e) {}
                }

                // Extract quality
                if (qualityPattern) {
                    try {
                        const regex = new RegExp(qualityPattern, 'i');
                        const match = cleanTitle.match(regex);
                        if (match && match[1]) {
                            quality = match[1].toUpperCase();
                            cleanTitle = cleanTitle.replace(new RegExp(qualityPattern, 'gi'), '');
                        }
                    } catch (e) {}
                }

                // Clean up title
                cleanTitle = cleanTitle.replace(/^[\s\-–:★❖]+/, '').replace(/[\s\-–:★❖]+$/, '').trim();
                cleanTitle = cleanTitle.replace(/\s+/g, ' ').trim();

                // If cleanTitle is empty but we extracted a year, use the year as the title
                // (handles cases like "DE ★ 1923" where "1923" is the actual show title)
                if (!cleanTitle && year) {
                    cleanTitle = String(year);
                }

                // Clean up category if patterns are available
                let cleanCategory = entry.category || '';
                const categoryCleanup = parserConfig.categoryCleanup;
                if (categoryCleanup?.removePatterns && Array.isArray(categoryCleanup.removePatterns)) {
                    for (const pattern of categoryCleanup.removePatterns) {
                        try {
                            const regex = new RegExp(pattern, 'gi');
                            cleanCategory = cleanCategory.replace(regex, '');
                        } catch (e) {}
                    }
                    cleanCategory = cleanCategory.trim();
                }

                // Update the entry (use cleanTitle or fall back to sourceTitle which preserves the original)
                // Also update show_name for series to ensure the grouped view shows clean titles
                const finalTitle = cleanTitle || sourceTitle;
                await db.run(`
                    UPDATE media
                    SET title = ?, show_name = CASE WHEN media_type = 'series' THEN ? ELSE show_name END,
                        year = COALESCE(?, year), language = COALESCE(?, language), quality = COALESCE(?, quality), category = ?
                    WHERE id = ?
                `, [finalTitle, finalTitle, year, language, quality, cleanCategory || entry.category, entry.id]);

                processed++;
            }

            logger?.info('app', `Reprocessed ${processed} entries for source ${source.name}`);
            res.json({ success: true, processed, total: entries.length });
        } catch (err) {
            logger?.error('app', `Reprocess failed: ${err.message}`);
            res.status(500).json({ error: err.message });
        }
    });

    // AI-powered pattern analysis
    router.post('/sources/:id/analyze-ai', async (req, res) => {
        try {
            const db = modules.db;
            const source = await db.get('SELECT * FROM sources WHERE id = ?', [req.params.id]);
            if (!source) return res.status(404).json({ error: 'Source not found' });

            const llm = modules.llm;
            if (!llm?.isConfigured()) {
                return res.status(400).json({ error: 'LLM not configured. Please configure OpenAI or Ollama in settings.' });
            }

            const { samples } = req.body;
            if (!samples) {
                return res.status(400).json({ error: 'samples are required' });
            }

            // Build prompt with sample data
            const movieSamples = (samples.movies || []).map(m => `  - Name: "${m.name}", Category: "${m.category}"`).join('\n');
            const seriesSamples = (samples.series || []).map(s => `  - Name: "${s.name}", Category: "${s.category}"`).join('\n');
            const livetvSamples = (samples.livetv || []).map(l => `  - Name: "${l.name}", Category: "${l.category}"`).join('\n');

            const prompt = `Analyze these IPTV M3U entries and generate regex patterns to extract metadata.

Sample MOVIES entries:
${movieSamples || '  (none available)'}

Sample SERIES entries:
${seriesSamples || '  (none available)'}

Sample LIVE TV entries:
${livetvSamples || '  (none available)'}

Based on these samples, generate regex patterns that would work for this IPTV source.
Look for common patterns like:
- Language codes at the start (e.g., "DE - ", "EN: ", "[DE]", "DE ★")
- Year in title (e.g., "(2024)", "- 2024")
- Quality indicators (4K, HD, FHD)
- Category keywords that distinguish movies from series from live TV

ALSO analyze the category names and provide patterns to clean them:
- Remove year ranges like "[2020/2024]" or "(2023-2024)"
- Remove language prefixes like "EN ", "FR ", "DE " at start
- Remove special symbols like ✪, ◉, ❖ and similar decorations
- Identify the clean category name (e.g., "✪ EN NETFLIX" -> "NETFLIX", "◉ FR HBO MAX" -> "HBO MAX")

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "titlePatterns": {
    "language": "regex pattern to extract 2-letter language code or null if not found",
    "year": "regex pattern to extract 4-digit year or null if not found"
  },
  "contentTypePatterns": {
    "movies": "regex pattern matching movie categories/titles",
    "series": "regex pattern matching series categories/titles"
  },
  "categoryCleanup": {
    "removePatterns": ["array of regex patterns to remove from category names"],
    "examples": [{"original": "✪ EN NETFLIX", "cleaned": "NETFLIX"}]
  },
  "confidence": 0.85
}`;

            logger?.info('app', 'Running AI pattern analysis...');
            const result = await llm.query(prompt, {
                temperature: 0.2,
                maxTokens: 1000,
                timeout: 60000
            });

            // Extract JSON from response
            const jsonMatch = result.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                return res.status(500).json({ error: 'AI did not return valid patterns' });
            }

            const patterns = JSON.parse(jsonMatch[0]);
            logger?.info('app', `AI analysis complete, confidence: ${patterns.confidence}`);

            res.json({ success: true, patterns });
        } catch (err) {
            logger?.error('app', `AI analysis failed: ${err.message}`);
            // Check for API key issues
            if (err.message?.includes('401') || err.message?.includes('API key') || err.message?.includes('Incorrect')) {
                return res.status(401).json({ error: 'Invalid OpenAI API key. Please check your API key in settings.' });
            }
            res.status(500).json({ error: err.message });
        }
    });

    // =====================
    // Usenet Provider Routes
    // =====================

    // Get all usenet providers
    router.get('/usenet/providers', async (req, res) => {
        try {
            const db = modules.db;
            const providers = await db.all('SELECT * FROM usenet_providers ORDER BY priority DESC, name');
            // Don't send passwords to frontend
            const safeProviders = providers.map(p => ({ ...p, password: p.password ? '********' : '' }));
            res.json(safeProviders);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Add usenet provider
    router.post('/usenet/providers', async (req, res) => {
        try {
            const db = modules.db;
            const { name, host, port, ssl, username, password, connections, priority, retention_days } = req.body;

            if (!name || !host) {
                return res.status(400).json({ error: 'Name and host are required' });
            }

            const result = await db.run(`
                INSERT INTO usenet_providers (name, host, port, ssl, username, password, connections, priority, retention_days)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [name, host, port || 563, ssl !== false ? 1 : 0, username || '', password || '', connections || 10, priority || 0, retention_days || 3000]);

            res.json({ success: true, id: result.lastID });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Update usenet provider
    router.put('/usenet/providers/:id', async (req, res) => {
        try {
            const db = modules.db;
            const { name, host, port, ssl, username, password, connections, priority, enabled, retention_days } = req.body;

            // Build update query dynamically to handle password updates
            const updates = [];
            const params = [];

            if (name !== undefined) { updates.push('name = ?'); params.push(name); }
            if (host !== undefined) { updates.push('host = ?'); params.push(host); }
            if (port !== undefined) { updates.push('port = ?'); params.push(port); }
            if (ssl !== undefined) { updates.push('ssl = ?'); params.push(ssl ? 1 : 0); }
            if (username !== undefined) { updates.push('username = ?'); params.push(username); }
            if (password !== undefined && password !== '********') { updates.push('password = ?'); params.push(password); }
            if (connections !== undefined) { updates.push('connections = ?'); params.push(connections); }
            if (priority !== undefined) { updates.push('priority = ?'); params.push(priority); }
            if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }
            if (retention_days !== undefined) { updates.push('retention_days = ?'); params.push(retention_days); }

            if (updates.length === 0) {
                return res.status(400).json({ error: 'No fields to update' });
            }

            params.push(req.params.id);
            await db.run(`UPDATE usenet_providers SET ${updates.join(', ')} WHERE id = ?`, params);

            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Delete usenet provider
    router.delete('/usenet/providers/:id', async (req, res) => {
        try {
            const db = modules.db;
            await db.run('DELETE FROM usenet_providers WHERE id = ?', [req.params.id]);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Test usenet provider connection
    router.post('/usenet/providers/:id/test', async (req, res) => {
        try {
            const db = modules.db;
            const provider = await db.get('SELECT * FROM usenet_providers WHERE id = ?', [req.params.id]);

            if (!provider) {
                return res.status(404).json({ error: 'Provider not found' });
            }

            // If usenet module is loaded, use it to test
            if (modules.usenet) {
                const result = await modules.usenet.testProvider(provider);
                res.json(result);
            } else {
                // Basic connection test using net/tls
                const net = require('net');
                const tls = require('tls');

                const socket = provider.ssl ? tls.connect({
                    host: provider.host,
                    port: provider.port,
                    rejectUnauthorized: false
                }) : net.connect({
                    host: provider.host,
                    port: provider.port
                });

                const timeout = setTimeout(() => {
                    socket.destroy();
                    res.json({ success: false, error: 'Connection timeout' });
                }, 10000);

                socket.once('connect', () => {
                    clearTimeout(timeout);
                    socket.destroy();
                    res.json({ success: true, message: 'Connected successfully' });
                });

                socket.once('error', (err) => {
                    clearTimeout(timeout);
                    res.json({ success: false, error: err.message });
                });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // =====================
    // Newznab Indexer Routes
    // =====================

    // Test newznab indexer (for source add/edit)
    router.post('/newznab/test', async (req, res) => {
        try {
            if (!modules.newznab) {
                return res.status(500).json({ error: 'Newznab module not loaded' });
            }

            const result = await modules.newznab.testIndexer(req.body);
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Search newznab indexer
    router.get('/newznab/:indexerId/search', async (req, res) => {
        try {
            if (!modules.newznab) {
                return res.status(500).json({ error: 'Newznab module not loaded' });
            }

            const { q, type, imdbId, tmdbId, tvdbId, season, episode, limit } = req.query;
            const indexerId = parseInt(req.params.indexerId, 10);
            const options = { imdbId, tmdbId, tvdbId, season, episode, limit: parseInt(limit) || 100 };

            let results;
            if (type === 'movie') {
                results = await modules.newznab.searchMovies(indexerId, q, options);
            } else if (type === 'tv') {
                results = await modules.newznab.searchTv(indexerId, q, options);
            } else {
                results = await modules.newznab.search(indexerId, q, options);
            }

            res.json(results);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Grab NZB and queue download
    router.post('/newznab/:indexerId/grab', async (req, res) => {
        try {
            if (!modules.newznab) {
                return res.status(500).json({ error: 'Newznab module not loaded' });
            }

            const db = modules.db;
            const indexerId = parseInt(req.params.indexerId, 10);
            const { guid, title, mediaId } = req.body;

            if (!guid) {
                return res.status(400).json({ error: 'GUID is required' });
            }

            // Download NZB content
            const nzbContent = await modules.newznab.getNzb(indexerId, guid);

            // Create download entry
            const mediaInfo = mediaId ? await db.get('SELECT * FROM media WHERE id = ?', [mediaId]) : null;
            const downloadType = mediaInfo?.media_type || 'movie';

            const downloadResult = await db.run(`
                INSERT INTO downloads (media_id, source_id, status, filename, download_type, created_at)
                VALUES (?, ?, 'pending', ?, ?, CURRENT_TIMESTAMP)
            `, [mediaId || null, indexerId, title || guid, downloadType === 'series' ? 'episode' : 'movie']);

            const downloadId = downloadResult.lastID;

            // Store NZB data
            await db.run(`
                INSERT INTO nzb_downloads (download_id, nzb_name, nzb_content)
                VALUES (?, ?, ?)
            `, [downloadId, title || guid, nzbContent]);

            // Queue for usenet download if module is loaded
            if (modules.usenet) {
                await modules.usenet.queueNzb(downloadId, nzbContent);
            }

            res.json({ success: true, downloadId });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get indexer capabilities
    router.get('/newznab/:indexerId/caps', async (req, res) => {
        try {
            if (!modules.newznab) {
                return res.status(500).json({ error: 'Newznab module not loaded' });
            }

            const caps = await modules.newznab.getCapabilities(parseInt(req.params.indexerId, 10));
            res.json(caps);
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
            const db = modules.db;
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

    // Get EPG channels for a source
    router.get('/epg/channels', async (req, res) => {
        try {
            if (!modules.epg) return res.status(500).json({ error: 'EPG module not loaded' });
            const sourceId = req.query.sourceId ? parseInt(req.query.sourceId) : null;
            const channels = await modules.epg.getChannelsWithEpg(sourceId);
            res.json(channels);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get Live TV channels that have EPG mapping (tvg_id set)
    router.get('/epg/live-channels', async (req, res) => {
        try {
            const db = modules.db;
            const channels = await db.all(`
                SELECT id, title, tvg_id, poster, stream_url, category
                FROM media
                WHERE media_type = 'live'
                  AND tvg_id IS NOT NULL
                  AND tvg_id != ''
                ORDER BY title
            `);
            res.json(channels);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Sync EPG for all sources with EPG URLs
    router.post('/epg/sync-all', async (req, res) => {
        try {
            if (!modules.epg) return res.status(500).json({ error: 'EPG module not loaded' });

            io?.emit('epg:start', { message: 'Syncing EPG for all sources...' });

            // Run sync in background
            modules.epg.syncAllSourcesEpg().then(result => {
                io?.emit('epg:complete', result);
            }).catch(err => {
                io?.emit('epg:error', { error: err.message });
            });

            res.json({ success: true, message: 'EPG sync started for all sources' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get EPG program guide for a time range (GET for small requests, POST for large channel lists)
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

    // POST version for large channel lists (avoids URL length limits)
    router.post('/epg/guide', async (req, res) => {
        try {
            if (!modules.epg) return res.status(500).json({ error: 'EPG module not loaded' });

            const { start: startStr, end: endStr, channels } = req.body;
            const start = startStr ? new Date(startStr) : new Date();
            const end = endStr ? new Date(endStr) : new Date(start.getTime() + 6 * 60 * 60 * 1000);

            const programs = await modules.epg.getProgramGuide(start, end, channels);
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

    // =====================================================
    // HDHomeRun Emulator endpoints
    // =====================================================

    // Get HDHR status
    router.get('/hdhr/status', async (req, res) => {
        try {
            if (!modules.hdhr) return res.json({ enabled: false, running: false });
            res.json(modules.hdhr.getStatus());
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Start/stop HDHR emulator
    router.post('/hdhr/toggle', async (req, res) => {
        try {
            if (!modules.hdhr) return res.status(500).json({ error: 'HDHR module not loaded' });
            const { enabled } = req.body;

            if (enabled) {
                await modules.hdhr.start();
                modules.settings.set('hdhrEnabled', true);
            } else {
                await modules.hdhr.stop();
                modules.settings.set('hdhrEnabled', false);
            }

            res.json(modules.hdhr.getStatus());
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get all channels available for HDHR
    router.get('/hdhr/channels/available', async (req, res) => {
        try {
            if (!modules.hdhr) return res.status(500).json({ error: 'HDHR module not loaded' });
            const channels = await modules.hdhr.getAvailableChannels();
            res.json(channels);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get enabled HDHR channels (lineup)
    router.get('/hdhr/channels', async (req, res) => {
        try {
            if (!modules.hdhr) return res.status(500).json({ error: 'HDHR module not loaded' });
            const channels = await modules.hdhr.getEnabledChannels();
            res.json(channels);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get categories for channel selection
    router.get('/hdhr/categories', async (req, res) => {
        try {
            if (!modules.hdhr) return res.status(500).json({ error: 'HDHR module not loaded' });
            const categories = await modules.hdhr.getCategories();
            res.json(categories);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Add channel to HDHR lineup
    router.post('/hdhr/channels', async (req, res) => {
        try {
            if (!modules.hdhr) return res.status(500).json({ error: 'HDHR module not loaded' });
            const { mediaId, guideNumber, guideName } = req.body;
            await modules.hdhr.addChannel(mediaId, guideNumber, guideName);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Remove channel from HDHR lineup
    router.delete('/hdhr/channels/:id', async (req, res) => {
        try {
            if (!modules.hdhr) return res.status(500).json({ error: 'HDHR module not loaded' });
            await modules.hdhr.removeChannel(parseInt(req.params.id));
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Toggle channel enabled/disabled
    router.post('/hdhr/channels/:id/toggle', async (req, res) => {
        try {
            if (!modules.hdhr) return res.status(500).json({ error: 'HDHR module not loaded' });
            const { enabled } = req.body;
            await modules.hdhr.toggleChannel(parseInt(req.params.id), enabled);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Add all channels from a category
    router.post('/hdhr/categories/add', async (req, res) => {
        try {
            if (!modules.hdhr) return res.status(500).json({ error: 'HDHR module not loaded' });
            const { category, sourceId, startNumber } = req.body;
            const count = await modules.hdhr.addChannelsByCategory(category, sourceId, startNumber || 1);
            res.json({ success: true, added: count });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Clear all HDHR channels
    router.delete('/hdhr/channels', async (req, res) => {
        try {
            if (!modules.hdhr) return res.status(500).json({ error: 'HDHR module not loaded' });
            await modules.hdhr.clearAllChannels();
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Rebuild lineup (auto-number channels)
    router.post('/hdhr/lineup/rebuild', async (req, res) => {
        try {
            if (!modules.hdhr) return res.status(500).json({ error: 'HDHR module not loaded' });
            const count = await modules.hdhr.rebuildLineup();
            res.json({ success: true, channels: count });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get XMLTV EPG (also available on HDHR port, but exposed here for convenience)
    router.get('/hdhr/xmltv', async (req, res) => {
        try {
            if (!modules.hdhr) return res.status(500).json({ error: 'HDHR module not loaded' });
            const xml = await modules.hdhr.generateXmltv();
            res.set('Content-Type', 'application/xml');
            res.send(xml);
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

    // Clear all non-active items from transcode queue (completed, skipped, failed)
    router.post('/transcoder/clear', async (req, res) => {
        try {
            const result = await modules.db.run(`
                DELETE FROM transcode_queue
                WHERE status IN ('completed', 'skipped', 'failed')
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
            const activeStats = modules.download?.getActiveStats?.() || {};
            const enriched = downloads.map((item) => {
                const stats = activeStats[item.id];
                if (stats) {
                    return {
                        ...item,
                        speed_bps: stats.speedBps || 0,
                        paused: stats.paused === true
                    };
                }
                return item;
            });
            res.json(enriched);
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

    // Clear completed downloads
    router.post('/downloads/clear-completed', async (req, res) => {
        try {
            const result = await modules.db.run(`
                DELETE FROM downloads
                WHERE status = 'completed'
            `);
            res.json({ success: true, deleted: result.changes });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Clear failed downloads
    router.post('/downloads/clear-failed', async (req, res) => {
        try {
            const result = await modules.db.run(`
                DELETE FROM downloads
                WHERE status IN ('failed', 'cancelled')
            `);
            res.json({ success: true, deleted: result.changes });
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

    // Database maintenance endpoints
    router.post('/db/reset-content', async (req, res) => {
        try {
            logger.warn('db', 'Content database reset requested');

            // Tables to drop (content tables, not config/sources)
            const contentTables = [
                'media',
                'media_trailers',
                'media_people',
                'people',
                'seasons',
                'episodes',
                'epg_programs',
                'epg_channel_cache',
                'epg_sync',
                'enrichment_queue',
                'enrichment_cache',
                'tmdb_cache',
                'channel_mappings',
                'hdhr_channels',
                'source_samples',
                'm3u_history'
            ];

            // Drop each table
            for (const table of contentTables) {
                try {
                    await modules.db.run(`DROP TABLE IF EXISTS ${table}`);
                    logger.info('db', `Dropped table: ${table}`);
                } catch (err) {
                    logger.warn('db', `Failed to drop ${table}: ${err.message}`);
                }
            }

            // Reset migration tracking so tables get recreated on restart
            // Keep migrations 1-10 (sources, downloads, settings, requests etc.)
            // Reset migrations 11+ (content tables)
            await modules.db.run('DELETE FROM migrations WHERE version > 10');
            logger.info('db', 'Reset migration tracking for content tables');

            logger.info('db', 'Content database reset complete - server will exit');
            res.json({ success: true, message: 'Content database reset. The server will now exit. Please restart it manually.' });

            // Exit after sending response - process manager or user will restart
            setTimeout(() => {
                logger.info('db', 'Exiting for database reset...');
                process.exit(0);
            }, 500);
        } catch (err) {
            logger.error('db', 'Content database reset failed', { error: err.message });
            res.status(500).json({ success: false, error: err.message });
        }
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

            // For live TV, get categories with their associated language for proper grouping
            let categories;
            if (type === 'live') {
                categories = await modules.db.all(`
                    SELECT DISTINCT category, language
                    FROM media
                    WHERE category IS NOT NULL AND media_type = 'live' AND is_active = 1
                    ORDER BY category
                `);
            } else {
                categories = await modules.db.all(`SELECT DISTINCT category FROM media WHERE category IS NOT NULL ${typeFilter} ORDER BY category`, typeParam);
            }
            const sources = await modules.db.all('SELECT id, name FROM sources ORDER BY name');

            // Get genres - stored as comma or slash separated values, need to parse and dedupe
            const genresRows = await modules.db.all(`SELECT DISTINCT genres FROM media WHERE genres IS NOT NULL AND genres != '' ${typeFilter}`, typeParam);
            const genreSet = new Set();
            genresRows.forEach(row => {
                // Split by comma or slash
                row.genres.split(/[,\/]/).forEach(g => {
                    const genre = g.trim();
                    if (genre) genreSet.add(genre);
                });
            });

            // Filter languages by preferred settings if configured
            const preferredLangs = expandPreferredLanguages(modules.settings?.get('preferredLanguages') || []);
            let filteredLanguages = languages.map(l => l.language);
            if (preferredLangs.length > 0) {
                const preferredUpper = preferredLangs.map(l => l.toUpperCase());
                filteredLanguages = filteredLanguages.filter(lang =>
                    lang && preferredUpper.includes(lang.toUpperCase())
                );
            }

            // Clean and sort categories - include language for live TV grouping
            const cleanedCategories = categories
                .map(c => ({
                    value: c.category,
                    display_name: modules.hdhr.cleanCategoryName(c.category),
                    language: c.language || null  // Include language for live TV country grouping
                }))
                .sort((a, b) => a.display_name.localeCompare(b.display_name, undefined, { sensitivity: 'base' }));

            res.json({
                years: years.map(y => y.year),
                qualities: qualities.map(q => q.quality),
                languages: filteredLanguages,
                categories: cleanedCategories,
                genres: Array.from(genreSet).sort(),
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

    // Enrich a single media item by ID
    router.post('/media/:id/enrich', async (req, res) => {
        try {
            const mediaId = parseInt(req.params.id);
            const db = modules.db;

            // Get the media item
            const media = await db.get('SELECT * FROM media WHERE id = ?', [mediaId]);
            if (!media) {
                return res.status(404).json({ error: 'Media not found' });
            }

            // Clear enrichment cache for this item (generate cache key same way as enrichment module)
            const normalizedTitle = media.title?.toLowerCase()
                .replace(/[^a-z0-9]/g, '')
                .substring(0, 100) || '';
            const cacheKey = `${normalizedTitle}|${media.year || ''}|${media.media_type}`;
            await db.run('DELETE FROM enrichment_cache WHERE cache_key = ? OR cache_key LIKE ?',
                [cacheKey, `${normalizedTitle}|%`]);

            // Clear old trailers (they may be from wrong TMDB match)
            await db.run('DELETE FROM media_trailers WHERE media_id = ?', [mediaId]);

            logger.info('api', `Cleared enrichment cache and trailers for: ${media.title}`);

            // Reset enrichment_attempted and all TMDB data to allow fresh re-enrichment
            await db.run(`UPDATE media SET
                enrichment_attempted = NULL,
                tmdb_id = NULL,
                poster = NULL,
                backdrop = NULL,
                plot = NULL,
                genres = NULL,
                rating = NULL,
                year = NULL
                WHERE id = ?`, [mediaId]);

            // Queue it for enrichment with high priority
            if (modules.enrichment) {
                await modules.enrichment.queueMediaForEnrichment([mediaId], 100);

                // Start workers if not running
                if (!modules.enrichment.isRunning()) {
                    await modules.enrichment.startWorkers();
                }

                res.json({
                    success: true,
                    message: `Queued "${media.title}" for enrichment`,
                    mediaId: mediaId
                });
            } else {
                res.status(400).json({ error: 'Enrichment module not loaded' });
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

    // =========================================================================
    // ENRICHMENT CACHE ENDPOINTS
    // Cache stores TMDB data so it persists across provider changes
    // =========================================================================

    // Get enrichment cache statistics
    router.get('/enrich/cache/stats', async (req, res) => {
        try {
            if (!modules.enrichment) {
                return res.status(400).json({ error: 'Enrichment module not loaded' });
            }
            const stats = await modules.enrichment.getCacheStats();
            res.json(stats);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Populate enrichment cache from existing enriched media
    // Call this before switching providers to backup enrichment data
    router.post('/enrich/cache/populate', async (req, res) => {
        try {
            if (!modules.enrichment) {
                return res.status(400).json({ error: 'Enrichment module not loaded' });
            }
            const result = await modules.enrichment.populateEnrichmentCache();
            res.json({
                message: 'Enrichment cache populated',
                ...result
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // =========================================================================
    // ON-DEMAND ENRICHMENT ENDPOINTS
    // These provide instant enrichment for visible content
    // =========================================================================

    /**
     * Instant enrichment for a single media item
     * Returns enriched data immediately (synchronous)
     * Use for: detail page views, user-initiated refresh
     */
    router.post('/enrich/instant/:id', async (req, res) => {
        try {
            const mediaId = parseInt(req.params.id);
            const { highPriority = true, forceRefresh = false } = req.body;

            if (!modules.enrichment) {
                return res.status(400).json({ error: 'Enrichment module not loaded' });
            }

            const result = await modules.enrichment.enrichItemSync(mediaId, {
                highPriority,
                forceRefresh
            });

            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /**
     * Batch enrichment for visible page items
     * Enriches multiple items and persists to database
     * Use for: list page loads (movies/series grid)
     */
    router.post('/enrich/batch', async (req, res) => {
        try {
            const { mediaIds, highPriority = false } = req.body;

            if (!mediaIds || !Array.isArray(mediaIds)) {
                return res.status(400).json({ error: 'mediaIds array required' });
            }

            if (mediaIds.length > 50) {
                return res.status(400).json({ error: 'Maximum 50 items per batch' });
            }

            if (!modules.enrichment) {
                return res.status(400).json({ error: 'Enrichment module not loaded' });
            }

            const result = await modules.enrichment.enrichBatch(mediaIds, { highPriority });
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /**
     * Batch enrichment for shows by name
     * Enriches all media items for given show names
     * Use for: series list page loads
     */
    router.post('/enrich/shows', async (req, res) => {
        try {
            const { showNames, highPriority = false } = req.body;
            const db = modules.db;

            if (!showNames || !Array.isArray(showNames)) {
                return res.status(400).json({ error: 'showNames array required' });
            }

            if (showNames.length > 50) {
                return res.status(400).json({ error: 'Maximum 50 shows per batch' });
            }

            if (!modules.enrichment) {
                return res.status(400).json({ error: 'Enrichment module not loaded' });
            }

            // Get one media ID per show (to get poster/backdrop for the show)
            const placeholders = showNames.map(() => '?').join(',');
            const mediaItems = await db.all(`
                SELECT MIN(id) as id, show_name
                FROM media
                WHERE show_name IN (${placeholders})
                AND media_type = 'series'
                GROUP BY show_name
            `, showNames);

            // Create mapping from mediaId to showName
            const idToShowName = {};
            for (const item of mediaItems) {
                idToShowName[item.id] = item.show_name;
            }

            const mediaIds = mediaItems.map(m => m.id);

            if (mediaIds.length === 0) {
                return res.json({ total: 0, enriched: 0, skipped: 0, failed: 0, results: [] });
            }

            const result = await modules.enrichment.enrichBatch(mediaIds, { highPriority });

            // Add showName to each result for UI matching
            if (result.results) {
                for (const item of result.results) {
                    item.showName = idToShowName[item.mediaId];
                }
            }

            res.json(result);
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
    router.get('/tmdb/movie/:id', tmdbRateLimiter, async (req, res) => {
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

    router.get('/tmdb/tv/:id', tmdbRateLimiter, async (req, res) => {
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
    router.get('/tmdb/search/movie', tmdbRateLimiter, async (req, res) => {
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

    router.get('/tmdb/search/tv', tmdbRateLimiter, async (req, res) => {
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

    router.get('/tmdb/tv/:id/season/:season', tmdbRateLimiter, async (req, res) => {
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
            const { search, quality, year, language, source, platform, genre, sort, order, limit, offset, recently_added, include_inactive } = req.query;
            const db = modules.db;

            // Build WHERE clause separately for reuse in count query
            let whereClause = `WHERE m.media_type = 'series' AND m.show_name IS NOT NULL AND m.show_name != '' AND s.active = 1`;
            const params = [];

            // Filter out inactive items unless explicitly requested
            if (include_inactive !== 'true') {
                whereClause += ' AND (m.is_active = 1 OR m.is_active IS NULL)';
            }

            if (search) {
                whereClause += ' AND m.show_name LIKE ?';
                params.push(`%${search}%`);
            }

            if (quality) {
                whereClause += ' AND m.quality = ?';
                params.push(quality);
            }

            if (year) {
                whereClause += ' AND (m.year = ? OR m.title LIKE ?)';
                params.push(parseInt(year), `%(${year})%`);
            }

            if (language) {
                // Check both show_language (from episodes) and language (from M3U sources)
                whereClause += ' AND (m.show_language = ? OR (m.show_language IS NULL AND m.language = ?))';
                params.push(language, language);
            }

            if (source) {
                whereClause += ' AND m.source_id = ?';
                params.push(parseInt(source));
            }
            if (platform) {
                // Platform filter now uses category field
                whereClause += ' AND m.category = ?';
                params.push(platform);
            }

            if (genre) {
                whereClause += ' AND m.genres LIKE ?';
                params.push(`%${genre}%`);
            }

            // Filter by recently added (last N days)
            if (recently_added) {
                const days = parseInt(recently_added) || 14;
                whereClause += ` AND m.created_at >= datetime('now', '-${days} days')`;
            }

            // Build main query with SELECT and GROUP BY
            let sql = `
                SELECT
                    m.show_name,
                    COUNT(*) as episode_count,
                    COUNT(DISTINCT m.season_number) as season_count,
                    GROUP_CONCAT(DISTINCT COALESCE(m.show_language, m.language)) as languages,
                    MAX(m.poster) as poster,
                    MAX(m.rating) as rating,
                    MAX(m.year) as year,
                    MAX(m.quality) as quality,
                    MAX(m.created_at) as created_at,
                    MAX(m.tmdb_id) as tmdb_id,
                    MAX(CASE WHEN EXISTS(
                        SELECT 1 FROM media_trailers mt WHERE mt.media_id = m.id
                    ) THEN 1 ELSE 0 END) as has_trailer
                FROM media m
                JOIN sources s ON m.source_id = s.id
                ${whereClause}
                GROUP BY m.show_name`;

            // Build count query using same WHERE clause
            const countSql = `SELECT COUNT(DISTINCT m.show_name) as total FROM media m JOIN sources s ON m.source_id = s.id ${whereClause}`;
            const countParams = [...params];

            // Sorting
            const sortField = ['show_name', 'year', 'rating', 'episode_count', 'created_at'].includes(sort) ? sort : 'show_name';
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

            const [shows, countResult] = await Promise.all([
                db.all(sql, params),
                db.get(countSql, countParams)
            ]);
            const totalCount = countResult?.total || 0;

            // Add is_new flag for items created in the last 14 days
            const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
            for (const show of shows) {
                show.is_new = show.created_at && show.created_at >= twoWeeksAgo;
            }

            res.json({ items: shows, total: totalCount });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get available categories for filter dropdown (was platforms)
    router.get('/platforms', async (req, res) => {
        try {
            const db = modules.db;
            const { type } = req.query;

            let sql = `
                SELECT category, COUNT(*) as count
                FROM media
                WHERE category IS NOT NULL AND category != ''
            `;
            const params = [];

            if (type) {
                sql += ' AND media_type = ?';
                params.push(type);
            }

            sql += ' GROUP BY category';

            const categories = await db.all(sql, params);

            // Clean category names and sort alphabetically
            const cleanedCategories = categories.map(c => ({
                platform: c.category,
                display_name: modules.hdhr.cleanCategoryName(c.category),
                count: c.count
            }))
            .sort((a, b) => a.display_name.localeCompare(b.display_name, undefined, { sensitivity: 'base' }));

            res.json(cleanedCategories);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Debug endpoint to check media classification and platform distribution
    router.get('/debug/media-stats', async (req, res) => {
        try {
            const db = modules.db;

            // Get media type and is_active breakdown
            const typeStats = await db.all(`
                SELECT media_type, is_active, COUNT(*) as count
                FROM media
                GROUP BY media_type, is_active
                ORDER BY media_type, is_active
            `);

            // Get platform distribution
            const platformStats = await db.all(`
                SELECT platform, media_type, COUNT(*) as count
                FROM media
                WHERE platform IS NOT NULL
                GROUP BY platform, media_type
                ORDER BY count DESC
            `);

            // Get category samples for debugging classification
            const categorySamples = await db.all(`
                SELECT media_type, category, COUNT(*) as count
                FROM media
                WHERE category IS NOT NULL
                GROUP BY media_type, category
                ORDER BY count DESC
                LIMIT 50
            `);

            res.json({
                type_breakdown: typeStats,
                platform_breakdown: platformStats,
                top_categories: categorySamples
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Activate all media items (useful after migration fixes)
    router.post('/debug/activate-all', async (req, res) => {
        try {
            const db = modules.db;
            const result = await db.run('UPDATE media SET is_active = 1 WHERE is_active = 0 OR is_active IS NULL');
            res.json({ success: true, updated: result.changes });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get single show details with episodes grouped by language and season
    router.get('/shows/:name', async (req, res) => {
        try {
            const db = modules.db;
            let showName = decodeURIComponent(req.params.name);

            // Check if :name is actually a numeric ID - if so, look up the show_name
            if (/^\d+$/.test(showName)) {
                const mediaItem = await db.get('SELECT show_name FROM media WHERE id = ? AND media_type = ?', [showName, 'series']);
                if (mediaItem && mediaItem.show_name) {
                    showName = mediaItem.show_name;
                }
            }

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
    router.get('/shows/:name/tmdb', tmdbRateLimiter, async (req, res) => {
        try {
            const db = modules.db;
            let showName = decodeURIComponent(req.params.name);

            // Check if :name is actually a numeric ID - if so, look up the show_name
            if (/^\d+$/.test(showName)) {
                const mediaItem = await db.get('SELECT show_name FROM media WHERE id = ? AND media_type = ?', [showName, 'series']);
                if (mediaItem && mediaItem.show_name) {
                    showName = mediaItem.show_name;
                }
            }

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

    // Get trailers for a show by name (from stored database trailers)
    router.get('/shows/:name/trailers', async (req, res) => {
        try {
            const db = modules.db;
            let showName = decodeURIComponent(req.params.name);

            // Check if :name is actually a numeric ID - if so, look up the show_name
            if (/^\d+$/.test(showName)) {
                const mediaItem = await db.get('SELECT show_name FROM media WHERE id = ? AND media_type = ?', [showName, 'series']);
                if (mediaItem && mediaItem.show_name) {
                    showName = mediaItem.show_name;
                }
            }

            // Find a media entry for this show to get its trailers
            const seriesEntry = await db.get(`
                SELECT id FROM media
                WHERE media_type = 'series'
                  AND show_name = ?
                LIMIT 1
            `, [showName]);

            if (!seriesEntry) {
                return res.json([]);
            }

            // Get trailers for this media (same format as /media/:id/trailers)
            const trailers = await db.all(`
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
            `, [seriesEntry.id]);

            res.json(trailers);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Fetch episodes on-demand for a show (lazy loading from Xtream API)
    router.post('/shows/:name/fetch-episodes', async (req, res) => {
        try {
            const db = modules.db;
            let showName = decodeURIComponent(req.params.name);

            // Check if :name is actually a numeric ID
            if (/^\d+$/.test(showName)) {
                const mediaItem = await db.get('SELECT show_name FROM media WHERE id = ? AND media_type = ?', [showName, 'series']);
                if (mediaItem && mediaItem.show_name) {
                    showName = mediaItem.show_name;
                }
            }

            // Get series entries for this show
            const seriesEntries = await db.all(`
                SELECT m.id, m.external_id, m.source_id, s.url, s.username, s.password, s.type
                FROM media m
                JOIN sources s ON m.source_id = s.id
                WHERE m.media_type = 'series' AND m.show_name = ? AND s.type = 'xtream'
            `, [showName]);

            if (seriesEntries.length === 0) {
                return res.status(404).json({ error: 'No Xtream series found for this show' });
            }

            let totalEpisodes = 0;
            const axios = require('axios');

            for (const series of seriesEntries) {
                // Check if episodes already exist
                const existingCount = await db.get('SELECT COUNT(*) as count FROM episodes WHERE media_id = ?', [series.id]);
                if (existingCount.count > 0) {
                    totalEpisodes += existingCount.count;
                    continue; // Already have episodes
                }

                // Fetch from Xtream API
                const baseUrl = series.url.replace(/\/+$/, '');
                const episodesUrl = `${baseUrl}/player_api.php?username=${series.username}&password=${series.password}&action=get_series_info&series_id=${series.external_id}`;

                try {
                    const response = await axios.get(episodesUrl, { timeout: 30000 });
                    const episodes = response.data?.episodes || {};

                    // Insert episodes
                    for (const [season, eps] of Object.entries(episodes)) {
                        for (const ep of eps) {
                            const ext = ep.container_extension || 'mkv';
                            const streamUrl = `${baseUrl}/series/${series.username}/${series.password}/${ep.id}.${ext}`;

                            await db.run(`
                                INSERT INTO episodes (media_id, external_id, season, episode, title, plot, air_date, runtime, stream_url, container)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                ON CONFLICT(media_id, season, episode) DO UPDATE SET
                                    external_id = excluded.external_id,
                                    title = COALESCE(excluded.title, episodes.title),
                                    stream_url = excluded.stream_url,
                                    container = excluded.container
                            `, [
                                series.id, String(ep.id), parseInt(season), ep.episode_num,
                                ep.title, ep.info?.plot || null, ep.info?.air_date || null,
                                ep.info?.duration_secs ? Math.floor(ep.info.duration_secs / 60) : null,
                                streamUrl, ext
                            ]);
                            totalEpisodes++;
                        }
                    }

                    logger.info('app', `Fetched ${totalEpisodes} episodes for "${showName}" from source ${series.source_id}`);
                } catch (err) {
                    logger.warn('app', `Failed to fetch episodes for series ${series.external_id}: ${err.message}`);
                }
            }

            res.json({ success: true, episodeCount: totalEpisodes });
        } catch (err) {
            logger.error('app', `Failed to fetch episodes: ${err.message}`);
            res.status(500).json({ error: err.message });
        }
    });

    // Enrich a show by name (all media items for that show)
    router.post('/shows/:name/enrich', async (req, res) => {
        try {
            const db = modules.db;
            let showName = decodeURIComponent(req.params.name);

            // Check if :name is actually a numeric ID - if so, look up the show_name
            if (/^\d+$/.test(showName)) {
                const mediaItem = await db.get('SELECT show_name FROM media WHERE id = ? AND media_type = ?', [showName, 'series']);
                if (mediaItem && mediaItem.show_name) {
                    showName = mediaItem.show_name;
                }
            }

            // Get all series entries for this show
            const seriesEntries = await db.all(`
                SELECT id, title FROM media
                WHERE media_type = 'series'
                  AND show_name = ?
            `, [showName]);

            if (seriesEntries.length === 0) {
                return res.status(404).json({ error: 'Show not found' });
            }

            // Reset enrichment_attempted for all media items of this show
            const mediaIds = seriesEntries.map(s => s.id);
            await db.run(`
                UPDATE media
                SET enrichment_attempted = NULL, tmdb_id = NULL
                WHERE id IN (${mediaIds.map(() => '?').join(',')})
            `, mediaIds);

            // Queue all for enrichment with high priority
            if (modules.enrichment) {
                await modules.enrichment.queueMediaForEnrichment(mediaIds, 100);

                // Start workers if not running
                if (!modules.enrichment.isRunning()) {
                    await modules.enrichment.startWorkers();
                }

                res.json({
                    success: true,
                    message: `Queued "${showName}" (${mediaIds.length} entries) for enrichment`,
                    showName: showName,
                    mediaCount: mediaIds.length
                });
            } else {
                res.status(400).json({ error: 'Enrichment module not loaded' });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Fetch TMDB season details with episodes
    router.get('/tmdb/tv/:id/season/:season', tmdbRateLimiter, async (req, res) => {
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

    // Play stream in external player (VLC) - returns M3U playlist download
    router.get('/play.m3u', async (req, res) => {
        try {
            const url = req.query.url;
            if (!url) {
                return res.status(400).send('URL is required');
            }

            // Generate M3U playlist that VLC can open
            const m3uContent = `#EXTM3U\n#EXTINF:-1,Stream\n${url}\n`;

            res.set('Content-Type', 'audio/x-mpegurl');
            res.set('Content-Disposition', 'attachment; filename="stream.m3u"');
            res.send(m3uContent);

            logger?.info('play', `Generated M3U playlist for: ${url}`);
        } catch (err) {
            logger?.error('play', `Failed to generate playlist: ${err.message}`);
            res.status(500).send('Error generating playlist');
        }
    });

    router.post('/play', async (req, res) => {
        try {
            const { url } = req.body;
            if (!url) {
                return res.status(400).json({ error: 'URL is required' });
            }

            // Return the M3U download URL for client-side handling
            const m3uUrl = `/api/play.m3u?url=${encodeURIComponent(url)}`;

            logger?.info('play', `Play request for: ${url}`);
            res.json({
                success: true,
                m3uUrl: m3uUrl,
                directUrl: url
            });
        } catch (err) {
            logger?.error('play', `Failed to generate play URL: ${err.message}`);
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
            runtimeName: 'recostream'
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
                        `SELECT m.* FROM media m
                         JOIN sources s ON m.source_id = s.id
                         WHERE m.tmdb_id = ? AND m.media_type = ? AND s.active = 1`,
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
                    `SELECT m.* FROM media m
                     JOIN sources s ON m.source_id = s.id
                     WHERE m.media_type = ? AND m.tmdb_id IS NOT NULL AND s.active = 1 LIMIT 1000`,
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

            // Return success - RecoStream handles downloads differently
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

    // Play stream in external player (VLC) - returns M3U playlist download
    router.get('/play.m3u', async (req, res) => {
        try {
            const url = req.query.url;
            if (!url) {
                return res.status(400).send('URL is required');
            }

            // Generate M3U playlist that VLC can open
            const m3uContent = `#EXTM3U\n#EXTINF:-1,Stream\n${url}\n`;

            res.set('Content-Type', 'audio/x-mpegurl');
            res.set('Content-Disposition', 'attachment; filename="stream.m3u"');
            res.send(m3uContent);

            logger?.info('play', `Generated M3U playlist for: ${url}`);
        } catch (err) {
            logger?.error('play', `Failed to generate playlist: ${err.message}`);
            res.status(500).send('Error generating playlist');
        }
    });

    router.post('/play', async (req, res) => {
        try {
            const { url } = req.body;
            if (!url) {
                return res.status(400).json({ error: 'URL is required' });
            }

            // Return the M3U download URL for client-side handling
            const m3uUrl = `/api/play.m3u?url=${encodeURIComponent(url)}`;

            logger?.info('play', `Play request for: ${url}`);
            res.json({
                success: true,
                m3uUrl: m3uUrl,
                directUrl: url
            });
        } catch (err) {
            logger?.error('play', `Failed to generate play URL: ${err.message}`);
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
    io.use(async (socket, next) => {
        try {
            const cookies = parseCookies(socket.handshake.headers.cookie || '');
            const token = cookies[SESSION_COOKIE];
            const session = await getSessionUserByToken(token);
            if (!session) {
                return next(new Error('Unauthorized'));
            }
            socket.user = session;
            return next();
        } catch (err) {
            return next(err);
        }
    });

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

function setupSyncEventRelay() {
    // Forward sync events from IPTV module to socket.io clients
    logger.info('app', 'Setting up sync event relay');

    app.on('sync:start', (data) => {
        logger.debug('app', `Relay sync:start for source ${data.source}`);
        io.emit('sync:source:start', { sourceId: data.source, sourceName: data.sourceName });
    });

    app.on('sync:progress', (data) => {
        logger.debug('app', `Relay sync:progress: ${data.message} (${data.percent}%)`);
        io.emit('sync:source:progress', {
            sourceId: data.source,
            step: data.step,
            message: data.message,
            percent: data.percent,
            current: data.current,
            total: data.total
        });
    });

    app.on('sync:complete', (data) => {
        io.emit('sync:source:complete', { sourceId: data.source, stats: data.stats });
    });

    app.on('sync:error', (data) => {
        io.emit('sync:source:error', { sourceId: data.source, error: data.error });
    });

    // EPG event relay
    app.on('epg:start', (data) => {
        logger.debug('app', `Relay epg:start for source ${data.sourceId}`);
        io.emit('epg:start', data);
    });

    app.on('epg:progress', (data) => {
        io.emit('epg:progress', data);
    });

    app.on('epg:complete', (data) => {
        logger.debug('app', `Relay epg:complete for source ${data.sourceId}`);
        io.emit('epg:complete', data);
    });

    app.on('epg:error', (data) => {
        io.emit('epg:error', data);
    });

    // Enrichment event relay (TMDB posters)
    app.on('enrichment:queued', (data) => {
        io.emit('enrichment:queued', data);
    });

    app.on('enrichment:workers:started', (data) => {
        io.emit('enrichment:workers:started', data);
    });

    app.on('enrichment:progress', (data) => {
        io.emit('enrichment:progress', data);
    });

    app.on('enrichment:workers:stopped', (data) => {
        io.emit('enrichment:workers:stopped', data);
    });

    app.on('enrichment:item:complete', (data) => {
        io.emit('enrichment:item:complete', data);
    });

    app.on('enrichment:item:failed', (data) => {
        io.emit('enrichment:item:failed', data);
    });
}

function setupWebhookDispatch() {
    logger.info('app', 'Setting up webhook dispatch');

    app.on('download:complete', async (data) => {
        try {
            logger?.info('webhook', `download:complete received for id ${data.id}`);
            const db = modules.db;
            const download = await db.get(`
                SELECT d.id, d.final_path, d.completed_at,
                       m.media_type, m.title as media_title, m.show_name,
                       e.season, e.episode, e.title as episode_title
                FROM downloads d
                LEFT JOIN media m ON d.media_id = m.id
                LEFT JOIN episodes e ON d.episode_id = e.id
                WHERE d.id = ?
            `, [data.id]);

            const mediaType = download?.media_type || null;
            const seriesName = mediaType === 'series' ? (download?.show_name || download?.media_title) : null;
            const title = mediaType === 'series'
                ? (download?.episode_title || seriesName || data.title || null)
                : (download?.media_title || data.title || null);

            await sendWebhook('download_complete', {
                id: data.id,
                media_type: mediaType,
                title,
                series_name: seriesName,
                season: download?.season ?? null,
                episode: download?.episode ?? null,
                path: data.path || download?.final_path || null,
                completed_at: download?.completed_at || null
            });
            await sendTelegramNotification('download_complete', {
                media_type: mediaType,
                title,
                series_name: seriesName,
                season: download?.season ?? null,
                episode: download?.episode ?? null
            });
        } catch (err) {
            logger?.warn('webhook', `Download webhook failed: ${err.message}`);
        }
    });

    app.on('recording:completed', async (data) => {
        try {
            logger?.info('webhook', `recording:completed received for id ${data.id}`);
            await sendWebhook('recording_finished', {
                id: data.id,
                title: data.title || null,
                path: data.outputPath || null,
                file_size: data.fileSize ?? null
            });
            await sendTelegramNotification('recording_finished', {
                title: data.title || null
            });
        } catch (err) {
            logger?.warn('webhook', `Recording webhook failed: ${err.message}`);
        }
    });
}

module.exports = {
    init: async (mods) => {
        modules = mods;
        logger = mods.logger;
        settings = mods.settings;

        app = express();
        app.set('trust proxy', true);
        app.set('view engine', 'ejs');
        app.set('views', PATHS.views);

        server = createServer(app);
        io = new Server(server);

        setupRoutes();
        await ensureAdminUser();
        setupSocket();
        setupSyncEventRelay();
        setupWebhookDispatch();

        // Start stream session cleanup interval (every 2 minutes)
        streamSessionCleanupInterval = setInterval(cleanupStaleSessions, 2 * 60 * 1000);

        const port = settings.get('port');
        return new Promise((resolve) => {
            server.listen(port, '0.0.0.0', () => {
                logger.info('app', `Server running on http://0.0.0.0:${port}`);
                resolve();
            });
        });
    },

    shutdown: async () => {
        // Clear stream session cleanup interval
        if (streamSessionCleanupInterval) {
            clearInterval(streamSessionCleanupInterval);
            streamSessionCleanupInterval = null;
        }
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
    emit: (event, data) => {
        app?.emit(event, data);
        io?.emit(event, data);
    },
    isStreamActive,
    getActivePreviewTitle
};
