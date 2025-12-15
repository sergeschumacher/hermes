# Claude Code Guidelines for Hermes

## Security - CRITICAL

### Before Committing or Pushing

**ALWAYS check deployment files for sensitive data before pushing to GitHub:**

1. **deploy-unraid.sh** - Check for:
   - Real IP addresses (should be `192.168.1.XXX` placeholder)
   - Passwords (UNRAID_PASS should be empty `""`)
   - SSH keys or credentials

2. **docker-compose.yml** - Check for:
   - API keys (TMDB_API_KEY, OPENAI_API_KEY, etc.)
   - Real IP addresses
   - Passwords

3. **Any .env files** - Should NOT be committed (verify .gitignore)

### Sanitization Commands

Before pushing, run:
```bash
grep -r "192\.168\.[0-9]*\.[0-9]*" --include="*.sh" --include="*.yml" --include="*.yaml" .
grep -ri "pass\|password\|secret\|key\|token" --include="*.sh" . | grep -v "XXX\|placeholder\|example"
```

### Placeholder Values

Use these placeholder values in deployment scripts:
- IP Address: `192.168.1.XXX`
- Password: `""` (empty string, script will prompt)
- API Keys: `your-api-key-here`

## Project Structure

- `src/modules/` - Core application modules
- `web/views/` - EJS templates
- `sql/` - Database migrations
- `deploy-unraid.sh` - Unraid deployment script
- `.github/workflows/` - GitHub Actions (Docker builds)

## Deployment

The project uses:
- **Docker** - Multi-platform builds (amd64, arm64)
- **GitHub Container Registry** - ghcr.io for pre-built images
- **Unraid** - Primary deployment target with Intel QSV GPU support

## Database

SQLite database with migrations in `sql/` directory. Key tables:
- `media` - Movies and series
- `media_trailers` - YouTube trailer links
- `enrichment_queue` - TMDB enrichment queue
