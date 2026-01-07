/**
 * HDHomeRun Emulator Module
 * Makes RecoStream appear as an HDHomeRun tuner for Plex Live TV & DVR integration
 */

const express = require('express');
const dgram = require('dgram');
const http = require('http');
const os = require('os');
const axios = require('axios');

let db = null;
let logger = null;
let settings = null;
let iptv = null;
let epg = null;

let httpServer = null;
let udpServer = null;
let activeStreams = new Map(); // Track active tuner usage

// Generate a random 8-character hex device ID
function generateDeviceId() {
    return Array.from({ length: 8 }, () =>
        Math.floor(Math.random() * 16).toString(16)
    ).join('').toUpperCase();
}

// Get local IP address for BaseURL
function getLocalIP() {
    const override = settings?.get('hdhrBaseUrl');
    if (override) {
        // Extract host from URL if full URL provided
        try {
            const url = new URL(override);
            return url.host;
        } catch {
            return override;
        }
    }

    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

function getBaseUrl() {
    // Check for custom base URL first
    const customBaseUrl = settings?.get('hdhrBaseUrl');
    if (customBaseUrl) {
        return customBaseUrl.replace(/\/$/, ''); // Remove trailing slash if present
    }
    const port = settings?.get('hdhrPort') || 5004;
    return `http://${getLocalIP()}:${port}`;
}

function getAppBaseUrl() {
    // Get main app URL for logo caching endpoint
    // Check for custom app base URL setting first
    const appBaseUrl = settings?.get('appBaseUrl');
    if (appBaseUrl) {
        return appBaseUrl.replace(/\/$/, '');
    }
    // Extract just the hostname/IP from hdhr base URL (remove port if present)
    const hdhrBase = getBaseUrl();
    const match = hdhrBase.match(/^(https?:\/\/[^:\/]+)/);
    const host = match ? match[1] : `http://${getLocalIP()}`;
    // Default to 4000 for external Docker access (internal 3000 maps to external 4000)
    return `${host}:4000`;
}

// HDHomeRun Discovery Response
function getDiscoverJson() {
    const deviceId = settings?.get('hdhrDeviceId') || generateDeviceId();
    const friendlyName = settings?.get('hdhrFriendlyName') || 'RecoStream HDHR';
    const tunerCount = settings?.get('hdhrTunerCount') || 2;
    const baseUrl = getBaseUrl();

    return {
        FriendlyName: friendlyName,
        ModelNumber: 'HDHR5-4US',
        FirmwareName: 'hdhomerun5_atsc',
        FirmwareVersion: '20231001',
        DeviceID: deviceId,
        DeviceAuth: 'recostream',
        TunerCount: tunerCount,
        BaseURL: baseUrl,
        LineupURL: `${baseUrl}/lineup.json`
    };
}

// UPnP Device XML
function getDeviceXml() {
    const deviceId = settings?.get('hdhrDeviceId') || generateDeviceId();
    const friendlyName = settings?.get('hdhrFriendlyName') || 'RecoStream HDHR';

    return `<?xml version="1.0" encoding="UTF-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
    <specVersion>
        <major>1</major>
        <minor>0</minor>
    </specVersion>
    <device>
        <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
        <friendlyName>${friendlyName}</friendlyName>
        <manufacturer>Silicondust</manufacturer>
        <modelName>HDHR5-4US</modelName>
        <modelNumber>HDHR5-4US</modelNumber>
        <serialNumber>${deviceId}</serialNumber>
        <UDN>uuid:${deviceId}-recostream-hdhr</UDN>
    </device>
</root>`;
}

// Lineup Status
function getLineupStatus() {
    return {
        ScanInProgress: 0,
        ScanPossible: 1,
        Source: 'Cable',
        SourceList: ['Cable']
    };
}

// Get channel lineup for Plex
async function getLineup() {
    const baseUrl = getBaseUrl();

    // Get enabled HDHR channels (only from active sources)
    const channels = await db.all(`
        SELECT
            h.id,
            h.guide_number,
            h.guide_name,
            m.id as media_id,
            m.title,
            m.stream_url,
            m.poster,
            m.tvg_id
        FROM hdhr_channels h
        JOIN media m ON h.media_id = m.id
        JOIN sources s ON m.source_id = s.id
        WHERE h.enabled = 1 AND s.active = 1
        ORDER BY CAST(h.guide_number AS REAL), h.guide_number
    `);

    return channels.map(ch => ({
        GuideNumber: ch.guide_number,
        GuideName: ch.guide_name || ch.title,
        URL: `${baseUrl}/stream/${ch.guide_number}`
    }));
}

// Get detailed channel info (includes stream URL for internal use)
async function getChannelByNumber(guideNumber) {
    return await db.get(`
        SELECT
            h.id,
            h.guide_number,
            h.guide_name,
            m.id as media_id,
            m.title,
            m.stream_url,
            m.poster,
            m.tvg_id,
            m.source_id,
            s.user_agent,
            s.spoofed_mac,
            s.spoofed_device_key
        FROM hdhr_channels h
        JOIN media m ON h.media_id = m.id
        JOIN sources s ON m.source_id = s.id
        WHERE h.guide_number = ? AND h.enabled = 1 AND s.active = 1
    `, [guideNumber]);
}

// Generate XMLTV EPG for enabled channels
async function generateXmltv() {
    // Get source filter from settings
    const sourceId = settings.get('hdhrSourceId');

    // Build source filter for channels query
    const channelParams = [];
    let channelSourceFilter = '';
    if (sourceId) {
        channelSourceFilter = 'AND m.source_id = ?';
        channelParams.push(sourceId);
    }

    const channels = await db.all(`
        SELECT
            h.guide_number,
            h.guide_name,
            m.id as media_id,
            m.title,
            m.poster,
            m.tvg_id
        FROM hdhr_channels h
        JOIN media m ON h.media_id = m.id
        JOIN sources s ON m.source_id = s.id
        WHERE h.enabled = 1 AND s.active = 1 ${channelSourceFilter}
        ORDER BY CAST(h.guide_number AS REAL)
    `, channelParams);

    // Get app base URL for cached logo endpoint
    const appBaseUrl = getAppBaseUrl();

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<!DOCTYPE tv SYSTEM "xmltv.dtd">\n';
    xml += '<tv generator-info-name="RecoStream HDHR">\n';

    // Channel definitions
    for (const ch of channels) {
        xml += `  <channel id="${escapeXml(ch.guide_number)}">\n`;
        xml += `    <display-name>${escapeXml(ch.guide_name || ch.title)}</display-name>\n`;
        // Use cached logo endpoint for persistent logos
        xml += `    <icon src="${appBaseUrl}/logo/${ch.media_id}" />\n`;
        xml += `  </channel>\n`;
    }

    // Get EPG programs for channels with tvg_id
    const tvgIds = channels.filter(c => c.tvg_id).map(c => c.tvg_id);
    if (tvgIds.length > 0) {
        const placeholders = tvgIds.map(() => '?').join(',');
        const now = new Date();
        const endTime = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days ahead

        // Build source filter for EPG query
        let epgSourceFilter = '';
        const epgParams = [...tvgIds, now.toISOString(), endTime.toISOString()];
        if (sourceId) {
            epgSourceFilter = 'AND ep.source_id = ?';
            epgParams.push(sourceId);
        }

        const programs = await db.all(`
            SELECT
                ep.channel_id,
                ep.title,
                ep.subtitle,
                ep.description,
                ep.start_time,
                ep.end_time,
                ep.category,
                ep.icon,
                ep.episode_num
            FROM epg_programs ep
            WHERE ep.channel_id IN (${placeholders})
              AND ep.end_time > ?
              AND ep.start_time < ?
              ${epgSourceFilter}
            ORDER BY ep.start_time
        `, epgParams);

        // Map tvg_id to guide_number
        const tvgToGuide = {};
        for (const ch of channels) {
            if (ch.tvg_id) {
                tvgToGuide[ch.tvg_id] = ch.guide_number;
            }
        }

        for (const prog of programs) {
            const guideNumber = tvgToGuide[prog.channel_id];
            if (!guideNumber) continue;

            const start = formatXmltvDate(prog.start_time);
            const stop = formatXmltvDate(prog.end_time);

            xml += `  <programme start="${start}" stop="${stop}" channel="${escapeXml(guideNumber)}">\n`;
            xml += `    <title>${escapeXml(prog.title)}</title>\n`;
            if (prog.subtitle) {
                xml += `    <sub-title>${escapeXml(prog.subtitle)}</sub-title>\n`;
            }
            if (prog.description) {
                xml += `    <desc>${escapeXml(prog.description)}</desc>\n`;
            }
            if (prog.category) {
                xml += `    <category>${escapeXml(prog.category)}</category>\n`;
            }
            if (prog.episode_num) {
                xml += `    <episode-num system="onscreen">${escapeXml(prog.episode_num)}</episode-num>\n`;
            }
            if (prog.icon) {
                xml += `    <icon src="${escapeXml(prog.icon)}" />\n`;
            }
            xml += `  </programme>\n`;
        }
    }

    xml += '</tv>\n';
    return xml;
}

function escapeXml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function formatXmltvDate(dateStr) {
    const d = new Date(dateStr);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
           `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0000`;
}

// Create Express app for HDHomeRun HTTP API
function createHttpServer() {
    const app = express();
    app.use(express.json());

    // CORS for all requests
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type');
        next();
    });

    // Device Discovery
    app.get('/discover.json', (req, res) => {
        logger?.debug('hdhr', 'Discovery request received');
        res.json(getDiscoverJson());
    });

    // Device XML (UPnP)
    app.get('/device.xml', (req, res) => {
        res.set('Content-Type', 'application/xml');
        res.send(getDeviceXml());
    });

    // Lineup Status
    app.get('/lineup_status.json', (req, res) => {
        res.json(getLineupStatus());
    });

    // Channel Lineup
    app.get('/lineup.json', async (req, res) => {
        try {
            const lineup = await getLineup();
            logger?.info('hdhr', `Lineup requested: ${lineup.length} channels`);
            res.json(lineup);
        } catch (err) {
            logger?.error('hdhr', 'Failed to get lineup', { error: err.message });
            res.status(500).json({ error: err.message });
        }
    });

    // Trigger channel scan (no-op for IPTV, just return success)
    app.post('/lineup.post', (req, res) => {
        logger?.info('hdhr', 'Channel scan requested (no-op)');
        res.sendStatus(200);
    });

    // XMLTV EPG
    app.get('/xmltv', async (req, res) => {
        try {
            const xml = await generateXmltv();
            res.set('Content-Type', 'application/xml');
            res.send(xml);
        } catch (err) {
            logger?.error('hdhr', 'Failed to generate XMLTV', { error: err.message });
            res.status(500).send('Error generating EPG');
        }
    });

    // Stream proxy for channel
    app.get('/stream/:channelNumber', async (req, res) => {
        const { channelNumber } = req.params;
        const tunerCount = settings?.get('hdhrTunerCount') || 2;

        // Check tuner availability
        if (activeStreams.size >= tunerCount) {
            logger?.warn('hdhr', `All ${tunerCount} tuners busy, rejecting stream request`);
            return res.status(503).send('All tuners busy');
        }

        try {
            const channel = await getChannelByNumber(channelNumber);
            if (!channel) {
                logger?.warn('hdhr', `Channel ${channelNumber} not found`);
                return res.status(404).send('Channel not found');
            }

            logger?.info('hdhr', `Starting stream for channel ${channelNumber}: ${channel.title}`);

            // Track this stream
            const streamId = `${Date.now()}-${channelNumber}`;
            activeStreams.set(streamId, { channelNumber, startTime: Date.now() });

            // Build headers for source request
            const headers = {
                'User-Agent': channel.user_agent || 'IBOPlayer',
                'Accept': '*/*',
                'Connection': 'keep-alive'
            };

            if (channel.spoofed_mac) {
                headers['X-Device-MAC'] = channel.spoofed_mac;
                headers['X-Forwarded-For'] = channel.spoofed_mac;
            }

            // Proxy the stream
            const response = await axios({
                method: 'get',
                url: channel.stream_url,
                headers,
                responseType: 'stream',
                timeout: 30000
            });

            // Set response headers for MPEG-TS
            res.set('Content-Type', 'video/mp2t');
            res.set('Cache-Control', 'no-cache');
            res.set('Connection', 'keep-alive');

            // Pipe stream to client
            response.data.pipe(res);

            // Cleanup on disconnect
            res.on('close', () => {
                activeStreams.delete(streamId);
                logger?.info('hdhr', `Stream ended for channel ${channelNumber}`);
                response.data.destroy();
            });

            response.data.on('error', (err) => {
                activeStreams.delete(streamId);
                logger?.error('hdhr', `Stream error for channel ${channelNumber}`, { error: err.message });
            });

        } catch (err) {
            logger?.error('hdhr', `Failed to start stream for channel ${channelNumber}`, { error: err.message });
            res.status(500).send('Failed to start stream');
        }
    });

    // Status endpoint
    app.get('/status', (req, res) => {
        res.json({
            running: true,
            tunerCount: settings?.get('hdhrTunerCount') || 2,
            activeStreams: activeStreams.size,
            streams: Array.from(activeStreams.values())
        });
    });

    return app;
}

