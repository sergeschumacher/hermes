const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

let logger = null;
let db = null;
let settings = null;
let app = null;

// Default spoofed MAC address for IPTV provider authentication (IBU Player Pro)
const DEFAULT_SPOOFED_MAC = '77:f4:8b:a4:ed:10';
const DEFAULT_SPOOFED_DEVICE_KEY = '006453';

// Default headers that mimic IBU Player Pro
// If source is provided, use source-specific spoofing settings, otherwise fall back to global settings
function getDefaultHeaders(userAgent = 'IBOPlayer', source = null) {
    // Priority: source-specific > global settings > defaults
    const spoofedMac = source?.spoofed_mac || settings?.get('spoofedMac') || DEFAULT_SPOOFED_MAC;
    const spoofedDeviceKey = source?.spoofed_device_key || settings?.get('spoofedDeviceKey') || DEFAULT_SPOOFED_DEVICE_KEY;
    return {
        'User-Agent': userAgent,
        'X-Device-MAC': spoofedMac,
        'X-Forwarded-For': spoofedMac,
        'X-Device-Key': spoofedDeviceKey,
        'X-Device-ID': spoofedMac.replace(/:/g, ''),
        'Accept': '*/*',
        'Connection': 'keep-alive'
    };
}

async function fetchWithRetry(url, options = {}, retries = 3, source = null) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await axios({
                url,
                timeout: 30000,
                ...options,
                headers: {
                    ...getDefaultHeaders(options.headers?.['User-Agent'], source),
                    ...options.headers
                }
            });
            return response;
        } catch (err) {
            if (i === retries - 1) throw err;
            await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        }
    }
}

