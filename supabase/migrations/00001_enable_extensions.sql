-- Enable required extensions for synology monitor
-- pg_cron and pg_net are already installed, pg_partman needs enabling

create extension if not exists pg_partman schema public;
