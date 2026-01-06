/**
 * Newznab Module
 * Provides API client for Newznab-compatible indexers (NZBGeek, DrunkenSlug, etc.)
 */

const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

// Module references
const refs = {
    logger: null,
    db: null,
    settings: null,
    app: null
};

// XML parser instance
const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_'
});

// Standard Newznab categories
const NEWZNAB_CATEGORIES = {
    movies: {
        all: 2000,
        foreign: 2010,
        other: 2020,
        sd: 2030,
        hd: 2040,
        uhd: 2045,
        bluray: 2050,
        '3d': 2060
    },
    tv: {
        all: 5000,
        webdl: 5010,
        foreign: 5020,
        sd: 5030,
        hd: 5040,
        uhd: 5045,
        other: 5050,
        sport: 5060,
        anime: 5070,
        documentary: 5080
    }
};

/**
 * Build API URL for Newznab requests
 */
function buildApiUrl(baseUrl, action, params = {}) {
    const url = new URL(baseUrl.replace(/\/$/, '') + '/api');
    url.searchParams.set('t', action);

    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
            url.searchParams.set(key, value);
        }
    }

    return url.toString();
}

/**
 * Parse Newznab API response
 */
function parseApiResponse(xmlContent) {
    try {
        const result = xmlParser.parse(xmlContent);

        // Check for error response
        if (result.error) {
            const code = result.error['@_code'] || 'unknown';
            const description = result.error['@_description'] || 'Unknown error';
            throw new Error(`Newznab API error ${code}: ${description}`);
        }

        // Handle RSS response (search results)
        if (result.rss?.channel) {
            const channel = result.rss.channel;
            const items = channel.item || [];

            // Normalize to array
            const itemArray = Array.isArray(items) ? items : (items ? [items] : []);

            return {
                type: 'rss',
                title: channel.title,
                description: channel.description,
                items: itemArray.map(parseRssItem)
            };
        }

        // Handle caps response
        if (result.caps) {
            return {
                type: 'caps',
                caps: parseCaps(result.caps)
            };
        }

        return result;
    } catch (err) {
        if (err.message.includes('Newznab API error')) {
            throw err;
        }
        throw new Error(`Failed to parse Newznab response: ${err.message}`);
    }
}

/**
 * Parse RSS item from search results
 */
function parseRssItem(item) {
    // Extract Newznab attributes
    const attrs = {};
    const newznabAttrs = item['newznab:attr'] || item['nzb:attr'] || [];
    const attrArray = Array.isArray(newznabAttrs) ? newznabAttrs : [newznabAttrs];

    for (const attr of attrArray) {
        if (attr && attr['@_name']) {
            attrs[attr['@_name']] = attr['@_value'];
        }
    }

    // Parse enclosure for NZB URL
    const enclosure = item.enclosure || {};

    return {
        title: item.title || '',
        guid: attrs.guid || item.guid?.['#text'] || item.guid || '',
        link: item.link || '',
        nzbUrl: enclosure['@_url'] || item.link || '',
        size: parseInt(attrs.size || enclosure['@_length'] || 0, 10),
        category: item.category || attrs.category || '',
        pubDate: item.pubDate || '',
        description: item.description || '',

        // Newznab specific attributes
        grabs: parseInt(attrs.grabs || 0, 10),
        files: parseInt(attrs.files || 0, 10),
        poster: attrs.poster || '',
        group: attrs.group || '',

        // Media info
        imdb: attrs.imdb || attrs.imdbid || '',
        tmdb: attrs.tmdb || attrs.tmdbid || '',
        tvdb: attrs.tvdb || attrs.tvdbid || '',
        tvrage: attrs.tvrage || attrs.tvrageid || '',
        tvmaze: attrs.tvmaze || attrs.tvmazeid || '',

        // Episode info
        season: attrs.season || '',
        episode: attrs.episode || '',

        // Quality info
        resolution: attrs.resolution || '',
        video: attrs.video || '',
        audio: attrs.audio || '',

        // Raw attributes for debugging
        rawAttrs: attrs
    };
}

