const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

let logger = null;
let db = null;
let app = null;
let settings = null;
let plex = null;

let activeJob = null;
let isProcessing = false;
let transcodeInterval = null;
let watchInterval = null;
let hwAccelCache = null;

// Supported video extensions for watch folder
const VIDEO_EXTENSIONS = ['.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.ts', '.mp4'];

/**
 * Convert SMB URL to mounted filesystem path
 * smb://hostname/sharename/path -> /Volumes/sharename/path (macOS)
 */
function smbToLocalPath(smbUrl) {
    if (!smbUrl || !smbUrl.startsWith('smb://')) {
        return smbUrl; // Not an SMB URL, return as-is
    }

    // Parse: smb://hostname/sharename/rest/of/path
    const match = smbUrl.match(/^smb:\/\/[^/]+\/([^/]+)(.*)$/);
    if (!match) {
        logger?.warn('transcoder', `Could not parse SMB URL: ${smbUrl}`);
        return smbUrl;
    }

    const shareName = match[1];
    const restOfPath = match[2] || '';

    // On macOS, SMB shares are mounted under /Volumes/
    const localPath = path.join('/Volumes', shareName, restOfPath);

    logger?.debug('transcoder', `Converted SMB path: ${smbUrl} -> ${localPath}`);
    return localPath;
}

/**
 * Find ffmpeg binary
 */
async function findFfmpeg() {
    const paths = [
        'ffmpeg',
        '/usr/bin/ffmpeg',
        '/usr/local/bin/ffmpeg',
        '/opt/homebrew/bin/ffmpeg',
        'C:\\ffmpeg\\bin\\ffmpeg.exe'
    ];

    for (const ffmpegPath of paths) {
        try {
            execSync(`"${ffmpegPath}" -version`, { stdio: 'ignore' });
            return ffmpegPath;
        } catch (err) {
            // Not found at this path
        }
    }
    return null;
}

/**
 * Find ffprobe binary
 */
async function findFfprobe() {
    const paths = [
        'ffprobe',
        '/usr/bin/ffprobe',
        '/usr/local/bin/ffprobe',
        '/opt/homebrew/bin/ffprobe',
        'C:\\ffmpeg\\bin\\ffprobe.exe'
    ];

    for (const ffprobePath of paths) {
        try {
            execSync(`"${ffprobePath}" -version`, { stdio: 'ignore' });
            return ffprobePath;
        } catch (err) {
            // Not found at this path
        }
    }
    return null;
}

/**
 * Detect available hardware acceleration
 */
async function detectHardwareAcceleration() {
    if (hwAccelCache) return hwAccelCache;

    const ffmpegPath = await findFfmpeg();
    if (!ffmpegPath) {
        hwAccelCache = { type: 'unavailable', encoders: {} };
        return hwAccelCache;
    }

    const platform = process.platform;
    const result = { type: 'software', encoders: {} };

    try {
        const encoderOutput = execSync(`"${ffmpegPath}" -encoders 2>&1`, { encoding: 'utf8' });

        if (platform === 'darwin') {
            // Apple Silicon / macOS - VideoToolbox
            if (encoderOutput.includes('h264_videotoolbox')) {
                result.type = 'videotoolbox';
                result.encoders.h264 = 'h264_videotoolbox';
            }
            if (encoderOutput.includes('hevc_videotoolbox')) {
                result.encoders.hevc = 'hevc_videotoolbox';
            }
        } else if (platform === 'win32') {
            // Windows - NVENC first, then AMF
            if (encoderOutput.includes('h264_nvenc')) {
                result.type = 'nvenc';
                result.encoders.h264 = 'h264_nvenc';
                result.encoders.hevc = encoderOutput.includes('hevc_nvenc') ? 'hevc_nvenc' : null;
            } else if (encoderOutput.includes('h264_amf')) {
                result.type = 'amf';
                result.encoders.h264 = 'h264_amf';
                result.encoders.hevc = encoderOutput.includes('hevc_amf') ? 'hevc_amf' : null;
            }
        } else if (platform === 'linux') {
            // Linux - Check for actual hardware, not just encoder support
            // NVENC requires NVIDIA GPU with CUDA - check if nvidia device exists
            const hasNvidia = fs.existsSync('/dev/nvidia0') || fs.existsSync('/dev/nvidiactl');
            // VAAPI requires Intel/AMD GPU - check if render device exists
            const hasVaapi = fs.existsSync('/dev/dri/renderD128');

            if (hasNvidia && encoderOutput.includes('h264_nvenc')) {
                result.type = 'nvenc';
                result.encoders.h264 = 'h264_nvenc';
                result.encoders.hevc = encoderOutput.includes('hevc_nvenc') ? 'hevc_nvenc' : null;
            } else if (hasVaapi && encoderOutput.includes('h264_vaapi')) {
                result.type = 'vaapi';
                result.encoders.h264 = 'h264_vaapi';
                result.encoders.hevc = encoderOutput.includes('hevc_vaapi') ? 'hevc_vaapi' : null;
            }
        }

        // Software fallback
        if (!result.encoders.h264) {
            result.encoders.h264 = 'libx264';
            result.encoders.hevc = 'libx265';
        }
    } catch (err) {
        logger?.warn('transcoder', `HW detection failed: ${err.message}`);
        result.encoders.h264 = 'libx264';
        result.encoders.hevc = 'libx265';
    }

    hwAccelCache = result;
    logger?.info('transcoder', `Detected hardware acceleration: ${result.type}`, result.encoders);
    return result;
}