async function syncXtreamSource(source) {
    logger.info('iptv', `Syncing Xtream source: ${source.name}`);
    const baseUrl = source.url.replace(/\/$/, '');
    const headers = { 'User-Agent': source.user_agent || 'IBOPlayer' };

    // Emit start event
    app?.emit('sync:start', { source: source.id, sourceName: source.name });

    // Test connection first
    app?.emit('sync:progress', { source: source.id, step: 'auth', message: 'Authenticating...' });
    const authUrl = `${baseUrl}/player_api.php?username=${source.username}&password=${source.password}`;
    const authResponse = await fetchWithRetry(authUrl, { headers }, 3, source);

    if (!authResponse.data?.user_info?.auth) {
        throw new Error('Authentication failed');
    }

    logger.info('iptv', `Authenticated to ${source.name}`);

    // Fetch categories first to map category_id to category_name
    app?.emit('sync:progress', { source: source.id, step: 'categories', message: 'Fetching categories...' });
    const categoriesUrl = `${baseUrl}/player_api.php?username=${source.username}&password=${source.password}&action=get_live_categories`;
    const categoriesResponse = await fetchWithRetry(categoriesUrl, { headers }, 3, source);
    const categories = categoriesResponse.data || [];
    const categoryMap = {};
    for (const cat of categories) {
        categoryMap[cat.category_id] = cat.category_name;
    }
    logger.info('iptv', `Loaded ${categories.length} categories`);

    // Sync Live TV
    app?.emit('sync:progress', { source: source.id, step: 'live', message: 'Fetching live channels...' });
    const liveUrl = `${baseUrl}/player_api.php?username=${source.username}&password=${source.password}&action=get_live_streams`;
    const liveResponse = await fetchWithRetry(liveUrl, { headers }, 3, source);
    const liveChannels = liveResponse.data || [];

    logger.info('iptv', `Found ${liveChannels.length} live channels`);
    app?.emit('sync:progress', { source: source.id, step: 'live', message: `Saving ${liveChannels.length} live channels...`, total: liveChannels.length });

    let liveCount = 0, movieCount = 0, seriesCount = 0;

    for (let i = 0; i < liveChannels.length; i++) {
        const channel = liveChannels[i];
        const streamUrl = `${baseUrl}/live/${source.username}/${source.password}/${channel.stream_id}.ts`;

        // Get category name from map
        const categoryName = categoryMap[channel.category_id] || '';

        // Detect 24/7 movie/series channels based on category name
        const mediaType = detectMediaTypeFromCategory(categoryName, channel.name);

        if (mediaType === 'movie') movieCount++;
        else if (mediaType === 'series') seriesCount++;
        else liveCount++;

        await db.run(`
            INSERT OR REPLACE INTO media (source_id, external_id, media_type, title, poster, category, stream_url, language)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [source.id, String(channel.stream_id), mediaType, channel.name, channel.stream_icon, categoryName, streamUrl, channel.lang]);

        // Emit progress every 100 items
        if ((i + 1) % 100 === 0 || i === liveChannels.length - 1) {
            app?.emit('sync:progress', { source: source.id, step: 'live', message: `Channels: ${i + 1}/${liveChannels.length}`, current: i + 1, total: liveChannels.length });
        }
    }

    logger.info('iptv', `Categorized: ${liveCount} live, ${movieCount} movies, ${seriesCount} series`);

    // Sync VOD
    app?.emit('sync:progress', { source: source.id, step: 'vod', message: 'Fetching movies...' });
    const vodUrl = `${baseUrl}/player_api.php?username=${source.username}&password=${source.password}&action=get_vod_streams`;
    const vodResponse = await fetchWithRetry(vodUrl, { headers }, 3, source);
    const vodItems = vodResponse.data || [];

    logger.info('iptv', `Found ${vodItems.length} VOD items`);
    app?.emit('sync:progress', { source: source.id, step: 'vod', message: `Saving ${vodItems.length} movies...`, total: vodItems.length });

    for (let i = 0; i < vodItems.length; i++) {
        const vod = vodItems[i];
        const ext = vod.container_extension || 'mp4';
        const streamUrl = `${baseUrl}/movie/${source.username}/${source.password}/${vod.stream_id}.${ext}`;
        const quality = detectQuality(vod.name);

        await db.run(`
            INSERT OR REPLACE INTO media (source_id, external_id, media_type, title, poster, category, stream_url, container, rating, year, plot, genres, quality, tmdb_id)
            VALUES (?, ?, 'movie', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            source.id, String(vod.stream_id), vod.name, vod.stream_icon, vod.category_name,
            streamUrl, ext, vod.rating || null, extractYear(vod.name), vod.plot || null,
            vod.genre || null, quality, vod.tmdb || null
        ]);

        // Emit progress every 100 items
        if ((i + 1) % 100 === 0 || i === vodItems.length - 1) {
            app?.emit('sync:progress', { source: source.id, step: 'vod', message: `Movies: ${i + 1}/${vodItems.length}`, current: i + 1, total: vodItems.length });
        }
    }

    // Sync Series
    app?.emit('sync:progress', { source: source.id, step: 'series', message: 'Fetching series...' });
    const seriesUrl = `${baseUrl}/player_api.php?username=${source.username}&password=${source.password}&action=get_series`;
    const seriesResponse = await fetchWithRetry(seriesUrl, { headers }, 3, source);
    const seriesList = seriesResponse.data || [];

    logger.info('iptv', `Found ${seriesList.length} series`);
    app?.emit('sync:progress', { source: source.id, step: 'series', message: `Processing ${seriesList.length} series...`, total: seriesList.length });

    for (let i = 0; i < seriesList.length; i++) {
        const series = seriesList[i];
        const result = await db.run(`
            INSERT OR REPLACE INTO media (source_id, external_id, media_type, title, poster, backdrop, category, rating, year, plot, genres, tmdb_id)
            VALUES (?, ?, 'series', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            source.id, String(series.series_id), series.name, series.cover,
            series.backdrop_path?.[0] || null, series.category_name, series.rating || null,
            extractYear(series.releaseDate || series.name), series.plot || null,
            series.genre || null, series.tmdb || null
        ]);

        // Fetch episodes (with rate limiting)
        try {
            await new Promise(r => setTimeout(r, 100)); // Small delay between requests
            const episodesUrl = `${baseUrl}/player_api.php?username=${source.username}&password=${source.password}&action=get_series_info&series_id=${series.series_id}`;
            const episodesResponse = await fetchWithRetry(episodesUrl, { headers }, 3, source);
            const episodesData = episodesResponse.data?.episodes || {};

            for (const [season, episodes] of Object.entries(episodesData)) {
                for (const ep of episodes) {
                    const ext = ep.container_extension || 'mkv';
                    const streamUrl = `${baseUrl}/series/${source.username}/${source.password}/${ep.id}.${ext}`;

                    await db.run(`
                        INSERT OR REPLACE INTO episodes (media_id, external_id, season, episode, title, plot, air_date, runtime, stream_url, container)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `, [
                        result.lastID, String(ep.id), parseInt(season), ep.episode_num,
                        ep.title, ep.info?.plot || null, ep.info?.air_date || null,
                        ep.info?.duration_secs ? Math.floor(ep.info.duration_secs / 60) : null,
                        streamUrl, ext
                    ]);
                }
            }
        } catch (err) {
            logger.warn('iptv', `Failed to fetch episodes for series ${series.series_id}: ${err.message}`);
        }

        // Emit progress every 10 series (since each has episode fetching)
        if ((i + 1) % 10 === 0 || i === seriesList.length - 1) {
            app?.emit('sync:progress', { source: source.id, step: 'series', message: `Series: ${i + 1}/${seriesList.length}`, current: i + 1, total: seriesList.length });
        }
    }

    // Update last sync time
    await db.run('UPDATE sources SET last_sync = CURRENT_TIMESTAMP WHERE id = ?', [source.id]);

    logger.info('iptv', `Sync complete for ${source.name}`);
    app?.emit('sync:complete', { source: source.id });
}

async function syncM3USource(source) {
    logger.info('iptv', `Syncing M3U source: ${source.name}`);
    const headers = { 'User-Agent': source.user_agent || 'IBOPlayer' };

    // Emit start event
    app?.emit('sync:start', { source: source.id, sourceName: source.name });
    app?.emit('sync:progress', { source: source.id, step: 'fetch', message: 'Fetching M3U playlist...' });

    // Fetch M3U content
    const response = await fetchWithRetry(source.url, { headers, timeout: 60000 }, 3, source);
    const m3uContent = response.data;

    if (!m3uContent || typeof m3uContent !== 'string') {
        throw new Error('Invalid M3U content');
    }

    // Save M3U to history table (keep last 5 per source)
    try {
        const channelCount = (m3uContent.match(/#EXTINF:/g) || []).length;
        const fileSize = Buffer.byteLength(m3uContent, 'utf8');

        // Insert new entry
        await db.run(`
            INSERT INTO m3u_history (source_id, content, channel_count, file_size)
            VALUES (?, ?, ?, ?)
        `, [source.id, m3uContent, channelCount, fileSize]);

        // Delete old entries, keep only last 5 per source
        await db.run(`
            DELETE FROM m3u_history
            WHERE source_id = ?
            AND id NOT IN (
                SELECT id FROM m3u_history
                WHERE source_id = ?
                ORDER BY fetched_at DESC
                LIMIT 5
            )
        `, [source.id, source.id]);

        logger.info('iptv', `Saved M3U to history (${channelCount} channels, ${Math.round(fileSize / 1024)} KB)`);
    } catch (err) {
        logger.warn('iptv', `Failed to save M3U to history: ${err.message}`);
    }

    // Also save M3U backup to cache folder (legacy)
    try {
        const cacheDir = path.join(process.cwd(), 'data', 'cache', 'm3u');
        await fs.mkdir(cacheDir, { recursive: true });
        const date = new Date().toISOString().split('T')[0];
        const safeName = source.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const filename = `${safeName}-${date}.m3u`;
        await fs.writeFile(path.join(cacheDir, filename), m3uContent);
        logger.debug('iptv', `Saved M3U backup to ${filename}`);
    } catch (err) {
        logger.warn('iptv', `Failed to save M3U backup file: ${err.message}`);
    }

    // Parse M3U
    app?.emit('sync:progress', { source: source.id, step: 'parse', message: 'Parsing playlist...' });
    const channels = parseM3U(m3uContent);

    logger.info('iptv', `Found ${channels.length} channels in M3U`);

    // Separate episodes from non-episodes and group episodes by series
    const seriesMap = new Map(); // seriesName -> { episodes: [], category, logo }
    const nonEpisodeChannels = [];

    for (const channel of channels) {
        const episodeInfo = parseEpisodeInfo(channel.name);

        if (episodeInfo) {
            // This is an episode - group by series name
            const key = episodeInfo.seriesName.toLowerCase();
            if (!seriesMap.has(key)) {
                seriesMap.set(key, {
                    seriesName: episodeInfo.seriesName,
                    category: channel.group,
                    logo: channel.logo,
                    episodes: []
                });
            }
            const series = seriesMap.get(key);
            series.episodes.push({
                ...channel,
                season: episodeInfo.season,
                episode: episodeInfo.episode,
                episodeTitle: episodeInfo.episodeTitle
            });
            // Use first available logo for series
            if (!series.logo && channel.logo) {
                series.logo = channel.logo;
            }
        } else {
            nonEpisodeChannels.push(channel);
        }
    }

    logger.info('iptv', `Identified ${seriesMap.size} series with episodes, ${nonEpisodeChannels.length} other channels`);

    const totalItems = seriesMap.size + nonEpisodeChannels.length;
    app?.emit('sync:progress', { source: source.id, step: 'save', message: `Saving ${totalItems} items...`, total: totalItems });

    let processedCount = 0;

    // First, save all series with their episodes
    for (const [key, series] of seriesMap) {
        // Calculate episode count per season
        const seasonEpisodeCounts = {};
        for (const ep of series.episodes) {
            seasonEpisodeCounts[ep.season] = (seasonEpisodeCounts[ep.season] || 0) + 1;
        }
        const totalEpisodes = series.episodes.length;

        // Create a unique external_id for this series from this source
        const seriesExternalId = `m3u_series_${key.replace(/[^a-z0-9]/g, '_')}`;

        // Insert or update the parent series entry
        const result = await db.run(`
            INSERT INTO media (source_id, external_id, media_type, title, poster, category, episode_count)
            VALUES (?, ?, 'series', ?, ?, ?, ?)
            ON CONFLICT(source_id, external_id) DO UPDATE SET
                title = excluded.title,
                poster = COALESCE(excluded.poster, media.poster),
                category = COALESCE(excluded.category, media.category),
                episode_count = excluded.episode_count
        `, [
            source.id,
            seriesExternalId,
            series.seriesName,
            series.logo,
            series.category,
            totalEpisodes
        ]);

        // Get the media_id (either from insert or existing)
        let mediaId = result.lastID;
        if (!mediaId || result.changes === 0) {
            // Was an update, need to fetch the ID
            const existing = await db.get(
                'SELECT id FROM media WHERE source_id = ? AND external_id = ?',
                [source.id, seriesExternalId]
            );
            mediaId = existing?.id;
        }

        if (mediaId) {
            // Insert episodes into the episodes table
            for (const ep of series.episodes) {
                await db.run(`
                    INSERT INTO episodes (media_id, external_id, season, episode, title, stream_url)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(media_id, season, episode) DO UPDATE SET
                        external_id = excluded.external_id,
                        title = excluded.title,
                        stream_url = excluded.stream_url
                `, [
                    mediaId,
                    ep.id || `${ep.season}_${ep.episode}`,
                    ep.season,
                    ep.episode,
                    ep.episodeTitle || ep.name,
                    ep.url
                ]);
            }
        }

        processedCount++;
        if (processedCount % 50 === 0 || processedCount === totalItems) {
            app?.emit('sync:progress', {
                source: source.id,
                step: 'save',
                message: `Items: ${processedCount}/${totalItems}`,
                current: processedCount,
                total: totalItems
            });
        }
    }

    // Save non-episode channels
    for (let i = 0; i < nonEpisodeChannels.length; i++) {
        const channel = nonEpisodeChannels[i];

        // Determine media type from group or default to live
        let mediaType = 'live';
        const groupLower = (channel.group || '').toLowerCase();
        if (groupLower.includes('vod') || groupLower.includes('movie') || groupLower.includes('film')) {
            mediaType = 'movie';
        } else if (groupLower.includes('series') || groupLower.includes('show') || groupLower.startsWith('srs')) {
            mediaType = 'series';
        }

        await db.run(`
            INSERT OR REPLACE INTO media (source_id, external_id, media_type, title, poster, category, stream_url, language)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            source.id,
            channel.id || String(i),
            mediaType,
            channel.name,
            channel.logo,
            channel.group,
            channel.url,
            channel.language
        ]);

        processedCount++;
        if (processedCount % 100 === 0 || processedCount === totalItems) {
            app?.emit('sync:progress', {
                source: source.id,
                step: 'save',
                message: `Items: ${processedCount}/${totalItems}`,
                current: processedCount,
                total: totalItems
            });
        }
    }

    // Update last sync time
    await db.run('UPDATE sources SET last_sync = CURRENT_TIMESTAMP WHERE id = ?', [source.id]);

    logger.info('iptv', `Sync complete for ${source.name}: ${seriesMap.size} series (${[...seriesMap.values()].reduce((sum, s) => sum + s.episodes.length, 0)} episodes), ${nonEpisodeChannels.length} other channels`);
    app?.emit('sync:complete', { source: source.id });
}