/**
 * Parse indexer capabilities response
 */
function parseCaps(caps) {
    const result = {
        server: {},
        limits: {},
        categories: [],
        searching: {}
    };

    // Server info
    if (caps.server) {
        result.server = {
            version: caps.server['@_version'],
            title: caps.server['@_title'],
            strapline: caps.server['@_strapline'],
            email: caps.server['@_email'],
            url: caps.server['@_url'],
            image: caps.server['@_image']
        };
    }

    // Limits
    if (caps.limits) {
        result.limits = {
            max: parseInt(caps.limits['@_max'] || 100, 10),
            default: parseInt(caps.limits['@_default'] || 100, 10)
        };
    }

    // Categories
    if (caps.categories?.category) {
        const cats = Array.isArray(caps.categories.category)
            ? caps.categories.category
            : [caps.categories.category];

        result.categories = cats.map(cat => ({
            id: cat['@_id'],
            name: cat['@_name'],
            subcats: (cat.subcat ? (Array.isArray(cat.subcat) ? cat.subcat : [cat.subcat]) : [])
                .map(sub => ({
                    id: sub['@_id'],
                    name: sub['@_name']
                }))
        }));
    }

    // Search capabilities
    if (caps.searching) {
        for (const [type, info] of Object.entries(caps.searching)) {
            if (info && typeof info === 'object') {
                result.searching[type] = {
                    available: info['@_available'] === 'yes',
                    supportedParams: info['@_supportedParams']?.split(',') || []
                };
            }
        }
    }

    return result;
}

/**
 * Get indexer source by ID
 */
async function getIndexer(indexerId) {
    const source = await refs.db.get(
        'SELECT * FROM sources WHERE id = ? AND type = ?',
        [indexerId, 'newznab']
    );

    if (!source) {
        throw new Error('Newznab indexer not found');
    }

    const config = source.indexer_config ? JSON.parse(source.indexer_config) : {};

    return {
        ...source,
        config
    };
}

/**
 * Make API request to indexer
 */
async function apiRequest(indexer, action, params = {}) {
    const config = indexer.config || {};
    const apiKey = config.apiKey;

    if (!apiKey) {
        throw new Error('API key not configured for this indexer');
    }

    const url = buildApiUrl(indexer.url, action, {
        ...params,
        apikey: apiKey,
        o: 'xml'  // Always request XML response
    });

    refs.logger?.debug('newznab', `API request: ${action}`, { url: url.replace(apiKey, '***') });

    try {
        const response = await axios.get(url, {
            timeout: 30000,
            headers: {
                'User-Agent': indexer.user_agent || 'RecoStream/1.0'
            },
            responseType: 'text'
        });

        return parseApiResponse(response.data);
    } catch (err) {
        if (err.response) {
            // Try to parse error response
            try {
                const errorResult = parseApiResponse(err.response.data);
                throw new Error(errorResult.error || `HTTP ${err.response.status}`);
            } catch (parseErr) {
                throw new Error(`HTTP ${err.response.status}: ${err.response.statusText}`);
            }
        }
        throw err;
    }
}

/**
 * Get indexer capabilities
 */
async function getCapabilities(indexerId) {
    const indexer = await getIndexer(indexerId);
    const result = await apiRequest(indexer, 'caps');
    return result.caps;
}

/**
 * Test indexer connection
 */
async function testIndexer(source) {
    const config = source.indexer_config ? JSON.parse(source.indexer_config) : {};

    if (!config.apiKey) {
        throw new Error('API key is required');
    }

    const testIndexer = {
        ...source,
        config
    };

    const result = await apiRequest(testIndexer, 'caps');
    return {
        success: true,
        serverName: result.caps?.server?.title || 'Unknown',
        categories: result.caps?.categories?.length || 0
    };
}