/**
 * Get video duration using ffprobe
 */
async function getVideoDuration(filePath) {
    const ffprobePath = await findFfprobe();
    if (!ffprobePath) return 0;

    try {
        const result = execSync(
            `"${ffprobePath}" -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`,
            { encoding: 'utf8', timeout: 30000 }
        );
        return parseFloat(result.trim()) || 0;
    } catch (err) {
        logger?.warn('transcoder', `Could not get duration: ${err.message}`);
        return 0;
    }
}

/**
 * Check if file is already in compatible format (H.264/H.265 in MP4)
 */
async function isCompatibleFormat(filePath) {
    const ffprobePath = await findFfprobe();
    if (!ffprobePath) return false;

    try {
        const result = execSync(
            `"${ffprobePath}" -v quiet -select_streams v:0 -show_entries stream=codec_name -of json "${filePath}"`,
            { encoding: 'utf8', timeout: 30000 }
        );
        const data = JSON.parse(result);
        const codec = data.streams?.[0]?.codec_name?.toLowerCase();
        const container = path.extname(filePath).toLowerCase();

        const isH264orH265 = ['h264', 'avc', 'hevc', 'h265'].includes(codec);
        const isMp4Container = ['.mp4', '.m4v'].includes(container);

        logger?.debug('transcoder', `Format check: codec=${codec}, container=${container}, compatible=${isH264orH265 && isMp4Container}`);
        return isH264orH265 && isMp4Container;
    } catch (err) {
        logger?.warn('transcoder', `Format check failed: ${err.message}`);
        return false; // Can't determine, transcode to be safe
    }
}

/**
 * Build FFmpeg arguments for transcoding
 */
function buildFfmpegArgs(inputPath, outputPath, hwAccel, codec) {
    const args = ['-y']; // Overwrite output

    // Hardware-specific input decoding
    switch (hwAccel.type) {
        case 'videotoolbox':
            args.push('-hwaccel', 'videotoolbox');
            break;
        case 'nvenc':
            args.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda');
            break;
        case 'vaapi':
            // Use VAAPI hardware decoding AND encoding for full GPU acceleration
            args.push('-hwaccel', 'vaapi');
            args.push('-hwaccel_device', '/dev/dri/renderD128');
            args.push('-hwaccel_output_format', 'vaapi');
            break;
        case 'amf':
            // AMF uses DirectX for decoding on Windows
            break;
    }

    args.push('-i', inputPath);

    // Select encoder
    const encoder = codec === 'hevc'
        ? (hwAccel.encoders.hevc || 'libx265')
        : (hwAccel.encoders.h264 || 'libx264');

    args.push('-c:v', encoder);

    // Quality settings (CRF 18-20 equivalent for high quality)
    if (encoder.includes('videotoolbox')) {
        args.push('-q:v', '65', '-profile:v', codec === 'hevc' ? 'main' : 'high');
    } else if (encoder.includes('nvenc')) {
        args.push('-preset', 'p4', '-cq', '19', '-profile:v', codec === 'hevc' ? 'main' : 'high');
    } else if (encoder.includes('amf')) {
        args.push('-quality', 'quality', '-rc', 'cqp', '-qp_i', '19', '-qp_p', '19');
    } else if (encoder.includes('vaapi')) {
        // With hwaccel_output_format=vaapi, frames are already on GPU - use scale_vaapi for format conversion
        args.push('-vf', 'scale_vaapi=format=nv12');
        args.push('-qp', '19', '-profile:v', codec === 'hevc' ? 'main' : 'high');
    } else {
        // libx264/libx265 software encoding
        args.push('-preset', 'medium', '-crf', '18');
        if (encoder === 'libx264') {
            args.push('-profile:v', 'high');
        }
    }

    // Audio: AAC for broad compatibility
    args.push('-c:a', 'aac', '-b:a', '192k');

    // Copy all audio streams
    args.push('-map', '0:v:0', '-map', '0:a?');

    // Skip subtitles - mov_text often fails with bitmap subtitles
    // Users can extract subtitles separately if needed

    // MP4 optimizations
    args.push('-movflags', '+faststart', '-f', 'mp4');

    args.push(outputPath);
    return args;
}

