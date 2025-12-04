# Implementation Plan: Global EPG, Language Preferences & Scheduled Recording

## Overview

This plan covers:
1. Remove per-source EPG, implement global EPG from globetvapp/epg
2. Add language preferences to settings (for movies, series, live TV, EPG)
3. Add EPG page in navbar with program guide view
4. Implement scheduled recording system for live TV
5. Create a scheduler engine for automated tasks

---

## Phase 1: Database Changes (Migration 012)

### New/Modified Tables

```sql
-- Remove source_id from epg_programs (make global)
-- Keep epg_programs table but remove source_id foreign key

-- Scheduled recordings table
CREATE TABLE IF NOT EXISTS scheduled_recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL,          -- Live TV channel media ID
    title TEXT NOT NULL,                -- Recording title (program name)
    channel_name TEXT,                  -- Channel display name
    start_time DATETIME NOT NULL,       -- When to start recording
    end_time DATETIME NOT NULL,         -- When to stop recording
    status TEXT DEFAULT 'scheduled',    -- scheduled, recording, completed, failed, cancelled
    recurrence TEXT,                    -- null=once, daily, weekly, weekdays
    epg_program_id INTEGER,             -- Link to EPG program if scheduled from EPG
    output_path TEXT,                   -- Where recording was saved
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
);

-- Scheduler tasks table (for general scheduled tasks)
CREATE TABLE IF NOT EXISTS scheduler_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_type TEXT NOT NULL,            -- epg_sync, source_sync, cleanup, etc.
    task_data TEXT,                     -- JSON data for the task
    next_run DATETIME NOT NULL,
    interval_minutes INTEGER,           -- Repeat interval (null = one-time)
    last_run DATETIME,
    status TEXT DEFAULT 'active',       -- active, paused, completed
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- EPG countries table (selected countries for EPG)
CREATE TABLE IF NOT EXISTS epg_countries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country_code TEXT NOT NULL UNIQUE,  -- e.g., "Germany", "United Kingdom"
    country_name TEXT,
    enabled INTEGER DEFAULT 1,
    last_sync DATETIME
);
```

### Settings Changes

Add to settings.json:
- `preferredLanguages`: Array of language codes ["de", "en", "fr"]
- `epgCountries`: Array of country names from globetvapp/epg

---

## Phase 2: Refactor EPG Module

### Changes to epg.js

1. **Remove source-based EPG sync** - Delete per-source EPG URL handling
2. **Add global EPG sync from globetvapp/epg**:
   - URL pattern: `https://raw.githubusercontent.com/globetvapp/epg/main/{Country}/{country}1.xml`
   - Fetch all XML files for selected countries (germany1.xml, germany2.xml, etc.)
   - Merge EPG data from multiple files
3. **Update EPG queries** - Remove source_id filtering
4. **Add channel matching** - Match EPG channel IDs to media items across all sources

### New Functions

```javascript
// Fetch list of available countries from GitHub repo
async function getAvailableCountries() { ... }

// Sync EPG for selected countries
async function syncGlobalEpg(countries) { ... }

// Get EPG programs for a time range (for EPG grid view)
async function getProgramGuide(startTime, endTime, channelIds) { ... }
```

---

## Phase 3: Scheduler Module (NEW)

Create `src/modules/scheduler.js`:

### Core Features

1. **Periodic task execution** - Check every minute for tasks to run
2. **Task types**:
   - `epg_sync` - Sync global EPG (daily at 4am)
   - `source_sync` - Refresh IPTV sources (configurable)
   - `recording_start` - Start a scheduled recording
   - `recording_stop` - Stop a recording
   - `cleanup` - Clean old EPG data, temp files

### Recording Logic

```javascript
async function startRecording(scheduledRecording) {
    // 1. Get channel stream URL from media table
    // 2. Create ffmpeg process to capture stream
    // 3. Update status to 'recording'
    // 4. Schedule stop task
}

async function stopRecording(recordingId) {
    // 1. Kill ffmpeg process
    // 2. Move file to recordings folder
    // 3. Update status to 'completed'
}
```

### Dependencies

- Uses `ffmpeg` for stream capture (external dependency)
- Falls back to direct stream download if ffmpeg not available

---

## Phase 4: Settings Page Updates

### Add Language Preferences Section

```html
<div class="card">
    <h2>Language Preferences</h2>
    <p>Select languages for movies, series, and live TV</p>
    <div class="grid grid-cols-4 gap-2">
        <!-- Checkbox for each common language -->
        <!-- German, English, French, Spanish, Italian, etc. -->
    </div>
</div>
```

