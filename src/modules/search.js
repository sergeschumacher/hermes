let logger = null;
let db = null;

module.exports = {
    init: async (modules) => {
        logger = modules.logger;
        db = modules.db;
    },

    // Full-text search across media
    search: async (query, options = {}) => {
        const {
            type,
            year,
            quality,
            language,
            category,
            limit = 50,
            offset = 0
        } = options;

        let sql = `
            SELECT * FROM media
            WHERE (title LIKE ? OR original_title LIKE ? OR plot LIKE ?)
        `;
        const params = [`%${query}%`, `%${query}%`, `%${query}%`];

        if (type) {
            sql += ' AND media_type = ?';
            params.push(type);
        }
        if (year) {
            sql += ' AND year = ?';
            params.push(year);
        }
        if (quality) {
            sql += ' AND quality = ?';
            params.push(quality);
        }
        if (language) {
            sql += ' AND language = ?';
            params.push(language);
        }
        if (category) {
            sql += ' AND category LIKE ?';
            params.push(`%${category}%`);
        }

        sql += ' ORDER BY rating DESC NULLS LAST, title ASC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        return db.all(sql, params);
    },

    // Get filter options
    getFilters: async (type = null) => {
        const years = await db.all('SELECT DISTINCT year FROM media WHERE year IS NOT NULL ORDER BY year DESC');
        const qualities = await db.all('SELECT DISTINCT quality FROM media WHERE quality IS NOT NULL');
        const languages = await db.all('SELECT DISTINCT language FROM media WHERE language IS NOT NULL');

        // For live TV, get categories with their associated language
        // This helps group categories by country even when category name doesn't have country prefix
        let categories;
        if (type === 'live') {
            categories = await db.all(`
                SELECT DISTINCT category, language
                FROM media
                WHERE category IS NOT NULL AND media_type = 'live' AND is_active = 1
                ORDER BY category
            `);
        } else {
            categories = await db.all('SELECT DISTINCT category FROM media WHERE category IS NOT NULL ORDER BY category');
        }

        return {
            years: years.map(y => y.year),
            qualities: qualities.map(q => q.quality),
            languages: languages.map(l => l.language),
            categories: type === 'live'
                ? categories.map(c => ({ value: c.category, language: c.language, display_name: c.category.replace(/^\|?[A-Z]{2}\|\s*/i, '') }))
                : categories.map(c => c.category)
        };
    },

    // Get recently added media
    getRecent: async (limit = 20) => {
        return db.all(`
            SELECT * FROM media
            WHERE media_type IN ('movie', 'series')
            ORDER BY created_at DESC
            LIMIT ?
        `, [limit]);
    },

    // Get popular (by rating)
    getPopular: async (type = null, limit = 20) => {
        let sql = 'SELECT * FROM media WHERE rating IS NOT NULL';
        const params = [];

        if (type) {
            sql += ' AND media_type = ?';
            params.push(type);
        }

        sql += ' ORDER BY rating DESC LIMIT ?';
        params.push(limit);

        return db.all(sql, params);
    }
};