/**
 * Queue a file for transcoding (from download)
 */
async function queue(downloadId, inputPath, finalDir, filename, mediaType) {
    // Change extension to .mp4
    const mp4Filename = filename.replace(/\.[^.]+$/, '.mp4');

    await db.run(`
        INSERT INTO transcode_queue (download_id, input_path, final_dir, filename, media_type, source, status)
        VALUES (?, ?, ?, ?, ?, 'download', 'pending')
    `, [downloadId, inputPath, finalDir, mp4Filename, mediaType]);

    logger?.info('transcoder', `Queued for transcoding: ${filename}`);

    // Trigger queue processing
    processQueue();
}

/**
 * Scan watch folder for new video files
 */
async function scanWatchFolder() {
    if (!settings?.get('transcodeWatchEnabled')) return;

    const watchFolder = settings.get('transcodeWatchFolder');
    const outputFolder = settings.get('transcodeOutputFolder');

    if (!watchFolder || !outputFolder) return;

    // Ensure folders exist
    if (!fs.existsSync(watchFolder)) {
        fs.mkdirSync(watchFolder, { recursive: true });
        logger?.info('transcoder', `Created watch folder: ${watchFolder}`);
    }
    if (!fs.existsSync(outputFolder)) {
        fs.mkdirSync(outputFolder, { recursive: true });
        logger?.info('transcoder', `Created output folder: ${outputFolder}`);
    }

    try {
        const files = fs.readdirSync(watchFolder);

        for (const file of files) {
            const ext = path.extname(file).toLowerCase();
            if (!VIDEO_EXTENSIONS.includes(ext)) continue;

            const filePath = path.join(watchFolder, file);

            // Skip if not a file
            const stat = fs.statSync(filePath);
            if (!stat.isFile()) continue;

            // Skip files that are still being written (modified in last 10 seconds)
            const mtime = stat.mtimeMs;
            if (Date.now() - mtime < 10000) continue;

            // Check if already queued, processing, completed, or recently failed
            const existing = await db.get(
                'SELECT id, status, created_at FROM transcode_queue WHERE input_path = ? ORDER BY created_at DESC LIMIT 1',
                [filePath]
            );
            if (existing) {
                // Skip if pending, transcoding, completed, or skipped
                if (['pending', 'transcoding', 'completed', 'skipped'].includes(existing.status)) {
                    continue;
                }
                // For failed jobs, don't retry automatically - user must retry manually
                if (existing.status === 'failed') {
                    continue;
                }
            }

            // Queue the file
            await queueWatchFile(filePath, outputFolder, file);
        }
    } catch (err) {
        logger?.error('transcoder', `Watch folder scan error: ${err.message}`);
    }
}

/**
 * Parse filename to detect if it's a series or movie
 * Returns { type: 'series'|'movie', showName?: string, season?: number, episode?: number }
 */