// UDP Discovery Server
function startUdpDiscovery() {
    const server = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    server.on('error', (err) => {
        logger?.error('hdhr', `UDP server error: ${err.message}`);
        server.close();
    });

    server.on('message', (msg, rinfo) => {
        // HDHomeRun discovery packet starts with specific bytes
        // Type: 0x0002 = discover request
        if (msg.length >= 4 && msg[0] === 0x00 && msg[1] === 0x02) {
            logger?.debug('hdhr', `Discovery packet from ${rinfo.address}:${rinfo.port}`);

            // Build discovery response
            const response = buildDiscoveryResponse();
            server.send(response, rinfo.port, rinfo.address, (err) => {
                if (err) {
                    logger?.error('hdhr', `Failed to send discovery response: ${err.message}`);
                }
            });
        }
    });

    server.on('listening', () => {
        const addr = server.address();
        logger?.info('hdhr', `UDP discovery listening on ${addr.address}:${addr.port}`);

        // Enable broadcast
        try {
            server.setBroadcast(true);
        } catch (e) {
            logger?.warn('hdhr', 'Could not enable broadcast mode');
        }
    });

    // Bind to discovery port
    server.bind(65001, '0.0.0.0');

    return server;
}

// Build HDHomeRun discovery response packet
function buildDiscoveryResponse() {
    const deviceId = settings?.get('hdhrDeviceId') || generateDeviceId();
    const deviceIdNum = parseInt(deviceId, 16);

    // HDHomeRun discovery response format:
    // Type (2 bytes): 0x0003 (discover reply)
    // Length (2 bytes)
    // Tags...

    const baseUrl = getBaseUrl();
    const tunerCount = settings?.get('hdhrTunerCount') || 2;

    // Build tag data
    const tags = [];

    // Device ID tag (0x01)
    tags.push(Buffer.from([0x01, 0x04])); // tag + length
    const idBuf = Buffer.alloc(4);
    idBuf.writeUInt32BE(deviceIdNum & 0xFFFFFFFF, 0);
    tags.push(idBuf);

    // Device Type tag (0x02)
    tags.push(Buffer.from([0x02, 0x04]));
    tags.push(Buffer.from([0x00, 0x00, 0x00, 0x01])); // tuner type

    // Tuner Count tag (0x10)
    tags.push(Buffer.from([0x10, 0x01, tunerCount]));

    // Base URL tag (0x2A)
    const urlBytes = Buffer.from(baseUrl + '\0', 'utf8');
    tags.push(Buffer.from([0x2A, urlBytes.length]));
    tags.push(urlBytes);

    // Combine all tags
    const tagData = Buffer.concat(tags);

    // Build final packet
    const packet = Buffer.alloc(4 + tagData.length);
    packet.writeUInt16BE(0x0003, 0); // Reply type
    packet.writeUInt16BE(tagData.length, 2); // Length
    tagData.copy(packet, 4);

    return packet;
}

