-- Add per-source spoofing settings
-- Allows different IPTV sources to use different device identities

ALTER TABLE sources ADD COLUMN spoofed_mac TEXT;
ALTER TABLE sources ADD COLUMN spoofed_device_key TEXT;

-- Note: user_agent column already exists from initial schema
