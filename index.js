const path = require('path');
const fs = require('fs');

// Global configuration
global.APP_NAME = 'Hermes';
global.VERSION = '1.0.0';
global.PATHS = {
    root: path.resolve(__dirname),
    data: process.env.DATA_PATH || path.resolve(__dirname, 'data'),
    views: path.resolve(__dirname, 'web', 'views'),
    static: path.resolve(__dirname, 'web', 'static'),
    sql: path.resolve(__dirname, 'sql')
};

// Ensure data directories exist
const dataDirs = ['config', 'cache', 'temp', 'downloads'];
dataDirs.forEach(dir => {
    const dirPath = path.join(PATHS.data, dir);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
});

// Module loader
const modules = {};
const moduleOrder = ['logger', 'settings', 'db', 'tmdb', 'llm', 'enrichment', 'iptv', 'newznab', 'usenet', 'usenet-postprocess', 'source-analyzer', 'epg', 'hdhr', 'scheduler', 'transcoder', 'download', 'plex', 'overseerr', 'search', 'app'];

async function loadModules() {
    console.log(`[${APP_NAME}] Starting v${VERSION}...`);

    for (const moduleName of moduleOrder) {
        try {
            const modulePath = path.join(__dirname, 'src', 'modules', `${moduleName}.js`);
            if (fs.existsSync(modulePath)) {
                modules[moduleName] = require(modulePath);
                if (modules[moduleName].init) {
                    await modules[moduleName].init(modules);
                }
                console.log(`[${APP_NAME}] Loaded module: ${moduleName}`);
            }
        } catch (err) {
            console.error(`[${APP_NAME}] Failed to load module ${moduleName}:`, err.message);
        }
    }

    console.log(`[${APP_NAME}] All modules loaded`);
}

// Export module getter
module.exports = {
    get: (name) => modules[name],
    modules
};

// Start the application
loadModules().catch(err => {
    console.error(`[${APP_NAME}] Fatal error:`, err);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log(`\n[${APP_NAME}] Shutting down...`);
    for (const moduleName of moduleOrder.reverse()) {
        if (modules[moduleName]?.shutdown) {
            await modules[moduleName].shutdown();
        }
    }
    process.exit(0);
});
