const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

let logger = null;
let db = null;
let settings = null;
let allModules = null;  // Store modules ref for dynamic app access

// Track sync status for each source (persists across page navigation)
const syncStatus = {};

function updateSyncStatus(sourceId, data) {
    syncStatus[sourceId] = {
        ...syncStatus[sourceId],
        ...data,
        lastUpdate: Date.now()
    };
}

function clearSyncStatus(sourceId) {
    delete syncStatus[sourceId];
}

function getSyncStatus(sourceId) {
    return syncStatus[sourceId] || null;
}

function getAllSyncStatus() {
    return syncStatus;
}

function normalizeCountryCode(code) {
    if (!code) return null;
    const trimmed = String(code).trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(trimmed)) return null;
    return trimmed;
}

function parseCountryFilterList(filter) {
    if (!filter) return [];
    if (Array.isArray(filter)) {
        return filter.map(normalizeCountryCode).filter(Boolean);
    }
    return String(filter)
        .split(',')
        .map(s => normalizeCountryCode(s))
        .filter(Boolean);
}

function extractCountryFromGroup(group) {
    if (!group) return null;
    const match = group.match(/\|([A-Z]{2})\|/);
    if (match && match[1]) return match[1];
    const prefixMatch = group.match(/^([A-Z]{2})\s/);
    if (prefixMatch && prefixMatch[1]) return prefixMatch[1];
    return null;
}

function matchesCountryFilter(source, detectedCode, category, title, group) {
    const filters = parseCountryFilterList(source?.country_filter);
    if (!filters.length) return true;
    let candidate = normalizeCountryCode(detectedCode);
    if (!candidate) candidate = normalizeCountryCode(extractCountryFromGroup(group || category));
    if (!candidate) candidate = normalizeCountryCode(extractLanguageFromText(category, title));
    return candidate ? filters.includes(candidate) : false;
}

/**
 * Check if a channel title is actually a category header (not a real channel)
 * These are used by IPTV providers to organize their channel lists
 */
