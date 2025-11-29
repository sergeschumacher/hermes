const axios = require('axios');
const zlib = require('zlib');
const { promisify } = require('util');

const gunzip = promisify(zlib.gunzip);

let logger = null;
let db = null;
let app = null;
let settings = null;

// Base URL for globetvapp/epg repository
const EPG_BASE_URL = 'https://raw.githubusercontent.com/globetvapp/epg/main';

// Available countries from globetvapp/epg
const AVAILABLE_COUNTRIES = [
    'Albania', 'Argentina', 'Australia', 'Austria', 'Belgium', 'Bolivia', 'Bosnia',
    'Brazil', 'Bulgaria', 'Canada', 'Caribbean', 'Chile', 'China', 'Colombia',
    'Costa Rica', 'Croatia', 'Cyprus', 'Czech Republic', 'Denmark', 'Dominican Republic',
    'Ecuador', 'Egypt', 'El Salvador', 'Estonia', 'Finland', 'France', 'Georgia',
    'Germany', 'Ghana', 'Greece', 'Guatemala', 'Honduras', 'Hong Kong', 'Hungary',
    'Iceland', 'India', 'Indonesia', 'Ireland', 'Israel', 'Italy', 'Ivory Coast',
    'Jamaica', 'Kenya', 'Korea', 'Latvia', 'Lithuania', 'Luxembourg', 'Macau',
    'Madagascar', 'Malawi', 'Malaysia', 'Malta', 'Mauritius', 'Mexico', 'Mongolia',
    'Montenegro', 'Morocco', 'Mozambique', 'Namibia', 'Netherlands', 'New Caledonia',
    'New Zealand', 'Nigeria', 'Norway', 'Pakistan', 'Panama', 'Paraguay', 'Peru',
    'Philippines', 'Poland', 'Portugal', 'Puerto Rico', 'Qatar', 'Romania', 'Russia',
    'Saudi Arabia', 'Scotland', 'Serbia', 'Singapore', 'Slovakia', 'Slovenia',
    'South Africa', 'Spain', 'Sports', 'Sweden', 'Switzerland', 'Taiwan', 'Thailand',
    'Turkey', 'UAE', 'Uganda', 'Ukraine', 'United Kingdom', 'Uruguay', 'USA',
    'Uzbekistan', 'Vietnam', 'Zambia'
];

// Simple streaming XML parser for XMLTV format
// XMLTV format: https://wiki.xmltv.org/index.php/XMLTVFormat

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
 * @param {string} country - Country name for this EPG data
 * @returns {Object} - { channels: [], programs: [] }
 */
function parseXmltvContent(xmlContent, country = null) {
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
            icon: extractAttribute(channelContent, 'src') || extractTagContent(channelContent, 'icon'),
            country
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
            rating,
            country
        });
    }

    return { channels, programs };
}

/**
 * Fetch EPG XML from a URL
 * @param {string} url - URL to fetch
 * @returns {string} - XML content
 */
async function fetchEpgXml(url) {
    logger.debug('epg', `Fetching EPG from ${url}`);

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

    let content = response.data;

    // Check if gzipped (magic bytes: 1f 8b)
    if (content[0] === 0x1f && content[1] === 0x8b) {
        logger.debug('epg', 'Decompressing gzipped EPG');
        content = await gunzip(content);
    }

    return content.toString('utf-8');
}

/**
 * Get available EPG countries
 * @returns {Array} - List of available country names
 */
function getAvailableCountries() {
    return AVAILABLE_COUNTRIES;
}

/**
 * Build EPG URLs for a country
 * Country files are named like: germany1.xml, germany2.xml, etc.
 * @param {string} country - Country name
 * @returns {Array} - List of URLs to try
 */
function getCountryEpgUrls(country) {
    const countryLower = country.toLowerCase().replace(/\s+/g, '');
    const urls = [];

    // Try up to 5 numbered files for each country
    for (let i = 1; i <= 5; i++) {
        urls.push(`${EPG_BASE_URL}/${country}/${countryLower}${i}.xml`);
    }

    return urls;
}

/**
 * Sync EPG for selected countries (global EPG)
 * @param {Array} countries - List of country names to sync
 */
