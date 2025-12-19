/**
 * Source Pattern Analyzer Module
 * Analyzes IPTV sources to automatically detect parsing patterns
 * for title, year, language, and category extraction
 */

const axios = require('axios');

// Module references - stored in object to avoid closure issues
const refs = {
    logger: null,
    db: null,
    settings: null,
    llm: null,
    iptv: null
};

// Default headers for fetching
function getHeaders(userAgent = 'IBOPlayer') {
    return {
        'User-Agent': userAgent,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive'
    };
}

/**
 * Fetch sample entries from an IPTV source
 * Returns 5 samples each for movies, series, and live TV
 */
async function fetchSamples(source) {
    refs.logger?.info('source-analyzer', `Fetching samples from source: ${source.name}`);

    const samples = {
        movies: [],
        series: [],
        livetv: [],
        raw: [] // Store raw EXTINF lines for analysis
    };

    try {
        if (source.type === 'xtream') {
            return await fetchXtreamSamples(source);
        } else if (source.type === 'm3u') {
            return await fetchM3USamples(source);
        }
    } catch (err) {
        refs.logger?.error('source-analyzer', `Failed to fetch samples: ${err.message}`);
        throw err;
    }

    return samples;
}

/**
 * Fetch samples from Xtream Codes API
 */
async function fetchXtreamSamples(source) {
    const baseUrl = source.url.replace(/\/$/, '');
    const headers = getHeaders(source.user_agent);
    const cleanUsername = (source.username || '').replace(/[\x00-\x1F\x7F]/g, '');
    const cleanPassword = (source.password || '').replace(/[\x00-\x1F\x7F]/g, '');

    const samples = {
        movies: [],
        series: [],
        livetv: [],
        raw: []
    };

    // Fetch categories first
    const categoryMap = {};

    try {
        // Live categories
        const liveCatUrl = `${baseUrl}/player_api.php?username=${cleanUsername}&password=${cleanPassword}&action=get_live_categories`;
        const liveCatRes = await axios.get(liveCatUrl, { headers, timeout: 30000 });
        for (const cat of (liveCatRes.data || [])) {
            categoryMap[cat.category_id] = cat.category_name;
        }

        // VOD categories
        const vodCatUrl = `${baseUrl}/player_api.php?username=${cleanUsername}&password=${cleanPassword}&action=get_vod_categories`;
        const vodCatRes = await axios.get(vodCatUrl, { headers, timeout: 30000 });
        for (const cat of (vodCatRes.data || [])) {
            categoryMap[cat.category_id] = cat.category_name;
        }

        // Series categories
        const seriesCatUrl = `${baseUrl}/player_api.php?username=${cleanUsername}&password=${cleanPassword}&action=get_series_categories`;
        const seriesCatRes = await axios.get(seriesCatUrl, { headers, timeout: 30000 });
        for (const cat of (seriesCatRes.data || [])) {
            categoryMap[cat.category_id] = cat.category_name;
        }
    } catch (err) {
        refs.logger?.warn('source-analyzer', `Failed to fetch categories: ${err.message}`);
    }

    // Fetch live channels
    try {
        const liveUrl = `${baseUrl}/player_api.php?username=${cleanUsername}&password=${cleanPassword}&action=get_live_streams`;
        const liveRes = await axios.get(liveUrl, { headers, timeout: 30000 });
        const channels = liveRes.data || [];

        // Get 5 random samples
        const shuffled = channels.sort(() => 0.5 - Math.random());
        samples.livetv = shuffled.slice(0, 5).map(ch => ({
            name: ch.name,
            category: categoryMap[ch.category_id] || '',
            logo: ch.stream_icon,
            id: ch.stream_id,
            raw: `#EXTINF:-1 tvg-id="${ch.epg_channel_id || ''}" tvg-name="${ch.name}" tvg-logo="${ch.stream_icon || ''}" group-title="${categoryMap[ch.category_id] || ''}",${ch.name}`
        }));
    } catch (err) {
        refs.logger?.warn('source-analyzer', `Failed to fetch live channels: ${err.message}`);
    }

    // Fetch VOD (movies)
    try {
        const vodUrl = `${baseUrl}/player_api.php?username=${cleanUsername}&password=${cleanPassword}&action=get_vod_streams`;
        const vodRes = await axios.get(vodUrl, { headers, timeout: 60000 });
        const movies = vodRes.data || [];

        const shuffled = movies.sort(() => 0.5 - Math.random());
        samples.movies = shuffled.slice(0, 5).map(m => ({
            name: m.name,
            category: categoryMap[m.category_id] || '',
            logo: m.stream_icon,
            id: m.stream_id,
            year: m.year,
            raw: `#EXTINF:-1 tvg-id="${m.stream_id}" tvg-name="${m.name}" tvg-logo="${m.stream_icon || ''}" group-title="${categoryMap[m.category_id] || ''}",${m.name}`
        }));
    } catch (err) {
        refs.logger?.warn('source-analyzer', `Failed to fetch VOD: ${err.message}`);
    }

    // Fetch series
    try {
        const seriesUrl = `${baseUrl}/player_api.php?username=${cleanUsername}&password=${cleanPassword}&action=get_series`;
        const seriesRes = await axios.get(seriesUrl, { headers, timeout: 60000 });
        const series = seriesRes.data || [];

        const shuffled = series.sort(() => 0.5 - Math.random());
        samples.series = shuffled.slice(0, 5).map(s => ({
            name: s.name,
            category: categoryMap[s.category_id] || '',
            logo: s.cover,
            id: s.series_id,
            year: s.year,
            raw: `#EXTINF:-1 tvg-id="${s.series_id}" tvg-name="${s.name}" tvg-logo="${s.cover || ''}" group-title="${categoryMap[s.category_id] || ''}",${s.name}`
        }));
    } catch (err) {
        refs.logger?.warn('source-analyzer', `Failed to fetch series: ${err.message}`);
    }

    // Combine all raw entries
    samples.raw = [
        ...samples.movies.map(m => m.raw),
        ...samples.series.map(s => s.raw),
        ...samples.livetv.map(l => l.raw)
    ];

    refs.logger?.info('source-analyzer', `Xtream samples: ${samples.movies.length} movies, ${samples.series.length} series, ${samples.livetv.length} live`);
    return samples;
}

