# Hermes

**Your personal IPTV media management system**

Hermes is a self-hosted media management application that transforms your IPTV subscriptions into a Netflix-like experience. Browse movies and series with rich metadata, preview streams before downloading, and manage your media library with ease.

![Docker Pulls](https://img.shields.io/docker/pulls/ghcr.io/sergeschumacher/hermes)
![License](https://img.shields.io/badge/license-MIT-blue.svg)

## Features

- **Rich Media Library** - Browse movies and series with posters, descriptions, ratings, and trailers from TMDB
- **Multi-Source Support** - Connect multiple IPTV providers (Xtream Codes, M3U) simultaneously
- **In-Browser Preview** - Test video quality and language before downloading with built-in player
- **Smart Enrichment** - Automatic metadata matching with TMDB, including cast, genres, and release info
- **EPG Integration** - Electronic Program Guide support for live TV scheduling
- **Download Manager** - Queue and manage downloads with priority controls
- **Hardware Transcoding** - Intel QSV/VAAPI and NVIDIA GPU acceleration support
- **Plex Integration** - Automatically scan new media into your Plex library
- **DVR/Recording** - Schedule recordings from live TV streams
- **Usenet Support** - Download via Usenet with NZB indexer integration
- **Source Analyzer** - Analyze your IPTV sources for quality and availability

## Quick Start

### Using Docker Compose (Recommended)

```yaml
services:
  hermes2:
    image: ghcr.io/sergeschumacher/hermes:latest
    container_name: hermes2
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./data:/data
      - ./downloads:/downloads
    environment:
      - TZ=Europe/Amsterdam
      - ADMIN_USERNAME=admin
      - ADMIN_PASSWORD=password
      - MFA_ENABLED=true
```

```bash
docker-compose up -d
```

Then open http://localhost:3000 in your browser.

### Using Docker Run

```bash
docker run -d \
  --name hermes2 \
  -p 3000:3000 \
  -v ./data:/data \
  -v ./downloads:/downloads \
  -e TZ=Europe/Amsterdam \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=password \
  -e MFA_ENABLED=true \
  ghcr.io/sergeschumacher/hermes:latest
```

## Configuration

### First-Time Setup

1. Open http://localhost:3000/settings
2. Add your IPTV source (Xtream Codes or M3U URL)
3. Click "Sync" to fetch your media catalog
4. Browse your library at http://localhost:3000/movies or /series

### TMDB API Key (Recommended)

For rich metadata enrichment, add your free TMDB API key:

1. Get a free API key at https://www.themoviedb.org/settings/api
2. Go to Settings > General > TMDB API Key
3. Paste your API key and save

### TMDB Rate Limit

TMDB requests are limited to **40 requests per 10 seconds per IP**. If you hit the limit, you’ll receive HTTP 429 responses with `Retry-After` headers. Consider caching or reducing concurrent lookups if you see throttling.

### Hardware Acceleration

**Intel QuickSync (VAAPI):**
```yaml
devices:
  - /dev/dri:/dev/dri
```

**NVIDIA GPU:**
```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: 1
          capabilities: [gpu]
```

## Screenshots

| Movies Library | Series Detail | Preview Player |
|:---:|:---:|:---:|
| Browse with posters | Episode guide | Test before download |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TZ` | Timezone | `UTC` |
| `DATA_PATH` | Data directory path | `/data` |
| `TMDB_API_KEY` | TMDB API key for metadata | - |
| `PLEX_URL` | Plex server URL | - |
| `PLEX_TOKEN` | Plex authentication token | - |

## Architecture

Hermes is built with:
- **Backend:** Node.js with Express
- **Database:** SQLite with automatic migrations
- **Frontend:** EJS templates with Tailwind CSS
- **Streaming:** FFmpeg for transcoding and preview

## Updating

Hermes automatically applies database migrations on startup. Simply pull the latest image:

```bash
docker-compose pull
docker-compose up -d
```

Your data and settings are preserved in the mounted volumes.

## Support

- **Issues:** [GitHub Issues](https://github.com/sergeschumacher/hermes/issues)
- **Discussions:** [GitHub Discussions](https://github.com/sergeschumacher/hermes/discussions)

## License

MIT License - see [LICENSE](LICENSE) for details.

---

**Hermes** - Stream smarter, not harder.
