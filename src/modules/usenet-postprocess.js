/**
 * Usenet Post-Processing Module
 * Handles PAR2 verification/repair and archive extraction
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createHash } = require('crypto');

// Module references
const refs = {
    logger: null,
    db: null,
    settings: null,
    app: null
};

/**
 * Post-process a completed NZB download
 */
async function process(downloadId, tempDir) {
    refs.logger?.info('usenet-postprocess', `Starting post-processing for download ${downloadId}`);

    const nzbDownload = await refs.db.get(
        'SELECT * FROM nzb_downloads WHERE download_id = ?',
        [downloadId]
    );

    if (!nzbDownload) {
        throw new Error('NZB download record not found');
    }

    try {
        // Update status
        await updateStatus(nzbDownload.id, 'par2_status', 'verifying');

        // Step 1: PAR2 verification
        const par2Result = await verifyPar2(tempDir);

        if (par2Result.needsRepair) {
            await updateStatus(nzbDownload.id, 'par2_status', 'repairing');
            const repairResult = await repairPar2(tempDir);

            if (!repairResult.success) {
                await updateStatus(nzbDownload.id, 'par2_status', 'failed');
                throw new Error('PAR2 repair failed: ' + repairResult.error);
            }
        }

        await updateStatus(nzbDownload.id, 'par2_status', 'verified');

        // Step 2: Extract archives
        await updateStatus(nzbDownload.id, 'extract_status', 'extracting');

        const extractResult = await extractArchives(tempDir);

        if (!extractResult.success) {
            await updateStatus(nzbDownload.id, 'extract_status', 'failed');
            throw new Error('Extraction failed: ' + extractResult.error);
        }

        await updateStatus(nzbDownload.id, 'extract_status', 'extracted');

        // Step 3: Cleanup if enabled
        if (refs.settings?.get('usenetCleanupAfterExtract')) {
            await cleanupArchives(tempDir);
        }

        // Step 4: Get final files
        const finalFiles = await getFinalFiles(tempDir);

        refs.logger?.info('usenet-postprocess', `Post-processing complete: ${finalFiles.length} files`);

        // Emit completion
        refs.app?.emit('usenet:postprocess:complete', {
            downloadId,
            tempDir,
            files: finalFiles
        });

        return {
            success: true,
            files: finalFiles
        };

    } catch (err) {
        refs.logger?.error('usenet-postprocess', `Post-processing failed: ${err.message}`);

        refs.app?.emit('usenet:postprocess:error', {
            downloadId,
            error: err.message
        });

        throw err;
    }
}

/**
 * Update NZB download status
 */
async function updateStatus(nzbDownloadId, field, status) {
    await refs.db.run(
        `UPDATE nzb_downloads SET ${field} = ? WHERE id = ?`,
        [status, nzbDownloadId]
    );
}

/**
 * Verify PAR2 files
 */
async function verifyPar2(dir) {
    const files = await fs.readdir(dir);
    const par2Files = files.filter(f => f.toLowerCase().endsWith('.par2'));

    if (par2Files.length === 0) {
        refs.logger?.debug('usenet-postprocess', 'No PAR2 files found, skipping verification');
        return { verified: true, needsRepair: false };
    }

    // Find the main PAR2 file (usually the smallest one without vol in name)
    const mainPar2 = par2Files.find(f => !f.toLowerCase().includes('.vol')) || par2Files[0];
    const par2Path = path.join(dir, mainPar2);

    // Check if par2 binary is available
    const par2Binary = await findPar2Binary();

    if (!par2Binary) {
        refs.logger?.warn('usenet-postprocess', 'PAR2 binary not found, skipping verification');
        return { verified: true, needsRepair: false, skipped: true };
    }

    return new Promise((resolve) => {
        const args = ['v', par2Path];
        const proc = spawn(par2Binary, args, { cwd: dir });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });

        proc.on('close', (code) => {
            if (code === 0) {
                resolve({ verified: true, needsRepair: false });
            } else if (stdout.includes('Repair is required') || stdout.includes('damaged')) {
                resolve({ verified: false, needsRepair: true });
            } else {
                refs.logger?.warn('usenet-postprocess', `PAR2 verify returned code ${code}`);
                resolve({ verified: false, needsRepair: true, error: stderr || stdout });
            }
        });

        proc.on('error', (err) => {
            refs.logger?.error('usenet-postprocess', `PAR2 verify error: ${err.message}`);
            resolve({ verified: false, needsRepair: false, error: err.message });
        });
    });
}

/**
 * Repair using PAR2
 */
