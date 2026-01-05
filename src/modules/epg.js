const axios = require('axios');
const zlib = require('zlib');
const { promisify } = require('util');

const gunzip = promisify(zlib.gunzip);

let logger = null;
let db = null;
let app = null;
let settings = null;

/**
 * Parse XMLTV date format: YYYYMMDDHHmmss +HHMM
 * @param {string} dateStr - XMLTV date string
 * @returns {Date} - JavaScript Date object
 */
function parseXmltvDate(dateStr) {
    if (!dateStr) return null;

    // Format: 20231225143000 +0100 or 20231225143000
    const match = dateStr.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?$/);
    if (!match) return null;

    const [, year, month, day, hour, minute, second = '00', tz] = match;

    // Create ISO string
    let isoStr = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
    if (tz) {
        // Convert +0100 to +01:00
        isoStr += tz.slice(0, 3) + ':' + tz.slice(3);
    } else {
        isoStr += 'Z';
    }

    return new Date(isoStr);
}

/**
 * Extract text content from between tags
 */
function extractTagContent(xml, tagName) {
    const regex = new RegExp(`<${tagName}[^>]*>([^<]*)</${tagName}>`, 'i');
    const match = xml.match(regex);
    return match ? decodeXmlEntities(match[1].trim()) : null;
}

/**
 * Extract attribute value from a tag
 */
function extractAttribute(xml, attrName) {
    const regex = new RegExp(`${attrName}="([^"]*)"`, 'i');
    const match = xml.match(regex);
    return match ? decodeXmlEntities(match[1]) : null;
}

/**
 * Decode XML entities
 */
function decodeXmlEntities(str) {
    if (!str) return str;
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

/**
 * Parse XMLTV content and extract programs
 * @param {string} xmlContent - Raw XMLTV content
 * @returns {Object} - { channels: [], programs: [] }
 */
function parseXmltvContent(xmlContent) {
    const channels = [];
    const programs = [];

    // Extract channels
    const channelRegex = /<channel\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/gi;
    let channelMatch;
    while ((channelMatch = channelRegex.exec(xmlContent)) !== null) {
        const channelId = channelMatch[1];
        const channelContent = channelMatch[2];

        channels.push({
            id: channelId,
            name: extractTagContent(channelContent, 'display-name'),
            icon: extractAttribute(channelContent, 'src') || extractTagContent(channelContent, 'icon')
        });
    }

    // Extract programs
    const programRegex = /<programme\s+([^>]+)>([\s\S]*?)<\/programme>/gi;
    let programMatch;
    while ((programMatch = programRegex.exec(xmlContent)) !== null) {
        const attrs = programMatch[1];
        const content = programMatch[2];

        const startStr = extractAttribute(attrs, 'start');
        const stopStr = extractAttribute(attrs, 'stop');
        const channelId = extractAttribute(attrs, 'channel');

        if (!startStr || !channelId) continue;

        const startTime = parseXmltvDate(startStr);
        const endTime = stopStr ? parseXmltvDate(stopStr) : null;

        if (!startTime) continue;

        // Extract episode number in various formats
        let episodeNum = null;
        const episodeMatch = content.match(/<episode-num[^>]*>([^<]+)<\/episode-num>/i);
        if (episodeMatch) {
            const epContent = episodeMatch[1].trim();
            // xmltv_ns format: season.episode.part (0-indexed)
            const nsMatch = epContent.match(/^(\d+)\s*\.\s*(\d+)/);
            if (nsMatch) {
                const season = parseInt(nsMatch[1], 10) + 1;
                const episode = parseInt(nsMatch[2], 10) + 1;
                episodeNum = `S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}`;
            } else {
                episodeNum = epContent;
            }
        }

        // Extract category
        let category = null;
        const categoryMatch = content.match(/<category[^>]*>([^<]+)<\/category>/i);
        if (categoryMatch) {
            category = decodeXmlEntities(categoryMatch[1].trim());
        }

        // Extract icon
        let icon = null;
        const iconMatch = content.match(/<icon\s+src="([^"]+)"/i);
        if (iconMatch) {
            icon = iconMatch[1];
        }

        // Extract rating
        let rating = null;
        const ratingMatch = content.match(/<rating[^>]*>[\s\S]*?<value>([^<]+)<\/value>/i);
        if (ratingMatch) {
            rating = decodeXmlEntities(ratingMatch[1].trim());
        }

        programs.push({
            channel_id: channelId,
            title: extractTagContent(content, 'title') || 'Unknown',
            subtitle: extractTagContent(content, 'sub-title'),
            description: extractTagContent(content, 'desc'),
            category,
            start_time: startTime,
            end_time: endTime,
            icon,
            episode_num: episodeNum,
            rating
        });
    }

    return { channels, programs };
}

