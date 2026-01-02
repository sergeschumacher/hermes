/**
 * LLM Module - Unified interface for OpenAI and Ollama
 * Provides title translation and channel matching capabilities
 */

const axios = require('axios');

let settings = null;
let logger = null;

// Language name mapping for prompts
const LANGUAGE_NAMES = {
    'de': 'German', 'en': 'English', 'es': 'Spanish', 'fr': 'French',
    'it': 'Italian', 'pt': 'Portuguese', 'nl': 'Dutch', 'pl': 'Polish',
    'ru': 'Russian', 'tr': 'Turkish', 'ar': 'Arabic', 'ja': 'Japanese',
    'ko': 'Korean', 'zh': 'Chinese', 'sv': 'Swedish', 'da': 'Danish',
    'no': 'Norwegian', 'fi': 'Finnish', 'el': 'Greek', 'cs': 'Czech',
    'hu': 'Hungarian', 'ro': 'Romanian', 'bg': 'Bulgarian', 'uk': 'Ukrainian'
};

/**
 * Check if LLM is configured and available
 */
function isConfigured() {
    const provider = settings?.get('llmProvider');
    if (!provider || provider === 'none') return false;

    if (provider === 'openai') {
        return !!settings?.get('openaiApiKey');
    }

    if (provider === 'ollama') {
        return !!settings?.get('ollamaUrl');
    }

    return false;
}

/**
 * Get current provider name
 */
function getProvider() {
    return settings?.get('llmProvider') || 'none';
}

/**
 * Send a query to the configured LLM provider
 */
async function query(prompt, options = {}) {
    const provider = settings?.get('llmProvider');

    if (!provider || provider === 'none') {
        throw new Error('LLM not configured');
    }

    if (provider === 'openai') {
        return queryOpenAI(prompt, options);
    }

    if (provider === 'ollama') {
        return queryOllama(prompt, options);
    }

    throw new Error(`Unknown LLM provider: ${provider}`);
}

/**
 * Query OpenAI API
 */
async function queryOpenAI(prompt, options = {}) {
    const apiKey = settings?.get('openaiApiKey');
    const model = options.model || settings?.get('openaiModel') || 'gpt-4o-mini';

    if (!apiKey) {
        throw new Error('OpenAI API key not configured');
    }

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model,
                messages: [
                    { role: 'user', content: prompt }
                ],
                temperature: options.temperature ?? 0.3,
                max_tokens: options.maxTokens ?? 500
            },
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: options.timeout ?? 30000
            }
        );

        return response.data.choices[0]?.message?.content?.trim() || '';
    } catch (error) {
        logger?.error('llm', 'OpenAI query failed', {
            error: error.response?.data?.error?.message || error.message
        });
        throw error;
    }
}

/**
 * Query Ollama API
 */
async function queryOllama(prompt, options = {}) {
    const baseUrl = settings?.get('ollamaUrl') || 'http://localhost:11434';
    const model = options.model || settings?.get('ollamaModel') || 'llama3.2';

    try {
        const response = await axios.post(
            `${baseUrl.replace(/\/$/, '')}/api/generate`,
            {
                model,
                prompt,
                stream: false,
                options: {
                    temperature: options.temperature ?? 0.3
                }
            },
            {
                timeout: options.timeout ?? 60000 // Ollama can be slower
            }
        );

        return response.data.response?.trim() || '';
    } catch (error) {
        logger?.error('llm', 'Ollama query failed', {
            error: error.message,
            url: baseUrl
        });
        throw error;
    }
}

/**
 * Translate a movie/TV title to English
 */