async function repairPar2(dir) {
    const files = await fs.readdir(dir);
    const par2Files = files.filter(f => f.toLowerCase().endsWith('.par2'));

    if (par2Files.length === 0) {
        return { success: false, error: 'No PAR2 files found' };
    }

    const mainPar2 = par2Files.find(f => !f.toLowerCase().includes('.vol')) || par2Files[0];
    const par2Path = path.join(dir, mainPar2);

    const par2Binary = await findPar2Binary();

    if (!par2Binary) {
        return { success: false, error: 'PAR2 binary not found' };
    }

    return new Promise((resolve) => {
        const args = ['r', par2Path];
        const proc = spawn(par2Binary, args, { cwd: dir });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });

        proc.on('close', (code) => {
            if (code === 0 || stdout.includes('Repair complete')) {
                resolve({ success: true });
            } else {
                resolve({ success: false, error: stderr || stdout || `Exit code ${code}` });
            }
        });

        proc.on('error', (err) => {
            resolve({ success: false, error: err.message });
        });
    });
}

/**
 * Find PAR2 binary
 */
async function findPar2Binary() {
    const candidates = ['par2', 'par2repair', '/usr/bin/par2', '/usr/local/bin/par2'];

    for (const candidate of candidates) {
        try {
            await new Promise((resolve, reject) => {
                const proc = spawn(candidate, ['--version']);
                proc.on('close', (code) => code === 0 ? resolve() : reject());
                proc.on('error', reject);
            });
            return candidate;
        } catch {
            // Try next candidate
        }
    }

    return null;
}

/**
 * Extract archives (RAR, ZIP, 7z)
 */
async function extractArchives(dir) {
    const files = await fs.readdir(dir);

    // Find RAR files
    const rarFiles = files.filter(f => /\.rar$/i.test(f));
    // Find ZIP files
    const zipFiles = files.filter(f => /\.zip$/i.test(f));
    // Find 7z files
    const sevenZipFiles = files.filter(f => /\.7z$/i.test(f));

    if (rarFiles.length === 0 && zipFiles.length === 0 && sevenZipFiles.length === 0) {
        refs.logger?.debug('usenet-postprocess', 'No archives found');
        return { success: true, extracted: 0 };
    }

    let extracted = 0;

    // Extract RAR files (only first part of multipart)
    for (const rarFile of rarFiles) {
        // Skip .r00, .r01, etc (parts of multipart RAR)
        if (/\.r\d{2}$/i.test(rarFile)) continue;

        // For multipart, only extract the first .rar file
        if (rarFiles.some(f => f.replace(/\.rar$/i, '.r00') === rarFile.replace(/\.rar$/i, '.r00') && f !== rarFile)) {
            // This might be part 2+ of a multipart, check if part 1 exists
        }

        const result = await extractRar(path.join(dir, rarFile), dir);
        if (result.success) extracted++;
    }

    // Extract ZIP files
    for (const zipFile of zipFiles) {
        const result = await extractZip(path.join(dir, zipFile), dir);
        if (result.success) extracted++;
    }

    // Extract 7z files
    for (const szFile of sevenZipFiles) {
        const result = await extract7z(path.join(dir, szFile), dir);
        if (result.success) extracted++;
    }

    return { success: true, extracted };
}

/**
 * Extract RAR archive
 */
async function extractRar(archivePath, destDir) {
    // Try unrar first, then 7z
    const unrarBinary = await findBinary(['unrar', '/usr/bin/unrar', '/usr/local/bin/unrar']);

    if (unrarBinary) {
        return new Promise((resolve) => {
            const args = ['x', '-y', '-o+', archivePath, destDir + '/'];
            const proc = spawn(unrarBinary, args);

            proc.on('close', (code) => {
                resolve({ success: code === 0 });
            });

            proc.on('error', () => {
                resolve({ success: false });
            });
        });
    }

    // Try 7z as fallback
    const szBinary = await findBinary(['7z', '7za', '/usr/bin/7z', '/usr/local/bin/7z']);

    if (szBinary) {
        return new Promise((resolve) => {
            const args = ['x', '-y', `-o${destDir}`, archivePath];
            const proc = spawn(szBinary, args);

            proc.on('close', (code) => {
                resolve({ success: code === 0 });
            });

            proc.on('error', () => {
                resolve({ success: false });
            });
        });
    }

    refs.logger?.warn('usenet-postprocess', 'No RAR extraction tool found (unrar or 7z)');
    return { success: false, error: 'No extraction tool available' };
}

/**
 * Extract ZIP archive
 */
async function extractZip(archivePath, destDir) {
    const unzipBinary = await findBinary(['unzip', '/usr/bin/unzip']);

    if (unzipBinary) {
        return new Promise((resolve) => {
            const args = ['-o', archivePath, '-d', destDir];
            const proc = spawn(unzipBinary, args);

            proc.on('close', (code) => {
                resolve({ success: code === 0 });
            });

            proc.on('error', () => {
                resolve({ success: false });
            });
        });
    }

    // Try 7z as fallback
    const szBinary = await findBinary(['7z', '7za']);

    if (szBinary) {
        return new Promise((resolve) => {
            const args = ['x', '-y', `-o${destDir}`, archivePath];
            const proc = spawn(szBinary, args);

            proc.on('close', (code) => {
                resolve({ success: code === 0 });
            });

            proc.on('error', () => {
                resolve({ success: false });
            });
        });
    }

    return { success: false, error: 'No ZIP extraction tool available' };
}

