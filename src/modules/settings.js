const fs = require('fs');
const path = require('path');

let settings = {};
let settingsPath = '';
let logger = null;

const defaults = {
    // Server
    port: 3000,

    // Paths
    tempPath: '',
    downloadPath: '',        // Legacy/fallback path
    movieDownloadPath: '',   // Path for movie downloads
    seriesDownloadPath: '',  // Path for series downloads
    recordingsPath: '',      // Path for live TV recordings

    // TMDB
    tmdbApiKey: '',

    // Webhooks
    webhookUrl: '',

    // Plex
    plexUrl: '',
    plexToken: '',
    plexMovieLibraryId: '',
    plexTvLibraryId: '',

    // Overseerr
    overseerrUrl: '',
    overseerrApiKey: '',

    // Download settings
    maxConcurrentDownloads: 2,
    downloadRetries: 3,
    downloadDelayMin: 1000,
    downloadDelayMax: 5000,

    // Language preferences (ISO 639-1 codes)
    // These filter movies, series, and live TV by language
    preferredLanguages: ['de', 'en'],

    // EPG countries from globetvapp/epg
    // Available: Germany, Austria, Switzerland, United Kingdom, USA, France, Spain, Italy, etc.
    epgCountries: ['Germany'],

    // Scheduler settings
    epgSyncHour: 4,  // Hour of day to sync EPG (0-23, default 4am)
    sourceSyncIntervalHours: 24,  // How often to refresh IPTV sources

    // Transcoding settings
    transcodeFilesEnabled: true,      // Enable transcoding for downloads and watch folder
    transcodeStreamEnabled: true,     // Enable transcoding for live TV/IPTV streams
    transcodeCodec: 'h264',           // 'h264' or 'hevc'
    transcodeHwAccel: 'auto',         // 'auto', 'videotoolbox', 'nvenc', 'amf', 'vaapi', 'software'
    transcodeSkipCompatible: true,    // Skip if already H.264/H.265 in MP4
    transcodeWatchEnabled: false,     // Enable watch folder for manual transcoding
    transcodeWatchFolder: '',         // Input folder to watch for files to transcode
    transcodeOutputFolder: '',        // Output folder for transcoded files
    slowDiskMode: false,              // Sequential download+transcode: one at a time for slow HDDs

    // LLM settings
    llmProvider: 'none',                    // 'none', 'openai', 'ollama'
    openaiApiKey: '',                       // OpenAI API key
    openaiModel: 'gpt-4o-mini',             // OpenAI model to use
    ollamaUrl: 'http://localhost:11434',    // Ollama server URL
    ollamaModel: 'llama3.2',                // Ollama model to use

    // Usenet settings
    usenetEnabled: false,                   // Enable usenet downloading
    usenetTempPath: '',                     // Temp path for NZB downloads (set in init)
    usenetDownloadPath: '',                 // Final path for completed usenet downloads
    usenetConnections: 10,                  // Max connections per provider
    usenetRetryAttempts: 3,                 // Retry failed segments
    usenetParRepair: true,                  // Enable PAR2 verification/repair
    usenetAutoExtract: true,                // Auto-extract archives after download
    usenetCleanupAfterExtract: true,        // Delete archives after extraction

    // User agents for rotation
    userAgents: [
        'IBOPlayer/1.0',
        'VLC/3.0.18 LibVLC/3.0.18',
        'Lavf/58.29.100',
        'Kodi/19.4 (Windows NT 10.0; Win64; x64)',
        'ExoPlayer/2.18.1',
        'TiviMate/4.7.0'
    ],

    // HDHomeRun Emulator settings
    hdhrEnabled: false,                   // Enable HDHomeRun emulator for Plex
    hdhrPort: 5004,                       // HTTP server port (standard HDHomeRun port)
    hdhrDeviceId: null,                   // Auto-generated 8-char hex device ID
    hdhrFriendlyName: 'Hermes HDHR',      // Device name shown in Plex
    hdhrTunerCount: 2,                    // Number of virtual tuners (concurrent streams)
    hdhrBaseUrl: null,                    // External URL override (auto-detected if null)
    hdhrSourceId: null,                   // IPTV source ID for channel/EPG filtering
    appBaseUrl: null                      // External app URL for logos/images (e.g. http://192.168.1.100:4000)
};

function load() {
    try {
        if (fs.existsSync(settingsPath)) {
            const data = fs.readFileSync(settingsPath, 'utf8');
            settings = { ...defaults, ...JSON.parse(data) };

            // Migration: convert old transcodeEnabled to new settings
            if (settings.transcodeEnabled !== undefined && settings.transcodeFilesEnabled === undefined) {
                settings.transcodeFilesEnabled = settings.transcodeEnabled;
                settings.transcodeStreamEnabled = true; // Default to enabled for streams
                delete settings.transcodeEnabled;
                save(); // Save migrated settings
                logger?.info('settings', 'Migrated transcodeEnabled to transcodeFilesEnabled/transcodeStreamEnabled');
            }

            logger?.info('settings', 'Settings loaded');
        } else {
            settings = { ...defaults };
            save();
            logger?.info('settings', 'Created default settings');
        }
    } catch (err) {
        logger?.error('settings', 'Failed to load settings', { error: err.message });
        settings = { ...defaults };
    }
}

function save() {
    try {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        logger?.debug('settings', 'Settings saved');
    } catch (err) {
        logger?.error('settings', 'Failed to save settings', { error: err.message });
    }
}

module.exports = {
    init: async (modules) => {
        logger = modules.logger;
        settingsPath = path.join(PATHS.data, 'config', 'settings.json');

        // Set default paths based on data directory
        defaults.tempPath = path.join(PATHS.data, 'temp');
        defaults.downloadPath = path.join(PATHS.data, 'downloads');
        defaults.movieDownloadPath = path.join(PATHS.data, 'downloads', 'movies');
        defaults.seriesDownloadPath = path.join(PATHS.data, 'downloads', 'series');
        defaults.recordingsPath = path.join(PATHS.data, 'recordings');
        defaults.transcodeWatchFolder = path.join(PATHS.data, 'transcode-input');
        defaults.transcodeOutputFolder = path.join(PATHS.data, 'transcode-output');
        defaults.usenetTempPath = path.join(PATHS.data, 'usenet-temp');
        defaults.usenetDownloadPath = path.join(PATHS.data, 'downloads', 'usenet');

        load();
    },

    get: (key) => {
        return settings[key] ?? defaults[key];
    },

    set: (key, value) => {
        settings[key] = value;
        save();
        return value;
    },

    getAll: () => ({ ...settings }),

    update: (newSettings) => {
        settings = { ...settings, ...newSettings };
        save();
        return settings;
    },

    reset: () => {
        settings = { ...defaults };
        save();
        return settings;
    },

    getRandomUserAgent: () => {
        const agents = settings.userAgents || defaults.userAgents;
        return agents[Math.floor(Math.random() * agents.length)];
    }
};
