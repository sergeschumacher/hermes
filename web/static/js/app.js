// Hermes Client-side JavaScript

const socket = io();

// Image proxy helper - routes external images through cache
function proxyImage(url) {
    if (!url) return '/static/img/no-poster.png';
    // Don't proxy local images or already proxied images
    if (url.startsWith('/') || url.startsWith(window.location.origin)) {
        return url;
    }
    return '/img?url=' + encodeURIComponent(url);
}

// Lazy loading with Intersection Observer
let lazyObserver = null;

function initLazyLoad() {
    if (!lazyObserver) {
        lazyObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    if (img.dataset.src) {
                        img.src = img.dataset.src;
                        img.classList.remove('lazy-image');
                        img.classList.add('lazy-loaded');
                        lazyObserver.unobserve(img);
                    }
                }
            });
        }, {
            rootMargin: '100px 0px', // Start loading 100px before visible
            threshold: 0.01
        });
    }

    // Observe all lazy images
    document.querySelectorAll('.lazy-image').forEach(img => {
        if (!img.dataset.observed) {
            img.dataset.observed = 'true';
            lazyObserver.observe(img);
        }
    });
}

// Socket event listeners
socket.on('connect', () => {
    console.log('Connected to server');
});

socket.on('disconnect', () => {
    console.log('Disconnected from server');
});

socket.on('notification', (data) => {
    showNotification(data.message, data.type || 'info');
});

socket.on('download:progress', (data) => {
    updateDownloadBadge();
});

socket.on('download:complete', (data) => {
    showNotification(`Download complete: ${data.title}`, 'success');
    updateDownloadBadge();
});

socket.on('download:failed', (data) => {
    showNotification(`Download failed: ${data.title} - ${data.error}`, 'error');
    updateDownloadBadge();
});

socket.on('sync:start', (data) => {
    const progressEl = document.getElementById('sync-progress-' + data.source);
    const statusEl = document.getElementById('sync-status-' + data.source);
    const barEl = document.getElementById('sync-bar-' + data.source);
    if (progressEl) {
        progressEl.classList.remove('hidden');
        if (statusEl) statusEl.textContent = 'Starting sync...';
        if (barEl) barEl.style.width = '0%';
    }
});

socket.on('sync:progress', (data) => {
    const progressEl = document.getElementById('sync-progress-' + data.source);
    const statusEl = document.getElementById('sync-status-' + data.source);
    const barEl = document.getElementById('sync-bar-' + data.source);

    if (progressEl) {
        // On settings page - update progress UI
        if (statusEl) statusEl.textContent = data.message;
        if (barEl && data.current && data.total) {
            const percent = Math.round((data.current / data.total) * 100);
            barEl.style.width = percent + '%';
        }
    } else {
        // Not on settings page - show notification
        showNotification(data.message || `Syncing ${data.step}...`, 'info');
    }
});

socket.on('sync:complete', (data) => {
    const progressEl = document.getElementById('sync-progress-' + data.source);
    const btnEl = document.getElementById('sync-btn-' + data.source);
    if (progressEl) {
        progressEl.classList.add('hidden');
        if (btnEl) btnEl.disabled = false;
        // Reload sources list if function exists
        if (typeof loadSources === 'function') loadSources();
    }
    showNotification('Sync complete!', 'success');
});

socket.on('sync:error', (data) => {
    const progressEl = document.getElementById('sync-progress-' + data.source);
    const btnEl = document.getElementById('sync-btn-' + data.source);
    if (progressEl) {
        progressEl.classList.add('hidden');
        if (btnEl) btnEl.disabled = false;
    }
    showNotification(`Sync error: ${data.error}`, 'error');
});

// TMDB Enrichment events
socket.on('enrich:start', (data) => {
    const progressEl = document.getElementById('enrich-progress');
    const statusEl = document.getElementById('enrich-status');
    const barEl = document.getElementById('enrich-bar');
    const btnEl = document.getElementById('enrich-btn');
    if (progressEl) {
        progressEl.classList.remove('hidden');
        if (statusEl) statusEl.textContent = `Starting enrichment of ${data.total} items...`;
        if (barEl) barEl.style.width = '0%';
        if (btnEl) btnEl.disabled = true;
    }
});

socket.on('enrich:progress', (data) => {
    const statusEl = document.getElementById('enrich-status');
    const barEl = document.getElementById('enrich-bar');
    if (statusEl) {
        statusEl.textContent = `${data.message} (${data.success} success, ${data.failed} failed)`;
    }
    if (barEl && data.current && data.total) {
        const percent = Math.round((data.current / data.total) * 100);
        barEl.style.width = percent + '%';
    }
});

socket.on('enrich:complete', (data) => {
    const progressEl = document.getElementById('enrich-progress');
    const btnEl = document.getElementById('enrich-btn');
    if (progressEl) {
        progressEl.classList.add('hidden');
        if (btnEl) btnEl.disabled = false;
    }
    showNotification(`Enrichment complete: ${data.success} posters updated, ${data.failed} failed`, 'success');
    // Refresh stats if function exists
    if (typeof loadEnrichStats === 'function') loadEnrichStats();
});

// Notification system
function showNotification(message, type = 'info') {
    const container = document.getElementById('notifications') || createNotificationContainer();

    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.innerHTML = `
        <span>${message}</span>
        <button onclick="this.parentElement.remove()">&times;</button>
    `;

    container.appendChild(notification);

    setTimeout(() => {
        notification.classList.add('fade-out');
        setTimeout(() => notification.remove(), 300);
    }, 5000);
}

function createNotificationContainer() {
    const container = document.createElement('div');
    container.id = 'notifications';
    container.className = 'fixed top-4 right-4 z-50 space-y-2';
    document.body.appendChild(container);

    // Add notification styles
    const style = document.createElement('style');
    style.textContent = `
        .notification {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 1rem;
            padding: 0.75rem 1rem;
            border-radius: 0.5rem;
            color: white;
            font-size: 0.875rem;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.3);
            animation: slideIn 0.3s ease;
        }
        .notification button {
            background: none;
            border: none;
            color: inherit;
            cursor: pointer;
            font-size: 1.25rem;
            line-height: 1;
            opacity: 0.7;
        }
        .notification button:hover { opacity: 1; }
        .notification-info { background: #0284c7; }
        .notification-success { background: #059669; }
        .notification-error { background: #dc2626; }
        .notification-warning { background: #d97706; }
        .notification.fade-out { animation: fadeOut 0.3s ease forwards; }
        @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @keyframes fadeOut { from { opacity: 1; } to { opacity: 0; } }
    `;
    document.head.appendChild(style);

    return container;
}

// Update download badge
async function updateDownloadBadge() {
    try {
        const response = await fetch('/api/stats');
        const stats = await response.json();
        const badge = document.getElementById('download-badge');
        if (badge) {
            badge.textContent = stats.activeDownloads;
            badge.classList.toggle('hidden', stats.activeDownloads === 0);
        }
    } catch (err) {
        console.error('Failed to update download badge:', err);
    }
}

// Utility: Debounce function
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

// Utility: Format file size
function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Utility: Format duration
function formatDuration(minutes) {
    if (!minutes) return '';
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    updateDownloadBadge();
});
