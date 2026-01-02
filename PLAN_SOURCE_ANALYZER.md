# Source Pattern Analyzer Feature Plan

## Overview
Automatically analyze new IPTV sources to detect parsing patterns for title, year, language, and category extraction. Uses LLM when configured, falls back to user configuration UI.

## Requirements
- **Trigger**: Auto-run on source add + manual "Analyze Source" button
- **Detection**: LLM first (if configured), fall back to user input
- **Sample Size**: 5 entries each of movies, series, and live TV (15 total)

---

## Implementation Steps

### Phase 1: Backend - Source Analyzer Module

**File: `src/modules/source-analyzer.js`** (NEW)

1. **`fetchSamples(source)`** - Download sample M3U/Xtream content
   - For Xtream: Use player API to get 5 items from VOD, series, and live categories
   - For M3U: Parse first ~1000 lines to find 5 of each content type
   - Return structured samples: `{ movies: [], series: [], livetv: [] }`

2. **`analyzeWithLLM(samples)`** - Use LLM to generate regex patterns
   - Build prompt with sample entries showing raw M3U EXTINF lines
   - Ask LLM to identify:
     - Language extraction pattern (from title prefix like "DE - " or category)
     - Year extraction pattern (e.g., "(2024)" at end)
     - Title cleaning pattern (remove prefix/suffix noise)
     - Content type detection patterns for each category
   - Parse LLM response as JSON with regex patterns
   - Validate generated regexes against samples

3. **`buildManualAnalysis(samples)`** - Fallback pattern detection
   - Detect common patterns programmatically:
     - Language prefixes: `^([A-Z]{2})\s*[-:]\s*`
     - Year in parentheses: `\((\d{4})\)`
     - Common group-title structures
   - Return detected patterns + confidence scores

4. **`validatePatterns(patterns, samples)`** - Test patterns against samples
   - Run patterns on each sample
   - Return success rate and parsed preview

### Phase 2: API Endpoints

**File: `src/modules/app.js`** - Add to `setupApiRoutes()`

```javascript
// POST /api/sources/:id/analyze - Analyze source and generate patterns
router.post('/sources/:id/analyze', async (req, res) => {
  // 1. Fetch samples from source
  // 2. If LLM configured, use it; otherwise use programmatic detection
  // 3. Return suggested patterns + preview results
});

// POST /api/sources/analyze-preview - Preview patterns on samples
router.post('/sources/analyze-preview', async (req, res) => {
  // Takes samples + patterns, returns parsed preview
});
```

### Phase 3: LLM Prompt Design

**Prompt Template:**
```
Analyze these IPTV M3U entries and generate regex patterns to extract metadata.

Sample MOVIES entries:
{movieSamples}

Sample SERIES entries:
{seriesSamples}

Sample LIVE TV entries:
{livetvSamples}

Generate JSON with these regex patterns:
1. titlePatterns.language - Extract 2-letter language code from title
2. titlePatterns.year - Extract 4-digit year
3. titlePatterns.cleanTitle - Pattern to clean/extract actual title
4. contentTypePatterns.movies - Keywords/patterns identifying movie content
5. contentTypePatterns.series - Keywords/patterns identifying series content
6. contentTypePatterns.livetv - Keywords/patterns identifying live TV

Return ONLY valid JSON, no explanation.
```

### Phase 4: UI - Source Configuration Modal

**File: `web/views/settings.ejs`** - Enhance source modal

1. **Auto-analyze on source add:**
   - After saving new source, show "Analyzing source patterns..." loading state
   - Display analysis results with preview table
   - Allow user to accept, modify, or skip patterns

2. **"Analyze Patterns" button for existing sources:**
   - In source edit modal, add button to trigger analysis
   - Show side-by-side comparison: current patterns vs suggested

3. **Pattern Editor UI:**
   - Editable regex inputs for each pattern
   - Live preview showing how patterns parse sample entries
   - "Test Patterns" button to validate against more samples

### Phase 5: Database Schema Update

**File: `sql/027_source_analyzer.sql`** (NEW)

```sql
-- Add analysis metadata to sources
ALTER TABLE sources ADD COLUMN analysis_status TEXT DEFAULT NULL;
ALTER TABLE sources ADD COLUMN last_analyzed DATETIME;
ALTER TABLE sources ADD COLUMN analysis_confidence REAL;

-- Store raw samples for re-analysis
CREATE TABLE IF NOT EXISTS source_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL,
    content_type TEXT NOT NULL,  -- 'movie', 'series', 'live'
    raw_extinf TEXT NOT NULL,
    raw_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
);
```

---

## Flow Diagram

```
[Add Source] --> [Fetch Samples (15 items)]
                         |
                         v
              [LLM Configured?]
                  /        \
                YES         NO
                 |           |
                 v           v
         [Send to LLM]  [Programmatic Detection]
                 \          /
                  \        /
                   v      v
            [Validate Patterns]
                     |
                     v
           [Show Results to User]
                     |
              +------+------+
              |             |
         [Accept]      [Modify]
              |             |
              v             v
        [Save Config]  [Pattern Editor]
                              |
                              v
                       [Save Config]
```

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/modules/source-analyzer.js` | CREATE | New module for analysis logic |
| `src/modules/app.js` | MODIFY | Add API endpoints |
| `src/modules/llm.js` | MODIFY | Add analyze prompt helper |
| `web/views/settings.ejs` | MODIFY | Add analyzer UI components |
| `sql/027_source_analyzer.sql` | CREATE | Database migration |
| `index.js` | MODIFY | Load source-analyzer module |

---

## Estimated Complexity

- **Backend module**: Medium (~200 lines)
- **API endpoints**: Low (~50 lines)
- **LLM integration**: Low (~30 lines)
- **UI changes**: Medium (~150 lines)
- **Database migration**: Low (~15 lines)

Total: ~445 lines of new/modified code

---

## Dependencies

- Existing `llm.js` module for LLM queries
- Existing `iptv.js` for `parseM3U()` and `previewM3UParser()`
- Existing parser config structure (`DEFAULT_PARSER_CONFIG`)