// ============== Public API Functions ==============

// Get all live channels available for HDHR (only from active sources)
async function getAvailableChannels(sourceId = null) {
    // Use provided sourceId or fall back to hdhrSourceId setting
    const filterSourceId = sourceId || settings.get('hdhrSourceId');

    const params = [];
    let sourceFilter = '';
    if (filterSourceId) {
        sourceFilter = 'AND m.source_id = ?';
        params.push(filterSourceId);
    }

    return await db.all(`
        SELECT
            m.id,
            m.title,
            m.category,
            m.poster,
            m.tvg_id,
            m.source_id,
            s.name as source_name,
            h.id as hdhr_id,
            h.guide_number,
            h.guide_name,
            h.enabled as hdhr_enabled
        FROM media m
        JOIN sources s ON m.source_id = s.id
        LEFT JOIN hdhr_channels h ON m.id = h.media_id
        WHERE m.media_type = 'live' AND m.is_active = 1 AND s.active = 1 ${sourceFilter}
        ORDER BY m.category, m.title
    `, params);
}

// Get enabled HDHR channels (only from active sources)
async function getEnabledChannels() {
    return await db.all(`
        SELECT
            h.id,
            h.guide_number,
            h.guide_name,
            h.enabled,
            m.id as media_id,
            m.title,
            m.category,
            m.poster,
            m.tvg_id
        FROM hdhr_channels h
        JOIN media m ON h.media_id = m.id
        JOIN sources s ON m.source_id = s.id
        WHERE h.enabled = 1 AND s.active = 1
        ORDER BY CAST(h.guide_number AS REAL)
    `);
}