/**
 * Fetch EPG XML from a URL or local file
 * @param {string} url - URL to fetch or file:// path
 * @returns {string} - XML content
 */
async function fetchEpgXml(url) {
    logger.debug('epg', `Fetching EPG from ${url}`);

    let content;

    // Support local file paths (file:// or absolute path starting with /)
    if (url.startsWith('file://') || url.startsWith('/')) {
        const fs = require('fs').promises;
        const filePath = url.startsWith('file://') ? url.slice(7) : url;
        logger.debug('epg', `Reading local EPG file: ${filePath}`);
        content = await fs.readFile(filePath);
    } else {
        const response = await axios({
            url,
            method: 'GET',
            timeout: 120000,  // 2 minute timeout for large files
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Hermes/1.0',
                'Accept-Encoding': 'gzip, deflate'
            }
        });
        content = response.data;
    }

    // Check if gzipped (magic bytes: 1f 8b)
    if (content[0] === 0x1f && content[1] === 0x8b) {
        logger.debug('epg', 'Decompressing gzipped EPG');
        content = await gunzip(content);
    }

    return content.toString('utf-8');
}

/**
 * Sync EPG from a source's EPG URL
 * @param {Object} source - Source object with epg_url
 * @returns {Object} - { success, programCount, channelCount }
 */
async function syncSourceEpg(source) {
    if (!source.epg_url) {
        return { success: false, error: 'No EPG URL configured for this source' };
    }

    logger.info('epg', `Starting EPG sync for source: ${source.name}`);
    app?.emit('epg:start', { sourceId: source.id, sourceName: source.name });

    try {
        const xmlContent = await fetchEpgXml(source.epg_url);
        const { channels, programs } = parseXmltvContent(xmlContent);

        if (programs.length === 0) {
            logger.warn('epg', `No programs found in EPG for ${source.name}`);
            return { success: true, programCount: 0, channelCount: 0 };
        }

        logger.info('epg', `Parsed ${programs.length} programs, ${channels.length} channels from ${source.name}`);

        // Filter programs: only keep programs that haven't ended yet
        const now = new Date();
        const futurePrograms = programs.filter(p => !p.end_time || p.end_time > now);

        logger.info('epg', `${futurePrograms.length} future programs after filtering`);

        // Clear old EPG data for this source
        await db.run('DELETE FROM epg_programs WHERE source_id = ?', [source.id]);

        // Insert programs in batches using transactions for speed
        // SQLite has 999 parameter limit, 11 columns = max 90 rows per batch
        const batchSize = 80;
        for (let i = 0; i < futurePrograms.length; i += batchSize) {
            const batch = futurePrograms.slice(i, i + batchSize);

            // Build bulk insert statement
            const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
            const values = batch.flatMap(program => [
                program.channel_id,
                source.id,
                program.title,
                program.subtitle,
                program.description,
                program.category,
                program.start_time?.toISOString(),
                program.end_time?.toISOString(),
                program.icon,
                program.episode_num,
                program.rating
            ]);

            await db.run(`
                INSERT INTO epg_programs (channel_id, source_id, title, subtitle, description, category, start_time, end_time, icon, episode_num, rating)
                VALUES ${placeholders}
            `, values);

            app?.emit('epg:progress', {
                sourceId: source.id,
                sourceName: source.name,
                message: `${source.name}: ${Math.min(i + batchSize, futurePrograms.length)}/${futurePrograms.length} programs`,
                current: Math.min(i + batchSize, futurePrograms.length),
                total: futurePrograms.length
            });
        }

        const uniqueChannels = new Set(futurePrograms.map(p => p.channel_id)).size;

        // Store EPG channel icons in epg_icon column (used as fallback in logo endpoint)
        const channelsWithIcons = channels.filter(ch => ch.icon);
        if (channelsWithIcons.length > 0) {
            logger.debug('epg', `Updating ${channelsWithIcons.length} channel icons from EPG`);
            for (const ch of channelsWithIcons) {
                // Update epg_icon where tvg_id matches
                await db.run(`
                    UPDATE media
                    SET epg_icon = ?
                    WHERE source_id = ?
                    AND tvg_id = ?
                    AND media_type = 'live'
                `, [ch.icon, source.id, ch.id]);
            }
        }

        // Update epg_sync metadata
        await db.run(`
            INSERT OR REPLACE INTO epg_sync (source_id, last_sync, program_count, channel_count)
            VALUES (?, datetime('now'), ?, ?)
        `, [source.id, futurePrograms.length, uniqueChannels]);

        logger.info('epg', `EPG sync complete for ${source.name}: ${futurePrograms.length} programs, ${uniqueChannels} channels`);
        app?.emit('epg:complete', {
            sourceId: source.id,
            sourceName: source.name,
            programCount: futurePrograms.length,
            channelCount: uniqueChannels
        });

        return {
            success: true,
            programCount: futurePrograms.length,
            channelCount: uniqueChannels
        };

    } catch (err) {
        logger.error('epg', `EPG sync failed for ${source.name}: ${err.message}`);
        app?.emit('epg:error', { sourceId: source.id, sourceName: source.name, error: err.message });
        return { success: false, error: err.message };
    }
}

