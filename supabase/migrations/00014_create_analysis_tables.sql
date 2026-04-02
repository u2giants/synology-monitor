-- Migration: 00014_create_analysis_tables.sql
-- Creates tables for AI-powered root cause analysis

-- Table to store each analysis run
CREATE TABLE IF NOT EXISTS smon_analysis_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  summary text NOT NULL,
  problem_count integer NOT NULL DEFAULT 0,
  model text NOT NULL DEFAULT 'MiniMax-M2.7',
  tokens_used integer DEFAULT 0,
  lookback_minutes integer NOT NULL DEFAULT 60,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Table to store each distinct problem identified by AI
CREATE TABLE IF NOT EXISTS smon_analyzed_problems (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id uuid NOT NULL REFERENCES smon_analysis_runs(id) ON DELETE CASCADE,
  slug text NOT NULL,
  title text NOT NULL,
  explanation text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  affected_nas text[] NOT NULL DEFAULT '{}',
  affected_shares text[] NOT NULL DEFAULT '{}',
  affected_users text[] NOT NULL DEFAULT '{}',
  affected_files jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_event_count integer NOT NULL DEFAULT 0,
  raw_event_ids text[] NOT NULL DEFAULT '{}',
  technical_diagnosis text NOT NULL,
  first_seen timestamptz,
  last_seen timestamptz,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved')),
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_analyzed_problems_status ON smon_analyzed_problems(status);
CREATE INDEX IF NOT EXISTS idx_analyzed_problems_severity ON smon_analyzed_problems(severity);
CREATE INDEX IF NOT EXISTS idx_analyzed_problems_analysis_run ON smon_analyzed_problems(analysis_run_id);
CREATE INDEX IF NOT EXISTS idx_analysis_runs_created ON smon_analysis_runs(created_at DESC);

-- Enable RLS
ALTER TABLE smon_analysis_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE smon_analyzed_problems ENABLE ROW LEVEL SECURITY;

-- Policies - read access for authenticated users
CREATE POLICY IF NOT EXISTS "smon_analysis_runs_read" ON smon_analysis_runs
  FOR SELECT TO authenticated USING (true);

CREATE POLICY IF NOT EXISTS "smon_analyzed_problems_read" ON smon_analyzed_problems
  FOR SELECT TO authenticated USING (true);

-- Allow service role to insert (for API routes)
CREATE POLICY IF NOT EXISTS "smon_analysis_runs_insert" ON smon_analysis_runs
  FOR INSERT TO service_role WITH CHECK (true);

CREATE POLICY IF NOT EXISTS "smon_analyzed_problems_insert" ON smon_analyzed_problems
  FOR INSERT TO service_role WITH CHECK (true);
