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

exec /usr/local/bin/nas-api "$@"