async function syncGlobalEpg(countries = null) {
    // Use settings if no countries provided
    if (!countries) {
        countries = settings.get('epgCountries') || ['Germany'];
    }

    logger.info('epg', `Starting global EPG sync for: ${countries.join(', ')}`);
    app?.emit('epg:start', { countries });

    let totalPrograms = 0;
    let totalChannels = 0;

    try {
        // Clear old EPG data (global entries only)
        await db.run('DELETE FROM epg_programs WHERE source_id IS NULL');

        for (const country of countries) {
            if (!AVAILABLE_COUNTRIES.includes(country)) {
                logger.warn('epg', `Unknown country: ${country}, skipping`);
                continue;
            }

            const urls = getCountryEpgUrls(country);
            let countryPrograms = 0;
            let countryChannels = 0;

            for (const url of urls) {
                try {
                    const xmlContent = await fetchEpgXml(url);
                    const { channels, programs } = parseXmltvContent(xmlContent, country);

                    if (programs.length === 0) {
                        logger.debug('epg', `No programs in ${url}, trying next`);
                        continue;
                    }

                    logger.info('epg', `Parsed ${programs.length} programs from ${url}`);

                    // Filter programs: only keep programs that haven't ended yet
                    const now = new Date();
                    const futurePrograms = programs.filter(p => !p.end_time || p.end_time > now);

                    // Insert programs in batches
                    const batchSize = 500;
                    for (let i = 0; i < futurePrograms.length; i += batchSize) {
                        const batch = futurePrograms.slice(i, i + batchSize);

                        for (const program of batch) {
                            await db.run(`
                                INSERT INTO epg_programs (channel_id, source_id, title, subtitle, description, category, start_time, end_time, icon, episode_num, rating, country)
                                VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            `, [
                                program.channel_id,
                                program.title,
                                program.subtitle,
                                program.description,
                                program.category,
                                program.start_time?.toISOString(),
                                program.end_time?.toISOString(),
                                program.icon,
                                program.episode_num,
                                program.rating,
                                program.country
                            ]);
                        }

                        app?.emit('epg:progress', {
                            country,
                            message: `${country}: ${Math.min(i + batchSize, futurePrograms.length)}/${futurePrograms.length} programs`,
                            current: Math.min(i + batchSize, futurePrograms.length),
                            total: futurePrograms.length
                        });
                    }

                    countryPrograms += futurePrograms.length;
                    countryChannels += new Set(futurePrograms.map(p => p.channel_id)).size;

                } catch (err) {
                    // File might not exist, continue to next
                    if (err.response?.status === 404) {
                        logger.debug('epg', `${url} not found, continuing`);
                    } else {
                        logger.warn('epg', `Failed to fetch ${url}: ${err.message}`);
                    }
                }
            }

            logger.info('epg', `${country}: ${countryPrograms} programs, ${countryChannels} channels`);
            totalPrograms += countryPrograms;
            totalChannels += countryChannels;
        }

        // Update channel tvg_id in media table for matching
        // Try to match EPG channel names to live TV channels
        await matchChannelsToEpg();

        logger.info('epg', `Global EPG sync complete: ${totalPrograms} programs, ${totalChannels} channels`);
        app?.emit('epg:complete', {
            programCount: totalPrograms,
            channelCount: totalChannels,
            countries
        });

        return {
            success: true,
            programCount: totalPrograms,
            channelCount: totalChannels,
            countries
        };

    } catch (err) {
        logger.error('epg', `Global EPG sync failed: ${err.message}`);
        app?.emit('epg:error', { error: err.message });
        throw err;
    }
}

/**
 * Normalize channel name for comparison
 */
function normalizeChannelName(name) {
    if (!name) return '';
    return name
        .toLowerCase()
        .replace(/\s*(hd|sd|fhd|uhd|4k)\s*/gi, '')  // Remove quality indicators
        .replace(/\s*\+\s*/g, ' plus ')              // Replace + with plus
        .replace(/\.\w{2}$/i, '')                    // Remove country suffix like .de
        .replace(/[^\w\s]/g, '')                     // Remove special chars
        .replace(/\s+/g, ' ')                        // Normalize spaces
        .trim();
}

/**
 * Match live TV channels to EPG channel IDs
 */
async function matchChannelsToEpg() {
    // Get unique channel IDs from EPG
    const epgChannels = await db.all(`
        SELECT DISTINCT channel_id FROM epg_programs WHERE source_id IS NULL
    `);

    // Get all live TV channels without tvg_id
    const liveChannels = await db.all(`
        SELECT id, title FROM media WHERE media_type = 'live' AND (tvg_id IS NULL OR tvg_id = '')
    `);

    let matchCount = 0;

    for (const epgChannel of epgChannels) {
        const epgNormalized = normalizeChannelName(epgChannel.channel_id);

        for (const liveChannel of liveChannels) {
            const liveNormalized = normalizeChannelName(liveChannel.title);

            // Check for match
            if (epgNormalized === liveNormalized ||
                epgNormalized.includes(liveNormalized) ||
                liveNormalized.includes(epgNormalized)) {

                await db.run(
                    'UPDATE media SET tvg_id = ? WHERE id = ? AND (tvg_id IS NULL OR tvg_id = "")',
                    [epgChannel.channel_id, liveChannel.id]
                );
                matchCount++;
            }
        }
    }

    logger.info('epg', `Channel-to-EPG matching complete: ${matchCount} matches found`);
    return matchCount;
}

