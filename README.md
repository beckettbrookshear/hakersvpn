# HakersVPN

A browser VPN with two parts:

- **`extension/`** is a Chrome, Edge or Brave extension. It sends all of your browser's traffic through your server.
- **`server/`** is a small Go proxy server that you run on a VPS. It needs a password and uses TLS. It has no dependencies.

Websites see the server's IP address instead of yours. DNS lookups happen on the server. WebRTC can't leak your real IP.
If the server goes down, the browser stops loading pages rather than falling back to a direct connection, which works as a kill switch.

> This only covers browser traffic. Other apps on your computer still connect directly.

## 1. Run the server

You need a VPS and a domain or subdomain pointing at it (for example `vpn.example.com`).
Chrome only accepts encrypted proxies that have a real, trusted certificate.

```bash
# Build it on your computer (or on the VPS):
cd server && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o hakersvpn-server .

# On the VPS, get a free certificate:
sudo certbot certonly --standalone -d vpn.example.com

# Run the server:
sudo LISTEN=:443 \
  PROXY_USER=me \
  PROXY_PASS="$(openssl rand -base64 18)" \
  TLS_CERT=/etc/letsencrypt/live/vpn.example.com/fullchain.pem \
  TLS_KEY=/etc/letsencrypt/live/vpn.example.com/privkey.pem \
  ./hakersvpn-server
```

Write down the password. Port 443 is the least likely to be blocked on restrictive networks.

| Variable | Default | Meaning |
|---|---|---|
| `LISTEN` | `:8443` | Address and port to listen on |
| `PROXY_USER` / `PROXY_PASS` | — (required) | Login the extension uses |
| `TLS_CERT` / `TLS_KEY` | — | Certificate and key (PEM). Without them the server runs unencrypted, which is only for local testing |
| `ALLOW_PRIVATE` | off | Set to `1` to allow access to private and loopback addresses on the server's own network |

## 2. Install the extension

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `extension/` folder.
3. Click the HakersVPN icon. Open **Server settings** and enter your host, port, username and password.
4. Click **Connect**, then **Check** to confirm that your IP is now the server's IP.

## Notes

- If the server rejects the login, the extension stops retrying and shows **ERR** on its badge.
- The password is saved in the extension's local storage on your computer.
- To test locally without TLS, run the server with no cert, set `LISTEN=127.0.0.1:8080` and untick **Encrypt connection** in the extension.