function parseM3U(content) {
    const channels = [];
    const lines = content.split('\n');

    let currentChannel = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (line.startsWith('#EXTINF:')) {
            // Parse EXTINF line
            currentChannel = {
                name: '',
                logo: null,
                group: null,
                language: null,
                id: null,
                url: null
            };

            // Extract attributes using regex
            const tvgId = line.match(/tvg-id="([^"]*)"/i);
            const tvgName = line.match(/tvg-name="([^"]*)"/i);
            const tvgLogo = line.match(/tvg-logo="([^"]*)"/i);
            const groupTitle = line.match(/group-title="([^"]*)"/i);
            const tvgLanguage = line.match(/tvg-language="([^"]*)"/i);

            if (tvgId) currentChannel.id = tvgId[1];
            if (tvgLogo) currentChannel.logo = tvgLogo[1];
            if (groupTitle) currentChannel.group = groupTitle[1];
            if (tvgLanguage) currentChannel.language = tvgLanguage[1];

            // Channel name extraction - properly handle quoted attributes
            // Format: #EXTINF:duration attr1="val1" attr2="val2",Channel Name
            // The comma before channel name is OUTSIDE all quotes
            // Find the first comma that's not inside quotes (scanning from start)

            let inQuotes = false;
            let commaPos = -1;

            for (let j = 0; j < line.length; j++) {
                if (line[j] === '"') {
                    inQuotes = !inQuotes;
                } else if (line[j] === ',' && !inQuotes) {
                    // Found a comma outside quotes - this is likely the separator
                    // But there might be commas in channel name too, so we want
                    // the comma that comes after the last attribute
                    commaPos = j;
                    // Check if this looks like it's after the attributes (followed by non-attr content)
                    // Attributes have format: key="value"
                    // After the last attribute, the comma is followed by the channel name
                    const rest = line.substring(j + 1);
                    // If the rest doesn't start with an attribute pattern, this is the channel name separator
                    if (!rest.trim().match(/^[a-z_-]+="/i)) {
                        break;
                    }
                }
            }

            if (commaPos > 0) {
                currentChannel.name = line.substring(commaPos + 1).trim();
            }

            // Fallback to tvg-name if we couldn't extract channel name
            if (!currentChannel.name && tvgName) {
                currentChannel.name = tvgName[1];
            }

            // Final fallback: try to extract name after last comma (simple approach)
            if (!currentChannel.name) {
                const nameMatch = line.match(/,\s*([^,]+)$/);
                if (nameMatch) {
                    currentChannel.name = nameMatch[1].trim();
                }
            }

        } else if (line && !line.startsWith('#') && currentChannel) {
            // This is the URL line
            currentChannel.url = line;
            if (currentChannel.name && currentChannel.url) {
                channels.push(currentChannel);
            }
            currentChannel = null;
        }
    }

    return channels;
}