/**
 * Get current program for a channel
 * @param {string} channelId - The tvg_id of the channel
 * @returns {Object|null} - Current program or null
 */
async function getCurrentProgram(channelId) {
    const now = new Date().toISOString();

    return db.get(`
        SELECT * FROM epg_programs
        WHERE channel_id = ?
          AND start_time <= ?
          AND (end_time IS NULL OR end_time > ?)
        ORDER BY start_time DESC LIMIT 1
    `, [channelId, now, now]);
}

/**
 * Get upcoming programs for a channel
 * @param {string} channelId - The tvg_id of the channel
 * @param {number} limit - Max programs to return
 * @returns {Array} - List of upcoming programs
 */
async function getUpcomingPrograms(channelId, limit = 5) {
    const now = new Date().toISOString();

    return db.all(`
        SELECT * FROM epg_programs
        WHERE channel_id = ?
          AND start_time > ?
        ORDER BY start_time ASC LIMIT ?
    `, [channelId, now, limit]);
}

/**
 * Get program schedule for a time range (for EPG grid view)
 * @param {Date} startTime - Start of time range
 * @param {Date} endTime - End of time range
 * @param {Array} channelIds - Optional filter by channel IDs
 * @returns {Array} - List of programs in the range
 */
async function getProgramGuide(startTime, endTime, channelIds = null) {
    let sql = `
        SELECT * FROM epg_programs
        WHERE start_time < ?
          AND (end_time IS NULL OR end_time > ?)
    `;
    const params = [endTime.toISOString(), startTime.toISOString()];

    if (channelIds && channelIds.length > 0) {
        const placeholders = channelIds.map(() => '?').join(',');
        sql += ` AND channel_id IN (${placeholders})`;
        params.push(...channelIds);
    }

    sql += ' ORDER BY channel_id, start_time ASC';

    return db.all(sql, params);
}

/**
 * Get EPG data for multiple channels at once
 * @param {Array} channelIds - Array of tvg_id values
 * @returns {Object} - Map of channelId -> { current, next }
 */
async function getEpgForChannels(channelIds) {
    if (!channelIds || channelIds.length === 0) return {};

    const now = new Date().toISOString();
    const placeholders = channelIds.map(() => '?').join(',');

    // Get current programs
    const currentPrograms = await db.all(`
        SELECT * FROM epg_programs
        WHERE channel_id IN (${placeholders})
          AND start_time <= ?
          AND (end_time IS NULL OR end_time > ?)
        ORDER BY channel_id, start_time DESC
    `, [...channelIds, now, now]);

    // Get next programs (one per channel)
    const nextPrograms = await db.all(`
        SELECT * FROM epg_programs
        WHERE channel_id IN (${placeholders})
          AND start_time > ?
        ORDER BY channel_id, start_time ASC
    `, [...channelIds, now]);

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
 * Get distinct channels that have EPG data
 * @param {string} country - Optional country filter
 * @returns {Array} - List of channel IDs with EPG data
 */
async function getChannelsWithEpg(country = null) {
    let sql = 'SELECT DISTINCT channel_id, country FROM epg_programs WHERE source_id IS NULL';
    const params = [];

    if (country) {
        sql += ' AND country = ?';
        params.push(country);
    }

    sql += ' ORDER BY channel_id';
    return db.all(sql, params);
}

/**
 * Get EPG program by ID (for scheduling recordings)
 * @param {number} programId - Program ID
 * @returns {Object} - Program data
 */
async function getProgramById(programId) {
    return db.get('SELECT * FROM epg_programs WHERE id = ?', [programId]);
}

module.exports = {
    init: async (modules) => {
        logger = modules.logger;
        db = modules.db;
        app = modules.app;
        settings = modules.settings;
    },

    // Global EPG sync
    syncGlobalEpg,
    getAvailableCountries,

    // Program queries
    getCurrentProgram,
    getUpcomingPrograms,
    getProgramGuide,
    getEpgForChannels,
    getChannelsWithEpg,
    getProgramById,

    // Utilities
    parseXmltvContent,
    parseXmltvDate,
    matchChannelsToEpg
};