/**
 * Fetch samples from M3U playlist
 */
async function fetchM3USamples(source) {
    const headers = getHeaders(source.user_agent);

    const samples = {
        movies: [],
        series: [],
        livetv: [],
        raw: []
    };

    // Fetch M3U content (limit to first portion to speed up)
    const response = await axios.get(source.url, {
        headers,
        timeout: 120000,
        maxContentLength: 100 * 1024 * 1024, // 100MB max
        maxBodyLength: 100 * 1024 * 1024
    });

    const content = response.data;
    if (!content || typeof content !== 'string') {
        throw new Error('Invalid M3U content');
    }

    const lines = content.split('\n');
    const entries = [];

    // Parse EXTINF entries
    let currentExtinf = null;
    for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed.startsWith('#EXTINF:')) {
            currentExtinf = trimmed;
        } else if (currentExtinf && trimmed && !trimmed.startsWith('#')) {
            // Extract attributes from EXTINF
            const entry = parseExtinfLine(currentExtinf);
            entry.url = trimmed;
            entry.raw = currentExtinf;
            entries.push(entry);
            currentExtinf = null;

            // Stop after collecting enough entries (about 1000 should give good variety)
            if (entries.length >= 1000) break;
        }
    }

    // Categorize entries
    for (const entry of entries) {
        const category = classifyEntry(entry);

        if (category === 'movie' && samples.movies.length < 5) {
            samples.movies.push(entry);
        } else if (category === 'series' && samples.series.length < 5) {
            samples.series.push(entry);
        } else if (category === 'live' && samples.livetv.length < 5) {
            samples.livetv.push(entry);
        }

        // Stop if we have enough samples
        if (samples.movies.length >= 5 && samples.series.length >= 5 && samples.livetv.length >= 5) {
            break;
        }
    }

    // If we don't have enough of each type, fill with random entries
    if (samples.movies.length < 5 || samples.series.length < 5 || samples.livetv.length < 5) {
        const shuffled = entries.sort(() => 0.5 - Math.random());
        for (const entry of shuffled) {
            if (samples.movies.length < 5) {
                samples.movies.push(entry);
            } else if (samples.series.length < 5) {
                samples.series.push(entry);
            } else if (samples.livetv.length < 5) {
                samples.livetv.push(entry);
            } else {
                break;
            }
        }
    }

    // Combine all raw entries
    samples.raw = [
        ...samples.movies.map(m => m.raw),
        ...samples.series.map(s => s.raw),
        ...samples.livetv.map(l => l.raw)
    ];

    refs.logger?.info('source-analyzer', `M3U samples: ${samples.movies.length} movies, ${samples.series.length} series, ${samples.livetv.length} live`);
    return samples;
}

