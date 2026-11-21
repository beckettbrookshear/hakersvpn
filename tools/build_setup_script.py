"""Generate extension/setup/server-setup.sh from server/main.go.

The extension's Setup page hands this script to the user to paste into their
VPS provider's "user data" / "cloud-init" box. It embeds the server source,
so re-run this whenever server/main.go changes:

    python3 tools/build_setup_script.py
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
main_go = (ROOT / "server" / "main.go").read_text()
go_mod = (ROOT / "server" / "go.mod").read_text()

MARK = "HAKERSVPN_FILE_END"
assert MARK not in main_go and MARK not in go_mod

TEMPLATE = f"""#!/bin/bash
# HakersVPN one-shot server setup. Paste this into your VPS provider's
# "User data" / "Cloud-init" / "Startup script" box when creating an
# Ubuntu 24.04 server. It runs once on first boot (takes ~3-5 minutes).
set -euxo pipefail
exec > /var/log/hakersvpn-setup.log 2>&1

PROXY_USER="__USER__"
PROXY_PASS="__PASS__"
DOMAIN="__DOMAIN__"

export DEBIAN_FRONTEND=noninteractive HOME=/root
apt-get update
apt-get install -y golang-go certbot curl

if [ -z "$DOMAIN" ]; then
  IP=$(curl -4 -fsS https://api.ipify.org)
  DOMAIN="${{IP//./-}}.sslip.io"
fi

# Build the server
mkdir -p /opt/hakersvpn && cd /opt/hakersvpn
cat > go.mod <<'{MARK}'
{go_mod.rstrip()}
{MARK}
cat > main.go <<'{MARK}'
{main_go.rstrip()}
{MARK}
GOCACHE=/tmp/gocache CGO_ENABLED=0 go build -o /usr/local/bin/hakersvpn-server .

# Open the firewall if ufw is on
if command -v ufw >/dev/null && ufw status | grep -q active; then
  ufw allow 80/tcp; ufw allow 443/tcp
fi

# Free TLS certificate (auto-renews; restart the server after renewal)
certbot certonly --standalone --non-interactive --agree-tos \\
  --register-unsafely-without-email -d "$DOMAIN"
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\\nsystemctl restart hakersvpn\\n' \\
  > /etc/letsencrypt/renewal-hooks/deploy/hakersvpn.sh
chmod +x /etc/letsencrypt/renewal-hooks/deploy/hakersvpn.sh

cat > /etc/hakersvpn.env <<EOF
LISTEN=:443
PROXY_USER=$PROXY_USER
PROXY_PASS=$PROXY_PASS
TLS_CERT=/etc/letsencrypt/live/$DOMAIN/fullchain.pem
TLS_KEY=/etc/letsencrypt/live/$DOMAIN/privkey.pem
EOF
chmod 600 /etc/hakersvpn.env

cat > /etc/systemd/system/hakersvpn.service <<'EOF'
[Unit]
Description=HakersVPN proxy
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/hakersvpn.env
ExecStart=/usr/local/bin/hakersvpn-server
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now hakersvpn
echo "HakersVPN ready on $DOMAIN"
"""

out = ROOT / "extension" / "setup" / "server-setup.sh"
out.write_text(TEMPLATE)
print(f"wrote {out.relative_to(ROOT)} ({len(TEMPLATE)} bytes)")