function parseFilename(filename) {
    // Remove extension
    const name = filename.replace(/\.[^.]+$/, '');

    // Common series patterns:
    // Show.Name.S01E01, Show Name - S01E01, Show.Name.1x01, Show_Name_S1E1
    const seriesPatterns = [
        // S01E01 format (most common)
        /^(.+?)[.\s_-]+S(\d{1,2})E(\d{1,2})/i,
        // 1x01 format
        /^(.+?)[.\s_-]+(\d{1,2})x(\d{1,2})/i,
        // Season 1 Episode 1 format
        /^(.+?)[.\s_-]+Season[.\s_-]*(\d{1,2})[.\s_-]*Episode[.\s_-]*(\d{1,2})/i,
        // S01.E01 format (with dot between)
        /^(.+?)[.\s_-]+S(\d{1,2})[.\s_-]*E(\d{1,2})/i,
    ];

    for (const pattern of seriesPatterns) {
        const match = name.match(pattern);
        if (match) {
            // Clean up show name: replace dots/underscores with spaces, trim
            let showName = match[1]
                .replace(/[._]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            // Strip language prefixes like "DE -", "EN -", "FR -", etc.
            showName = showName.replace(/^[A-Z]{2}\s*-\s*/i, '');

            return {
                type: 'series',
                showName,
                season: parseInt(match[2]),
                episode: parseInt(match[3])
            };
        }
    }

    // No series pattern found - assume it's a movie
    return { type: 'movie' };
}

/**
 * Sanitize filename for filesystem
 */
function sanitizeFilename(name) {
    return name
        .replace(/[<>:"/\\|?*]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Join paths while preserving URL schemes (smb://, file://, etc.)
 * path.join() normalizes consecutive slashes which breaks URL schemes
 */
function joinPath(basePath, ...segments) {
    // Check if basePath is a URL (has ://)
    const urlMatch = basePath.match(/^(\w+:\/\/)/);
    if (urlMatch) {
        // Preserve the scheme, join the rest
        const scheme = urlMatch[1];
        const rest = basePath.slice(scheme.length);
        const joined = path.join(rest, ...segments);
        return scheme + joined;
    }
    // Regular path, use normal join
    return path.join(basePath, ...segments);
}

/**
 * Queue a file from watch folder
 */
async function queueWatchFile(inputPath, outputFolder, filename) {
    const mp4Filename = filename.replace(/\.[^.]+$/, '.mp4');

    // Parse filename to determine type and destination
    const parsed = parseFilename(filename);
    let finalDir = outputFolder;
    let mediaType = null;

    if (parsed.type === 'series' && parsed.showName) {
        // Series: put in seriesDownloadPath/{showName}/
        const seriesPath = settings.get('seriesDownloadPath');
        if (seriesPath) {
            // Use joinPath helper to avoid path.join mangling SMB URLs
            finalDir = joinPath(seriesPath, sanitizeFilename(parsed.showName));
            mediaType = 'series';
            logger?.info('transcoder', `Detected series: "${parsed.showName}" S${parsed.season}E${parsed.episode}`);
        }
    } else {
        // Movie: put in movieDownloadPath/
        const moviePath = settings.get('movieDownloadPath');
        if (moviePath) {
            finalDir = moviePath;
            mediaType = 'movie';
            logger?.info('transcoder', `Detected movie: ${filename}`);
        }
    }

    await db.run(`
        INSERT INTO transcode_queue (download_id, input_path, final_dir, filename, media_type, source, status)
        VALUES (NULL, ?, ?, ?, ?, 'watch', 'pending')
    `, [inputPath, finalDir, mp4Filename, mediaType]);

    logger?.info('transcoder', `Queued from watch folder: ${filename} -> ${finalDir}`);
    app?.emit('transcode:queued', { filename, source: 'watch', mediaType, finalDir });

    // Trigger queue processing
    processQueue();
}

/**
 * Process the transcode queue
 */
async function processQueue() {
    if (isProcessing || !settings?.get('transcodeFilesEnabled')) return;

    const job = await db.get(`
        SELECT * FROM transcode_queue
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
    `);

    if (!job) return;

    isProcessing = true;
    activeJob = job;

    try {
        // Check if we should skip compatible files
        if (settings.get('transcodeSkipCompatible')) {
            const isCompatible = await isCompatibleFormat(job.input_path);
            if (isCompatible) {
                logger?.info('transcoder', `Skipping already compatible file: ${job.filename}`);
                await skipJob(job);
                isProcessing = false;
                activeJob = null;
                processQueue(); // Process next
                return;
            }
        }

        // Get video duration for progress calculation
        const duration = await getVideoDuration(job.input_path);
        await db.run('UPDATE transcode_queue SET duration = ? WHERE id = ?', [duration, job.id]);
        job.duration = duration;

        await transcodeFile(job);

    } catch (err) {
        logger?.error('transcoder', `Transcode failed: ${err.message}`);
        await failJob(job, err.message);
    }

    isProcessing = false;
    activeJob = null;

    // Process next in queue
    setTimeout(processQueue, 1000);
}

/**
 * Skip a job (already compatible)
 */
async function skipJob(job) {
    // Convert SMB URLs to local mounted paths
    const localFinalDir = smbToLocalPath(job.final_dir);

    // Move file directly to final destination
    const finalPath = joinPath(localFinalDir, job.filename.replace(/\.mp4$/, path.extname(job.input_path)));

    if (!fs.existsSync(localFinalDir)) {
        fs.mkdirSync(localFinalDir, { recursive: true });
    }

    try {
        fs.renameSync(job.input_path, finalPath);
    } catch (renameErr) {
        if (renameErr.code === 'EXDEV') {
            fs.copyFileSync(job.input_path, finalPath);
            fs.unlinkSync(job.input_path);
        } else {
            throw renameErr;
        }
    }

    // Update transcode queue
    await db.run(`
        UPDATE transcode_queue SET status = 'skipped', completed_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `, [job.id]);

    // Handle based on source type
    if (job.source === 'watch' || !job.download_id) {
        // Watch folder job - just emit event
        app?.emit('transcode:skipped', { id: job.id, filename: job.filename, source: 'watch', path: finalPath });
        logger?.info('transcoder', `Skipped (already compatible): ${job.filename} -> ${finalPath}`);
    } else {
        // Download job - update download status
        await db.run(`
            UPDATE downloads SET status = 'completed', final_path = ?, completed_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [finalPath, job.download_id]);

        const download = await db.get('SELECT * FROM downloads WHERE id = ?', [job.download_id]);
        app?.emit('transcode:skipped', { id: job.id, downloadId: job.download_id, title: download?.title });
        app?.emit('download:complete', { id: job.download_id, title: download?.title, path: finalPath });

        // Trigger Plex scan
        await triggerPlexScan(job, finalPath);
    }
}

/**
 * Transcode the file
 */
async function transcodeFile(job) {
    const ffmpegPath = await findFfmpeg();
    if (!ffmpegPath) {
        throw new Error('FFmpeg not found');
    }

    // Determine hardware acceleration
    let hwAccel;
    const hwSetting = settings.get('transcodeHwAccel');
    if (hwSetting === 'auto') {
        hwAccel = await detectHardwareAcceleration();
    } else if (hwSetting === 'software') {
        hwAccel = { type: 'software', encoders: { h264: 'libx264', hevc: 'libx265' } };
    } else if (hwSetting === 'vaapi') {
        // Force VAAPI (Intel QSV)
        hwAccel = { type: 'vaapi', encoders: { h264: 'h264_vaapi', hevc: 'hevc_vaapi' } };
    } else if (hwSetting === 'nvenc') {
        // Force NVENC (NVIDIA)
        hwAccel = { type: 'nvenc', encoders: { h264: 'h264_nvenc', hevc: 'hevc_nvenc' } };
    } else if (hwSetting === 'videotoolbox') {
        // Force VideoToolbox (macOS)
        hwAccel = { type: 'videotoolbox', encoders: { h264: 'h264_videotoolbox', hevc: 'hevc_videotoolbox' } };
    } else if (hwSetting === 'amf') {
        // Force AMF (AMD)
        hwAccel = { type: 'amf', encoders: { h264: 'h264_amf', hevc: 'hevc_amf' } };
    } else {
        // Unknown setting, fall back to detection
        hwAccel = await detectHardwareAcceleration();
    }

    const codec = settings.get('transcodeCodec') || 'h264';
    const outputPath = job.input_path.replace(/\.[^.]+$/, '_transcoded.mp4');
    const args = buildFfmpegArgs(job.input_path, outputPath, hwAccel, codec);

    logger?.info('transcoder', `Starting transcode: ${job.filename}`, { hwAccel: hwAccel.type, codec });

    // Update status
    await db.run(`
        UPDATE transcode_queue SET status = 'transcoding', started_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `, [job.id]);

    // Get download info
    const download = await db.get('SELECT * FROM downloads WHERE id = ?', [job.download_id]);

    app?.emit('transcode:start', {
        id: job.id,
        downloadId: job.download_id,
        title: download?.title,
        hwAccel: hwAccel.type
    });

    return new Promise((resolve, reject) => {
        const ffmpeg = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        activeJob.process = ffmpeg;

        let lastProgress = 0;
        let stderrBuffer = '';

        ffmpeg.stderr.on('data', async (data) => {
            const output = data.toString();
            stderrBuffer += output;
            // Keep only last 4KB of stderr for error reporting
            if (stderrBuffer.length > 4096) {
                stderrBuffer = stderrBuffer.slice(-4096);
            }
            logger?.debug('transcoder', output.trim());

            // Parse progress from FFmpeg output
            const timeMatch = output.match(/time=(\d{2}):(\d{2}):(\d{2})\.\d+/);
            if (timeMatch && job.duration > 0) {
                const currentTime = parseInt(timeMatch[1]) * 3600 +
                    parseInt(timeMatch[2]) * 60 +
                    parseInt(timeMatch[3]);
                const progress = Math.min(99, Math.round((currentTime / job.duration) * 100));

                if (progress > lastProgress) {
                    lastProgress = progress;
                    await db.run('UPDATE transcode_queue SET progress = ? WHERE id = ?', [progress, job.id]);
                    app?.emit('transcode:progress', {
                        id: job.id,
                        downloadId: job.download_id,
                        progress,
                        title: download?.title
                    });
                }
            }
        });

        ffmpeg.on('close', async (code) => {
            if (code === 0) {
                // Success - move to final destination
                try {
                    await completeJob(job, outputPath);
                    resolve();
                } catch (err) {
                    reject(err);
                }
            } else if (code === 255) {
                // Killed - likely by user
                reject(new Error('Transcoding cancelled'));
            } else {
                // Extract last error lines from stderr
                const errorLines = stderrBuffer.split('\n').filter(l => l.trim()).slice(-5).join(' | ');
                logger?.error('transcoder', `FFmpeg stderr: ${errorLines}`);
                reject(new Error(`FFmpeg exited with code ${code}: ${errorLines.substring(0, 200)}`));
            }
        });

        ffmpeg.on('error', (err) => {
            reject(err);
        });
    });
}

/**
 * Complete a transcoding job
 */
async function completeJob(job, transcodedPath) {
    // Convert SMB URLs to local mounted paths
    const localFinalDir = smbToLocalPath(job.final_dir);
    const finalPath = joinPath(localFinalDir, job.filename);

    if (!fs.existsSync(localFinalDir)) {
        fs.mkdirSync(localFinalDir, { recursive: true });
    }

    // Move transcoded file to final destination
    try {
        fs.renameSync(transcodedPath, finalPath);
    } catch (renameErr) {
        if (renameErr.code === 'EXDEV') {
            fs.copyFileSync(transcodedPath, finalPath);
            fs.unlinkSync(transcodedPath);
        } else {
            throw renameErr;
        }
    }

    // Delete original input file
    if (fs.existsSync(job.input_path)) {
        fs.unlinkSync(job.input_path);
    }

    // Update transcode queue
    await db.run(`
        UPDATE transcode_queue SET status = 'completed', progress = 100, completed_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `, [job.id]);

    logger?.info('transcoder', `Completed: ${job.filename} -> ${finalPath}`);

    // Handle based on source type
    if (job.source === 'watch' || !job.download_id) {
        // Watch folder job
        app?.emit('transcode:complete', {
            id: job.id,
            filename: job.filename,
            source: 'watch',
            path: finalPath
        });
    } else {
        // Download job - update download status
        await db.run(`
            UPDATE downloads SET status = 'completed', final_path = ?, completed_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [finalPath, job.download_id]);

        const download = await db.get('SELECT * FROM downloads WHERE id = ?', [job.download_id]);

        app?.emit('transcode:complete', {
            id: job.id,
            downloadId: job.download_id,
            title: download?.title,
            path: finalPath
        });

        app?.emit('download:complete', {
            id: job.download_id,
            title: download?.title,
            path: finalPath
        });

        // Trigger Plex scan
        await triggerPlexScan(job, finalPath);
    }
}

/**
 * Fail a transcoding job
 */
async function failJob(job, errorMessage) {
    await db.run(`
        UPDATE transcode_queue SET status = 'failed', error_message = ?
        WHERE id = ?
    `, [errorMessage, job.id]);

    logger?.error('transcoder', `Failed: ${job.filename} - ${errorMessage}`);

    // Handle based on source type
    if (job.source === 'watch' || !job.download_id) {
        // Watch folder job
        app?.emit('transcode:failed', {
            id: job.id,
            filename: job.filename,
            source: 'watch',
            error: errorMessage
        });
    } else {
        // Download job - update download status
        await db.run(`
            UPDATE downloads SET status = 'failed', error_message = ?
            WHERE id = ?
        `, [`Transcode failed: ${errorMessage}`, job.download_id]);

        const download = await db.get('SELECT * FROM downloads WHERE id = ?', [job.download_id]);

        app?.emit('transcode:failed', {
            id: job.id,
            downloadId: job.download_id,
            title: download?.title,
            error: errorMessage
        });
    }
}

/**
 * Trigger Plex library scan
 */
async function triggerPlexScan(job, finalPath) {
    if (!plex) return;

    const libraryId = job.media_type === 'movie'
        ? settings.get('plexMovieLibraryId')
        : settings.get('plexTvLibraryId');

    if (libraryId) {
        try {
            await plex.scanLibrary(libraryId, job.final_dir);
        } catch (err) {
            logger?.warn('transcoder', `Failed to trigger Plex scan: ${err.message}`);
        }
    }
}

/**
 * Get transcoder status
 */
function getStatus() {
    return {
        active: activeJob ? {
            id: activeJob.id,
            downloadId: activeJob.download_id,
            filename: activeJob.filename,
            progress: activeJob.progress || 0
        } : null,
        isProcessing
    };
}

/**
 * Cancel active transcoding job
 */
async function cancelActive() {
    if (activeJob?.process) {
        activeJob.process.kill('SIGTERM');
        setTimeout(() => {
            if (activeJob?.process) {
                activeJob.process.kill('SIGKILL');
            }
        }, 5000);
    }
}

/**
 * Retry a failed job
 */
async function retryJob(jobId) {
    await db.run(`
        UPDATE transcode_queue SET status = 'pending', error_message = NULL, progress = 0
        WHERE id = ?
    `, [jobId]);

    await db.run(`
        UPDATE downloads SET status = 'transcoding', error_message = NULL
        WHERE id = (SELECT download_id FROM transcode_queue WHERE id = ?)
    `, [jobId]);

    processQueue();
}

module.exports = {
    init: async (modules) => {
        logger = modules.logger;
        db = modules.db;
        app = modules.app;
        settings = modules.settings;
        plex = modules.plex;

        // Detect hardware on startup
        const hwAccel = await detectHardwareAcceleration();
        logger?.info('transcoder', `Hardware acceleration: ${hwAccel.type}`);

        // Reset any stuck jobs from previous run
        await db.run(`
            UPDATE transcode_queue SET status = 'pending'
            WHERE status = 'transcoding'
        `);

        // Start queue processor
        transcodeInterval = setInterval(processQueue, 5000);
        logger?.info('transcoder', 'Transcoder engine started');

        // Start watch folder scanner (every 10 seconds)
        watchInterval = setInterval(scanWatchFolder, 10000);
        // Do initial scan
        scanWatchFolder();

        if (settings.get('transcodeWatchEnabled')) {
            const watchFolder = settings.get('transcodeWatchFolder');
            const outputFolder = settings.get('transcodeOutputFolder');
            logger?.info('transcoder', `Watch folder enabled: ${watchFolder} -> ${outputFolder}`);
        }
    },

    shutdown: async () => {
        if (transcodeInterval) clearInterval(transcodeInterval);
        if (watchInterval) clearInterval(watchInterval);
        await cancelActive();
        logger?.info('transcoder', 'Transcoder engine stopped');
    },

    // Public API
    queue,
    processQueue,
    getStatus,
    detectHardwareAcceleration,
    isCompatibleFormat,
    retryJob,
    cancelActive,
    scanWatchFolder,

    // For testing
    findFfmpeg,
    findFfprobe,
    buildFfmpegArgs
};