function isCategoryHeader(title) {
    if (!title) return true;

    // Patterns that indicate category headers
    const headerPatterns = [
        /^[#=*\-►▶■◆●]{2,}\s*.+\s*[#=*\-◄◀■◆●]{2,}$/,  // ## SOMETHING ## or === SOMETHING ===
        /^[#=*\-►▶]{3,}\s*/,                   // ### SOMETHING or *** SOMETHING
        /\s*[#=*\-◄◀]{3,}$/,                   // SOMETHING ###
        /^[-=]{2,}\s*NO\s*(EVENT|STREAM)/i,    // -- NO EVENT STREAMING --
        /COLLECTION|CATEGORY|SECTION/i,        // Category keywords
        /^\s*[-=~►▶◄◀■◆●]+\s*$/,              // Just separators
        /^(VIP|MAGENTA|SPORT)\s+(COLLECTION|ZONE|PACK)/i,  // Common header patterns
    ];

    for (const pattern of headerPatterns) {
        if (pattern.test(title)) return true;
    }

    // Check if it looks like a real channel (has some meaningful text)
    const normalized = title.replace(/[^a-zA-Z0-9\s]/g, '').trim();
    if (normalized.length < 2) return true;  // Too short to be a real channel

    return false;
}

// Default spoofed MAC address for IPTV provider authentication (IBU Player Pro)
const DEFAULT_SPOOFED_MAC = '77:f4:8b:a4:ed:10';
const DEFAULT_SPOOFED_DEVICE_KEY = '006453';

// Default headers that mimic IBU Player Pro
// If source is provided, use source-specific spoofing settings, otherwise fall back to global settings
function getDefaultHeaders(userAgent = 'IBOPlayer', source = null) {
    // Priority: source-specific > global settings > defaults
    const spoofedMac = source?.spoofed_mac || settings?.get('spoofedMac') || DEFAULT_SPOOFED_MAC;
    const spoofedDeviceKey = source?.spoofed_device_key || settings?.get('spoofedDeviceKey') || DEFAULT_SPOOFED_DEVICE_KEY;

    // Normalize MAC address format (uppercase, colon-separated)
    const normalizedMac = spoofedMac.toUpperCase();
    const macNoColons = normalizedMac.replace(/:/g, '');

    // Log headers being used for debugging
    if (logger) {
        logger.debug('iptv', `Using MAC: ${normalizedMac}, Device Key: ${spoofedDeviceKey}`);
    }

    return {
        'User-Agent': userAgent,
        // Standard MAC headers used by various IPTV players
        'X-Device-MAC': normalizedMac,
        'X-Forwarded-For': normalizedMac,
        'X-Device-Key': spoofedDeviceKey,
        'X-Device-ID': macNoColons,
        // Additional headers some providers may require
        'X-Real-IP': normalizedMac,
        'X-Client-MAC': normalizedMac,
        'MAC': normalizedMac,
        'Cookie': `mac=${normalizedMac}; device_key=${spoofedDeviceKey}`,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive'
    };
}

// Extract language code from category or title patterns like [DE], |DE|, GERMANY, etc.
function extractLanguageFromText(category, title) {
    const text = `${category || ''} ${title || ''}`.toUpperCase();

    // Known 2-letter language codes to match
    const knownLangCodes = ['DE', 'EN', 'ES', 'FR', 'IT', 'PT', 'NL', 'PL', 'TR', 'RU', 'AR', 'HI', 'KO', 'JA', 'ZH', 'SV', 'NO', 'DA', 'FI', 'EL', 'RO', 'HU', 'CS', 'SK', 'HR', 'SR', 'BG', 'UK', 'SQ', 'FA', 'HE', 'LU'];
    const englishCountryCodes = new Set(['US', 'UK', 'CA', 'AU', 'NZ']);

    // Common language patterns: [XX], |XX|, (XX), -XX-, XX- prefix
    const langPatterns = [
        /\[([A-Z]{2})\]/,           // [DE], [EN]
        /\|([A-Z]{2})\|/,           // |DE|, |EN|
        /\(([A-Z]{2})\)/,           // (DE), (EN)
        /-([A-Z]{2})-/,             // -DE-, -EN-
        /^([A-Z]{2})\s*[-|]/,       // DE -, DE|
        /[-|]\s*([A-Z]{2})$/,       // - DE, |DE
        /[✪◉★●▶]\s*([A-Z]{2})\s/,   // ✪ DE , ◉ EN  (special markers followed by lang code)
        /\s([A-Z]{2})\s*[✪◉★●▶]/,   // DE ✪ (lang code before special markers)
    ];

    for (const pattern of langPatterns) {
        const match = text.match(pattern);
        if (match && knownLangCodes.includes(match[1])) {
            return match[1];
        }
    }

    // Country name to language code mapping
    const countryToLang = {
        'GERMAN': 'DE', 'GERMANY': 'DE', 'DEUTSCH': 'DE', 'DEUTSCHE': 'DE',
        'LUXEMBOURGISH': 'LU', 'LUXEMBOURG': 'LU', 'LUXEMBURG': 'LU', 'LËTZEBUERG': 'LU', 'LETZEBUERG': 'LU',
        'ENGLISH': 'EN', 'UK': 'EN', 'USA': 'EN', 'BRITISH': 'EN', 'AMERICAN': 'EN',
        'FRENCH': 'FR', 'FRANCE': 'FR', 'FRANCAIS': 'FR', 'FRANÇAIS': 'FR',
        'SPANISH': 'ES', 'SPAIN': 'ES', 'ESPANOL': 'ES', 'ESPAÑOL': 'ES', 'LATINO': 'ES',
        'ITALIAN': 'IT', 'ITALY': 'IT', 'ITALIANO': 'IT',
        'PORTUGUESE': 'PT', 'PORTUGAL': 'PT', 'BRAZIL': 'PT', 'BRASIL': 'PT',
        'DUTCH': 'NL', 'NETHERLANDS': 'NL', 'HOLLAND': 'NL',
        'POLISH': 'PL', 'POLAND': 'PL', 'POLSKI': 'PL',
        'TURKISH': 'TR', 'TURKEY': 'TR', 'TURK': 'TR',
        'RUSSIAN': 'RU', 'RUSSIA': 'RU',
        'ARABIC': 'AR', 'ARAB': 'AR',
        'HINDI': 'HI', 'INDIAN': 'HI', 'INDIA': 'HI',
        'KOREAN': 'KO', 'KOREA': 'KO',
        'JAPANESE': 'JA', 'JAPAN': 'JA',
        'CHINESE': 'ZH', 'CHINA': 'ZH',
        'SWEDISH': 'SV', 'SWEDEN': 'SV',
        'NORWEGIAN': 'NO', 'NORWAY': 'NO',
        'DANISH': 'DA', 'DENMARK': 'DA',
        'FINNISH': 'FI', 'FINLAND': 'FI',
        'GREEK': 'EL', 'GREECE': 'EL',
        'ROMANIAN': 'RO', 'ROMANIA': 'RO',
        'HUNGARIAN': 'HU', 'HUNGARY': 'HU',
        'CZECH': 'CS', 'CZECHIA': 'CS',
        'SLOVAK': 'SK', 'SLOVAKIA': 'SK',
        'CROATIAN': 'HR', 'CROATIA': 'HR',
        'SERBIAN': 'SR', 'SERBIA': 'SR',
        'BULGARIAN': 'BG', 'BULGARIA': 'BG',
        'UKRAINIAN': 'UK', 'UKRAINE': 'UK',
        'ALBANIAN': 'SQ', 'ALBANIA': 'SQ',
        'PERSIAN': 'FA', 'IRANIAN': 'FA', 'IRAN': 'FA', 'FARSI': 'FA',
        'HEBREW': 'HE', 'ISRAELI': 'HE', 'ISRAEL': 'HE'
    };

    // Check for country/language names
    for (const [name, code] of Object.entries(countryToLang)) {
        // Match as whole word (with word boundaries or special characters)
        const regex = new RegExp(`(^|[\\s|\\[\\(\\-])${name}([\\s|\\]\\)\\-]|$)`, 'i');
        if (regex.test(text)) {
            return code;
        }
    }

    // If category uses prefixes like "CA| ..." and suffixes like " ... EN",
    // prefer the last 2-letter token (often the language).
    const tokens = text.split(/[\s|\/\\-]+/).filter(Boolean);
    for (let i = tokens.length - 1; i >= 0; i--) {
        const token = tokens[i];
        if (knownLangCodes.includes(token)) {
            return token;
        }
        if (englishCountryCodes.has(token)) {
            return 'EN';
        }
    }

    return null;
}

// Check if detected language is in the user's preferred languages
// Returns true if: no preferences set, no language detected, or language matches preferences
function isLanguageAllowed(detectedLang) {
    const preferredLangs = settings?.get('preferredLanguages') || [];

    // If no preferences set, allow everything
    if (!preferredLangs.length) return true;

    // If no language detected, allow it (we can't filter what we can't detect)
    if (!detectedLang) return true;

    // Normalize to lowercase for comparison
    const detected = detectedLang.toLowerCase();
    return preferredLangs.some(lang => lang.toLowerCase() === detected);
}

// Validate API response is an array (Xtream API should always return arrays for list endpoints)
function validateApiResponse(response, context = 'API') {
    const data = response?.data;

    // Check if response is an array
    if (!Array.isArray(data)) {
        const actualType = data === null ? 'null' : typeof data;
        throw new Error(`Invalid ${context} response: expected array, got ${actualType}`);
    }

    return data;
}

// Warn if API returns suspiciously empty/low results
function warnIfSuspiciouslyEmpty(items, itemType, source, previousCount = null) {
    if (items.length === 0) {
        logger.warn('iptv', `⚠️ ${source.name} returned 0 ${itemType}. This might indicate an API issue. Try syncing again.`);
        return true;
    }

    // If we had previous data, warn if count dropped by more than 90%
    if (previousCount && previousCount > 10 && items.length < previousCount * 0.1) {
        logger.warn('iptv', `⚠️ ${source.name} ${itemType} dropped from ${previousCount} to ${items.length}. Possible API issue.`);
        return true;
    }

    return false;
}

// Extract streaming platform from category name
function extractPlatform(category) {
    if (!category) return null;

    const platforms = {
        'NETFLIX': /NETFLIX/i,
        'AMAZON': /PRIME\+?|AMAZON/i,
        'DISNEY+': /DISNEY\+?/i,
        'HBO': /HBO/i,
        'APPLE TV': /APPLE\s*TV?\+?/i,
        'PARAMOUNT+': /PARAMOUNT\+?/i,
        'HULU': /HULU/i,
        'CANAL+': /CANAL\+/i,
        'MOVISTAR+': /MOVISTAR\+?/i,
        'SKY': /\bSKY\b/i,
        'DAZN': /DAZN/i
    };

    for (const [name, pattern] of Object.entries(platforms)) {
        if (pattern.test(category)) return name;
    }
    return null;
}

// Platform prefix mappings for title parsing
const PLATFORM_PREFIXES = {
    'NF': 'Netflix', 'NETFLIX': 'Netflix',
    'DSNP': 'Disney+', 'DISNEY': 'Disney+', 'DISNEYPLUS': 'Disney+', 'DNP': 'Disney+',
    'AMZN': 'Amazon', 'AMAZON': 'Amazon', 'PRIME': 'Amazon', 'ATVP': 'Amazon',
    'APTV': 'Apple TV+', 'APPLE': 'Apple TV+', 'ATV': 'Apple TV+',
    'HMAX': 'HBO Max', 'HBO': 'HBO Max', 'MAX': 'HBO Max',
    'PMTP': 'Paramount+', 'PARAMOUNT': 'Paramount+', 'PPLUS': 'Paramount+',
    'PCOK': 'Peacock', 'PEACOCK': 'Peacock',
    'HULU': 'Hulu',
    'STAN': 'Stan',
    'CRAV': 'Crave',
    'ROKU': 'Roku',
    'TUBI': 'Tubi',
    'VUDU': 'Vudu',
    'CRKL': 'Crackle',
    'NOW': 'NOW TV',
    'STZD': 'Starz',
    'STARZ': 'Starz',
    'SHO': 'Showtime',
    'SHOWTIME': 'Showtime',
};

// Known 2-letter language codes
const KNOWN_LANG_CODES = ['DE', 'EN', 'ES', 'FR', 'IT', 'PT', 'NL', 'PL', 'TR', 'RU', 'AR', 'HI', 'KO', 'JA', 'ZH', 'SV', 'NO', 'DA', 'FI', 'EL', 'RO', 'HU', 'CS', 'SK', 'HR', 'SR', 'BG', 'UK', 'SQ', 'FA', 'HE', 'TH', 'VI', 'ID', 'MS', 'TL', 'CA', 'EU', 'GL', 'CY', 'GA', 'MT', 'LV', 'LT', 'ET', 'MK', 'SL', 'BS', 'ME', 'IS', 'FO', 'BE', 'KK', 'UZ', 'TG', 'KY', 'TK', 'AZ', 'KA', 'HY', 'MN', 'GB', 'US'];

// Check if a string is a valid language code
function isValidLanguageCode(code) {
    if (!code || code.length !== 2) return false;
    return KNOWN_LANG_CODES.includes(code.toUpperCase());
}

// Normalize quality strings to standard values
function normalizeQuality(q) {
    if (!q) return null;
    const upper = q.toUpperCase().replace(/\s+/g, '');
    if (['4K', 'UHD', '2160P', '2160'].includes(upper)) return '4K';
    if (['FHD', '1080P', '1080', 'FULLHD'].includes(upper)) return '1080p';
    if (['HD', '720P', '720'].includes(upper)) return '720p';
    if (['SD', '480P', '480', '360P', '360'].includes(upper)) return 'SD';
    return 'Other';
}

/**
 * Parse original title to extract metadata (language, year, quality, platform)
 * Example: "NF - Dead Boy Detectives 4K (2024) (US)"
 *   → { title: "Dead Boy Detectives", year: 2024, quality: "4K", language: "US", platform: "Netflix" }
 * Example: "4K-DE - 1923"
 *   → { title: "1923", year: null, quality: "4K", language: "DE", platform: null }
 */
function parseOriginalTitle(originalTitle) {
    if (!originalTitle) return { title: '', year: null, quality: null, language: null, platform: null };

    let title = originalTitle;
    let year = null;
    let quality = null;
    let language = null;
    let platform = null;

    // Handle "Quality-Language - Title" prefix pattern (e.g., "4K-DE - 1923", "FHD-EN - Show Name")
    const qualityLangPrefixMatch = title.match(/^\s*(4K|UHD|FHD|HD|SD)-([A-Z]{2})\s*[-:|]\s*/i);
    if (qualityLangPrefixMatch) {
        quality = normalizeQuality(qualityLangPrefixMatch[1]);
        if (isValidLanguageCode(qualityLangPrefixMatch[2])) {
            language = qualityLangPrefixMatch[2].toUpperCase();
        }
        title = title.replace(qualityLangPrefixMatch[0], '');
    }

    // Handle "Language-Quality - Title" prefix pattern (e.g., "DE-4K - Show Name")
    if (!quality && !language) {
        const langQualityPrefixMatch = title.match(/^\s*([A-Z]{2})-(4K|UHD|FHD|HD|SD)\s*[-:|]\s*/i);
        if (langQualityPrefixMatch && isValidLanguageCode(langQualityPrefixMatch[1])) {
            language = langQualityPrefixMatch[1].toUpperCase();
            quality = normalizeQuality(langQualityPrefixMatch[2]);
            title = title.replace(langQualityPrefixMatch[0], '');
        }
    }

    // Extract platform prefix: "NF - ", "DSNP - ", "AMZN| ", etc.
    const platformMatch = title.match(/^\s*([A-Z]{2,10})\s*[-:|]\s*/i);
    if (platformMatch) {
        const prefix = platformMatch[1].toUpperCase();
        if (PLATFORM_PREFIXES[prefix]) {
            platform = PLATFORM_PREFIXES[prefix];
            title = title.replace(platformMatch[0], '');
        }
    }

    // Extract year: (2024), [2024] - only in brackets to avoid treating titles like "1923" as years
    const yearPatterns = [
        /\((\d{4})\)/,           // (2024)
        /\[(\d{4})\]/,           // [2024]
    ];

    for (const pattern of yearPatterns) {
        const match = title.match(pattern);
        if (match) {
            const y = parseInt(match[1]);
            if (y >= 1900 && y <= 2030) {
                year = y;
                title = title.replace(match[0], ' ');
                break;
            }
        }
    }

    // Only extract standalone year if title has other content (avoid treating "1923" show as a year)
    if (!year && title.trim().length > 4) {
        const standaloneYearPatterns = [
            /\s-\s(\d{4})(?:\s|$)/,  // - 2024
            /\s(\d{4})$/,            // 2024 at end (only if preceded by other content)
        ];
        for (const pattern of standaloneYearPatterns) {
            const match = title.match(pattern);
            if (match) {
                const y = parseInt(match[1]);
                if (y >= 1900 && y <= 2030) {
                    year = y;
                    title = title.replace(match[0], ' ');
                    break;
                }
            }
        }
    }

    // Extract quality if not already found: 4K, UHD, FHD, HD, 1080p, 720p, etc.
    // Also handle Unicode markers: ᴴᴰ, ˢᴰ, ᴿᴬᵂ, ᶠᴴᴰ
    if (!quality) {
        const qualityPatterns = [
            /\b(4K|UHD|2160p?)\b/i,
            /\b(FHD|1080p?)\b/i,
            /\b(HD|720p?)\b/i,
            /\b(SD|480p?|360p?)\b/i,
            /ᴴᴰ|ᶠᴴᴰ/,               // Unicode HD markers
            /ˢᴰ/,                    // Unicode SD marker
            /HEVC|H\.?265/i,         // HEVC often indicates HD+
        ];

        for (const pattern of qualityPatterns) {
            const match = title.match(pattern);
            if (match) {
                const q = match[1] || match[0];
                // Map Unicode and special markers
                if (/ᶠᴴᴰ/.test(q)) quality = '1080p';
                else if (/ᴴᴰ/.test(q)) quality = '720p';
                else if (/ˢᴰ/.test(q)) quality = 'SD';
                else if (/HEVC|H\.?265/i.test(q)) quality = '1080p';
                else quality = normalizeQuality(q);

                title = title.replace(match[0], ' ');
                break;
            }
        }
    }

    // Extract/remove language codes from title: [DE], (US), |FR|, "DE - " prefix
    // Always remove these patterns from the title, but only set language if not already set
    const langPatterns = [
        /\[([A-Z]{2})\]/i,                     // [DE]
        /\|([A-Z]{2})\|/i,                     // |DE|
        /\(([A-Z]{2})\)\s*$/i,                 // (US) at end
        /\(([A-Z]{2})\)(?=\s*[\(\[]|\s*$)/i,   // (US) before another bracket or end
    ];

    for (const pattern of langPatterns) {
        const match = title.match(pattern);
        if (match && isValidLanguageCode(match[1])) {
            if (!language) {
                language = match[1].toUpperCase();
            }
            title = title.replace(match[0], ' ');
            // Don't break - continue to remove other language codes from title
        }
    }

    // Check for language prefix (but only if we didn't find a platform)
    // Also handle leading dash: "-DE - Title" or "- DE - Title"
    // Also handle noise prefix with language: "BLURAY-DE - Title", "DVDRIP-EN - Title"
    if (!language && !platform) {
        // First try noise-language prefix: "BLURAY-DE - ", "DVDRIP-EN - ", etc.
        const noiseLangPrefixMatch = title.match(/^\s*(?:BLURAY|DVDRIP|BDRIP|BRRIP|HDTV|WEBRIP|WEBDL|WEB)-([A-Z]{2})\s*[-:|]\s*/i);
        if (noiseLangPrefixMatch && isValidLanguageCode(noiseLangPrefixMatch[1])) {
            language = noiseLangPrefixMatch[1].toUpperCase();
            title = title.replace(noiseLangPrefixMatch[0], '');
        }

        // Then try with optional leading dash: "-DE - Title", "- DE - Title", "DE - Title"
        if (!language) {
            const langPrefixMatch = title.match(/^\s*-?\s*([A-Z]{2})\s*[-:|]\s*/i);
            if (langPrefixMatch && isValidLanguageCode(langPrefixMatch[1])) {
                language = langPrefixMatch[1].toUpperCase();
                title = title.replace(langPrefixMatch[0], '');
            }
        }
    }

    // Remove common noise patterns
    title = title
        .replace(/\s*ᴿᴬᵂ\s*/g, ' ')           // Remove RAW marker
        .replace(/\s*\[MULTI\]\s*/gi, ' ')     // Remove [MULTI]
        .replace(/\s*MULTI\s*/gi, ' ')         // Remove MULTI
        .replace(/\s*DUAL\s*/gi, ' ')          // Remove DUAL
        .replace(/\s*\(DUBBED\)\s*/gi, ' ')    // Remove (DUBBED)
        .replace(/\s*DUBBED\s*/gi, ' ')        // Remove DUBBED
        .replace(/\s*\(SUB\)\s*/gi, ' ')       // Remove (SUB)
        .replace(/\s*SUBBED\s*/gi, ' ')        // Remove SUBBED
        .replace(/\s*WEB-?DL\s*/gi, ' ')       // Remove WEB-DL
        .replace(/\s*BluRay\s*/gi, ' ')        // Remove BluRay
        .replace(/\s*BRRip\s*/gi, ' ')         // Remove BRRip
        .replace(/\s*HDRip\s*/gi, ' ')         // Remove HDRip
        .replace(/\s*x264\s*/gi, ' ')          // Remove x264
        .replace(/\s*x265\s*/gi, ' ')          // Remove x265
        .replace(/\s*AAC\s*/gi, ' ')           // Remove AAC
        .replace(/\s*\d+MB\s*/gi, ' ')         // Remove file size
        .replace(/\s*[-–]\s*$/, '')            // Remove trailing dash
        .replace(/\s+/g, ' ')                  // Collapse multiple spaces
        .trim();

    return { title, year, quality, language, platform };
}

async function fetchWithRetry(url, options = {}, retries = 3, source = null) {
    let lastError = null;

    for (let i = 0; i < retries; i++) {
        try {
            const headers = {
                ...getDefaultHeaders(options.headers?.['User-Agent'], source),
                ...options.headers
            };

            if (logger && i === 0) {
                logger.debug('iptv', `Fetching: ${url.substring(0, 100)}... with headers: ${JSON.stringify(Object.keys(headers))}`);
            }

            const response = await axios({
                url,
                timeout: 30000,
                ...options,
                headers
            });
            return response;
        } catch (err) {
            lastError = err;
            const status = err.response?.status || 'unknown';
            const statusText = err.response?.statusText || err.message;

            if (logger) {
                logger.warn('iptv', `Fetch attempt ${i + 1}/${retries} failed: HTTP ${status} - ${statusText}`);
            }

            // Don't retry on certain errors
            if (status === 401 || status === 403 || status === 884) {
                // Authentication/authorization errors - no point retrying
                const errorMsg = `HTTP ${status}: ${statusText}. Check MAC address and credentials.`;
                throw new Error(errorMsg);
            }

            if (i === retries - 1) {
                throw new Error(`Failed after ${retries} attempts: HTTP ${status} - ${statusText}`);
            }
            await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        }
    }
}

async function syncXtreamSource(source) {
    logger.info('iptv', `Syncing Xtream source: ${source.name}`);

    // Safety: rollback any dangling transaction from previous failed sync
    try { await db.run('ROLLBACK'); } catch (e) { /* ignore if no transaction */ }

    const baseUrl = source.url.replace(/\/$/, '');
    const headers = { 'User-Agent': source.user_agent || 'IBOPlayer' };

    // Sanitize credentials - remove any control characters (including null bytes)
    const cleanUsername = (source.username || '').replace(/[\x00-\x1F\x7F]/g, '');
    const cleanPassword = (source.password || '').replace(/[\x00-\x1F\x7F]/g, '');

    // Track sync start time for marking inactive items
    // Use SQLite-compatible format (YYYY-MM-DD HH:MM:SS) to match CURRENT_TIMESTAMP
    const syncStartTime = new Date().toISOString().replace('T', ' ').replace('Z', '').split('.')[0];

    // Track sync statistics
    const stats = { added: 0, updated: 0, unchanged: 0, removed: 0 };

    // Emit start event
    allModules?.app?.emit('sync:source:start', { sourceId: source.id, sourceName: source.name });
    updateSyncStatus(source.id, { step: 'auth', message: 'Authenticating...', percent: 0, syncing: true, sourceType: 'xtream', stats });

    // Test connection first
    allModules?.app?.emit('sync:source:progress', { sourceId: source.id, step: 'auth', message: 'Authenticating...', percent: 0 });
    const authUrl = `${baseUrl}/player_api.php?username=${cleanUsername}&password=${cleanPassword}`;
    const authResponse = await fetchWithRetry(authUrl, { headers }, 3, source);

    if (!authResponse.data?.user_info?.auth) {
        throw new Error('Authentication failed');
    }

    logger.info('iptv', `Authenticated to ${source.name}`);

    // Fetch categories first to map category_id to category_name
    updateSyncStatus(source.id, { step: 'categories', message: 'Fetching categories...', percent: 5 });
    allModules?.app?.emit('sync:source:progress', { sourceId: source.id, step: 'categories', message: 'Fetching categories...', percent: 5 });

    // Fetch all category types (live, VOD, series) and merge into one map
    const categoryMap = {};

    // Live categories
    const liveCatUrl = `${baseUrl}/player_api.php?username=${cleanUsername}&password=${cleanPassword}&action=get_live_categories`;
    const liveCatResponse = await fetchWithRetry(liveCatUrl, { headers }, 3, source);
    for (const cat of (liveCatResponse.data || [])) {
        categoryMap[cat.category_id] = cat.category_name;
    }

    // VOD categories
    const vodCatUrl = `${baseUrl}/player_api.php?username=${cleanUsername}&password=${cleanPassword}&action=get_vod_categories`;
    const vodCatResponse = await fetchWithRetry(vodCatUrl, { headers }, 3, source);
    for (const cat of (vodCatResponse.data || [])) {
        categoryMap[cat.category_id] = cat.category_name;
    }

    // Series categories
    const seriesCatUrl = `${baseUrl}/player_api.php?username=${cleanUsername}&password=${cleanPassword}&action=get_series_categories`;
    const seriesCatResponse = await fetchWithRetry(seriesCatUrl, { headers }, 3, source);
    for (const cat of (seriesCatResponse.data || [])) {
        categoryMap[cat.category_id] = cat.category_name;
    }

    logger.info('iptv', `Loaded ${Object.keys(categoryMap).length} categories`);

    // Sync Live TV (10-40%)
    updateSyncStatus(source.id, { step: 'live', message: 'Fetching live channels...', percent: 10 });
    allModules?.app?.emit('sync:source:progress', { sourceId: source.id, step: 'live', message: 'Fetching live channels...', percent: 10 });
    const liveUrl = `${baseUrl}/player_api.php?username=${cleanUsername}&password=${cleanPassword}&action=get_live_streams`;
    const liveResponse = await fetchWithRetry(liveUrl, { headers }, 3, source);
    const liveChannels = validateApiResponse(liveResponse, 'live channels');
    warnIfSuspiciouslyEmpty(liveChannels, 'live channels', source);

    logger.info('iptv', `Found ${liveChannels.length} live channels`);
    updateSyncStatus(source.id, { step: 'live', message: `Saving ${liveChannels.length} live channels...`, percent: 12, total: liveChannels.length });
    allModules?.app?.emit('sync:source:progress', { sourceId: source.id, step: 'live', message: `Saving ${liveChannels.length} live channels...`, total: liveChannels.length, percent: 12 });

    let liveCount = 0, movieCount = 0, seriesCount = 0;

    // Use transaction for faster bulk inserts
    await db.run('BEGIN TRANSACTION');
    let skippedHeaders = 0;
    let liveCountrySkipped = 0;
    for (let i = 0; i < liveChannels.length; i++) {
        const channel = liveChannels[i];

        // Skip category headers (titles like ## SOMETHING ##, *** SOMETHING ***, etc.)
        if (isCategoryHeader(channel.name)) {
            skippedHeaders++;
            continue;
        }

        // Build stream URL using sanitized credentials
        const streamUrl = `${baseUrl}/live/${cleanUsername}/${cleanPassword}/${channel.stream_id}.ts`;

        // Get category name from map
        const categoryName = categoryMap[channel.category_id] || '';

        // Detect 24/7 movie/series channels based on category name
        const mediaType = detectMediaTypeFromCategory(categoryName, channel.name);

        if (mediaType === 'movie') movieCount++;
        else if (mediaType === 'series') seriesCount++;
        else liveCount++;

        // Parse title to extract metadata (title, year, quality, language, platform)
        const parsed = parseOriginalTitle(channel.name);
        const platform = parsed.platform || extractPlatform(categoryName);
        const detectedLanguage = parsed.language || channel.lang || extractLanguageFromText(categoryName, channel.name);
        if (!matchesCountryFilter(source, detectedLanguage, categoryName, channel.name, categoryName)) {
            liveCountrySkipped++;
            continue;
        }

        const result = await db.run(`
            INSERT INTO media (source_id, external_id, media_type, title, original_title, poster, category, stream_url, language, platform, tvg_id, is_active, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
            ON CONFLICT(source_id, external_id) DO UPDATE SET
                media_type = excluded.media_type,
                title = COALESCE(media.title, excluded.title),
                original_title = excluded.original_title,
                poster = COALESCE(media.poster, excluded.poster),
                category = excluded.category,
                stream_url = excluded.stream_url,
                language = COALESCE(media.language, excluded.language),
                platform = COALESCE(media.platform, excluded.platform),
                tvg_id = COALESCE(excluded.tvg_id, media.tvg_id),
                is_active = 1,
                last_seen_at = CURRENT_TIMESTAMP
        `, [source.id, String(channel.stream_id), mediaType, parsed.title || channel.name, channel.name, channel.stream_icon, categoryName, streamUrl, detectedLanguage, platform, channel.epg_channel_id || null]);

        // Track statistics (lastID > 0 means new insert, changes > 0 means update)
        if (result.lastID && result.changes === 1) {
            stats.added++;
        } else if (result.changes === 1) {
            stats.updated++;
        } else {
            stats.unchanged++;
        }

        // Emit progress every 100 items (12-40% = 28% range for live channels)
        if ((i + 1) % 100 === 0 || i === liveChannels.length - 1) {
            const livePercent = 12 + Math.round(((i + 1) / liveChannels.length) * 28);
            const msg = `Channels: ${i + 1}/${liveChannels.length}`;
            updateSyncStatus(source.id, { step: 'live', message: msg, percent: livePercent, current: i + 1, total: liveChannels.length });
            allModules?.app?.emit('sync:source:progress', { sourceId: source.id, step: 'live', message: msg, current: i + 1, total: liveChannels.length, percent: livePercent });
        }
    }

    await db.run('COMMIT');
    logger.info('iptv', `Categorized: ${liveCount} live, ${movieCount} movies, ${seriesCount} series (skipped ${skippedHeaders} category headers, ${liveCountrySkipped} filtered by country)`);

    // Sync VOD (40-70%)
    updateSyncStatus(source.id, { step: 'vod', message: 'Fetching movies...', percent: 40 });
    allModules?.app?.emit('sync:source:progress', { sourceId: source.id, step: 'vod', message: 'Fetching movies...', percent: 40 });
    const vodUrl = `${baseUrl}/player_api.php?username=${cleanUsername}&password=${cleanPassword}&action=get_vod_streams`;
    // Use longer timeout for VOD - some providers have large catalogs (30MB+)
    const vodResponse = await fetchWithRetry(vodUrl, { headers, timeout: 120000 }, 3, source);
    const vodItems = validateApiResponse(vodResponse, 'VOD');
    warnIfSuspiciouslyEmpty(vodItems, 'VOD items', source);

    logger.info('iptv', `Found ${vodItems.length} VOD items`);
    updateSyncStatus(source.id, { step: 'vod', message: `Saving ${vodItems.length} movies...`, percent: 42, total: vodItems.length });
    allModules?.app?.emit('sync:source:progress', { sourceId: source.id, step: 'vod', message: `Saving ${vodItems.length} movies...`, total: vodItems.length, percent: 42 });

    let vodSaved = 0, vodSkipped = 0, vodCountrySkipped = 0;
    const vodFilteredLanguages = {}; // Track what languages are being filtered
    // Use transaction for faster bulk inserts
    await db.run('BEGIN TRANSACTION');
    for (let i = 0; i < vodItems.length; i++) {
        const vod = vodItems[i];

        // Get category name from map (API only provides category_id)
        const categoryName = categoryMap[vod.category_id] || '';

        // Parse title to extract metadata (title, year, quality, language, platform)
        const parsed = parseOriginalTitle(vod.name);

        // Extract language and check if allowed
        const language = extractLanguageFromText(categoryName, vod.name);
        if (!isLanguageAllowed(language)) {
            vodSkipped++;
            // Track filtered languages for reporting
            const langKey = language || 'unknown';
            vodFilteredLanguages[langKey] = (vodFilteredLanguages[langKey] || 0) + 1;
            continue; // Skip content not in preferred languages
        }
        if (!matchesCountryFilter(source, parsed.language || language, categoryName, vod.name, categoryName)) {
            vodCountrySkipped++;
            continue;
        }

        const ext = vod.container_extension || 'mp4';
        const streamUrl = `${baseUrl}/movie/${cleanUsername}/${cleanPassword}/${vod.stream_id}.${ext}`;
        const quality = parsed.quality || detectQuality(vod.name);
        const year = parsed.year || extractYear(vod.name);
        const platform = parsed.platform || extractPlatform(categoryName);

        const result = await db.run(`
            INSERT INTO media (source_id, external_id, media_type, title, original_title, poster, category, stream_url, container, rating, year, plot, genres, quality, tmdb_id, language, platform, is_active, last_seen_at)
            VALUES (?, ?, 'movie', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
            ON CONFLICT(source_id, external_id) DO UPDATE SET
                title = COALESCE(media.title, excluded.title),
                original_title = excluded.original_title,
                poster = COALESCE(media.poster, excluded.poster),
                category = excluded.category,
                stream_url = excluded.stream_url,
                container = excluded.container,
                rating = COALESCE(media.rating, excluded.rating),
                year = COALESCE(media.year, excluded.year),
                plot = COALESCE(media.plot, excluded.plot),
                genres = COALESCE(media.genres, excluded.genres),
                quality = COALESCE(excluded.quality, media.quality),
                language = COALESCE(media.language, excluded.language),
                platform = COALESCE(media.platform, excluded.platform),
                is_active = 1,
                last_seen_at = CURRENT_TIMESTAMP
        `, [
            source.id, String(vod.stream_id), parsed.title || vod.name, vod.name, vod.stream_icon, categoryName,
            streamUrl, ext, vod.rating || null, year, vod.plot || null,
            vod.genre || null, quality, vod.tmdb || null, parsed.language || language, platform
        ]);

        // Track statistics (lastID > 0 means new insert)
        if (result.lastID && result.changes === 1) {
            stats.added++;
        } else if (result.changes === 1) {
            stats.updated++;
        } else {
            stats.unchanged++;
        }
        vodSaved++;

        // Emit progress every 100 items (42-70% = 28% range for VOD)
        if ((i + 1) % 100 === 0 || i === vodItems.length - 1) {
            const vodPercent = 42 + Math.round(((i + 1) / vodItems.length) * 28);
            const msg = `Movies: ${vodSaved} saved, ${vodSkipped} filtered, ${vodCountrySkipped} country`;
            updateSyncStatus(source.id, { step: 'vod', message: msg, percent: vodPercent, current: i + 1, total: vodItems.length });
            allModules?.app?.emit('sync:source:progress', { sourceId: source.id, step: 'vod', message: msg, current: i + 1, total: vodItems.length, percent: vodPercent });
        }
    }
    await db.run('COMMIT');
    logger.info('iptv', `VOD: ${vodSaved} saved, ${vodSkipped} filtered by language, ${vodCountrySkipped} filtered by country`);

    // Warn if significant content is being filtered
    if (vodSkipped > 0 && vodItems.length > 0) {
        const filterPercent = Math.round((vodSkipped / vodItems.length) * 100);
        const langSummary = Object.entries(vodFilteredLanguages)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([lang, count]) => `${lang}: ${count}`)
            .join(', ');

        if (filterPercent >= 10) {
            logger.warn('iptv', `⚠️ ${filterPercent}% of movies filtered out! Filtered languages: ${langSummary}. Check Settings > Language Preferences if this seems wrong.`);
        } else {
            logger.info('iptv', `Filtered movies by language: ${langSummary}`);
        }
    }

    // Sync Series (70-100%)
    updateSyncStatus(source.id, { step: 'series', message: 'Fetching series...', percent: 70 });
    allModules?.app?.emit('sync:source:progress', { sourceId: source.id, step: 'series', message: 'Fetching series...', percent: 70 });
    const seriesUrl = `${baseUrl}/player_api.php?username=${cleanUsername}&password=${cleanPassword}&action=get_series`;
    // Use longer timeout for series - some providers have large catalogs
    const seriesResponse = await fetchWithRetry(seriesUrl, { headers, timeout: 120000 }, 3, source);
    const seriesList = validateApiResponse(seriesResponse, 'series');
    warnIfSuspiciouslyEmpty(seriesList, 'series', source);

    logger.info('iptv', `Found ${seriesList.length} series`);
    updateSyncStatus(source.id, { step: 'series', message: `Processing ${seriesList.length} series...`, percent: 72, total: seriesList.length });
    allModules?.app?.emit('sync:source:progress', { sourceId: source.id, step: 'series', message: `Processing ${seriesList.length} series...`, total: seriesList.length, percent: 72 });

    let seriesSaved = 0, seriesSkipped = 0, seriesCountrySkipped = 0;
    const filteredLanguages = {}; // Track what languages are being filtered

    // PHASE 1: Save all series metadata (fast - no API calls)
    await db.run('BEGIN TRANSACTION');
    for (let i = 0; i < seriesList.length; i++) {
        const series = seriesList[i];

        // Get category name from map (API only provides category_id)
        const categoryName = categoryMap[series.category_id] || '';

        // Parse title to extract metadata (title, year, quality, language, platform)
        const parsed = parseOriginalTitle(series.name);
        const language = parsed.language || extractLanguageFromText(categoryName, series.name);
        const year = parsed.year || extractYear(series.releaseDate || series.name);
        const platform = parsed.platform || extractPlatform(categoryName);

        // Check if language is allowed
        if (!isLanguageAllowed(language)) {
            seriesSkipped++;
            const langKey = language || 'unknown';
            filteredLanguages[langKey] = (filteredLanguages[langKey] || 0) + 1;
            continue; // Skip content not in preferred languages
        }
        if (!matchesCountryFilter(source, parsed.language || language, categoryName, series.name, categoryName)) {
            seriesCountrySkipped++;
            continue;
        }

        const result = await db.run(`
            INSERT INTO media (source_id, external_id, media_type, title, original_title, show_name, poster, backdrop, category, rating, year, plot, genres, tmdb_id, language, platform, is_active, last_seen_at)
            VALUES (?, ?, 'series', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
            ON CONFLICT(source_id, external_id) DO UPDATE SET
                title = COALESCE(media.title, excluded.title),
                original_title = excluded.original_title,
                show_name = COALESCE(media.show_name, excluded.show_name),
                poster = COALESCE(media.poster, excluded.poster),
                backdrop = COALESCE(media.backdrop, excluded.backdrop),
                category = excluded.category,
                rating = COALESCE(media.rating, excluded.rating),
                year = COALESCE(media.year, excluded.year),
                plot = COALESCE(media.plot, excluded.plot),
                genres = COALESCE(media.genres, excluded.genres),
                language = COALESCE(media.language, excluded.language),
                platform = COALESCE(media.platform, excluded.platform),
                is_active = 1,
                last_seen_at = CURRENT_TIMESTAMP
        `, [
            source.id, String(series.series_id), parsed.title || series.name, series.name, parsed.title || series.name, series.cover,
            series.backdrop_path?.[0] || null, categoryName, series.rating || null,
            year, series.plot || null, series.genre || null, series.tmdb || null, language, platform
        ]);

        // Track statistics (lastID > 0 means new insert)
        if (result.lastID && result.changes === 1) {
            stats.added++;
        } else if (result.changes === 1) {
            stats.updated++;
        } else {
            stats.unchanged++;
        }
        seriesSaved++;

        // Emit progress every 100 series during metadata phase
        if ((i + 1) % 100 === 0 || i === seriesList.length - 1) {
            const metaPercent = 72 + Math.round(((i + 1) / seriesList.length) * 14); // 72-86%
            const msg = `Series metadata: ${seriesSaved} saved, ${seriesSkipped} filtered, ${seriesCountrySkipped} country`;
            updateSyncStatus(source.id, { step: 'series', message: msg, percent: metaPercent, current: i + 1, total: seriesList.length });
            allModules?.app?.emit('sync:source:progress', { sourceId: source.id, step: 'series', message: msg, current: i + 1, total: seriesList.length, percent: metaPercent });
        }
    }
    await db.run('COMMIT');

    // Episodes are now lazy-loaded when user views a show (see /api/shows/:name/fetch-episodes)

    logger.info('iptv', `Series: ${seriesSaved} saved, ${seriesSkipped} filtered by language, ${seriesCountrySkipped} filtered by country`);

    // Warn if significant content is being filtered
    if (seriesSkipped > 0 && seriesList.length > 0) {
        const filterPercent = Math.round((seriesSkipped / seriesList.length) * 100);
        const langSummary = Object.entries(filteredLanguages)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([lang, count]) => `${lang}: ${count}`)
            .join(', ');

        if (filterPercent >= 10) {
            logger.warn('iptv', `⚠️ ${filterPercent}% of series filtered out! Filtered languages: ${langSummary}. Check Settings > Language Preferences if this seems wrong.`);
        } else {
            logger.info('iptv', `Filtered series by language: ${langSummary}`);
        }
    }

    // Mark items not seen in this sync as inactive
    updateSyncStatus(source.id, { step: 'cleanup', message: 'Marking removed items...', percent: 98 });
    allModules?.app?.emit('sync:source:progress', { sourceId: source.id, step: 'cleanup', message: 'Marking removed items...', percent: 98 });

    const inactiveResult = await db.run(`
        UPDATE media SET is_active = 0
        WHERE source_id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)
    `, [source.id, syncStartTime]);
    stats.removed = inactiveResult.changes || 0;

    // Update last sync time
    await db.run('UPDATE sources SET last_sync = CURRENT_TIMESTAMP WHERE id = ?', [source.id]);

    logger.info('iptv', `Sync complete for ${source.name}: +${stats.added} added, ~${stats.updated} updated, =${stats.unchanged} unchanged, -${stats.removed} removed`);
    clearSyncStatus(source.id);
    allModules?.app?.emit('sync:source:complete', { sourceId: source.id, stats });
}

async function syncM3USource(source) {
    logger.info('iptv', `Syncing M3U source: ${source.name}`);

    // Safety: rollback any dangling transaction from previous failed sync
    try { await db.run('ROLLBACK'); } catch (e) { /* ignore if no transaction */ }

    const headers = getDefaultHeaders(source.user_agent || 'IBOPlayer', source);

    // Track sync start time for marking inactive items
    // Use SQLite-compatible format (YYYY-MM-DD HH:MM:SS) to match CURRENT_TIMESTAMP
    const syncStartTime = new Date().toISOString().replace('T', ' ').replace('Z', '').split('.')[0];

    // Track sync statistics
    const stats = { added: 0, updated: 0, unchanged: 0, removed: 0 };

    // Emit start event
    allModules?.app?.emit('sync:source:start', { sourceId: source.id, sourceName: source.name });
    updateSyncStatus(source.id, { step: 'fetch', message: 'Checking for cached M3U...', percent: 0, syncing: true, sourceType: 'm3u', stats });
    allModules?.app?.emit('sync:source:progress', { sourceId: source.id, step: 'fetch', message: 'Checking for cached M3U...', percent: 0 });

    let m3uContent = null;
    let usedCache = false;

    // First, check for recent cached M3U file (within last 24 hours)
    try {
        const cacheDir = path.join(PATHS.data, 'cache', 'm3u');
        const safeName = source.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const files = await fs.readdir(cacheDir);

        // Find most recent cache file for this source
        const sourceFiles = files
            .filter(f => f.startsWith(safeName) && f.endsWith('.m3u'))
            .sort()
            .reverse();

        if (sourceFiles.length > 0) {
            const latestFile = sourceFiles[0];
            const filePath = path.join(cacheDir, latestFile);
            const stats = await fs.stat(filePath);
            const ageHours = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60);

            // Use cache if less than 24 hours old
            if (ageHours < 24) {
                logger.info('iptv', `Using cached M3U file: ${latestFile} (${ageHours.toFixed(1)} hours old)`);
                updateSyncStatus(source.id, { step: 'fetch', message: `Using cached M3U (${ageHours.toFixed(1)}h old)...`, percent: 5 });
                m3uContent = await fs.readFile(filePath, 'utf8');
                usedCache = true;
            } else {
                logger.info('iptv', `Cached M3U too old (${ageHours.toFixed(1)} hours), fetching fresh`);
            }
        }
    } catch (err) {
        logger.debug('iptv', `No cached M3U found: ${err.message}`);
    }

    // If no cache, fetch from URL
    if (!m3uContent) {
        updateSyncStatus(source.id, { step: 'fetch', message: 'Fetching M3U playlist...', percent: 0 });
        allModules?.app?.emit('sync:source:progress', { sourceId: source.id, step: 'fetch', message: 'Fetching M3U playlist...', percent: 0 });

        try {
            const response = await fetchWithRetry(source.url, { headers, timeout: 60000 }, 3, source);
            m3uContent = response.data;
        } catch (fetchErr) {
            // If fetch failed, try to use any available cached M3U as fallback
            logger.warn('iptv', `Fetch failed: ${fetchErr.message}. Looking for cached M3U fallback...`);

            try {
                const cacheDir = path.join(PATHS.data, 'cache', 'm3u');
                const safeName = source.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
                const files = await fs.readdir(cacheDir);

                // Find most recent cache file for this source (regardless of age)
                const sourceFiles = files
                    .filter(f => f.startsWith(safeName) && f.endsWith('.m3u'))
                    .sort()
                    .reverse();

                if (sourceFiles.length > 0) {
                    const latestFile = sourceFiles[0];
                    const filePath = path.join(cacheDir, latestFile);
                    const fileStats = await fs.stat(filePath);
                    const ageHours = (Date.now() - fileStats.mtime.getTime()) / (1000 * 60 * 60);
                    const ageDays = Math.floor(ageHours / 24);

                    logger.info('iptv', `Using fallback cached M3U: ${latestFile} (${ageDays} days old)`);
                    updateSyncStatus(source.id, { step: 'fetch', message: `Using cached M3U (${ageDays}d old, provider unavailable)...`, percent: 5 });
                    allModules?.app?.emit('sync:source:progress', { sourceId: source.id, step: 'fetch', message: `Using cached M3U (${ageDays}d old)...`, percent: 5 });

                    m3uContent = await fs.readFile(filePath, 'utf8');
                    usedCache = true;
                } else {
                    // No cache available, re-throw original error
                    throw fetchErr;
                }
            } catch (cacheErr) {
                if (cacheErr === fetchErr) {
                    throw fetchErr;
                }
                logger.error('iptv', `Failed to read cached M3U: ${cacheErr.message}`);
                throw new Error(`Provider unavailable (${fetchErr.message}) and no cached M3U available`);
            }
        }
    }

    if (!m3uContent || typeof m3uContent !== 'string') {
        throw new Error('Invalid M3U content');
    }

    // Save M3U to history and cache only if we fetched fresh content
    if (!usedCache) {
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

        // Also save M3U backup to cache folder
        try {
            const cacheDir = path.join(PATHS.data, 'cache', 'm3u');
            await fs.mkdir(cacheDir, { recursive: true });
            const date = new Date().toISOString().split('T')[0];
            const safeName = source.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
            const filename = `${safeName}-${date}.m3u`;
            await fs.writeFile(path.join(cacheDir, filename), m3uContent);
            logger.debug('iptv', `Saved M3U backup to ${filename}`);
        } catch (err) {
            logger.warn('iptv', `Failed to save M3U backup file: ${err.message}`);
        }
    }

    // Parse M3U (10%)
    updateSyncStatus(source.id, { step: 'parse', message: 'Parsing playlist...', percent: 10 });
    allModules?.app?.emit('sync:source:progress', { sourceId: source.id, step: 'parse', message: 'Parsing playlist...', percent: 10 });

    // Get custom parser config if available
    let parserConfig = null;
    if (source.m3u_parser_config) {
        try {
            parserConfig = JSON.parse(source.m3u_parser_config);
            logger.debug('iptv', `Using custom parser config for ${source.name}`);
        } catch (e) {
            logger.warn('iptv', `Invalid parser config for ${source.name}, using defaults`);
        }
    }
    let channels = parseM3U(m3uContent, parserConfig);

    if (source.country_filter) {
        const beforeCount = channels.length;
        channels = channels.filter(channel => matchesCountryFilter(source, channel.language, channel.group, channel.name, channel.group));
        const filteredCount = beforeCount - channels.length;
        if (filteredCount > 0) {
            logger.info('iptv', `Filtered ${filteredCount} M3U entries by country (${source.country_filter})`);
        }
    }

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
    updateSyncStatus(source.id, { step: 'save', message: `Saving ${totalItems} items...`, percent: 20, total: totalItems });
    allModules?.app?.emit('sync:source:progress', { sourceId: source.id, step: 'save', message: `Saving ${totalItems} items...`, total: totalItems, percent: 20 });

    let processedCount = 0;
    let savedCount = 0, skippedCount = 0;

    // OPTIMIZATION: Pre-load existing media IDs and titles for this source
    logger.info('iptv', 'Pre-loading existing media for fast lookup...');
    const existingMedia = await db.all(
        'SELECT id, external_id, title, stream_url FROM media WHERE source_id = ?',
        [source.id]
    );
    const existingMap = new Map();
    for (const item of existingMedia) {
        existingMap.set(item.external_id, { id: item.id, title: item.title, stream_url: item.stream_url });
    }
    logger.info('iptv', `Loaded ${existingMap.size} existing media items`);

    // Track classification stats
    const classificationStats = { live: 0, movie: 0, series: 0 };

    // OPTIMIZATION: Process in batches with transactions
    const BATCH_SIZE = 500;

    // Prepare series data for batch processing
    const seriesData = [];
    for (const [key, series] of seriesMap) {
        const language = extractLanguageFromText(series.category, series.seriesName);
        const platform = extractPlatform(series.category);

        if (!isLanguageAllowed(language)) {
            skippedCount++;
            processedCount++;
            continue;
        }

        const seriesExternalId = `m3u_series_${key.replace(/[^a-z0-9]/g, '_')}`;
        const totalEpisodes = series.episodes.length;
        const existing = existingMap.get(seriesExternalId);

        seriesData.push({
            externalId: seriesExternalId,
            seriesName: series.seriesName,
            logo: series.logo,
            category: series.category,
            totalEpisodes,
            language,
            platform,
            episodes: series.episodes,
            existing
        });
    }

    // Process series in batches
    logger.info('iptv', `Processing ${seriesData.length} series in batches of ${BATCH_SIZE}...`);
    for (let batchStart = 0; batchStart < seriesData.length; batchStart += BATCH_SIZE) {
        const batch = seriesData.slice(batchStart, batchStart + BATCH_SIZE);

        // Start transaction for this batch
        await db.run('BEGIN TRANSACTION');

        try {
            for (const item of batch) {
                // Insert/update series
                await db.run(`
                    INSERT INTO media (source_id, external_id, media_type, title, original_title, show_name, poster, category, episode_count, language, platform, is_active, last_seen_at)
                    VALUES (?, ?, 'series', ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
                    ON CONFLICT(source_id, external_id) DO UPDATE SET
                        title = COALESCE(media.title, excluded.title),
                        original_title = excluded.original_title,
                        show_name = excluded.show_name,
                        poster = COALESCE(media.poster, excluded.poster),
                        category = COALESCE(excluded.category, media.category),
                        episode_count = excluded.episode_count,
                        language = COALESCE(media.language, excluded.language),
                        platform = COALESCE(excluded.platform, media.platform),
                        is_active = 1,
                        last_seen_at = CURRENT_TIMESTAMP
                `, [
                    source.id,
                    item.externalId,
                    item.seriesName,
                    item.seriesName,
                    item.seriesName,
                    item.logo,
                    item.category,
                    item.totalEpisodes,
                    item.language,
                    item.platform
                ]);

                // Track statistics
                if (!item.existing) {
                    stats.added++;
                } else if (item.existing.title !== item.seriesName) {
                    stats.updated++;
                } else {
                    stats.unchanged++;
                }

                // Get media_id - use cached if available, otherwise query
                let mediaId = item.existing?.id;
                if (!mediaId) {
                    const inserted = await db.get(
                        'SELECT id FROM media WHERE source_id = ? AND external_id = ?',
                        [source.id, item.externalId]
                    );
                    mediaId = inserted?.id;
                    // Update cache
                    if (mediaId) {
                        existingMap.set(item.externalId, { id: mediaId, title: item.seriesName });
                    }
                }

                // Insert episodes for this series
                if (mediaId && item.episodes.length > 0) {
                    for (const ep of item.episodes) {
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

                savedCount++;
                processedCount++;
            }

            await db.run('COMMIT');
        } catch (err) {
            await db.run('ROLLBACK');
            throw err;
        }

        // Update progress after each batch
        const savePercent = 20 + Math.round((processedCount / totalItems) * 40); // Series = 20-60%
        const msg = `Saved: ${savedCount}, Filtered: ${skippedCount}`;
        updateSyncStatus(source.id, { step: 'save', message: msg, percent: savePercent, current: processedCount, total: totalItems });
        allModules?.app?.emit('sync:source:progress', { sourceId: source.id, step: 'save', message: msg, current: processedCount, total: totalItems, percent: savePercent });
    }

    // Prepare non-episode channel data
    const channelData = [];
    for (let i = 0; i < nonEpisodeChannels.length; i++) {
        const channel = nonEpisodeChannels[i];

        let mediaType = channel.contentType || 'live';
        if (!channel.contentType) {
            const groupLower = (channel.group || '').toLowerCase();
            if (groupLower.includes('vod') || groupLower.includes('movie') || groupLower.includes('film')) {
                mediaType = 'movie';
            } else if (groupLower.includes('series') || groupLower.includes('show') || groupLower.startsWith('srs')) {
                mediaType = 'series';
            }
        }

        classificationStats[mediaType] = (classificationStats[mediaType] || 0) + 1;

        const language = channel.language || extractLanguageFromText(channel.group, channel.name);
        const platform = extractPlatform(channel.group);

        if (mediaType !== 'live' && !isLanguageAllowed(language)) {
            skippedCount++;
            processedCount++;
            continue;
        }

        const externalId = channel.id || String(i);
        const existing = existingMap.get(externalId);

        channelData.push({
            externalId,
            mediaType,
            name: channel.name,
            logo: channel.logo,
            group: channel.group,
            url: channel.url,
            language,
            platform,
            tvgId: channel.id,  // tvg-id from M3U for EPG matching
            existing
        });
    }

    // Process channels in batches
    logger.info('iptv', `Processing ${channelData.length} channels in batches of ${BATCH_SIZE}...`);
    for (let batchStart = 0; batchStart < channelData.length; batchStart += BATCH_SIZE) {
        const batch = channelData.slice(batchStart, batchStart + BATCH_SIZE);

        await db.run('BEGIN TRANSACTION');

        try {
            for (const item of batch) {
                await db.run(`
                    INSERT INTO media (source_id, external_id, media_type, title, original_title, poster, category, stream_url, language, platform, tvg_id, is_active, last_seen_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
                    ON CONFLICT(source_id, external_id) DO UPDATE SET
                        media_type = excluded.media_type,
                        title = COALESCE(media.title, excluded.title),
                        original_title = excluded.original_title,
                        poster = COALESCE(media.poster, excluded.poster),
                        category = excluded.category,
                        stream_url = excluded.stream_url,
                        language = COALESCE(media.language, excluded.language),
                        platform = COALESCE(excluded.platform, media.platform),
                        tvg_id = COALESCE(excluded.tvg_id, media.tvg_id),
                        is_active = 1,
                        last_seen_at = CURRENT_TIMESTAMP
                `, [
                    source.id,
                    item.externalId,
                    item.mediaType,
                    item.name,
                    item.name,
                    item.logo,
                    item.group,
                    item.url,
                    item.language,
                    item.platform,
                    item.tvgId || null  // tvg_id for EPG matching
                ]);

                if (!item.existing) {
                    stats.added++;
                } else if (item.existing.title !== item.name || item.existing.stream_url !== item.url) {
                    stats.updated++;
                } else {
                    stats.unchanged++;
                }

                savedCount++;
                processedCount++;
            }

            await db.run('COMMIT');
        } catch (err) {
            await db.run('ROLLBACK');
            throw err;
        }

        // Update progress after each batch
        const savePercent = 60 + Math.round(((processedCount - seriesData.length) / channelData.length) * 38); // Channels = 60-98%
        const msg = `Saved: ${savedCount}, Filtered: ${skippedCount}`;
        updateSyncStatus(source.id, { step: 'save', message: msg, percent: savePercent, current: processedCount, total: totalItems });
        allModules?.app?.emit('sync:source:progress', { sourceId: source.id, step: 'save', message: msg, current: processedCount, total: totalItems, percent: savePercent });
    }

    // Log classification breakdown
    logger.info('iptv', `Categorized: ${classificationStats.live} live, ${classificationStats.movie} movies, ${classificationStats.series} series`);

    // Mark items not seen in this sync as inactive
    updateSyncStatus(source.id, { step: 'cleanup', message: 'Marking removed items...', percent: 98 });
    allModules?.app?.emit('sync:source:progress', { sourceId: source.id, step: 'cleanup', message: 'Marking removed items...', percent: 98 });

    const inactiveResult = await db.run(`
        UPDATE media SET is_active = 0
        WHERE source_id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)
    `, [source.id, syncStartTime]);
    stats.removed = inactiveResult.changes || 0;

    // Update last sync time
    await db.run('UPDATE sources SET last_sync = CURRENT_TIMESTAMP WHERE id = ?', [source.id]);

    logger.info('iptv', `Sync complete for ${source.name}: +${stats.added} added, ~${stats.updated} updated, =${stats.unchanged} unchanged, -${stats.removed} removed`);
    clearSyncStatus(source.id);
    allModules?.app?.emit('sync:source:complete', { sourceId: source.id, stats });
}

// Default parser config for standard M3U format
const DEFAULT_PARSER_CONFIG = {
    // Regex patterns to extract fields from EXTINF line
    // Each pattern should have a capture group for the value
    patterns: {
        id: 'tvg-id="([^"]*)"',
        name: 'tvg-name="([^"]*)"',
        logo: 'tvg-logo="([^"]*)"',
        group: 'group-title="([^"]*)"',
        language: 'tvg-language="([^"]*)"'
    },
    // Extract additional fields from the title itself
    // These patterns run against the extracted name/title
    titlePatterns: {
        // Extract language code from title prefix like "DE - ", "EN: ", "FR - "
        language: '^([A-Z]{2})\\s*[-:]\\s*',
        // Extract year from title like "Movie Name (2024)"
        year: '\\((\\d{4})\\)\\s*$',
        // Extract season/episode from title like "S01E02" or "S01 E02"
        season: 'S(\\d+)\\s*E\\d+',
        episode: 'S\\d+\\s*E(\\d+)',
        // Extract platform/category from title or group
        platform: '(NETFLIX|AMAZON|PRIME|DISNEY|APPLETV|HBO|PARAMOUNT|PEACOCK|HULU)'
    },
    // Content type detection patterns (matched against group-title)
    // Use pipe-separated keywords for OR matching
    // NOTE: Order matters - series patterns are checked first, then movies, then livetv
    contentTypePatterns: {
        // Series - SRS prefix (common in IPTV) and standard keywords
        series: '^SRS\\s*-|SERIE|SERIEN|SERIALE|SHOW|SHOWS|SEASON|S\\d+E\\d+|SOROZAT|TVSHOW',
        // Movies - VOD prefix (common in IPTV) and standard keywords
        movies: '^VOD\\s*-|MOVIE|FILM|FILME|FILMA|FILMES|FILMI|FILMOVI|VOD|CINEMA|KINO|CINE|BIOSCOOP',
        // Live TV - pipe-delimited country codes and standard keywords
        livetv: '^\\|[A-Z]{2}\\||LIVE|NEWS|SPORT|24\\/7|CHANNEL|TV\\s|\\sTV|RADIO|PPV'
    },
    // How to extract the display name from after the comma in EXTINF line
    nameExtraction: 'afterComma' // 'afterComma' | 'tvgName' | 'custom'
};

// Detect content type using configurable patterns
function detectContentTypeFromPatterns(group, title, contentTypePatterns) {
    const textToCheck = `${group || ''} ${title || ''}`.toUpperCase();

    if (!contentTypePatterns) {
        return null; // Will fall back to default detection
    }

    // Check patterns in order: series first (most specific), then movies, then livetv
    // Series detection - check title for S01E01 pattern first as it's very reliable
    if (contentTypePatterns.series) {
        try {
            const seriesRegex = new RegExp(contentTypePatterns.series, 'i');
            if (seriesRegex.test(textToCheck)) {
                return 'series';
            }
        } catch (e) {
            // Invalid regex, skip
        }
    }

    // Movies detection
    if (contentTypePatterns.movies) {
        try {
            const moviesRegex = new RegExp(contentTypePatterns.movies, 'i');
            if (moviesRegex.test(textToCheck)) {
                return 'movie';
            }
        } catch (e) {
            // Invalid regex, skip
        }
    }

    // Live TV detection
    if (contentTypePatterns.livetv) {
        try {
            const livetvRegex = new RegExp(contentTypePatterns.livetv, 'i');
            if (livetvRegex.test(textToCheck)) {
                return 'live';
            }
        } catch (e) {
            // Invalid regex, skip
        }
    }

    return null; // No pattern matched
}

function parseM3U(content, parserConfig = null) {
    const config = parserConfig ? { ...DEFAULT_PARSER_CONFIG, ...parserConfig } : DEFAULT_PARSER_CONFIG;

    // Merge patterns if custom config provided
    if (parserConfig?.patterns) {
        config.patterns = { ...DEFAULT_PARSER_CONFIG.patterns, ...parserConfig.patterns };
    }
    if (parserConfig?.titlePatterns) {
        config.titlePatterns = { ...DEFAULT_PARSER_CONFIG.titlePatterns, ...parserConfig.titlePatterns };
    }
    if (parserConfig?.contentTypePatterns) {
        config.contentTypePatterns = { ...DEFAULT_PARSER_CONFIG.contentTypePatterns, ...parserConfig.contentTypePatterns };
    }

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
                url: null,
                year: null,
                season: null,
                episode: null,
                platform: null,
                contentType: null
            };

            // Extract attributes using configured patterns
            for (const [field, pattern] of Object.entries(config.patterns)) {
                if (pattern) {
                    try {
                        const regex = new RegExp(pattern, 'i');
                        const match = line.match(regex);
                        if (match && match[1]) {
                            currentChannel[field] = match[1];
                        }
                    } catch (e) {
                        // Invalid regex, skip
                    }
                }
            }

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
                    commaPos = j;
                    const rest = line.substring(j + 1);
                    if (!rest.trim().match(/^[a-z_-]+="/i)) {
                        break;
                    }
                }
            }

            if (commaPos > 0) {
                currentChannel.name = line.substring(commaPos + 1).trim();
            }

            // Fallback to tvg-name if we couldn't extract channel name
            if (!currentChannel.name && currentChannel.id) {
                // Try to use the name from patterns
                const tvgNameMatch = line.match(/tvg-name="([^"]*)"/i);
                if (tvgNameMatch) {
                    currentChannel.name = tvgNameMatch[1];
                }
            }

            // Final fallback: try to extract name after last comma (simple approach)
            if (!currentChannel.name) {
                const nameMatch = line.match(/,\s*([^,]+)$/);
                if (nameMatch) {
                    currentChannel.name = nameMatch[1].trim();
                }
            }

            // Apply title patterns to extract additional metadata from the name
            if (currentChannel.name && config.titlePatterns) {
                for (const [field, pattern] of Object.entries(config.titlePatterns)) {
                    if (pattern && !currentChannel[field]) {
                        try {
                            const regex = new RegExp(pattern, 'i');
                            const match = currentChannel.name.match(regex);
                            if (match && match[1]) {
                                currentChannel[field] = match[1].toUpperCase();
                            }
                        } catch (e) {
                            // Invalid regex, skip
                        }
                    }
                }

                // Also check group for platform if not found in name
                if (!currentChannel.platform && currentChannel.group && config.titlePatterns.platform) {
                    try {
                        const regex = new RegExp(config.titlePatterns.platform, 'i');
                        const match = currentChannel.group.match(regex);
                        if (match && match[1]) {
                            currentChannel.platform = match[1].toUpperCase();
                        }
                    } catch (e) {
                        // Invalid regex, skip
                    }
                }
            }

            // Extract country/language from tvg-id (iptv-org format: "ChannelName.XX@quality")
            // e.g., "apartTV.lu@SD" -> "LU", "RTLTelevision.de@HD" -> "DE"
            if (!currentChannel.language && currentChannel.id) {
                const tvgIdMatch = currentChannel.id.match(/\.([a-z]{2})@/i);
                if (tvgIdMatch) {
                    currentChannel.language = tvgIdMatch[1].toUpperCase();
                }
            }

            // If we have a language but category doesn't have country prefix, add it
            // This ensures channels appear in the correct country group in Live TV
            if (currentChannel.language && currentChannel.group) {
                const hasCountryPrefix = /^\|?[A-Z]{2}\|/.test(currentChannel.group) || /^[A-Z]{2}\s/.test(currentChannel.group);
                if (!hasCountryPrefix) {
                    currentChannel.group = `|${currentChannel.language}| ${currentChannel.group}`;
                }
            }

        } else if (line && !line.startsWith('#') && currentChannel) {
            // This is the URL line
            currentChannel.url = line;
            if (currentChannel.name && currentChannel.url) {
                // Detect content type using custom patterns first, then fall back to default detection
                currentChannel.contentType = detectContentTypeFromPatterns(
                    currentChannel.group,
                    currentChannel.name,
                    config.contentTypePatterns
                ) || detectMediaTypeFromCategory(currentChannel.group, currentChannel.name);

                channels.push(currentChannel);
            }
            currentChannel = null;
        }
    }

    return channels;
}

