-- Track enrichment attempts for media items
ALTER TABLE media ADD COLUMN enrichment_attempted DATETIME;