/**
 * Search for movies
 */
async function searchMovies(indexerId, query, options = {}) {
    const indexer = await getIndexer(indexerId);

    const params = {
        q: query || undefined,
        cat: options.categories || NEWZNAB_CATEGORIES.movies.all,
        limit: options.limit || 100
    };

    // Add IMDB/TMDB ID if available
    if (options.imdbId) {
        params.imdbid = options.imdbId.replace(/^tt/, '');
    }
    if (options.tmdbId) {
        params.tmdbid = options.tmdbId;
    }
    if (options.year) {
        params.year = options.year;
    }

    const result = await apiRequest(indexer, 'movie', params);
    return result.items || [];
}

/**
 * Search for TV shows
 */
async function searchTv(indexerId, query, options = {}) {
    const indexer = await getIndexer(indexerId);

    const params = {
        q: query || undefined,
        cat: options.categories || NEWZNAB_CATEGORIES.tv.all,
        limit: options.limit || 100
    };

    // Add TV IDs if available
    if (options.tvdbId) {
        params.tvdbid = options.tvdbId;
    }
    if (options.imdbId) {
        params.imdbid = options.imdbId.replace(/^tt/, '');
    }
    if (options.tmdbId) {
        params.tmdbid = options.tmdbId;
    }
    if (options.season) {
        params.season = options.season;
    }
    if (options.episode) {
        params.ep = options.episode;
    }

    const result = await apiRequest(indexer, 'tvsearch', params);
    return result.items || [];
}

/**
 * General search
 */
async function search(indexerId, query, options = {}) {
    const indexer = await getIndexer(indexerId);

    const params = {
        q: query,
        cat: options.categories,
        limit: options.limit || 100,
        offset: options.offset || 0
    };

    const result = await apiRequest(indexer, 'search', params);
    return result.items || [];
}

/**
 * Get NZB file content
 */
async function getNzb(indexerId, guid) {
    const indexer = await getIndexer(indexerId);
    const config = indexer.config || {};

    const url = buildApiUrl(indexer.url, 'get', {
        id: guid,
        apikey: config.apiKey
    });

    refs.logger?.info('newznab', `Downloading NZB: ${guid}`);

    const response = await axios.get(url, {
        timeout: 60000,
        headers: {
            'User-Agent': indexer.user_agent || 'RecoStream/1.0'
        },
        responseType: 'text'
    });

    // Verify it's actually an NZB file
    if (!response.data.includes('<nzb') && !response.data.includes('<!DOCTYPE nzb')) {
        // Check if it's an error response
        try {
            const errorResult = parseApiResponse(response.data);
            throw new Error(errorResult.error || 'Invalid NZB response');
        } catch (e) {
            throw new Error('Invalid NZB file received');
        }
    }

    return response.data;
}

/**
 * Sync content from indexer to media table (RSS feed)
 * This is optional - mainly for browsing available content
 */