async function translateTitle(title, sourceLanguage) {
    if (!isConfigured()) {
        return null;
    }

    const langName = LANGUAGE_NAMES[sourceLanguage?.toLowerCase()] || sourceLanguage || 'non-English';

    const prompt = `You are a movie/TV title translator specializing in finding official English titles.

Given this ${langName} movie or TV show title: "${title}"

Provide ONLY the official English title as used by TMDB/IMDb.
If this is already an English title or you're unsure, return the original title exactly as given.
Do not add any explanation, quotes, or extra text. Just the title.`;

    try {
        const result = await query(prompt, { temperature: 0.1, maxTokens: 100 });

        // Clean up the result
        let translated = result
            .replace(/^["']|["']$/g, '') // Remove surrounding quotes
            .replace(/^(The English title is|English title:|Title:)\s*/i, '') // Remove common prefixes
            .trim();

        // If it looks like it contains explanation, try to extract just the title
        if (translated.includes('\n')) {
            translated = translated.split('\n')[0].trim();
        }

        logger?.info('llm', `Translated title: "${title}" -> "${translated}"`);
        return translated;
    } catch (error) {
        logger?.error('llm', 'Title translation failed', { title, error: error.message });
        return null;
    }
}

/**
 * Identify a movie or TV show from a foreign/localized title
 * Returns detailed information including original title and TMDB ID
 *
 * @param {string} title - The title to identify (e.g., "Zurück in die Vergangenheit")
 * @param {string} year - Optional year hint
 * @param {string} mediaType - 'movie' or 'series'
 * @param {string} sourceLanguage - Language code hint (e.g., 'de')
 * @returns {Object|null} - { originalTitle, englishTitle, tmdbId, year, confidence }
 */
async function identifyMedia(title, year, mediaType, sourceLanguage) {
    if (!isConfigured()) {
        return null;
    }

    const langName = LANGUAGE_NAMES[sourceLanguage?.toLowerCase()] || sourceLanguage || 'unknown';
    const typeHint = mediaType === 'movie' ? 'movie' : 'TV series/show';
    const yearHint = year ? ` (${year})` : '';

    const prompt = `You are a movie and TV show expert with comprehensive knowledge of international titles.

Identify this ${typeHint}: "${title}"${yearHint}
${sourceLanguage ? `The title appears to be in ${langName}.` : ''}

This could be:
1. A localized/dubbed title (e.g., German title for an American show)
2. A translated title
3. The original title with slight modifications (e.g., with language tags like "(JP) (Ger Sub)")
4. An anime or foreign production that should keep its original title
5. A reboot/remake where the year in the title might not match the actual release

IMPORTANT:
- The year in the title (if present) might be incorrect or refer to a different version.
- Anime titles like "07-Ghost", "Naruto", "Death Note" should be identified as their original anime, NOT confused with Western shows.
- Language tags like "(JP)", "(Ger Sub)", "(Eng Dub)" indicate the audio/subtitle language, not that it's a different show.

Please identify the ORIGINAL production and provide:
- The original title (as listed on TMDB/IMDb)
- The TMDB ID if you know it (format: tv/12345 for TV shows, movie/12345 for movies)
- The original release year

Respond ONLY with a valid JSON object in this exact format:
{"englishTitle": "Original Title", "tmdbId": "tv/12345", "year": 2009, "confidence": 0.95}

Rules:
- tmdbId should be in format "tv/NUMBER" or "movie/NUMBER" or null if unknown
- confidence: 0.95+ = certain match, 0.8-0.94 = likely, 0.6-0.79 = possible, below 0.6 = uncertain
- If you cannot identify it or are uncertain, return {"englishTitle": null, "tmdbId": null, "year": null, "confidence": 0}
- Do NOT guess or make up TMDB IDs - only provide if you are certain`;

    try {
        const result = await query(prompt, { temperature: 0.1, maxTokens: 200 });

        // Extract JSON from response
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            logger?.warn('llm', `identifyMedia: No JSON in response for "${title}"`);
            return null;
        }

        const parsed = JSON.parse(jsonMatch[0]);

        // Validate response
        if (!parsed.englishTitle || parsed.confidence < 0.6) {
            logger?.info('llm', `identifyMedia: Low confidence or no match for "${title}"`);
            return null;
        }

        // Parse TMDB ID format (e.g., "tv/4018" -> { type: 'tv', id: 4018 })
        let tmdbType = null;
        let tmdbNumericId = null;
        if (parsed.tmdbId) {
            const tmdbMatch = parsed.tmdbId.match(/^(tv|movie)\/(\d+)$/i);
            if (tmdbMatch) {
                tmdbType = tmdbMatch[1].toLowerCase();
                tmdbNumericId = parseInt(tmdbMatch[2], 10);
            }
        }

        logger?.info('llm', `identifyMedia: "${title}" -> "${parsed.englishTitle}" (TMDB: ${parsed.tmdbId}, confidence: ${parsed.confidence})`);

        return {
            originalTitle: title,
            englishTitle: parsed.englishTitle,
            tmdbId: tmdbNumericId,
            tmdbType: tmdbType,
            year: parsed.year,
            confidence: parsed.confidence
        };
    } catch (error) {
        logger?.error('llm', 'identifyMedia failed', { title, error: error.message });
        return null;
    }
}

/**
 * Batch identify multiple titles (more efficient than individual calls)
 *
 * @param {Array} items - Array of { title, year, mediaType }
 * @param {string} sourceLanguage - Common language hint
 * @returns {Array} - Array of identification results
 */
async function identifyMediaBatch(items, sourceLanguage) {
    if (!isConfigured() || !items?.length) {
        return [];
    }

    const langName = LANGUAGE_NAMES[sourceLanguage?.toLowerCase()] || sourceLanguage || 'unknown';

    // Process in batches of 10 to avoid token limits
    const BATCH_SIZE = 10;
    const allResults = [];

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE);

        const itemList = batch.map((item, idx) => {
            const yearHint = item.year ? ` (${item.year})` : '';
            const typeHint = item.mediaType === 'movie' ? 'movie' : 'series';
            return `${idx + 1}. "${item.title}"${yearHint} [${typeHint}]`;
        }).join('\n');

        const prompt = `You are a movie and TV show expert with comprehensive knowledge of international titles.

Identify these ${langName} titles and find their original English names:

${itemList}

For each title, identify the original production it represents.
Note:
- Some titles are localized/dubbed versions of English productions
- Anime titles (like "07-Ghost", "Death Note") should be identified as the original anime
- Language tags like "(JP)", "(Ger Sub)" indicate audio/subtitle options, not different shows
- If the title is already in its original form, keep it as-is

Respond with a JSON array. For each item include:
- index: the number from the list (1-based)
- englishTitle: the original English title (or same if already English)
- tmdbId: format "tv/NUMBER" or "movie/NUMBER" (or null if unknown)
- confidence: 0.0-1.0 (only include matches with confidence >= 0.6)

Example response format:
[{"index": 1, "englishTitle": "Original Title", "tmdbId": "tv/12345", "confidence": 0.95}]

Only include titles you can confidently identify. Omit uncertain matches.
Do NOT guess TMDB IDs - only include if you are certain.`;

        try {
            const result = await query(prompt, { temperature: 0.1, maxTokens: 1000, timeout: 60000 });

            // Extract JSON array from response
            const jsonMatch = result.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);

                for (const match of parsed) {
                    if (!match.englishTitle || match.confidence < 0.6) continue;

                    const originalItem = batch[match.index - 1];
                    if (!originalItem) continue;

                    // Parse TMDB ID
                    let tmdbType = null;
                    let tmdbNumericId = null;
                    if (match.tmdbId) {
                        const tmdbMatch = match.tmdbId.match(/^(tv|movie)\/(\d+)$/i);
                        if (tmdbMatch) {
                            tmdbType = tmdbMatch[1].toLowerCase();
                            tmdbNumericId = parseInt(tmdbMatch[2], 10);
                        }
                    }

                    allResults.push({
                        originalTitle: originalItem.title,
                        englishTitle: match.englishTitle,
                        tmdbId: tmdbNumericId,
                        tmdbType: tmdbType,
                        year: originalItem.year,
                        mediaType: originalItem.mediaType,
                        confidence: match.confidence
                    });
                }
            }
        } catch (error) {
            logger?.error('llm', 'identifyMediaBatch failed', {
                batch: Math.floor(i / BATCH_SIZE) + 1,
                error: error.message
            });
        }
    }

    logger?.info('llm', `identifyMediaBatch: Identified ${allResults.length} of ${items.length} titles`);
    return allResults;
}