// Clean category name by removing special characters
function cleanCategoryName(category) {
    if (!category) return category;
    // Remove common special characters and patterns used as prefixes/decorations
    return category
        // Remove pipe-wrapped codes at the beginning like |DE|, |MULTI|, |EN|, DE|, etc.
        .replace(/^\|?[A-Z0-9-]+\|\s*/gi, '')
        // Remove special unicode characters at the beginning
        .replace(/^[✪❖◉★☆●○◆◇▶►▸▹→⊛⊕⊗⊙⊚⋆✦✧✩✫✬✭✮✯✰✱✲✳✴✵✶✷✸✹✺✻✼✽✾✿❀❁❂❃❄❅❆❇❈❉❊❋\s]+/, '')
        // Remove any remaining special unicode characters elsewhere
        .replace(/[✪❖◉★☆●○◆◇▶►▸▹→⊛⊕⊗⊙⊚⋆✦✧✩✫✬✭✮✯✰✱✲✳✴✵✶✷✸✹✺✻✼✽✾✿❀❁❂❃❄❅❆❇❈❉❊❋]+/g, '')
        // Remove language codes at the beginning like "DE ", "EN ", "FR "
        .replace(/^(DE|EN|FR|ES|IT|PT|NL|RU|PL|TR|AR|HI|JA|KO|ZH|MULTI)\s+/i, '')
        .trim();
}