function detectMediaTypeFromCategory(category, title) {
    const catLower = (category || '').toLowerCase();
    const titleLower = (title || '').toLowerCase();

    // Keywords that indicate movies/films
    const movieKeywords = [
        'movie', 'movies', 'film', 'films', 'filma', 'filme', 'filmes', 'filmi',
        'cinema', 'vod ', 'vod|', '| vod', 'kino', 'cine ',
        '24/7 movie', '24/7 film', 'sky cinema', 'hbo max', 'netflix',
        'disney+', 'disney +', 'apple tv+', 'paramount+', 'peacock',
        'ppv', 'pay per view'
    ];

    // Keywords that indicate series/shows
    const seriesKeywords = [
        'series', 'serie', 'seriale', 'serien', 'shows', 'show',
        'tv show', 'tvshow', 'iplayer series', 'prime video series',
        '24/7 series', '24/7 show', 'boxset', 'box set'
    ];

    // Keywords that indicate it's definitely live TV (not movie/series)
    const liveKeywords = [
        'news', 'sport', 'sports', 'football', 'soccer', 'nfl', 'nba',
        'racing', 'f1', 'boxing', 'ufc', 'wrestling', 'wwe',
        'music', 'radio', 'kids', 'children', 'cartoon', 'baby',
        'documentary', 'docu', 'nature', 'discovery', 'national geographic',
        'weather', 'shopping', 'adult', 'xxx', '18+', 'religious'
    ];

    // Check if it's clearly live content first
    for (const keyword of liveKeywords) {
        if (catLower.includes(keyword)) {
            return 'live';
        }
    }

    // Check for movie indicators
    for (const keyword of movieKeywords) {
        if (catLower.includes(keyword)) {
            return 'movie';
        }
    }

    // Check for series indicators
    for (const keyword of seriesKeywords) {
        if (catLower.includes(keyword)) {
            return 'series';
        }
    }

    // Default to live
    return 'live';
}

