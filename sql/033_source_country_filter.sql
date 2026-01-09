-- Add per-source country filter for syncing content
ALTER TABLE sources ADD COLUMN country_filter TEXT;