/**
 * Parse an EXTINF line to extract attributes
 */
function parseExtinfLine(line) {
    const entry = {
        name: '',
        category: '',
        logo: '',
        id: '',
        language: ''
    };

    // Extract tvg-id
    const idMatch = line.match(/tvg-id="([^"]*)"/i);
    if (idMatch) entry.id = idMatch[1];

    // Extract tvg-name
    const nameMatch = line.match(/tvg-name="([^"]*)"/i);
    if (nameMatch) entry.name = nameMatch[1];

    // Extract tvg-logo
    const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
    if (logoMatch) entry.logo = logoMatch[1];

    // Extract group-title
    const groupMatch = line.match(/group-title="([^"]*)"/i);
    if (groupMatch) entry.category = groupMatch[1];

    // Extract tvg-language
    const langMatch = line.match(/tvg-language="([^"]*)"/i);
    if (langMatch) entry.language = langMatch[1];

    // Extract name from after comma if not found in tvg-name
    if (!entry.name) {
        const commaIdx = line.lastIndexOf(',');
        if (commaIdx > 0) {
            entry.name = line.substring(commaIdx + 1).trim();
        }
    }

    return entry;
}

/**
 * Classify an entry as movie, series, or live TV
 */
function classifyEntry(entry) {
    const text = `${entry.category || ''} ${entry.name || ''}`.toLowerCase();

    // Series indicators
    const seriesPatterns = /serie|serien|seriale|show|shows|season|s\d+e\d+|sorozat|tvshow|episode/i;
    if (seriesPatterns.test(text)) return 'series';

    // Movie indicators
    const moviePatterns = /movie|film|filme|filma|filmes|filmi|vod|cinema|kino|cine/i;
    if (moviePatterns.test(text)) return 'movie';

    // Live TV indicators
    const livePatterns = /live|news|sport|24\/7|channel|tv\s|\stv|radio|ppv/i;
    if (livePatterns.test(text)) return 'live';

    // Default to live if URL ends in .ts (typical for live streams)
    if (entry.url && entry.url.endsWith('.ts')) return 'live';

    return 'live'; // Default
}

/**
 * Analyze samples using LLM to generate regex patterns
 */
async function analyzeWithLLM(samples) {
    if (!refs.llm?.isConfigured()) {
        refs.logger?.info('source-analyzer', 'LLM not configured, using programmatic analysis');
        return null;
    }

    refs.logger?.info('source-analyzer', 'Analyzing samples with LLM');

    // Build prompt with sample data
    const movieSamples = samples.movies.map(m => `  - Name: "${m.name}", Category: "${m.category}"`).join('\n');
    const seriesSamples = samples.series.map(s => `  - Name: "${s.name}", Category: "${s.category}"`).join('\n');
    const livetvSamples = samples.livetv.map(l => `  - Name: "${l.name}", Category: "${l.category}"`).join('\n');

    const prompt = `Analyze these IPTV M3U entries and generate regex patterns to extract metadata.

Sample MOVIES entries:
${movieSamples || '  (none available)'}

Sample SERIES entries:
${seriesSamples || '  (none available)'}

Sample LIVE TV entries:
${livetvSamples || '  (none available)'}

Based on these samples, generate regex patterns that would work for this IPTV source.
Look for common patterns like:
- Language codes at the start (e.g., "DE - ", "EN: ", "[DE]")
- Year in title (e.g., "(2024)", "- 2024")
- Quality indicators (4K, HD, FHD)
- Category keywords that distinguish movies from series from live TV

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "titlePatterns": {
    "language": "regex pattern to extract 2-letter language code or null if not found",
    "year": "regex pattern to extract 4-digit year or null if not found",
    "cleanTitle": "regex pattern with capture group for clean title (removing prefixes/suffixes) or null"
  },
  "contentTypePatterns": {
    "movies": "regex pattern matching movie categories/titles",
    "series": "regex pattern matching series categories/titles",
    "livetv": "regex pattern matching live TV categories/titles"
  },
  "confidence": 0.85
}`;

    try {
        const result = await llm.query(prompt, {
            temperature: 0.2,
            maxTokens: 1000,
            timeout: 60000
        });

        // Extract JSON from response
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            refs.logger?.warn('source-analyzer', 'LLM did not return valid JSON');
            return null;
        }

        const patterns = JSON.parse(jsonMatch[0]);

        // Validate the patterns
        const validated = validateLLMPatterns(patterns);
        if (!validated) {
            refs.logger?.warn('source-analyzer', 'LLM patterns failed validation');
            return null;
        }

        refs.logger?.info('source-analyzer', `LLM analysis complete, confidence: ${patterns.confidence}`);
        return patterns;

    } catch (err) {
        refs.logger?.error('source-analyzer', `LLM analysis failed: ${err.message}`);
        return null;
    }
}