function detectQuality(title) {
    const titleLower = (title || '').toLowerCase();
    if (titleLower.includes('4k') || titleLower.includes('2160p') || titleLower.includes('uhd')) return '4K';
    if (titleLower.includes('1080p') || titleLower.includes('fhd')) return '1080p';
    if (titleLower.includes('720p') || titleLower.includes('hd')) return '720p';
    return null;
}

function extractYear(text) {
    if (!text) return null;
    const match = text.match(/\((\d{4})\)/);
    return match ? parseInt(match[1]) : null;
}

/**
 * Parse episode information from a channel name
 * Supports formats like:
 * - "DE - The King of Queens S01 E01"
 * - "Show Name S01E01"
 * - "Show Name - Season 1 Episode 1"
 * - "Show Name 1x01"
 * - "Show Name - 1x01 - Episode Title"
 * @returns {Object|null} { seriesName, season, episode, episodeTitle } or null if not an episode
 */
function parseEpisodeInfo(title) {
    if (!title) return null;

    // Common patterns for episode identification
    const patterns = [
        // S01 E01 or S01E01 format (most common in IPTV)
        /^(.+?)\s*[Ss](\d{1,2})\s*[Ee](\d{1,3})(?:\s*[-:]?\s*(.*))?$/,
        // S01 E01 with separator before S
        /^(.+?)\s*[-|]\s*[Ss](\d{1,2})\s*[Ee](\d{1,3})(?:\s*[-:]?\s*(.*))?$/,
        // Season 1 Episode 1 format
        /^(.+?)\s*[-|]?\s*[Ss]eason\s*(\d{1,2})\s*[Ee]pisode\s*(\d{1,3})(?:\s*[-:]?\s*(.*))?$/i,
        // 1x01 format
        /^(.+?)\s*[-|]?\s*(\d{1,2})x(\d{2,3})(?:\s*[-:]?\s*(.*))?$/,
    ];

    for (const pattern of patterns) {
        const match = title.match(pattern);
        if (match) {
            let seriesName = match[1].trim();

            // Clean up series name - remove trailing separators and language prefixes
            seriesName = seriesName.replace(/\s*[-|]\s*$/, '').trim();

            // Remove common language prefixes (DE -, EN -, etc.)
            seriesName = seriesName.replace(/^[A-Z]{2}\s*[-|]\s*/i, '').trim();

            return {
                seriesName: seriesName,
                season: parseInt(match[2], 10),
                episode: parseInt(match[3], 10),
                episodeTitle: match[4]?.trim() || null
            };
        }
    }

    return null;
}

