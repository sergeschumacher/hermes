const axios = require('axios');

let logger = null;
let settings = null;

async function plexRequest(endpoint, method = 'GET') {
    const plexUrl = settings.get('plexUrl');
    const plexToken = settings.get('plexToken');

    if (!plexUrl || !plexToken) {
        throw new Error('Plex not configured');
    }

    const url = `${plexUrl.replace(/\/$/, '')}${endpoint}`;
    const response = await axios({
        url,
        method,
        headers: {
            'X-Plex-Token': plexToken,
            'Accept': 'application/json'
        },
        timeout: 10000
    });

    return response.data;
}

module.exports = {
    init: async (modules) => {
        logger = modules.logger;
        settings = modules.settings;
    },

    // Test Plex connection
    test: async () => {
        try {
            const data = await plexRequest('/');
            return {
                success: true,
                serverName: data.MediaContainer?.friendlyName,
                version: data.MediaContainer?.version
            };
        } catch (err) {
            return { success: false, error: err.message };
        }
    },

    // Get all libraries
    getLibraries: async () => {
        try {
            const data = await plexRequest('/library/sections');
            return (data.MediaContainer?.Directory || []).map(lib => ({
                id: lib.key,
                title: lib.title,
                type: lib.type,
                location: lib.Location?.[0]?.path
            }));
        } catch (err) {
            logger?.error('plex', `Failed to get libraries: ${err.message}`);
            return [];
        }
    },

    // Scan a specific library
    scanLibrary: async (libraryId, path = null) => {
        try {
            let endpoint = `/library/sections/${libraryId}/refresh`;
            if (path) {
                endpoint += `?path=${encodeURIComponent(path)}`;
            }

            await plexRequest(endpoint, 'GET');
            logger?.info('plex', `Triggered scan for library ${libraryId}${path ? ` (path: ${path})` : ''}`);
            return { success: true };
        } catch (err) {
            logger?.error('plex', `Failed to scan library: ${err.message}`);
            return { success: false, error: err.message };
        }
    },

    // Scan all libraries
    scanAll: async () => {
        try {
            await plexRequest('/library/sections/all/refresh', 'GET');
            logger?.info('plex', 'Triggered scan for all libraries');
            return { success: true };
        } catch (err) {
            logger?.error('plex', `Failed to scan all libraries: ${err.message}`);
            return { success: false, error: err.message };
        }
    },

    // Search Plex library
    search: async (query) => {
        try {
            const data = await plexRequest(`/search?query=${encodeURIComponent(query)}`);
            return data.MediaContainer?.Metadata || [];
        } catch (err) {
            logger?.error('plex', `Search failed: ${err.message}`);
            return [];
        }
    }
};