/**
 * Match EPG channel IDs to IPTV source channel names
 */
async function matchChannels(epgChannels, sourceChannels) {
    if (!isConfigured() || !epgChannels?.length || !sourceChannels?.length) {
        return [];
    }

    // Process in batches to avoid token limits
    const BATCH_SIZE = 30;
    const allMatches = [];

    for (let i = 0; i < epgChannels.length; i += BATCH_SIZE) {
        const epgBatch = epgChannels.slice(i, i + BATCH_SIZE);

        const prompt = `You are a TV channel matching expert. Match EPG channel IDs to IPTV source channel names.

EPG Channel IDs (from TV guide):
${JSON.stringify(epgBatch)}

Available IPTV Source Channel Names:
${JSON.stringify(sourceChannels.slice(0, 100))}

For each EPG channel, find the best matching source channel name.
Consider that:
- Channel names may have different formats (e.g., "rtl2.de" matches "RTL Zwei", "RTL 2", "RTL II")
- HD/SD/FHD/4K suffixes should be ignored when matching
- Country suffixes (.de, .uk, etc.) indicate the channel region

Return ONLY a valid JSON array with matches. Format:
[{"epg": "epg_channel_id", "source": "source_channel_name", "confidence": 0.95}]

Rules:
- Only include matches with confidence > 0.7
- Confidence should reflect how certain you are (0.7 = possible, 0.85 = likely, 0.95+ = certain)
- If no good match exists for a channel, don't include it
- Return empty array [] if no matches found`;

        try {
            const result = await query(prompt, { temperature: 0.1, maxTokens: 2000, timeout: 60000 });

            // Extract JSON from response
            const jsonMatch = result.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                const matches = JSON.parse(jsonMatch[0]);
                allMatches.push(...matches.filter(m =>
                    m.epg && m.source && typeof m.confidence === 'number' && m.confidence > 0.7
                ));
            }
        } catch (error) {
            logger?.error('llm', 'Channel matching batch failed', {
                batch: i / BATCH_SIZE + 1,
                error: error.message
            });
        }
    }

    logger?.info('llm', `Channel matching complete: ${allMatches.length} matches found`);
    return allMatches;
}