/**
 * Validate LLM-generated patterns are valid regex
 */
function validateLLMPatterns(patterns) {
    if (!patterns || typeof patterns !== 'object') return false;

    const testPatterns = [
        patterns.titlePatterns?.language,
        patterns.titlePatterns?.year,
        patterns.titlePatterns?.cleanTitle,
        patterns.contentTypePatterns?.movies,
        patterns.contentTypePatterns?.series,
        patterns.contentTypePatterns?.livetv
    ];

    for (const pattern of testPatterns) {
        if (pattern && pattern !== 'null') {
            try {
                new RegExp(pattern);
            } catch (e) {
                refs.logger?.warn('source-analyzer', `Invalid regex pattern: ${pattern}`);
                return false;
            }
        }
    }

    return true;
}

/**
 * Build analysis using programmatic pattern detection (fallback when LLM unavailable)
 */
function buildManualAnalysis(samples) {
    refs.logger?.info('source-analyzer', 'Building programmatic pattern analysis');

    const allNames = [
        ...samples.movies.map(m => m.name),
        ...samples.series.map(s => s.name),
        ...samples.livetv.map(l => l.name)
    ];

    const allCategories = [
        ...samples.movies.map(m => m.category),
        ...samples.series.map(s => s.category),
        ...samples.livetv.map(l => l.category)
    ];

    const patterns = {
        titlePatterns: {
            language: null,
            year: null,
            cleanTitle: null
        },
        contentTypePatterns: {
            movies: null,
            series: null,
            livetv: null
        },
        confidence: 0.5, // Lower confidence for programmatic detection
        detectedPatterns: []
    };

    // Detect language prefix patterns
    const langPrefixPatterns = [
        { pattern: '^([A-Z]{2})\\s*[-:]\\s*', description: 'Language code prefix (DE - )' },
        { pattern: '^\\[([A-Z]{2})\\]\\s*', description: 'Language code in brackets [DE]' },
        { pattern: '\\|([A-Z]{2})\\|', description: 'Language code in pipes |DE|' }
    ];

    for (const lang of langPrefixPatterns) {
        const regex = new RegExp(lang.pattern, 'i');
        const matches = allNames.filter(n => regex.test(n));
        if (matches.length >= 3) { // At least 3 matches
            patterns.titlePatterns.language = lang.pattern;
            patterns.detectedPatterns.push({
                type: 'language',
                pattern: lang.pattern,
                description: lang.description,
                matches: matches.length,
                examples: matches.slice(0, 3)
            });
            patterns.confidence += 0.1;
            break;
        }
    }

    // Detect year patterns
    const yearPatterns = [
        { pattern: '\\((\\d{4})\\)\\s*$', description: 'Year in parentheses at end (2024)' },
        { pattern: '\\((\\d{4})\\)', description: 'Year in parentheses (2024)' },
        { pattern: '[-–]\\s*(\\d{4})\\s*$', description: 'Year after dash - 2024' }
    ];

    for (const year of yearPatterns) {
        const regex = new RegExp(year.pattern);
        const matches = allNames.filter(n => regex.test(n));
        if (matches.length >= 2) {
            patterns.titlePatterns.year = year.pattern;
            patterns.detectedPatterns.push({
                type: 'year',
                pattern: year.pattern,
                description: year.description,
                matches: matches.length,
                examples: matches.slice(0, 3)
            });
            patterns.confidence += 0.1;
            break;
        }
    }

    // Detect content type patterns from categories
    const movieKeywords = allCategories
        .filter(c => /movie|film|vod|cinema/i.test(c))
        .map(c => c.split(/\s+/)[0])
        .filter((v, i, a) => a.indexOf(v) === i);

    if (movieKeywords.length > 0) {
        patterns.contentTypePatterns.movies = movieKeywords.join('|');
        patterns.detectedPatterns.push({
            type: 'movies',
            pattern: movieKeywords.join('|'),
            description: 'Movie category keywords',
            keywords: movieKeywords
        });
    }

    const seriesKeywords = allCategories
        .filter(c => /serie|show|season/i.test(c))
        .map(c => c.split(/\s+/)[0])
        .filter((v, i, a) => a.indexOf(v) === i);

    if (seriesKeywords.length > 0) {
        patterns.contentTypePatterns.series = seriesKeywords.join('|');
        patterns.detectedPatterns.push({
            type: 'series',
            pattern: seriesKeywords.join('|'),
            description: 'Series category keywords',
            keywords: seriesKeywords
        });
    }

    const liveKeywords = allCategories
        .filter(c => /live|news|sport|channel/i.test(c))
        .map(c => c.split(/\s+/)[0])
        .filter((v, i, a) => a.indexOf(v) === i);

    if (liveKeywords.length > 0) {
        patterns.contentTypePatterns.livetv = liveKeywords.join('|');
        patterns.detectedPatterns.push({
            type: 'livetv',
            pattern: liveKeywords.join('|'),
            description: 'Live TV category keywords',
            keywords: liveKeywords
        });
    }

    // Cap confidence at 0.9
    patterns.confidence = Math.min(patterns.confidence, 0.9);

    refs.logger?.info('source-analyzer', `Programmatic analysis complete, confidence: ${patterns.confidence}`);
    return patterns;
}

