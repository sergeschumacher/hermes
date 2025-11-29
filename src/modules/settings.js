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
    downloadPath: '',
    recordingsPath: '',

    // TMDB
    tmdbApiKey: '',

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

    // User agents for rotation
    userAgents: [
        'IBOPlayer/1.0',
        'VLC/3.0.18 LibVLC/3.0.18',
        'Lavf/58.29.100',
        'Kodi/19.4 (Windows NT 10.0; Win64; x64)',
        'ExoPlayer/2.18.1',
        'TiviMate/4.7.0'
    ]
};

function load() {
    try {
        if (fs.existsSync(settingsPath)) {
            const data = fs.readFileSync(settingsPath, 'utf8');
            settings = { ...defaults, ...JSON.parse(data) };
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
        defaults.recordingsPath = path.join(PATHS.data, 'recordings');

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
