/**
 * NZB Parser Module
 * Parses NZB XML files into a downloadable structure
 */

const { XMLParser } = require('fast-xml-parser');

// XML parser instance
const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    allowBooleanAttributes: true
});

/**
 * Parse NZB XML content into structured data
 * @param {string} nzbContent - NZB XML content
 * @returns {Object} Parsed NZB data
 */
function parse(nzbContent) {
    const result = xmlParser.parse(nzbContent);

    if (!result.nzb) {
        throw new Error('Invalid NZB file: missing <nzb> root element');
    }

    const nzb = result.nzb;

    // Parse metadata
    const metadata = {};
    if (nzb.head?.meta) {
        const metas = Array.isArray(nzb.head.meta) ? nzb.head.meta : [nzb.head.meta];
        for (const meta of metas) {
            if (meta && meta['@_type']) {
                metadata[meta['@_type']] = meta['#text'] || '';
            }
        }
    }

    // Parse files
    const files = [];
    const rawFiles = nzb.file ? (Array.isArray(nzb.file) ? nzb.file : [nzb.file]) : [];

    for (let fileIndex = 0; fileIndex < rawFiles.length; fileIndex++) {
        const file = rawFiles[fileIndex];
        const fileData = parseFile(file, fileIndex);
        if (fileData) {
            files.push(fileData);
        }
    }

    // Sort files by subject (typically includes file number)
    files.sort((a, b) => a.subject.localeCompare(b.subject));

    // Calculate totals
    let totalSize = 0;
    let totalSegments = 0;
    for (const file of files) {
        totalSize += file.size;
        totalSegments += file.segments.length;
    }

    return {
        metadata,
        files,
        totalFiles: files.length,
        totalSegments,
        totalSize
    };
}

/**
 * Parse a single file element from NZB
 */
function parseFile(file, fileIndex) {
    if (!file) return null;

    const subject = file['@_subject'] || '';
    const poster = file['@_poster'] || '';
    const date = file['@_date'] ? parseInt(file['@_date'], 10) : 0;

    // Parse groups
    const groups = [];
    if (file.groups?.group) {
        const rawGroups = Array.isArray(file.groups.group) ? file.groups.group : [file.groups.group];
        for (const group of rawGroups) {
            if (group) {
                groups.push(typeof group === 'string' ? group : group['#text'] || '');
            }
        }
    }

    // Parse segments
    const segments = [];
    let fileSize = 0;

    if (file.segments?.segment) {
        const rawSegments = Array.isArray(file.segments.segment) ? file.segments.segment : [file.segments.segment];

        for (let i = 0; i < rawSegments.length; i++) {
            const seg = rawSegments[i];
            if (!seg) continue;

            const segmentNumber = seg['@_number'] ? parseInt(seg['@_number'], 10) : i + 1;
            const segmentBytes = seg['@_bytes'] ? parseInt(seg['@_bytes'], 10) : 0;
            const messageId = typeof seg === 'string' ? seg : (seg['#text'] || '');

            if (messageId) {
                segments.push({
                    number: segmentNumber,
                    bytes: segmentBytes,
                    messageId: messageId.trim()
                });
                fileSize += segmentBytes;
            }
        }
    }

    // Sort segments by number
    segments.sort((a, b) => a.number - b.number);

    // Extract filename from subject
    const filename = extractFilename(subject) || `file_${fileIndex + 1}`;

    return {
        index: fileIndex,
        subject,
        poster,
        date: date ? new Date(date * 1000) : null,
        groups,
        filename,
        segments,
        size: fileSize,
        isPar2: filename.toLowerCase().endsWith('.par2'),
        isRar: /\.(rar|r\d{2})$/i.test(filename),
        isArchive: /\.(rar|r\d{2}|zip|7z)$/i.test(filename)
    };
}

/**
 * Extract filename from subject line
 * Common patterns:
 * - "Some.Release.Name.mkv" yEnc (1/100)
 * - [123/456] - "filename.ext" yEnc (1/100)
 * - "filename.ext" (1/100)
 */
function extractFilename(subject) {
    // Try to extract filename in quotes
    const quotedMatch = subject.match(/"([^"]+)"/);
    if (quotedMatch) {
        return quotedMatch[1];
    }

    // Try to extract from common patterns
    const patterns = [
        /\[[\d\/]+\]\s*-\s*"?([^"]+)"?\s*yEnc/i,
        /([^\s"]+\.[a-z0-9]{2,4})\s*yEnc/i,
        /([^\s"]+\.[a-z0-9]{2,4})\s*\(\d+\/\d+\)/i
    ];

    for (const pattern of patterns) {
        const match = subject.match(pattern);
        if (match) {
            return match[1].trim();
        }
    }

    return null;
}

/**
 * Get files grouped by type
 */
function groupFilesByType(parsedNzb) {
    const result = {
        main: [],      // Main content files (video, etc.)
        par2: [],      // PAR2 repair files
        archives: [],  // RAR/ZIP archives
        other: []      // Other files
    };

    for (const file of parsedNzb.files) {
        if (file.isPar2) {
            result.par2.push(file);
        } else if (file.isArchive) {
            result.archives.push(file);
        } else if (/\.(mkv|avi|mp4|m4v|wmv|mov|mpg|mpeg|ts|iso|nfo)$/i.test(file.filename)) {
            result.main.push(file);
        } else {
            result.other.push(file);
        }
    }

    return result;
}

/**
 * Calculate download priority for files
 * Returns files in recommended download order
 */
function getPriorityOrder(parsedNzb) {
    const grouped = groupFilesByType(parsedNzb);

    // Download order: archives first (to start extraction early), then main files, then PAR2 if needed
    return [
        ...grouped.archives,
        ...grouped.main,
        ...grouped.other,
        ...grouped.par2
    ];
}

/**
 * Get PAR2 files only (for repair)
 */
function getPar2Files(parsedNzb) {
    return parsedNzb.files.filter(f => f.isPar2);
}

/**
 * Estimate download time based on connection speed
 * @param {Object} parsedNzb - Parsed NZB data
 * @param {number} speedBytesPerSec - Download speed in bytes/sec
 * @returns {number} Estimated time in seconds
 */
function estimateDownloadTime(parsedNzb, speedBytesPerSec) {
    if (!speedBytesPerSec || speedBytesPerSec <= 0) return 0;
    return Math.ceil(parsedNzb.totalSize / speedBytesPerSec);
}

module.exports = {
    parse,
    groupFilesByType,
    getPriorityOrder,
    getPar2Files,
    estimateDownloadTime
};