async function syncIndexer(source) {
    refs.logger?.info('newznab', `Starting sync for indexer: ${source.name}`);

    const config = source.indexer_config ? JSON.parse(source.indexer_config) : {};
    const categories = config.categories || [NEWZNAB_CATEGORIES.movies.all, NEWZNAB_CATEGORIES.tv.all];

    let totalItems = 0;
    const stats = { movies: 0, series: 0 };

    // Emit sync start
    refs.app?.emit('sync:start', { source: source.id });

    try {
        for (const category of categories) {
            // Fetch recent releases in this category
            const params = {
                cat: category,
                limit: 100
            };

            const indexer = { ...source, config };
            const result = await apiRequest(indexer, 'search', params);
            const items = result.items || [];

            for (const item of items) {
                try {
                    // Determine media type from category
                    const isMovie = category >= 2000 && category < 3000;
                    const mediaType = isMovie ? 'movie' : 'series';

                    // Extract year from title if present
                    const yearMatch = item.title.match(/\b(19|20)\d{2}\b/);
                    const year = yearMatch ? parseInt(yearMatch[0], 10) : null;

                    // Clean title
                    const cleanTitle = item.title
                        .replace(/\.(mkv|avi|mp4|nzb)$/i, '')
                        .replace(/\b(720p|1080p|2160p|4K|UHD|HDR|WEB-DL|BluRay|BRRip|DVDRip|x264|x265|HEVC)\b/gi, '')
                        .replace(/\s+/g, ' ')
                        .trim();

                    // Insert/update media entry
                    await refs.db.run(`
                        INSERT INTO media (
                            source_id, external_id, media_type, title, year,
                            category, stream_url, quality, is_active, last_seen_at, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                        ON CONFLICT(source_id, external_id) DO UPDATE SET
                            title = excluded.title,
                            year = excluded.year,
                            category = excluded.category,
                            stream_url = excluded.stream_url,
                            quality = excluded.quality,
                            is_active = 1,
                            last_seen_at = CURRENT_TIMESTAMP
                    `, [
                        source.id,
                        item.guid,
                        mediaType,
                        cleanTitle,
                        year,
                        item.category,
                        item.nzbUrl,
                        item.resolution || null
                    ]);

                    if (isMovie) stats.movies++;
                    else stats.series++;
                    totalItems++;
                } catch (itemErr) {
                    refs.logger?.warn('newznab', `Failed to process item: ${itemErr.message}`);
                }
            }

            refs.app?.emit('sync:progress', {
                source: source.id,
                step: 'sync',
                message: `Processing category ${category}`,
                percent: 50,
                current: totalItems,
                total: totalItems
            });
        }

        // Update source last sync time
        await refs.db.run(
            'UPDATE sources SET last_sync = CURRENT_TIMESTAMP WHERE id = ?',
            [source.id]
        );

        refs.logger?.info('newznab', `Sync complete: ${totalItems} items`, stats);
        refs.app?.emit('sync:complete', { source: source.id, stats });

        return stats;
    } catch (err) {
        refs.logger?.error('newznab', `Sync failed: ${err.message}`);
        refs.app?.emit('sync:error', { source: source.id, error: err.message });
        throw err;
    }
}

/**
 * Fetch NZB content from a direct URL
 * Used when we already have the NZB URL from a search result
 */
async function fetchNzb(nzbUrl) {
    refs.logger?.info('newznab', `Fetching NZB from: ${nzbUrl.substring(0, 80)}...`);

    try {
        const response = await axios.get(nzbUrl, {
            timeout: 60000,
            headers: {
                'User-Agent': 'RecoStream/1.0'
            },
            responseType: 'text'
        });

        // Verify it's actually an NZB file
        if (!response.data.includes('<nzb') && !response.data.includes('<!DOCTYPE nzb')) {
            // Check if it's an error response
            try {
                const errorResult = parseApiResponse(response.data);
                throw new Error(errorResult.error || 'Invalid NZB response');
            } catch (e) {
                throw new Error('Invalid NZB file received');
            }
        }

        refs.logger?.info('newznab', `NZB fetched successfully (${response.data.length} bytes)`);
        return response.data;
    } catch (err) {
        refs.logger?.error('newznab', `Failed to fetch NZB: ${err.message}`);
        throw err;
    }
}

module.exports = {
    init: async (modules) => {
        refs.logger = modules.logger;
        refs.db = modules.db;
        refs.settings = modules.settings;
        refs.app = modules.app;

        refs.logger?.info('newznab', 'Newznab module initialized');
    },

    // Public API
    getCapabilities,
    testIndexer,
    searchMovies,
    searchTv,
    search,
    getNzb,
    fetchNzb,
    syncIndexer,

    // Constants
    CATEGORIES: NEWZNAB_CATEGORIES
};
