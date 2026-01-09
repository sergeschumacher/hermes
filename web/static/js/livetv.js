    let currentOffset = 0;
    const limit = 100;
    let loading = false;
    let currentCategory = null;
    let currentChannel = null;
    let allCategories = [];
    let currentCountry = '';
    let currentSource = '';
    let preferredLanguages = [];
    const fallbackFlagSrc = '/static/images/recostream-icon-small.png';
    let sourcesList = [];
    let sourceFilterReady = false;

    const countryNameOverrides = {
        'UK': 'United Kingdom',
        'EN': 'English',
        'ENG': 'English',
        'EU': 'Europe',
        'LA': 'Latin America',
        'AF': 'Africa',
        'IA': 'India/Asia',
        'OTHER': 'Other'
    };

    const regionNameFormatter = typeof Intl !== 'undefined' && Intl.DisplayNames
        ? new Intl.DisplayNames(['en'], { type: 'region' })
        : null;
    const languageNameFormatter = typeof Intl !== 'undefined' && Intl.DisplayNames
        ? new Intl.DisplayNames(['en'], { type: 'language' })
        : null;

    function getCountryName(code) {
        if (!code) return '';
        const normalized = code.toUpperCase();
        if (countryNameOverrides[normalized]) return countryNameOverrides[normalized];

        if (regionNameFormatter) {
            const regionName = regionNameFormatter.of(normalized);
            if (regionName && regionName !== normalized) return regionName;
        }

        if (languageNameFormatter) {
            const langName = languageNameFormatter.of(normalized.toLowerCase());
            if (langName) return langName;
        }

        return code;
    }

    const countryFlagAliases = {
        'UK': 'gb',
        'ENG': 'gb',
        'EN': 'gb',
        'GER': 'de',
        'SPA': 'es',
        'FRA': 'fr',
        'ITA': 'it',
        'POR': 'pt',
        'DUT': 'nl',
        'POL': 'pl',
        'TUR': 'tr',
        'ARA': 'sa',
        'RUS': 'ru',
        'HIN': 'in',
        'JPN': 'jp',
        'KOR': 'kr',
        'CHN': 'cn',
        'EU': 'eu'
    };

    function getCategoryDisplayName(category) {
        if (!category) return 'Uncategorized';
        let name = category.replace(/^\|?[A-Z]{2}\|\s*/i, '');
        name = name.replace(/[|#]+/g, ' ').trim();
        return name || category;
    }

    // Map to store category -> language associations from API
    let categoryLanguageMap = {};

    function getCategoryCountry(category) {
        if (!category) return null;
        // First check if we have a language from the API for this category
        if (categoryLanguageMap[category]) {
            return categoryLanguageMap[category].toUpperCase();
        }
        // Fall back to parsing from category name prefix like |DE| or DE|
        const match = category.match(/\|?([A-Z]{2})\|/i) || category.match(/^([A-Z]{2})\s/i);
        return match ? match[1].toUpperCase() : null;
    }

    function getFlagCode(country) {
        if (!country) return null;
        const normalized = country.toUpperCase();
        if (countryFlagAliases[normalized]) return countryFlagAliases[normalized];
        if (/^[A-Z]{2}$/.test(normalized)) return normalized.toLowerCase();
        return null;
    }

    function renderFlag(country) {
        const code = getFlagCode(country);
        if (!code) {
            return `<img src="${fallbackFlagSrc}" alt="" loading="lazy" class="livetv-flag-img">`;
        }
        return `<img src="/static/images/flags/${code}.png" alt="" loading="lazy" class="livetv-flag-img" onerror="this.onerror=null;this.removeAttribute('src');this.src='${fallbackFlagSrc}'">`;
    }

    function renderCountryFlag(country) {
        const code = getFlagCode(country);
        if (!code) return `<img src="${fallbackFlagSrc}" alt="" loading="lazy" class="livetv-country-flag-img">`;
        return `<img src="/static/images/flags/${code}.png" alt="" loading="lazy" class="livetv-country-flag-img" onerror="this.onerror=null;this.removeAttribute('src');this.src='${fallbackFlagSrc}'">`;
    }

    function handleCountryChange(value) {
        currentCountry = value;
        if (currentCategory) resetChannelsPanel();
        applyFilters();
    }

    function handleSourceChange(value) {
        currentSource = value;
        resetChannelsPanel();
        loadCategories();
    }

    function setCountryValue(value, trigger = true) {
        const input = document.getElementById('country-filter');
        const label = document.querySelector('#country-toggle .livetv-country-label');
        const menu = document.getElementById('country-menu');
        input.value = value || '';

        if (!value) {
            label.textContent = 'All Countries';
        } else {
            const flagHtml = renderCountryFlag(value);
            const name = getCountryName(value);
            label.innerHTML = flagHtml + '<span>' + name + '</span>';
        }

        if (menu) {
            menu.querySelectorAll('.livetv-country-item').forEach(item => {
                item.classList.toggle('active', item.dataset.value === (value || ''));
            });
        }

        if (trigger) handleCountryChange(value || '');
    }

    function setSourceValue(value, trigger = true) {
        const input = document.getElementById('source-filter');
        if (!input) return;
        input.value = value || '';
        if (trigger) handleSourceChange(value || '');
    }

    async function loadCategories() {
        if (loadCategories.loading) return;
        loadCategories.loading = true;
        sourceFilterReady = false;
        try {
            try {
                const settingsResp = await fetch('/api/settings');
                const settings = await settingsResp.json();
                preferredLanguages = (settings.preferredLanguages || []).map(l => l.toUpperCase());
            } catch (err) {
                console.error('Failed to load settings:', err);
                preferredLanguages = [];
            }

            let filters = {};
            try {
                const filtersUrl = '/api/filters?type=live' + (currentSource ? '&source=' + encodeURIComponent(currentSource) : '');
                const response = await fetch(filtersUrl);
                filters = await response.json();
            } catch (err) {
                console.error('Failed to load filters:', err);
            }

            sourcesList = Array.isArray(filters.sources) ? filters.sources.filter(s => s && s.id) : [];
            if (sourcesList.length === 0) {
                try {
                    const sourcesResp = await fetch('/api/sources');
                    const sources = await sourcesResp.json();
                    sourcesList = Array.isArray(sources) ? sources.filter(s => s && s.id) : [];
                } catch (err) {
                    console.error('Failed to load sources:', err);
                }
            }

            // Build category -> language map from API response
            categoryLanguageMap = {};
            (filters.categories || []).filter(cat => cat).forEach(cat => {
                if (typeof cat === 'object') {
                    const key = cat.value || cat.category;
                    if (key && cat.language) {
                        categoryLanguageMap[key] = cat.language;
                    }
                }
            });

            // Handle both old (string) and new (object) category formats
            allCategories = (filters.categories || []).filter(cat => cat).map(cat => {
                if (typeof cat === 'object') return cat.value || cat.category;
                return cat;
            }).filter(Boolean);

            const seenCategories = new Set();
            allCategories = allCategories.filter(cat => {
                if (seenCategories.has(cat)) return false;
                seenCategories.add(cat);
                return true;
            });

            if (preferredLanguages.length > 0) {
                const filtered = allCategories.filter(cat => {
                    const country = getCategoryCountry(cat);
                    return !country || preferredLanguages.includes(country);
                });
                if (filtered.length > 0) {
                    allCategories = filtered;
                }
            }

            populateSourceFilter();
            populateCountryFilter();
            if (currentCategory && !allCategories.includes(currentCategory)) {
                resetChannelsPanel();
            }
            applyFilters();
        } catch (err) {
            console.error('Failed to load categories:', err);
        } finally {
            if (!sourceFilterReady) populateSourceFilter();
            loadCategories.loading = false;
        }
    }

    function populateSourceFilter() {
        const select = document.getElementById('source-filter');
        if (!select) return;

        select.innerHTML = '<option value="">All Sources</option>';
        sourcesList.forEach(source => {
            const value = String(source.id);
            const name = source.name || `Source ${value}`;
            select.innerHTML += '<option value="' + value + '">' + name + '</option>';
        });

        setSourceValue(currentSource || '', false);
        sourceFilterReady = true;
    }

    function populateCountryFilter() {
        const countries = new Set();
        let hasOther = false;
        allCategories.forEach(cat => {
            const country = getCategoryCountry(cat);
            if (country) {
                countries.add(country);
            } else {
                hasOther = true;
            }
        });

        const priority = ['DE', 'US', 'UK', 'FR', 'ES', 'IT'];
        const sortedCountries = Array.from(countries).sort((a, b) => {
            const aIdx = priority.indexOf(a);
            const bIdx = priority.indexOf(b);
            if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
            if (aIdx !== -1) return -1;
            if (bIdx !== -1) return 1;
            return a.localeCompare(b);
        });

        const menu = document.getElementById('country-menu');
        if (!menu) return;

        menu.innerHTML = '';
        menu.innerHTML += '<button type="button" class="livetv-country-item" data-value="">All Countries</button>';
        sortedCountries.forEach(code => {
            const flagHtml = renderCountryFlag(code);
            const name = getCountryName(code);
            menu.innerHTML += '<button type="button" class="livetv-country-item" data-value="' + code + '">' + flagHtml + '<span>' + name + '</span></button>';
        });
        if (hasOther) {
            menu.innerHTML += '<button type="button" class="livetv-country-item" data-value="OTHER">' + getCountryName('OTHER') + '</button>';
        }

        menu.querySelectorAll('.livetv-country-item').forEach(item => {
            item.addEventListener('click', () => {
                setCountryValue(item.dataset.value || '');
                menu.classList.add('hidden');
            });
        });

        setCountryValue(currentCountry || '', false);
    }

    function applyFilters() {
        const query = document.getElementById('search-input').value.toLowerCase();
        let filtered = allCategories;

        if (currentCountry) {
            if (currentCountry === 'OTHER') {
                // Show categories without a country
                filtered = filtered.filter(cat => !getCategoryCountry(cat));
            } else {
                filtered = filtered.filter(cat => getCategoryCountry(cat) === currentCountry);
            }
        }

        if (query) {
            filtered = filtered.filter(cat =>
                cat.toLowerCase().includes(query) ||
                getCategoryDisplayName(cat).toLowerCase().includes(query)
            );
        }

        renderCategories(filtered);
    }

    function updateResultCount() {
        const countEl = document.getElementById('results-count');
        const labelEl = document.getElementById('results-label');
        if (currentCategory) {
            countEl.textContent = document.getElementById('channels-count').textContent || '0';
            labelEl.textContent = 'channels';
        } else {
            countEl.textContent = document.getElementById('categories-count').textContent || '0';
            labelEl.textContent = 'categories';
        }
    }

    // Country colors for gradient backgrounds
    const countryColors = {
        'DE': { from: '#000000', to: '#DD0000', accent: '#FFCC00' },
        'US': { from: '#002868', to: '#BF0A30', accent: '#FFFFFF' },
        'UK': { from: '#00247D', to: '#CF142B', accent: '#FFFFFF' },
        'FR': { from: '#002395', to: '#ED2939', accent: '#FFFFFF' },
        'ES': { from: '#AA151B', to: '#F1BF00', accent: '#FFFFFF' },
        'IT': { from: '#009246', to: '#CE2B37', accent: '#FFFFFF' },
        'NL': { from: '#21468B', to: '#AE1C28', accent: '#FFFFFF' },
        'PL': { from: '#DC143C', to: '#FFFFFF', accent: '#DC143C' },
        'TR': { from: '#E30A17', to: '#E30A17', accent: '#FFFFFF' },
        'PT': { from: '#006600', to: '#FF0000', accent: '#FFCC00' },
        'BR': { from: '#009739', to: '#FEDD00', accent: '#002776' },
        'default': { from: '#667eea', to: '#764ba2', accent: '#FFFFFF' }
    };

    function getCountryColors(country) {
        return countryColors[country] || countryColors['default'];
    }

    async function fetchChannelCounts() {
        try {
            const url = '/api/livetv/counts' + (currentSource ? '?source=' + encodeURIComponent(currentSource) : '');
            const response = await fetch(url);
            return await response.json();
        } catch (e) {
            return {};
        }
    }

    async function renderCategories(categories) {
        const container = document.getElementById('categories-view');
        container.innerHTML = '';

        const channelCounts = await fetchChannelCounts();
        const sorted = [...categories].sort((a, b) => {
            const countryA = getCategoryCountry(a) || '';
            const countryB = getCategoryCountry(b) || '';
            if (countryA !== countryB) return countryA.localeCompare(countryB);
            return getCategoryDisplayName(a).localeCompare(getCategoryDisplayName(b));
        });

        if (sorted.length === 0) {
            container.innerHTML = '<div class="livetv-empty">No categories found</div>';
        } else {
            sorted.forEach(cat => {
                const displayName = getCategoryDisplayName(cat);
                const count = channelCounts[cat] || 0;
                const isActive = currentCategory === cat;
                const country = getCategoryCountry(cat);
                const flag = renderFlag(country);
                const colors = getCountryColors(country);
                const encodedCategory = encodeURIComponent(cat);

                container.innerHTML += `
                    <button class="livetv-category-item ${isActive ? 'active' : ''}"
                        data-category="${encodedCategory}">
                        <span class="livetv-category-flag">${flag}</span>
                        <span class="livetv-category-label">
                            <span class="livetv-category-name">${displayName}</span>
                            <span class="livetv-category-meta">${count > 0 ? count + ' channels' : 'No channels'}</span>
                        </span>
                        <span class="livetv-category-accent" style="background: linear-gradient(135deg, ${colors.from}55 0%, ${colors.to}55 100%);"></span>
                    </button>
                `;
            });
        }

        document.getElementById('categories-count').textContent = categories.length;
        updateResultCount();

        container.querySelectorAll('.livetv-category-item').forEach(button => {
            button.addEventListener('click', () => {
                const value = button.dataset.category ? decodeURIComponent(button.dataset.category) : '';
                if (value) selectCategory(value);
            });
        });
    }

    function selectCategory(category) {
        currentCategory = category;
        currentOffset = 0;
        currentChannel = null;

        document.getElementById('page-subtitle').textContent = getCategoryDisplayName(category);
        document.getElementById('search-input').placeholder = 'Search in ' + getCategoryDisplayName(category) + '...';
        document.getElementById('search-input').value = '';
        document.getElementById('channels-title').textContent = getCategoryDisplayName(category);
        document.getElementById('channels-count').textContent = '0';
        document.getElementById('channels-placeholder').classList.add('hidden');
        document.getElementById('empty-state').classList.add('hidden');

        resetEpgPanel();
        updateResultCount();
        applyFilters();
        loadChannels(true);
    }

    function resetChannelsPanel() {
        currentCategory = null;
        currentChannel = null;
        currentOffset = 0;

        document.getElementById('channels-title').textContent = 'Channels';
        document.getElementById('channels-count').textContent = '0';
        document.querySelectorAll('.livetv-channel-row').forEach(row => row.remove());
        document.getElementById('channels-placeholder').classList.remove('hidden');
        document.getElementById('load-more').classList.add('hidden');
        document.getElementById('empty-state').classList.add('hidden');
        document.getElementById('page-subtitle').textContent = 'Select a category to browse channels';
        document.getElementById('search-input').placeholder = 'Search channels or categories...';

        resetEpgPanel();
        updateResultCount();
    }

    function resetEpgPanel() {
        document.getElementById('epg-channel-name').textContent = 'No channel selected';
        document.getElementById('epg-view').innerHTML = '<div class="livetv-placeholder">Select a channel to see program info.</div>';
    }

    function selectChannel(channel) {
        currentChannel = channel;
        const channelName = cleanChannelTitle(channel.title);

        document.getElementById('epg-channel-name').textContent = channelName;
        document.querySelectorAll('.livetv-channel-row').forEach(row => {
            row.classList.toggle('active', row.dataset.channelId === String(channel.id));
        });

        loadChannelEpg(channel);
    }

    function formatEpgTime(dateStr) {
        if (!dateStr) return '--:--';
        const date = new Date(dateStr);
        if (Number.isNaN(date.getTime())) return '--:--';
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    async function loadChannelEpg(channel) {
        const epgView = document.getElementById('epg-view');
        if (!channel?._epgEnabled || !channel?.tvg_id) {
            epgView.innerHTML = '<div class="livetv-placeholder">No EPG data for this channel.</div>';
            return;
        }

        epgView.innerHTML = '<div class="livetv-epg-loading">Loading program info...</div>';

        try {
            const response = await fetch('/api/epg/channel/' + encodeURIComponent(channel.tvg_id));
            const data = await response.json();
            renderEpgPanel(data);
        } catch (err) {
            console.error('Failed to load channel EPG:', err);
            epgView.innerHTML = '<div class="livetv-placeholder">Failed to load EPG data.</div>';
        }
    }

    function renderEpgPanel(data) {
        const epgView = document.getElementById('epg-view');
        const current = data?.current;
        const upcoming = data?.upcoming || [];
        const recordButton = currentChannel
            ? '<div class="livetv-epg-actions"><button class="btn btn-danger btn-sm" onclick="openRecordModal(currentChannel)">Record</button></div>'
            : '';

        const currentBlock = current ? `
            <div class="livetv-epg-block">
                <div class="livetv-epg-label">Now</div>
                <div class="livetv-epg-title">${current.title || 'Unknown'}</div>
                <div class="livetv-epg-time">${formatEpgTime(current.start_time)} - ${formatEpgTime(current.end_time)}</div>
                <div class="livetv-epg-desc">${current.description || 'No description available.'}</div>
            </div>
        ` : `
            <div class="livetv-epg-block">
                <div class="livetv-epg-label">Now</div>
                <div class="livetv-epg-title">No current program</div>
            </div>
        `;

        const upcomingItems = upcoming.length ? upcoming.map(item => {
            const title = item.title || 'Unknown';
            const start = item.start_time || '';
            const end = item.end_time || '';
            const recordable = currentChannel && item.id && start && end;
            const recordBtn = recordable
                ? `<button class="livetv-epg-record-btn" data-program-id="${item.id}" data-start-time="${start}" data-end-time="${end}" data-title="${encodeURIComponent(title)}">Record</button>`
                : '';

            return `
            <div class="livetv-epg-item">
                <div class="livetv-epg-item-main">
                    <div class="livetv-epg-item-time">${formatEpgTime(start)} - ${formatEpgTime(end)}</div>
                    <div class="livetv-epg-item-title">${title}</div>
                </div>
                ${recordBtn}
            </div>
        `;
        }).join('') : '<div class="livetv-epg-empty">No upcoming programs.</div>';

        epgView.innerHTML = `
            ${currentBlock}
            ${recordButton}
            <div class="livetv-epg-block">
                <div class="livetv-epg-label">Up Next</div>
                <div class="livetv-epg-list">${upcomingItems}</div>
            </div>
        `;

        epgView.querySelectorAll('.livetv-epg-record-btn').forEach(button => {
            button.addEventListener('click', async (event) => {
                event.stopPropagation();
                if (!currentChannel) return;

                const programId = parseInt(button.dataset.programId, 10);
                const startTime = button.dataset.startTime;
                const endTime = button.dataset.endTime;
                const title = button.dataset.title ? decodeURIComponent(button.dataset.title) : 'Recording';

                try {
                    const resp = await fetch('/api/recordings', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            mediaId: currentChannel.id,
                            title,
                            startTime,
                            endTime,
                            epgProgramId: programId
                        })
                    });

                    const result = await resp.json();
                    if (resp.ok) {
                        if (window.showToast) showToast('Recording scheduled!', 'success');
                    } else {
                        throw new Error(result.error || 'Unknown error');
                    }
                } catch (err) {
                    console.error('Failed to schedule recording:', err);
                    if (window.showToast) showToast('Failed to schedule recording: ' + err.message, 'error');
                }
            });
        });
    }

    // Smart title cleaning - detects and removes country/language prefixes
    // Handles various IPTV provider formats like: DE ❖ Name, FR - Name, [US] Name, UK: Name, etc.
    function cleanChannelTitle(title) {
        if (!title) return '';

        // Country codes to detect (2-3 letter codes)
        const countryCodes = ['DE', 'FR', 'US', 'UK', 'GB', 'ES', 'IT', 'NL', 'BE', 'AT', 'CH', 'PL', 'PT', 'TR', 'GR', 'RU', 'BR', 'MX', 'AR', 'CA', 'AU', 'IN', 'JP', 'KR', 'CN', 'HK', 'TW', 'SE', 'NO', 'DK', 'FI', 'CZ', 'SK', 'HU', 'RO', 'BG', 'HR', 'SI', 'RS', 'BA', 'AL', 'MK', 'XK', 'ME', 'ENG', 'GER', 'SPA', 'FRA', 'ITA', 'POR', 'DUT', 'POL', 'TUR', 'ARA', 'RUS', 'HIN', 'JPN'];
        const codePattern = countryCodes.join('|');

        // Patterns to match and remove (order matters - more specific first)
        const patterns = [
            // [DE] Name or (DE) Name
            new RegExp(`^\\\\[(${codePattern})\\\\]\\\\s*`, 'i'),
            new RegExp(`^\\\\((${codePattern})\\\\)\\\\s*`, 'i'),
            // DE ❖ Name or DE ✦ Name (special symbols)
            new RegExp(`^(${codePattern})\\\\s*[❖✦★●◆◇▶►▷■□☆✧✩✪✫✬✭✮✯✰]\\\\s*`, 'i'),
            // DE | Name or DE / Name
            new RegExp(`^(${codePattern})\\\\s*[|/]\\\\s*`, 'i'),
            // DE - Name or DE : Name
            new RegExp(`^(${codePattern})\\\\s*[-:]\\\\s*`, 'i'),
            // DE_ Name (underscore separator)
            new RegExp(`^(${codePattern})_\\\\s*`, 'i'),
            // DE Name (just space, but only if followed by uppercase)
            new RegExp(`^(${codePattern})\\\\s+(?=[A-Z])`, 'i'),
        ];

        let cleaned = title.trim();
        for (const pattern of patterns) {
            cleaned = cleaned.replace(pattern, '');
        }

        // Also clean up any trailing quality markers if they're at the start: HD, SD, FHD, 4K
        cleaned = cleaned.replace(/^(HD|SD|FHD|UHD|4K)\\s*[-:|]?\\s*/i, '');

        return cleaned.trim() || title;
    }

    async function loadChannels(reset = false) {
        if (loading || !currentCategory) return;
        loading = true;

        const list = document.getElementById('channels-view');
        const emptyState = document.getElementById('empty-state');

        if (reset) {
            currentOffset = 0;
            document.querySelectorAll('.livetv-channel-row').forEach(row => row.remove());
        }

        const params = new URLSearchParams({
            type: 'live',
            search: document.getElementById('search-input').value,
            category: currentCategory || '',
            limit,
            offset: currentOffset
        });
        if (currentSource) params.set('source', currentSource);

        try {
            const response = await fetch('/api/media?' + params);
            const data = await response.json();
            const channels = data.items || data;
            const tvgIdCounts = channels.reduce((acc, channel) => {
                const id = channel.tvg_id || '';
                if (!id) return acc;
                acc[id] = (acc[id] || 0) + 1;
                return acc;
            }, {});

            if (channels.length === 0 && currentOffset === 0) {
                emptyState.classList.remove('hidden');
                document.getElementById('channels-count').textContent = '0';
                updateResultCount();
                loading = false;
                return;
            }

            emptyState.classList.add('hidden');
            document.getElementById('channels-placeholder').classList.add('hidden');

            channels.forEach((channel, index) => {
                const imgSrc = channel.id ? `/logo/${channel.id}` : '/static/img/no-logo.svg';
                const isEager = currentOffset === 0 && index < 16;
                const displayName = cleanChannelTitle(channel.title);
                channel._epgEnabled = Boolean(channel.tvg_id) && tvgIdCounts[channel.tvg_id] === 1;
                const channelJson = JSON.stringify(channel).replace(/"/g, '&quot;');
                const epgId = channel._epgEnabled ? channel.tvg_id : '';

                list.innerHTML += `
                    <div class="livetv-channel-row" data-channel-id="${channel.id}" oncontextmenu="showContextMenu(event, ${channelJson})" onclick="selectChannel(${channelJson})">
                        <div class="livetv-channel-logo">
                            <img src="${isEager ? imgSrc : '/static/img/no-logo.svg'}"
                                 data-src="${imgSrc}"
                                 alt="${displayName}"
                                 class="${isEager ? '' : 'lazy-image'}"
                                 onerror="this.src='/static/img/no-logo.svg'" />
                        </div>
                        <div class="livetv-channel-meta">
                            <div class="livetv-channel-name">${displayName}</div>
                            <div class="livetv-channel-epg">
                                <span class="livetv-now-label">Now</span>
                                <span class="livetv-now-title epg-now" data-tvg-id="${epgId}">${channel._epgEnabled ? 'Loading...' : 'No EPG data'}</span>
                            </div>
                            <div class="livetv-epg-progress" data-tvg-id-progress="${epgId}">
                                <div class="livetv-epg-progress-bar" style="width: 0%"></div>
                            </div>
                        </div>
                        <div class="livetv-channel-actions">
                            <button class="livetv-row-action" onclick="event.stopPropagation(); previewChannel(${channelJson})" title="Preview in Browser">
                                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                                    <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                    <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                </svg>
                            </button>
                            <button class="livetv-row-action" onclick="event.stopPropagation(); openChannelInBrowser(${channelJson})" title="Open in Browser">
                                <svg fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M4 5a2 2 0 012-2h12a2 2 0 012 2v3H4V5zm0 5h16v9a2 2 0 01-2 2H6a2 2 0 01-2-2v-9zm3 3v2h2v-2H7zm4 0v2h2v-2h-2z"/>
                                </svg>
                            </button>
                            <button class="livetv-row-action" onclick="event.stopPropagation(); openRecordModal(${channelJson})" title="Record Channel">
                                <svg fill="currentColor" viewBox="0 0 24 24">
                                    <circle cx="12" cy="12" r="8"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                `;
            });

            initLazyLoad();

            const tvgIds = channels.filter(c => c._epgEnabled && c.tvg_id).map(c => c.tvg_id);
            if (tvgIds.length > 0) {
                fetchEpgForChannels(tvgIds);
            } else {
                document.querySelectorAll('.epg-now').forEach(el => {
                    if (el.textContent === 'Loading...') el.textContent = 'No EPG data';
                });
            }

            const totalLoaded = currentOffset + channels.length;
            document.getElementById('channels-count').textContent = totalLoaded.toLocaleString();
            updateResultCount();

            document.getElementById('load-more').classList.toggle('hidden', channels.length < limit);
            if (channels.length === limit) currentOffset += limit;
        } catch (err) {
            console.error('Failed to load channels:', err);
        }
        loading = false;
    }

    function openChannelInBrowser(channel) {
        if (!channel.stream_url) {
            if (window.showToast) showToast('No stream URL available', 'error');
            return;
        }

        const browserUrl = '/player?url=' + encodeURIComponent(channel.stream_url);
        window.open(browserUrl, '_blank', 'noopener');
        if (window.showToast) showToast('Opening in browser...', 'success');
    }

    async function fetchEpgForChannels(tvgIds) {
        try {
            const response = await fetch('/api/epg/channels', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channelIds: tvgIds })
            });
            const epgData = await response.json();

            document.querySelectorAll('.epg-now').forEach(el => {
                const tvgId = el.dataset.tvgId;
                if (tvgId && epgData[tvgId]?.current) {
                    const program = epgData[tvgId].current;
                    el.textContent = program.title;
                    el.title = program.title;

                    // Update progress bar
                    const progressEl = document.querySelector(`[data-tvg-id-progress="${tvgId}"] .livetv-epg-progress-bar`);
                    if (progressEl && program.start_time && program.end_time) {
                        const start = new Date(program.start_time).getTime();
                        const end = new Date(program.end_time).getTime();
                        const now = Date.now();
                        const progress = Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100));
                        progressEl.style.width = progress + '%';
                    }
                } else if (tvgId) {
                    el.textContent = 'No program info';
                }
            });
        } catch (err) {
            console.error('Failed to fetch EPG:', err);
            document.querySelectorAll('.epg-now').forEach(el => {
                if (el.textContent === 'Loading...') el.textContent = 'No program info';
            });
        }
    }

    // Preview channel in browser
    function previewChannel(channel) {
        if (!channel.stream_url) {
            if (window.showToast) showToast('No stream URL available', 'error');
            return;
        }

        // Use the preview modal from main layout
        if (typeof openPreview === 'function') {
            openPreview(channel.stream_url, channel.title, '', '');
        } else {
            // Fallback to VLC
            playChannel(channel);
        }
    }

    // Event listeners
    document.getElementById('search-input').addEventListener('input', debounce((e) => {
        if (currentCategory) loadChannels(true);
        else applyFilters();
    }, 300));

    const countryDropdown = document.getElementById('country-dropdown');
    const countryToggle = document.getElementById('country-toggle');
    const countryMenu = document.getElementById('country-menu');
    if (countryDropdown && countryToggle && countryMenu) {
        countryToggle.addEventListener('click', (event) => {
            event.stopPropagation();
            countryMenu.classList.toggle('hidden');
        });
        document.addEventListener('click', (event) => {
            if (!countryDropdown.contains(event.target)) {
                countryMenu.classList.add('hidden');
            }
        });
    }

    document.getElementById('country-filter').addEventListener('change', (e) => {
        setCountryValue(e.target.value, false);
        handleCountryChange(e.target.value);
    });

    document.getElementById('source-filter').addEventListener('change', (e) => {
        setSourceValue(e.target.value, false);
        handleSourceChange(e.target.value);
    });

    document.getElementById('load-more').addEventListener('click', () => loadChannels(false));

    // Context menu
    let contextMenuChannel = null;

    function showContextMenu(e, channel) {
        e.preventDefault();
        e.stopPropagation();
        contextMenuChannel = channel;

        const menu = document.getElementById('context-menu');
        menu.classList.remove('hidden');

        let x = e.clientX, y = e.clientY;
        const menuRect = menu.getBoundingClientRect();
        if (x + menuRect.width > window.innerWidth) x = window.innerWidth - menuRect.width - 10;
        if (y + menuRect.height > window.innerHeight) y = window.innerHeight - menuRect.height - 10;

        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
    }

    function hideContextMenu() {
        document.getElementById('context-menu').classList.add('hidden');
        contextMenuChannel = null;
    }

    document.getElementById('ctx-play').addEventListener('click', () => {
        if (contextMenuChannel) playChannel(contextMenuChannel);
        hideContextMenu();
    });

    document.getElementById('ctx-record').addEventListener('click', () => {
        if (contextMenuChannel) openRecordModal(contextMenuChannel);
        hideContextMenu();
    });

    document.getElementById('ctx-copy').addEventListener('click', () => {
        if (contextMenuChannel?.stream_url) {
            navigator.clipboard.writeText(contextMenuChannel.stream_url).then(() => {
                if (window.showToast) showToast('Stream URL copied!', 'success');
            });
        }
        hideContextMenu();
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('#context-menu')) hideContextMenu();
    });
    document.addEventListener('scroll', hideContextMenu, true);

    // Recording modal
    let recordChannel = null;
    let recordingEndTime = null;

    function openRecordModal(channel) {
        recordChannel = channel;
        // Use cached logo endpoint for persistent logos
        const imgSrc = channel.id ? `/logo/${channel.id}` : '/static/img/no-logo.svg';
        document.getElementById('record-channel-logo').src = imgSrc;
        document.getElementById('record-channel-name').textContent = channel.title;
        document.getElementById('record-channel-category').textContent = channel.category || '';

        document.querySelectorAll('.duration-btn').forEach(btn => btn.classList.remove('btn-primary'));
        recordingEndTime = null;
        document.getElementById('record-end-display').textContent = '--:--';
        document.getElementById('record-end-time').value = '';

        selectDuration(60);
        document.getElementById('record-modal').classList.remove('hidden');
    }

    function closeRecordModal() {
        document.getElementById('record-modal').classList.add('hidden');
        recordChannel = null;
        recordingEndTime = null;
    }

    function selectDuration(minutes) {
        document.querySelectorAll('.duration-btn').forEach(btn => {
            const btnMinutes = parseInt(btn.dataset.minutes);
            btn.classList.toggle('btn-primary', btnMinutes === minutes);
            btn.classList.toggle('btn-secondary', btnMinutes !== minutes);
        });

        const endDate = new Date(Date.now() + minutes * 60 * 1000);
        recordingEndTime = endDate.toISOString();
        document.getElementById('record-end-display').textContent = endDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        document.getElementById('record-end-time').value = '';
    }

    document.querySelectorAll('.duration-btn').forEach(btn => {
        btn.addEventListener('click', () => selectDuration(parseInt(btn.dataset.minutes)));
    });

    document.getElementById('record-end-time').addEventListener('change', (e) => {
        if (e.target.value) {
            document.querySelectorAll('.duration-btn').forEach(btn => {
                btn.classList.remove('btn-primary');
                btn.classList.add('btn-secondary');
            });

            const [hours, minutes] = e.target.value.split(':').map(Number);
            const endDate = new Date();
            endDate.setHours(hours, minutes, 0, 0);
            if (endDate <= new Date()) endDate.setDate(endDate.getDate() + 1);

            recordingEndTime = endDate.toISOString();
            document.getElementById('record-end-display').textContent = endDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
    });

    async function startRecording() {
        if (!recordChannel || !recordingEndTime) {
            if (window.showToast) showToast('Please select a duration', 'error');
            return;
        }

        try {
            const resp = await fetch('/api/recordings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mediaId: recordChannel.id,
                    channelTvgId: recordChannel.tvg_id || null,
                    title: recordChannel.title,
                    startTime: new Date().toISOString(),
                    endTime: recordingEndTime
                })
            });

            const result = await resp.json();
            if (resp.ok) {
                if (window.showToast) showToast('Recording started!', 'success');
                closeRecordModal();
            } else {
                throw new Error(result.error || 'Unknown error');
            }
        } catch (err) {
            console.error('Failed to start recording:', err);
            if (window.showToast) showToast('Failed to start recording: ' + err.message, 'error');
        }
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { closeRecordModal(); hideContextMenu(); }
    });

    document.getElementById('record-modal').addEventListener('click', (e) => {
        if (e.target.id === 'record-modal') closeRecordModal();
    });

    // Initialize
    loadCategories();
    setInterval(() => {
        if (!document.hidden) loadCategories();
    }, 60000);

    const scrollContainers = [
        document.getElementById('categories-view'),
        document.getElementById('channels-view'),
        document.getElementById('epg-view')
    ].filter(Boolean);

    scrollContainers.forEach(container => {
        container.addEventListener('wheel', (event) => {
            event.stopPropagation();
        }, { passive: true });
    });

    function debounce(func, wait) {
        let timeout;
        return function(e) { clearTimeout(timeout); timeout = setTimeout(() => func(e), wait); };
    }
