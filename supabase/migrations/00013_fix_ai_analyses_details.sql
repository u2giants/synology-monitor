-- Migration: 00013_fix_ai_analyses_details.sql
-- Fix: Add missing details column to smon_ai_analyses table
-- This unblocks the smon_process_ai_responses() pipeline which inserts into details column

-- Add the details column if it doesn't exist
ALTER TABLE smon_ai_analyses ADD COLUMN IF NOT EXISTS details jsonb;

-- Set default empty object for existing rows
UPDATE smon_ai_analyses SET details = '{}'::jsonb WHERE details IS NULL;

-- Add NOT NULL constraint now that all rows have values
ALTER TABLE smon_ai_analyses ALTER COLUMN details SET NOT NULL;
ALTER TABLE smon_ai_analyses ALTER COLUMN details SET DEFAULT '{}'::jsonb;

-- Verify the table structure
-- SELECT column_name, data_type, is_nullable, column_default 
-- FROM information_schema.columns 
-- WHERE table_name = 'smon_ai_analyses' 
-- ORDER BY ordinal_position;
