alter table smon_logs
  drop constraint if exists smon_logs_source_check;

alter table smon_logs
  add constraint smon_logs_source_check
  check (
    source in (
      'system',
      'security',
      'connection',
      'package',
      'docker',
      'drive',
      'drive_server',
      'drive_sharesync'
    )
  );