/**
 * Test LLM connection
 */
async function testConnection() {
    const provider = settings?.get('llmProvider');

    if (!provider || provider === 'none') {
        return { success: false, error: 'LLM not configured', provider: 'none' };
    }

    try {
        const result = await query('Reply with exactly: OK', {
            temperature: 0,
            maxTokens: 10,
            timeout: 15000
        });

        const success = result.toLowerCase().includes('ok');
        return {
            success,
            provider,
            model: provider === 'openai'
                ? settings?.get('openaiModel')
                : settings?.get('ollamaModel'),
            response: result.substring(0, 50)
        };
    } catch (error) {
        return {
            success: false,
            provider,
            error: error.response?.data?.error?.message || error.message
        };
    }
}

/**
 * Get available Ollama models
 */
async function getOllamaModels() {
    const baseUrl = settings?.get('ollamaUrl') || 'http://localhost:11434';

    try {
        const response = await axios.get(`${baseUrl.replace(/\/$/, '')}/api/tags`, {
            timeout: 10000
        });

        return response.data.models?.map(m => m.name) || [];
    } catch (error) {
        logger?.error('llm', 'Failed to get Ollama models', { error: error.message });
        return [];
    }
}

module.exports = {
    init: async (modules) => {
        settings = modules.settings;
        logger = modules.logger;

        const provider = settings?.get('llmProvider');
        if (provider && provider !== 'none') {
            logger?.info('llm', `LLM module initialized with provider: ${provider}`);
        }
    },

    isConfigured,
    getProvider,
    query,
    translateTitle,
    identifyMedia,
    identifyMediaBatch,
    matchChannels,
    testConnection,
    getOllamaModels
};
