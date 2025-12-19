/**
 * yEnc Decoder Module
 * Decodes yEnc-encoded binary data from usenet articles
 *
 * yEnc encoding:
 * - Escape character: '=' (0x3D)
 * - Characters 0x00-0x3D are encoded as (byte + 42) % 256
 * - Special chars (=, ., NL, CR, TAB) are escaped with = and then (byte + 64) % 256
 * - Line length is typically 128 characters
 */

const crc32 = require('buffer-crc32');

// yEnc constants
const YENC_ESCAPE = 0x3D; // '='
const YENC_OFFSET = 42;
const YENC_ESCAPE_OFFSET = 64;

// Characters that need escaping in yEnc
const ESCAPE_CHARS = new Set([0x00, 0x0A, 0x0D, 0x3D]); // NUL, LF, CR, =

/**
 * Decode yEnc data from a usenet article
 * @param {Buffer|string} data - Raw article data
 * @returns {Object} Decoded result with data, filename, part info, and CRC status
 */
function decode(data) {
    const input = Buffer.isBuffer(data) ? data : Buffer.from(data, 'binary');

    // Find yEnc header and footer
    const header = parseHeader(input);
    if (!header) {
        throw new Error('Invalid yEnc data: no =ybegin header found');
    }

    // Find data boundaries
    let dataStart = header.headerEnd;
    let dataEnd = input.length;

    // Check for =ypart header (multipart)
    const partInfo = parsePartHeader(input, dataStart);
    if (partInfo) {
        dataStart = partInfo.headerEnd;
    }

    // Find =yend footer
    const footer = parseFooter(input, dataStart);
    if (footer) {
        dataEnd = footer.footerStart;
    }

    // Decode the data
    const decoded = decodeData(input, dataStart, dataEnd);

    // Verify CRC if available
    let crcValid = null;
    if (footer && footer.crc32) {
        const calculatedCrc = crc32.unsigned(decoded);
        const expectedCrc = parseInt(footer.crc32, 16);
        crcValid = calculatedCrc === expectedCrc;
    }

    // Verify part CRC if available
    let partCrcValid = null;
    if (footer && footer.pcrc32) {
        const calculatedCrc = crc32.unsigned(decoded);
        const expectedCrc = parseInt(footer.pcrc32, 16);
        partCrcValid = calculatedCrc === expectedCrc;
    }

    return {
        data: decoded,
        filename: header.name,
        size: header.size,
        line: header.line,
        part: partInfo ? partInfo.part : null,
        begin: partInfo ? partInfo.begin : 1,
        end: partInfo ? partInfo.end : decoded.length,
        totalParts: header.total || 1,
        crcValid: crcValid ?? partCrcValid,
        expectedSize: footer ? footer.size : header.size
    };
}

/**
 * Parse =ybegin header
 */
function parseHeader(data) {
    // Find =ybegin line
    const headerMatch = findLine(data, '=ybegin');
    if (!headerMatch) return null;

    const headerLine = headerMatch.line;
    const result = {
        headerEnd: headerMatch.lineEnd
    };

    // Parse parameters
    const lineMatch = headerLine.match(/line=(\d+)/);
    if (lineMatch) result.line = parseInt(lineMatch[1], 10);

    const sizeMatch = headerLine.match(/size=(\d+)/);
    if (sizeMatch) result.size = parseInt(sizeMatch[1], 10);

    const totalMatch = headerLine.match(/total=(\d+)/);
    if (totalMatch) result.total = parseInt(totalMatch[1], 10);

    const partMatch = headerLine.match(/part=(\d+)/);
    if (partMatch) result.part = parseInt(partMatch[1], 10);

    // Name is at the end after name=
    const nameMatch = headerLine.match(/name=(.+)$/);
    if (nameMatch) result.name = nameMatch[1].trim();

    return result;
}

/**
 * Parse =ypart header (for multipart files)
 */
function parsePartHeader(data, startPos) {
    const partMatch = findLine(data, '=ypart', startPos);
    if (!partMatch) return null;

    const partLine = partMatch.line;
    const result = {
        headerEnd: partMatch.lineEnd
    };

    const beginMatch = partLine.match(/begin=(\d+)/);
    if (beginMatch) result.begin = parseInt(beginMatch[1], 10);

    const endMatch = partLine.match(/end=(\d+)/);
    if (endMatch) result.end = parseInt(endMatch[1], 10);

    return result;
}

/**
 * Parse =yend footer
 */