// Get categories with channel counts (only from active sources)
async function getCategories(sourceId = null) {
    // Use provided sourceId or fall back to hdhrSourceId setting
    const filterSourceId = sourceId || settings.get('hdhrSourceId');

    const params = [];
    let sourceFilter = '';
    if (filterSourceId) {
        sourceFilter = 'AND m.source_id = ?';
        params.push(filterSourceId);
    }

    const categories = await db.all(`
        SELECT
            m.category,
            COUNT(*) as channel_count,
            m.source_id
        FROM media m
        JOIN sources s ON m.source_id = s.id
        WHERE m.media_type = 'live' AND m.is_active = 1 AND m.category IS NOT NULL AND s.active = 1 ${sourceFilter}
        GROUP BY m.category, m.source_id
        ORDER BY m.category
    `, params);

    // Clean category names and sort alphabetically
    return categories
        .map(cat => ({
            ...cat,
            display_name: cleanCategoryName(cat.category)
        }))
        .sort((a, b) => a.display_name.localeCompare(b.display_name, undefined, { sensitivity: 'base' }));
}

// Add channel to HDHR lineup
async function addChannel(mediaId, guideNumber, guideName = null) {
    await db.run(`
        INSERT INTO hdhr_channels (media_id, guide_number, guide_name, enabled)
        VALUES (?, ?, ?, 1)
        ON CONFLICT(guide_number) DO UPDATE SET
            media_id = excluded.media_id,
            guide_name = excluded.guide_name,
            enabled = 1
    `, [mediaId, guideNumber, guideName]);
}

// Remove channel from HDHR lineup
async function removeChannel(hdhrId) {
    await db.run('DELETE FROM hdhr_channels WHERE id = ?', [hdhrId]);
}