/**
 * Extract 7z archive
 */
async function extract7z(archivePath, destDir) {
    const szBinary = await findBinary(['7z', '7za', '/usr/bin/7z', '/usr/local/bin/7z']);

    if (!szBinary) {
        return { success: false, error: '7z not found' };
    }

    return new Promise((resolve) => {
        const args = ['x', '-y', `-o${destDir}`, archivePath];
        const proc = spawn(szBinary, args);

        proc.on('close', (code) => {
            resolve({ success: code === 0 });
        });

        proc.on('error', () => {
            resolve({ success: false });
        });
    });
}

/**
 * Find a binary from candidates
 */
async function findBinary(candidates) {
    for (const candidate of candidates) {
        try {
            await fs.access(candidate.startsWith('/') ? candidate : `/usr/bin/${candidate}`);
            return candidate;
        } catch {
            // Check with which
            try {
                await new Promise((resolve, reject) => {
                    const proc = spawn('which', [candidate]);
                    proc.on('close', (code) => code === 0 ? resolve() : reject());
                    proc.on('error', reject);
                });
                return candidate;
            } catch {
                // Try next
            }
        }
    }
    return null;
}

/**
 * Cleanup archive files after extraction
 */
async function cleanupArchives(dir) {
    const files = await fs.readdir(dir);

    const archivePatterns = [
        /\.rar$/i,
        /\.r\d{2}$/i,
        /\.zip$/i,
        /\.7z$/i,
        /\.par2$/i,
        /\.sfv$/i,
        /\.nfo$/i
    ];

    for (const file of files) {
        if (archivePatterns.some(p => p.test(file))) {
            try {
                await fs.unlink(path.join(dir, file));
                refs.logger?.debug('usenet-postprocess', `Deleted: ${file}`);
            } catch (err) {
                refs.logger?.warn('usenet-postprocess', `Failed to delete ${file}: ${err.message}`);
            }
        }
    }
}

/**
 * Get list of final files after extraction
 */
async function getFinalFiles(dir) {
    const files = await fs.readdir(dir);
    const result = [];

    // Media file extensions
    const mediaExtensions = ['.mkv', '.avi', '.mp4', '.m4v', '.wmv', '.mov', '.mpg', '.mpeg', '.ts', '.iso'];

    for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = await fs.stat(filePath);

        if (stat.isFile()) {
            const ext = path.extname(file).toLowerCase();
            const isMedia = mediaExtensions.includes(ext);

            result.push({
                name: file,
                path: filePath,
                size: stat.size,
                isMedia
            });
        }
    }

    // Sort by size descending (largest files first)
    result.sort((a, b) => b.size - a.size);

    return result;
}

/**
 * Move final files to destination
 */
async function moveToDestination(files, destDir, mediaInfo = null) {
    await fs.mkdir(destDir, { recursive: true });

    const moved = [];

    for (const file of files) {
        if (!file.isMedia) continue;

        let destName = file.name;

        // Rename if media info provided
        if (mediaInfo) {
            const ext = path.extname(file.name);
            if (mediaInfo.type === 'movie') {
                destName = `${mediaInfo.title} (${mediaInfo.year})${ext}`;
            } else if (mediaInfo.type === 'episode') {
                destName = `${mediaInfo.showTitle} - S${String(mediaInfo.season).padStart(2, '0')}E${String(mediaInfo.episode).padStart(2, '0')} - ${mediaInfo.title}${ext}`;
            }
        }

        const destPath = path.join(destDir, destName);

        try {
            await fs.rename(file.path, destPath);
            moved.push({ from: file.path, to: destPath });
        } catch (err) {
            // If rename fails (cross-device), try copy+delete
            try {
                await fs.copyFile(file.path, destPath);
                await fs.unlink(file.path);
                moved.push({ from: file.path, to: destPath });
            } catch (copyErr) {
                refs.logger?.error('usenet-postprocess', `Failed to move ${file.name}: ${copyErr.message}`);
            }
        }
    }

    return moved;
}

/**
 * Calculate file hash for verification
 */
async function calculateHash(filePath, algorithm = 'md5') {
    return new Promise((resolve, reject) => {
        const hash = createHash(algorithm);
        const stream = fsSync.createReadStream(filePath);

        stream.on('data', (data) => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

module.exports = {
    init: async (modules) => {
        refs.logger = modules.logger;
        refs.db = modules.db;
        refs.settings = modules.settings;
        refs.app = modules.app;

        // Listen for download completion events
        if (modules.app) {
            modules.app.on('usenet:download:complete', async (data) => {
                try {
                    await process(data.downloadId, data.tempDir);
                } catch (err) {
                    refs.logger?.error('usenet-postprocess', `Auto post-process failed: ${err.message}`);
                }
            });
        }

        refs.logger?.info('usenet-postprocess', 'Usenet post-processing module initialized');
    },

    // Public API
    process,
    verifyPar2,
    repairPar2,
    extractArchives,
    cleanupArchives,
    getFinalFiles,
    moveToDestination,
    calculateHash
};