// Preview parser results for testing regex patterns
function previewM3UParser(m3uSample, parserConfig = null) {
    const lines = m3uSample.split('\n');
    const results = [];

    // Find EXTINF entries (pairs of EXTINF line + URL line)
    let extinf = null;
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#EXTINF:')) {
            extinf = trimmed;
        } else if (extinf && trimmed && !trimmed.startsWith('#')) {
            // Parse this pair
            const parsed = parseM3U(extinf + '\n' + trimmed, parserConfig);
            if (parsed.length > 0) {
                results.push({
                    raw: { extinf, url: trimmed },
                    parsed: parsed[0]
                });
            }
            extinf = null;

            // Limit preview to 5 entries
            if (results.length >= 5) break;
        }
    }

    return results;
}

// Get default parser config (for UI display)
function getDefaultParserConfig() {
    return DEFAULT_PARSER_CONFIG;
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
    // Match (YYYY) or - YYYY or YYYY at end of title
    const patterns = [
        /\((\d{4})\)/,           // (2024)
        /[-–]\s*(\d{4})(?:\s|$)/, // - 2024 or – 2024
        /\s(\d{4})$/,            // ends with 2024
    ];
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
            const year = parseInt(match[1]);
            // Validate year is reasonable (1900-2030)
            if (year >= 1900 && year <= 2030) {
                return year;
            }
        }
    }
    return null;
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
        allModules = modules;  // Store ref for dynamic app access
    },

    testSource: async (source) => {
        try {
            const baseUrl = source.url.replace(/\/$/, '');
            const headers = { 'User-Agent': source.user_agent || 'IBOPlayer' };

            if (source.type === 'xtream') {
                // Sanitize credentials
                const cleanUsername = (source.username || '').replace(/[\x00-\x1F\x7F]/g, '');
                const cleanPassword = (source.password || '').replace(/[\x00-\x1F\x7F]/g, '');
                const authUrl = `${baseUrl}/player_api.php?username=${cleanUsername}&password=${cleanPassword}`;
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
                    // Parse parser config if available
                    let parserConfig = null;
                    if (source.m3u_parser_config) {
                        try {
                            parserConfig = JSON.parse(source.m3u_parser_config);
                        } catch (e) {}
                    }
                    const channels = parseM3U(content, parserConfig);
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
            clearSyncStatus(source.id);
            allModules?.app?.emit('sync:source:error', { sourceId: source.id, error: err.message });
            throw err;
        }
    },

    // Refresh source by ID (for scheduler)
    refreshSource: async (sourceId) => {
        const source = await db.get("SELECT * FROM sources WHERE id = ?", [sourceId]);
        if (!source) {
            throw new Error(`Source ${sourceId} not found`);
        }
        if (source.type === 'xtream') {
            await syncXtreamSource(source);
        } else if (source.type === 'm3u') {
            await syncM3USource(source);
        } else {
            throw new Error('Unsupported source type');
        }
    },

    // Get sync status for all sources (for page reload persistence)
    getAllSyncStatus: () => {
        return { ...syncStatus };
    },

    // Parser config functions for API
    getDefaultParserConfig,
    previewM3UParser,
    parseM3U,

    // Title parsing for reprocessing
    parseOriginalTitle
};