// Toggle channel enabled status
async function toggleChannel(hdhrId, enabled) {
    await db.run('UPDATE hdhr_channels SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, hdhrId]);
}

// Add channels by category (only from active sources)
async function addChannelsByCategory(category, sourceId = null, startNumber = 1) {
    let query = `
        SELECT m.id, m.title FROM media m
        JOIN sources s ON m.source_id = s.id
        WHERE m.media_type = 'live' AND m.is_active = 1 AND m.category = ? AND s.active = 1
    `;
    const params = [category];

    if (sourceId) {
        query += ' AND m.source_id = ?';
        params.push(sourceId);
    }

    query += ' ORDER BY m.title';

    const channels = await db.all(query, params);
    let number = startNumber;

    for (const ch of channels) {
        // Check if already exists
        const existing = await db.get(
            'SELECT id FROM hdhr_channels WHERE media_id = ?',
            [ch.id]
        );

        if (!existing) {
            await addChannel(ch.id, String(number), ch.title);
            number++;
        }
    }

    return channels.length;
}

// Clear all HDHR channels
async function clearAllChannels() {
    await db.run('DELETE FROM hdhr_channels');
}

// Rebuild channel numbers (auto-assign sequential numbers)
async function rebuildLineup() {
    const channels = await db.all(`
        SELECT h.id, m.title
        FROM hdhr_channels h
        JOIN media m ON h.media_id = m.id
        WHERE h.enabled = 1
        ORDER BY h.sort_order, m.category, m.title
    `);

    let number = 1;
    for (const ch of channels) {
        await db.run(
            'UPDATE hdhr_channels SET guide_number = ? WHERE id = ?',
            [String(number), ch.id]
        );
        number++;
    }

    return channels.length;
}

// Get HDHR status
function getStatus() {
    const enabled = settings?.get('hdhrEnabled') || false;
    const port = settings?.get('hdhrPort') || 5004;

    return {
        enabled,
        running: httpServer !== null,
        port,
        baseUrl: getBaseUrl(),
        deviceId: settings?.get('hdhrDeviceId'),
        friendlyName: settings?.get('hdhrFriendlyName') || 'RecoStream HDHR',
        tunerCount: settings?.get('hdhrTunerCount') || 2,
        activeStreams: activeStreams.size,
        xmltvUrl: `${getBaseUrl()}/xmltv`
    };
}

// Start the HDHR servers
async function start() {
    if (httpServer) {
        logger?.warn('hdhr', 'HDHR already running');
        return;
    }

    const port = settings?.get('hdhrPort') || 5004;

    // Ensure device ID exists
    if (!settings?.get('hdhrDeviceId')) {
        const newId = generateDeviceId();
        settings?.set('hdhrDeviceId', newId);
        logger?.info('hdhr', `Generated new device ID: ${newId}`);
    }

    // Start HTTP server
    const app = createHttpServer();
    httpServer = http.createServer(app);

    await new Promise((resolve, reject) => {
        httpServer.listen(port, '0.0.0.0', () => {
            logger?.info('hdhr', `HDHomeRun HTTP server running on port ${port}`);
            resolve();
        });
        httpServer.on('error', reject);
    });

    // Start UDP discovery
    try {
        udpServer = startUdpDiscovery();
    } catch (err) {
        logger?.warn('hdhr', `Could not start UDP discovery: ${err.message}`);
    }

    logger?.info('hdhr', `HDHomeRun emulator started - ${getBaseUrl()}`);
}

// Stop the HDHR servers
async function stop() {
    if (httpServer) {
        await new Promise(resolve => httpServer.close(resolve));
        httpServer = null;
        logger?.info('hdhr', 'HTTP server stopped');
    }

    if (udpServer) {
        udpServer.close();
        udpServer = null;
        logger?.info('hdhr', 'UDP discovery stopped');
    }

    activeStreams.clear();
}

module.exports = {
    init: async (modules) => {
        db = modules.db;
        logger = modules.logger;
        settings = modules.settings;
        iptv = modules.iptv;
        epg = modules.epg;

        // Auto-start if enabled
        if (settings?.get('hdhrEnabled')) {
            try {
                await start();
            } catch (err) {
                logger?.error('hdhr', `Failed to start HDHomeRun emulator: ${err.message}`);
            }
        } else {
            logger?.info('hdhr', 'HDHomeRun emulator disabled');
        }
    },

    shutdown: async () => {
        await stop();
    },

    // Public API
    start,
    stop,
    getStatus,
    getAvailableChannels,
    getEnabledChannels,
    getCategories,
    addChannel,
    removeChannel,
    toggleChannel,
    addChannelsByCategory,
    clearAllChannels,
    rebuildLineup,
    getLineup,
    generateXmltv,
    cleanCategoryName
};
