-- Add m3u_parser_config column to sources table for M3U URL parsing configuration
ALTER TABLE sources ADD COLUMN m3u_parser_config TEXT;