/**
 * Sync EPG for all sources that have EPG URLs configured
 * @returns {Object} - { sources: [{ sourceId, success, programCount, channelCount }] }
 */
async function syncAllSourcesEpg() {
    const sources = await db.all('SELECT * FROM sources WHERE epg_url IS NOT NULL AND active = 1');

    if (sources.length === 0) {
        logger.info('epg', 'No sources with EPG URLs configured');
        return { sources: [] };
    }

    logger.info('epg', `Syncing EPG for ${sources.length} sources`);

    const results = [];
    for (const source of sources) {
        const result = await syncSourceEpg(source);
        results.push({
            sourceId: source.id,
            sourceName: source.name,
            ...result
        });
    }

    return { sources: results };
}

/**
 * Get current program for a channel
 * @param {string} channelId - The tvg_id of the channel
 * @param {number} sourceId - Optional source ID to filter EPG data
 * @returns {Object|null} - Current program or null
 */
async function getCurrentProgram(channelId, sourceId = null) {
    const now = new Date().toISOString();

    let sql = `
        SELECT * FROM epg_programs
        WHERE channel_id = ?
          AND start_time <= ?
          AND (end_time IS NULL OR end_time > ?)
    `;
    const params = [channelId, now, now];

    if (sourceId) {
        sql += ' AND source_id = ?';
        params.push(sourceId);
    }

    sql += ' ORDER BY start_time DESC LIMIT 1';

    return db.get(sql, params);
}

/**
 * Get upcoming programs for a channel
 * @param {string} channelId - The tvg_id of the channel
 * @param {number} limit - Max programs to return
 * @param {number} sourceId - Optional source ID to filter EPG data
 * @returns {Array} - List of upcoming programs
 */
async function getUpcomingPrograms(channelId, limit = 5, sourceId = null) {
    const now = new Date().toISOString();

    let sql = `
        SELECT * FROM epg_programs
        WHERE channel_id = ?
          AND start_time > ?
    `;
    const params = [channelId, now];

    if (sourceId) {
        sql += ' AND source_id = ?';
        params.push(sourceId);
    }

    sql += ' ORDER BY start_time ASC LIMIT ?';
    params.push(limit);

    return db.all(sql, params);
}

/**
 * Get program schedule for a time range (for EPG grid view)
 * @param {Date} startTime - Start of time range
 * @param {Date} endTime - End of time range
 * @param {Array} channelIds - Optional filter by channel IDs
 * @param {number} sourceId - Optional source ID to filter EPG data
 * @returns {Array} - List of programs in the range
 */
async function getProgramGuide(startTime, endTime, channelIds = null, sourceId = null) {
    let sql = `
        SELECT * FROM epg_programs
        WHERE start_time < ?
          AND (end_time IS NULL OR end_time > ?)
    `;
    const params = [endTime.toISOString(), startTime.toISOString()];

    if (sourceId) {
        sql += ' AND source_id = ?';
        params.push(sourceId);
    }

    if (channelIds && channelIds.length > 0) {
        // Case-insensitive matching for channel IDs
        const placeholders = channelIds.map(() => '?').join(',');
        sql += ` AND LOWER(channel_id) IN (${placeholders})`;
        params.push(...channelIds.map(id => id.toLowerCase()));
    }

    sql += ' ORDER BY channel_id, start_time ASC';

    return db.all(sql, params);
}

/**
 * Get EPG data for multiple channels at once
 * @param {Array} channelIds - Array of tvg_id values
 * @param {number} sourceId - Optional source ID to filter EPG data
 * @returns {Object} - Map of channelId -> { current, next }
 */