/**
 * Validate patterns against samples and return preview results
 */
function validatePatterns(patterns, samples) {
    const results = {
        movies: [],
        series: [],
        livetv: [],
        successRate: 0,
        totalTested: 0,
        successful: 0
    };

    const allSamples = [
        ...samples.movies.map(s => ({ ...s, expectedType: 'movie' })),
        ...samples.series.map(s => ({ ...s, expectedType: 'series' })),
        ...samples.livetv.map(s => ({ ...s, expectedType: 'live' }))
    ];

    for (const sample of allSamples) {
        const parsed = {
            original: sample.name,
            category: sample.category,
            expectedType: sample.expectedType,
            extracted: {}
        };

        // Try language extraction
        if (patterns.titlePatterns?.language) {
            try {
                const regex = new RegExp(patterns.titlePatterns.language, 'i');
                const match = sample.name.match(regex);
                if (match && match[1]) {
                    parsed.extracted.language = match[1].toUpperCase();
                }
            } catch (e) {}
        }

        // Try year extraction
        if (patterns.titlePatterns?.year) {
            try {
                const regex = new RegExp(patterns.titlePatterns.year);
                const match = sample.name.match(regex);
                if (match && match[1]) {
                    parsed.extracted.year = match[1];
                }
            } catch (e) {}
        }

        // Try content type detection
        let detectedType = null;
        const textToCheck = `${sample.category} ${sample.name}`;

        if (patterns.contentTypePatterns?.series) {
            try {
                const regex = new RegExp(patterns.contentTypePatterns.series, 'i');
                if (regex.test(textToCheck)) detectedType = 'series';
            } catch (e) {}
        }

        if (!detectedType && patterns.contentTypePatterns?.movies) {
            try {
                const regex = new RegExp(patterns.contentTypePatterns.movies, 'i');
                if (regex.test(textToCheck)) detectedType = 'movie';
            } catch (e) {}
        }

        if (!detectedType && patterns.contentTypePatterns?.livetv) {
            try {
                const regex = new RegExp(patterns.contentTypePatterns.livetv, 'i');
                if (regex.test(textToCheck)) detectedType = 'live';
            } catch (e) {}
        }

        parsed.extracted.type = detectedType;
        parsed.typeMatch = detectedType === sample.expectedType;

        results.totalTested++;
        if (parsed.typeMatch || Object.keys(parsed.extracted).length > 1) {
            results.successful++;
        }

        // Add to appropriate category
        if (sample.expectedType === 'movie') {
            results.movies.push(parsed);
        } else if (sample.expectedType === 'series') {
            results.series.push(parsed);
        } else {
            results.livetv.push(parsed);
        }
    }

    results.successRate = results.totalTested > 0
        ? Math.round((results.successful / results.totalTested) * 100)
        : 0;

    return results;
}