module.exports = {
    init: async (modules) => {
        logger = modules.logger;
        db = modules.db;
        settings = modules.settings;
        app = modules.app;
    },

    testSource: async (source) => {
        try {
            const baseUrl = source.url.replace(/\/$/, '');
            const headers = { 'User-Agent': source.user_agent || 'IBOPlayer' };

            if (source.type === 'xtream') {
                const authUrl = `${baseUrl}/player_api.php?username=${source.username}&password=${source.password}`;
                const response = await fetchWithRetry(authUrl, { headers, timeout: 10000 }, 3, source);

                if (response.data?.user_info?.auth) {
                    return {
                        success: true,
                        message: `Connected! Account: ${response.data.user_info.username}, Status: ${response.data.user_info.status}`
                    };
                }
                return { success: false, message: 'Authentication failed' };
            }

            if (source.type === 'm3u') {
                const response = await fetchWithRetry(source.url, { headers, timeout: 15000 }, 3, source);
                const content = response.data;

                if (content && typeof content === 'string' && content.includes('#EXTINF')) {
                    const channels = parseM3U(content);
                    return {
                        success: true,
                        message: `Valid M3U! Found ${channels.length} channels`
                    };
                }
                return { success: false, message: 'Invalid M3U format' };
            }

            return { success: false, message: 'Unsupported source type' };
        } catch (err) {
            return { success: false, message: err.message };
        }
    },

    syncSource: async (source) => {
        try {
            if (source.type === 'xtream') {
                await syncXtreamSource(source);
            } else if (source.type === 'm3u') {
                await syncM3USource(source);
            } else {
                throw new Error('Unsupported source type');
            }
        } catch (err) {
            logger.error('iptv', `Sync failed for ${source.name}: ${err.message}`);
            app?.emit('sync:error', { source: source.id, error: err.message });
            throw err;
        }
    }
};
