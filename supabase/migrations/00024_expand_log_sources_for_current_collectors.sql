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
      'drive_sharesync',
      'smb',
      'backup',
      'webapi',
      'storage',
      'share',
      'kernel',
      'system_info',
      'service',
      'kernel_health',
      'share_health',
      'share_config',
      'package_health',
      'dsm_system_log',
      'drive_admin_stats'
    )
  );
