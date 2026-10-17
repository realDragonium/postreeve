#!/bin/sh
# Certbot deploy hook: copies the renewed certificate for Stalwart and restarts it so it loads the new files.
# Install: sudo install -m 755 deploy/stalwart/certbot-deploy-hook.sh /etc/letsencrypt/renewal-hooks/deploy/stalwart.sh
# Certbot sets RENEWED_LINEAGE to /etc/letsencrypt/live/<name>.
set -eu

target=/srv/stalwart-certs
compose_dir=${STALWART_COMPOSE_DIR:-/opt/postreeve/deploy/stalwart}

install -d -m 750 -o 2000 -g 2000 "$target"
install -m 644 -o 2000 -g 2000 "$RENEWED_LINEAGE/fullchain.pem" "$target/fullchain.pem"
install -m 600 -o 2000 -g 2000 "$RENEWED_LINEAGE/privkey.pem" "$target/privkey.pem"

# A restart drops open IMAP sessions for a second; clients reconnect on their own.
cd "$compose_dir" && docker compose restart stalwart