async function getEpgForChannels(channelIds, sourceId = null) {
    if (!channelIds || channelIds.length === 0) return {};

    const now = new Date().toISOString();
    const placeholders = channelIds.map(() => '?').join(',');

    // Build query params
    let currentSql = `
        SELECT * FROM epg_programs
        WHERE channel_id IN (${placeholders})
          AND start_time <= ?
          AND (end_time IS NULL OR end_time > ?)
    `;
    let currentParams = [...channelIds, now, now];

    let nextSql = `
        SELECT * FROM epg_programs
        WHERE channel_id IN (${placeholders})
          AND start_time > ?
    `;
    let nextParams = [...channelIds, now];

    if (sourceId) {
        currentSql += ' AND source_id = ?';
        currentParams.push(sourceId);
        nextSql += ' AND source_id = ?';
        nextParams.push(sourceId);
    }

    currentSql += ' ORDER BY channel_id, start_time DESC';
    nextSql += ' ORDER BY channel_id, start_time ASC';

    // Get current programs
    const currentPrograms = await db.all(currentSql, currentParams);

    // Get next programs
    const nextPrograms = await db.all(nextSql, nextParams);

    // Build result map
    const result = {};
    const seenCurrent = new Set();
    const seenNext = new Set();

    for (const prog of currentPrograms) {
        if (!seenCurrent.has(prog.channel_id)) {
            if (!result[prog.channel_id]) result[prog.channel_id] = {};
            result[prog.channel_id].current = prog;
            seenCurrent.add(prog.channel_id);
        }
    }

    for (const prog of nextPrograms) {
        if (!seenNext.has(prog.channel_id)) {
            if (!result[prog.channel_id]) result[prog.channel_id] = {};
            result[prog.channel_id].next = prog;
            seenNext.add(prog.channel_id);
        }
    }

    return result;
}

/**
 * Get distinct channels that have EPG data for a source
 * @param {number} sourceId - Source ID
 * @returns {Array} - List of channel IDs with EPG data
 */
async function getChannelsWithEpg(sourceId = null) {
    let sql = 'SELECT DISTINCT channel_id FROM epg_programs';
    const params = [];

    if (sourceId) {
        sql += ' WHERE source_id = ?';
        params.push(sourceId);
    }

    sql += ' ORDER BY channel_id';
    const rows = await db.all(sql, params);

    // Extract country from channel_id suffix (e.g., "ARD.de" -> "DE")
    return rows.map(row => {
        const match = row.channel_id.match(/\.([a-z]{2})$/i);
        return {
            channel_id: row.channel_id,
            country: match ? match[1].toUpperCase() : null
        };
    });
}

/**
 * Get EPG program by ID (for scheduling recordings)
 * @param {number} programId - Program ID
 * @returns {Object} - Program data
 */
async function getProgramById(programId) {
    return db.get('SELECT * FROM epg_programs WHERE id = ?', [programId]);
}

/**
 * Get EPG sync status for all sources
 * @returns {Array} - List of sync status per source
 */
async function getEpgSyncStatus() {
    return db.all(`
        SELECT
            s.id as source_id,
            s.name as source_name,
            s.epg_url,
            es.last_sync,
            es.program_count,
            es.channel_count
        FROM sources s
        LEFT JOIN epg_sync es ON s.id = es.source_id
        WHERE s.epg_url IS NOT NULL AND s.active = 1
        ORDER BY s.name
    `);
}

/**
 * Clean up old EPG programs (expired)
 * @returns {Object} - { deleted: number }
 */
async function cleanupOldPrograms() {
    const result = await db.run(`
        DELETE FROM epg_programs
        WHERE end_time IS NOT NULL AND end_time < datetime('now', '-1 day')
    `);

    if (result.changes > 0) {
        logger.info('epg', `Cleaned up ${result.changes} expired EPG programs`);
    }

    return { deleted: result.changes };
}

module.exports = {
    init: async (modules) => {
        logger = modules.logger;
        db = modules.db;
        app = modules.app;
        settings = modules.settings;
    },

    // EPG sync
    syncSourceEpg,
    syncAllSourcesEpg,

    // Program queries
    getCurrentProgram,
    getUpcomingPrograms,
    getProgramGuide,
    getEpgForChannels,
    getChannelsWithEpg,
    getProgramById,

    // Status and maintenance
    getEpgSyncStatus,
    cleanupOldPrograms,

    // Utilities
    parseXmltvContent,
    parseXmltvDate
};