function parseFooter(data, startPos) {
    const footerMatch = findLine(data, '=yend', startPos);
    if (!footerMatch) return null;

    const footerLine = footerMatch.line;
    const result = {
        footerStart: footerMatch.lineStart
    };

    const sizeMatch = footerLine.match(/size=(\d+)/);
    if (sizeMatch) result.size = parseInt(sizeMatch[1], 10);

    const partMatch = footerLine.match(/part=(\d+)/);
    if (partMatch) result.part = parseInt(partMatch[1], 10);

    // CRC32 for full file
    const crcMatch = footerLine.match(/crc32=([0-9a-fA-F]+)/);
    if (crcMatch) result.crc32 = crcMatch[1];

    // Part CRC32
    const pcrcMatch = footerLine.match(/pcrc32=([0-9a-fA-F]+)/);
    if (pcrcMatch) result.pcrc32 = pcrcMatch[1];

    return result;
}

/**
 * Find a line starting with a specific prefix
 */
function findLine(data, prefix, startPos = 0) {
    const prefixBytes = Buffer.from(prefix);
    let lineStart = startPos;

    while (lineStart < data.length) {
        // Check if this position matches prefix
        let matches = true;
        for (let i = 0; i < prefixBytes.length; i++) {
            if (data[lineStart + i] !== prefixBytes[i]) {
                matches = false;
                break;
            }
        }

        if (matches) {
            // Find end of line
            let lineEnd = lineStart;
            while (lineEnd < data.length && data[lineEnd] !== 0x0A) {
                lineEnd++;
            }
            lineEnd++; // Include the newline

            return {
                lineStart,
                lineEnd,
                line: data.slice(lineStart, lineEnd).toString('binary').trim()
            };
        }

        // Move to next line
        while (lineStart < data.length && data[lineStart] !== 0x0A) {
            lineStart++;
        }
        lineStart++; // Skip the newline
    }

    return null;
}

/**
 * Decode yEnc-encoded data
 */
function decodeData(data, start, end) {
    const output = [];
    let i = start;

    while (i < end) {
        const byte = data[i];

        // Skip line endings
        if (byte === 0x0A || byte === 0x0D) {
            i++;
            continue;
        }

        // Handle escape sequence
        if (byte === YENC_ESCAPE) {
            i++;
            if (i >= end) break;

            // Skip if it's a yEnc keyword line
            const nextByte = data[i];
            if (nextByte === 0x79) { // 'y' - could be =ybegin, =ypart, =yend
                // Skip to end of line
                while (i < end && data[i] !== 0x0A) {
                    i++;
                }
                i++;
                continue;
            }

            // Decode escaped byte
            output.push((nextByte - YENC_ESCAPE_OFFSET - YENC_OFFSET + 256) % 256);
            i++;
            continue;
        }

        // Decode normal byte
        output.push((byte - YENC_OFFSET + 256) % 256);
        i++;
    }

    return Buffer.from(output);
}

/**
 * Encode data to yEnc format (for testing/debugging)
 * @param {Buffer} data - Binary data to encode
 * @param {string} filename - Filename for header
 * @param {number} lineLength - Max line length (default 128)
 * @returns {Buffer} yEnc encoded data
 */
function encode(data, filename, lineLength = 128) {
    const lines = [];

    // Add header
    lines.push(`=ybegin line=${lineLength} size=${data.length} name=${filename}`);

    // Encode data
    let line = '';
    for (let i = 0; i < data.length; i++) {
        const byte = data[i];
        const encoded = (byte + YENC_OFFSET) % 256;

        // Check if needs escaping
        if (ESCAPE_CHARS.has(encoded) || encoded === YENC_ESCAPE) {
            line += '=' + String.fromCharCode((encoded + YENC_ESCAPE_OFFSET) % 256);
        } else {
            line += String.fromCharCode(encoded);
        }

        // Check line length
        if (line.length >= lineLength) {
            lines.push(line);
            line = '';
        }
    }

    // Add remaining data
    if (line.length > 0) {
        lines.push(line);
    }

    // Add footer
    const checksum = crc32.unsigned(data).toString(16).padStart(8, '0');
    lines.push(`=yend size=${data.length} crc32=${checksum}`);

    return Buffer.from(lines.join('\r\n'), 'binary');
}

/**
 * Verify CRC32 of decoded data
 */
function verifyCrc(data, expectedCrc) {
    const calculated = crc32.unsigned(data);
    const expected = typeof expectedCrc === 'string' ? parseInt(expectedCrc, 16) : expectedCrc;
    return calculated === expected;
}

module.exports = {
    decode,
    encode,
    verifyCrc
};
