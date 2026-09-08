#!/bin/sh
set -eu

# DNS-01 renewal for the private Tailscale-only DSM hostname.
umask 077

DOMAIN="${CERT_DOMAIN:-edge1.designflow.app}"
ARCHIVE_ID="${CERT_ARCHIVE_ID:-nS2S34}"
RENEW_ROOT="${CERT_RENEW_ROOT:-/volume1/docker/synology-monitor-agent/cert-renewal}"
LEGO="$RENEW_ROOT/lego"
STATE="$RENEW_ROOT/state"
TOKEN_FILE="$RENEW_ROOT/cloudflare-token"
ARCHIVE="/usr/syno/etc/certificate/_archive/$ARCHIVE_ID"
STAGE="$RENEW_ROOT/.deploy.$$"
BACKUP=""

cleanup_or_rollback() {
  rc=$?
  trap - EXIT HUP INT TERM
  if [ "$rc" -ne 0 ] && [ -n "$BACKUP" ] && [ -d "$BACKUP/archive" ]; then
    cp "$BACKUP/archive/cert.pem" "$ARCHIVE/cert.pem"
    cp "$BACKUP/archive/chain.pem" "$ARCHIVE/chain.pem"
    cp "$BACKUP/archive/fullchain.pem" "$ARCHIVE/fullchain.pem"
    cp "$BACKUP/archive/privkey.pem" "$ARCHIVE/privkey.pem"
    /usr/syno/bin/synow3tool --gen-all || true
    /usr/syno/bin/synosystemctl restart nginx || true
  fi
  rm -rf "$STAGE"
  exit "$rc"
}
trap cleanup_or_rollback EXIT HUP INT TERM

[ "$(id -u)" -eq 0 ]
[ -x "$LEGO" ]
[ -s "$TOKEN_FILE" ]
[ -d "$ARCHIVE" ]

CLOUDFLARE_DNS_API_TOKEN=$(cat "$TOKEN_FILE")
export CLOUDFLARE_DNS_API_TOKEN

"$LEGO" run \
  --path "$STATE" \
  --email u2giants@gmail.com \
  --accept-tos \
  --dns cloudflare \
  --dns.resolvers 1.1.1.1:53 \
  --domains "$DOMAIN" \
  --key-type EC256

CERT_DIR="$STATE/certificates"
BUNDLE="$CERT_DIR/$DOMAIN.crt"
ISSUER="$CERT_DIR/$DOMAIN.issuer.crt"
PRIVATE_KEY="$CERT_DIR/$DOMAIN.key"

mkdir -p "$STAGE"
openssl x509 -in "$BUNDLE" -out "$STAGE/cert.pem"
cp "$ISSUER" "$STAGE/chain.pem"
cp "$BUNDLE" "$STAGE/fullchain.pem"
cp "$PRIVATE_KEY" "$STAGE/privkey.pem"
openssl verify -CAfile "$STAGE/chain.pem" "$STAGE/cert.pem"

cert_public=$(openssl x509 -in "$STAGE/cert.pem" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum | cut -d' ' -f1)
key_public=$(openssl pkey -in "$STAGE/privkey.pem" -pubout -outform DER | sha256sum | cut -d' ' -f1)
[ "$cert_public" = "$key_public" ]

# A normal daily run is a no-op unless lego actually renewed the certificate.
if cmp -s "$STAGE/cert.pem" "$ARCHIVE/cert.pem"; then
  exit 0
fi

BACKUP="$RENEW_ROOT/backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP/archive"
cp -p "$ARCHIVE/cert.pem" "$BACKUP/archive/cert.pem"
cp -p "$ARCHIVE/chain.pem" "$BACKUP/archive/chain.pem"
cp -p "$ARCHIVE/fullchain.pem" "$BACKUP/archive/fullchain.pem"
cp -p "$ARCHIVE/privkey.pem" "$BACKUP/archive/privkey.pem"

cp "$STAGE/cert.pem" "$ARCHIVE/cert.pem"
cp "$STAGE/chain.pem" "$ARCHIVE/chain.pem"
cp "$STAGE/fullchain.pem" "$ARCHIVE/fullchain.pem"
cp "$STAGE/privkey.pem" "$ARCHIVE/privkey.pem"
chown root:root "$ARCHIVE/cert.pem" "$ARCHIVE/chain.pem" "$ARCHIVE/fullchain.pem" "$ARCHIVE/privkey.pem"
chmod 400 "$ARCHIVE/cert.pem" "$ARCHIVE/chain.pem" "$ARCHIVE/fullchain.pem" "$ARCHIVE/privkey.pem"

/usr/syno/bin/synow3tool --gen-all
/usr/syno/bin/synosystemctl restart nginx

archive_serial=$(openssl x509 -in "$ARCHIVE/cert.pem" -noout -serial)
system_serial=$(openssl x509 -in /usr/syno/etc/certificate/system/default/cert.pem -noout -serial)
[ "$archive_serial" = "$system_serial" ]

BACKUP=""
exit 0
