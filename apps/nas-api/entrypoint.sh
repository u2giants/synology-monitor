#!/bin/bash
# Set up symlinks so Synology glibc binaries find their expected paths.
# The container bind-mounts host system paths under /host/; synopkg and
# related binaries read from the native DSM paths (/usr/syno, /var/packages,
# /etc/synoinfo.conf). Symlinking at start avoids Tier-2 approval overhead
# at every tool invocation.
ln -sfn /host/usr/syno          /usr/syno           2>/dev/null || true
ln -sfn /host/packages          /var/packages       2>/dev/null || true
ln -sfn /host/etc/synoinfo.conf /etc/synoinfo.conf  2>/dev/null || true
ln -sfn /host/etc.defaults      /etc.defaults       2>/dev/null || true

# Package start-stop-status scripts dereference target/ → /volume1/@appstore.
# That path isn't mounted directly; expose it via the btrfs full-volume mount.
ln -sfn /btrfs/volume1/@appstore /volume1/@appstore 2>/dev/null || true

# get_key_value is called by package scripts to read key=value config files.
# It is not a standalone binary on DSM; emulate it here.
if [ ! -x /usr/local/bin/get_key_value ]; then
  printf '#!/bin/sh\ngrep -m1 "^${2}=" "$1" 2>/dev/null | cut -d= -f2- | tr -d '"'"'\"'"'"'\n' \
    > /usr/local/bin/get_key_value
  chmod +x /usr/local/bin/get_key_value
fi

exec /usr/local/bin/nas-api "$@"