### Add EPG Countries Section

```html
<div class="card">
    <h2>EPG Countries</h2>
    <p>Select countries for TV guide data</p>
    <div class="grid grid-cols-4 gap-2">
        <!-- Checkbox for each country from globetvapp/epg -->
    </div>
    <button onclick="syncEpg()">Sync EPG Now</button>
</div>
```

### Remove per-source EPG URL field

---

## Phase 5: EPG Page (NEW)

Create `/epg` route and `epg.ejs` view:

### Features

1. **Grid view** - TV guide style grid
   - X-axis: Time slots (30-min increments)
   - Y-axis: Channels
   - Scrollable horizontally (timeline)
2. **Timeline navigation** - Today, Tomorrow, +/- days
3. **Channel filtering** - By country, category, favorites
4. **Program details modal** - Click program to see details
5. **Schedule recording button** - One-click to schedule

### UI Layout

```
┌──────────────────────────────────────────────────────────┐
│ EPG - Program Guide                    [< Today >] [Sync]│
├──────────────────────────────────────────────────────────┤
│ Time:    │ 20:00  │ 20:30  │ 21:00  │ 21:30  │ 22:00   │
├──────────┼────────┴────────┼────────┴────────┼─────────┤
│ RTL      │ Show Name Here  │ Another Show    │ Movie   │
├──────────┼─────────────────┼─────────────────┼─────────┤
│ ProSieben│ Program Title   │ Next Program            │
├──────────┼─────────────────┴─────────────────┴─────────┤
│ SAT.1    │ Long Running Program Title                  │
└──────────┴────────────────────────────────────────────────┘
```

---

## Phase 6: Recordings Management

### Add to Downloads/Activity section or separate page

- List of scheduled recordings
- Status: Scheduled, Recording, Completed, Failed
- Cancel/Delete buttons
- View completed recordings

---

## Phase 7: API Endpoints

### New Endpoints

```
GET  /api/epg/countries           - List available EPG countries
POST /api/epg/sync                - Trigger global EPG sync
GET  /api/epg/guide               - Get program guide grid data
     ?start=ISO&end=ISO&channels=id1,id2

POST /api/recordings              - Create scheduled recording
GET  /api/recordings              - List recordings
PUT  /api/recordings/:id          - Update recording
DELETE /api/recordings/:id        - Cancel/delete recording

GET  /api/scheduler/tasks         - List scheduled tasks
POST /api/scheduler/tasks         - Create task
PUT  /api/scheduler/tasks/:id     - Update task
```

---

## Phase 8: Language Filtering

### Apply language filter to:

1. **Movies page** - Filter by detected language
2. **Series page** - Filter by detected language
3. **Live TV** - Filter channels by country/language code
4. **Search** - Respect language preferences

### Implementation

- Use existing category/title language detection
- Add language filter to media queries
- Store user's `preferredLanguages` in settings

---

## File Changes Summary

### New Files
- `sql/012_scheduler_recordings.sql` - Migration
- `src/modules/scheduler.js` - Scheduler engine
- `web/views/epg.ejs` - EPG page
- `web/views/recordings.ejs` - Recordings page (optional, could be part of downloads)

### Modified Files
- `src/modules/epg.js` - Refactor for global EPG
- `src/modules/settings.js` - Add language/country defaults
- `src/modules/app.js` - New routes and API endpoints
- `web/views/settings.ejs` - Language and EPG settings
- `web/views/layouts/main.ejs` - Add EPG nav link
- `web/views/livetv.ejs` - Update EPG display (remove source-specific)
- `index.js` - Add scheduler to module order

### Files to Clean Up
- Remove EPG URL from source modal in settings.ejs
- Remove source-based EPG sync from epg.js
- Update epg_programs table (remove source_id constraint)

---

## Implementation Order

1. Database migration (012)
2. Settings updates (language preferences, EPG countries)
3. Refactor EPG module for global sync
4. Create scheduler module
5. Update settings page UI
6. Add EPG nav link
7. Create EPG page with grid view
8. Implement scheduled recordings
9. Add recording to scheduler
10. Apply language filtering across the app
11. Testing and polish

---

## Notes

- **ffmpeg requirement**: For recording, ffmpeg must be installed. Show warning if not available.
- **Storage**: Recordings can be large. Consider adding storage management.
- **EPG refresh**: Daily sync recommended (3-4 AM to match source update time)
- **Timezone handling**: EPG times are typically UTC, convert for display