/**
 * Full analysis flow - fetch samples, analyze, validate
 */
async function analyzeSource(source) {
    refs.logger?.info('source-analyzer', `Starting full analysis for source: ${source.name}`);

    // Step 1: Fetch samples
    const samples = await fetchSamples(source);

    if (!samples.movies.length && !samples.series.length && !samples.livetv.length) {
        throw new Error('No samples could be fetched from source');
    }

    // Step 2: Try LLM analysis first, fall back to programmatic
    let patterns = await analyzeWithLLM(samples);
    const usedLLM = !!patterns;

    if (!patterns) {
        patterns = buildManualAnalysis(samples);
    }

    // Step 3: Validate patterns against samples
    const validation = validatePatterns(patterns, samples);

    // Step 4: Store samples in database for re-analysis
    await storeSamples(source.id, samples);

    return {
        success: true,
        usedLLM,
        patterns,
        validation,
        samples: {
            movieCount: samples.movies.length,
            seriesCount: samples.series.length,
            livetvCount: samples.livetv.length,
            movies: samples.movies,
            series: samples.series,
            livetv: samples.livetv
        }
    };
}

/**
 * Store samples in database for future re-analysis
 */
async function storeSamples(sourceId, samples) {
    try {
        // Clear existing samples for this source
        await refs.db.run('DELETE FROM source_samples WHERE source_id = ?', [sourceId]);

        // Insert new samples
        const insertSample = async (sample, contentType) => {
            await refs.db.run(`
                INSERT INTO source_samples (source_id, content_type, raw_extinf, raw_url)
                VALUES (?, ?, ?, ?)
            `, [sourceId, contentType, sample.raw || '', sample.url || '']);
        };

        for (const sample of samples.movies) {
            await insertSample(sample, 'movie');
        }
        for (const sample of samples.series) {
            await insertSample(sample, 'series');
        }
        for (const sample of samples.livetv) {
            await insertSample(sample, 'live');
        }

        refs.logger?.debug('source-analyzer', `Stored ${samples.movies.length + samples.series.length + samples.livetv.length} samples`);
    } catch (err) {
        refs.logger?.warn('source-analyzer', `Failed to store samples: ${err.message}`);
        // Non-fatal error, continue
    }
}

/**
 * Convert analysis patterns to parser config format
 */
function patternsToParserConfig(patterns) {
    const config = {
        patterns: {
            id: 'tvg-id="([^"]*)"',
            name: 'tvg-name="([^"]*)"',
            logo: 'tvg-logo="([^"]*)"',
            group: 'group-title="([^"]*)"',
            language: 'tvg-language="([^"]*)"'
        },
        titlePatterns: {},
        contentTypePatterns: {},
        nameExtraction: 'afterComma'
    };

    // Copy title patterns
    if (patterns.titlePatterns) {
        if (patterns.titlePatterns.language) {
            config.titlePatterns.language = patterns.titlePatterns.language;
        }
        if (patterns.titlePatterns.year) {
            config.titlePatterns.year = patterns.titlePatterns.year;
        }
    }

    // Copy content type patterns
    if (patterns.contentTypePatterns) {
        if (patterns.contentTypePatterns.movies) {
            config.contentTypePatterns.movies = patterns.contentTypePatterns.movies;
        }
        if (patterns.contentTypePatterns.series) {
            config.contentTypePatterns.series = patterns.contentTypePatterns.series;
        }
        if (patterns.contentTypePatterns.livetv) {
            config.contentTypePatterns.livetv = patterns.contentTypePatterns.livetv;
        }
    }

    return config;
}

module.exports = {
    init: async (modules) => {
        refs.logger = modules.logger;
        refs.db = modules.db;
        refs.settings = modules.settings;
        refs.llm = modules.llm;
        refs.iptv = modules.iptv;

        refs.logger?.info('source-analyzer', 'Source Analyzer module initialized');
    },

    fetchSamples,
    analyzeWithLLM,
    buildManualAnalysis,
    validatePatterns,
    analyzeSource,
    patternsToParserConfig,
    storeSamples
};
