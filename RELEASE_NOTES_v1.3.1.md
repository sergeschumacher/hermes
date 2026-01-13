# v1.3.1 - Download Manager Improvements

## 🎉 What's New in v1.3.1

### ✨ New Features

#### "Add all to Queue" Button
- Added bulk retry button in the Failed downloads card
- Retries all failed/cancelled downloads with a single click
- Sets high priority (75) for retried downloads
- Shows success notification with count of downloads added back to queue

### 🐛 Bug Fixes

#### Critical Download System Fixes
1. **Fixed HTTP 404 error** when using "Add all to Queue" button
   - Corrected Express route ordering (literal paths before parameterized routes)
   - Removed duplicate unreachable route definitions

2. **Fixed download limit not being respected**
   - Resolved race condition in `reconcileStuckDownloads()`
   - Download counter now properly enforces `maxConcurrentDownloads` setting
   - Added safeguards to prevent counter from going negative

3. **Fixed duplicate concurrent downloads**
   - Downloads were starting multiple times simultaneously
   - Added `processingDownloadIds` Set to track active downloads
   - Implemented robust try-finally blocks for error handling
   - Prevents same download from being processed multiple times

4. **Fixed stuck downloads**
   - Downloads getting stuck in "already being processed" state
   - `processingDownloadIds` Set now cleared when stuck downloads detected
   - Added debug logging for tracking download processing state

5. **Fixed high-priority downloads bypassing queue limits**
   - High-priority batch downloads (e.g., entire TV seasons) were all activating simultaneously
   - Race condition in `processQueue()` released mutex before downloads actually started
   - Queue limits (`maxConcurrentDownloads`) now properly enforced for all priority levels
   - Fixed by moving mutex release to happen after download initialization completes

### 🔧 Improvements

#### Error Handling & Logging
- Better error messages in frontend with specific details
- Comprehensive logging in backend for debugging
- Proper HTTP response status checks before parsing JSON
- Shows "No failed downloads to retry" when appropriate
- Individual retry errors no longer stop bulk retry process

#### Code Quality
- Removed accidentally committed temp files
- Updated `.gitignore` for better exclusions
- Improved code organization and route structure

### 📝 Technical Details

**Files Changed:**
- `src/modules/app.js` - Route fixes and retry-all endpoint
- `src/modules/download.js` - Race condition fixes and stuck download cleanup
- `web/views/downloads.ejs` - UI improvements and error handling

**Commits:**
- 8c15b14 - Fix race condition causing high-priority downloads to bypass queue limits
- 06f4146 - Cleanup and prepare for v1.3.1 release
- 4ccfbd3 - Fix HTTP 404 error and stuck download issues
- e005100 - Add comprehensive debugging for retry-all-failed endpoint
- 76c4224 - Fix error handling in retry-all-failed endpoint
- d9730d3 - Fix race condition causing duplicate concurrent downloads
- 6b156db - Fix retry-all and download limit bugs
- 059e789 - Add retry all button for failed downloads

### 🚀 Upgrade Instructions

**Docker Compose:**
```bash
cd /path/to/RecoStream
git pull
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

**Docker (pre-built image):**
```bash
docker pull ghcr.io/sergeschumacher/recostream:latest
docker stop recostream
docker rm recostream
# Run your docker run command again
```

### 💝 Contributors

Co-Authored-By: Claude Sonnet 4.5

---

**Full Changelog**: https://github.com/sergeschumacher/RecoStream/compare/v1.3.0...v1.3.1
