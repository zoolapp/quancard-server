# Deployment guide

QuanCard Server ships as one container image (`ghcr.io/zoolapp/quancard-server`) that serves the API
and the web client. HTTPS is not optional: the server answers plain HTTP with `426 Upgrade Required`
unless the request comes from `localhost` with the explicit development flag.

## Requirements

- A Linux host with Docker Engine 24+ and Docker Compose v2 (1 vCPU / 512 MB RAM is enough for a
  household; Argon2id runs in the browser, not on the server).
- A domain name whose DNS A/AAAA record points to the host, with ports **80 and 443** reachable
  (Let's Encrypt validation and HTTP→HTTPS redirect).
- No other service bound to 80/443, or use [your own reverse proxy](#option-b--behind-your-own-reverse-proxy).

## Option A — bundled Caddy (recommended)

```sh
git clone https://github.com/zoolapp/quancard-server.git && cd quancard-server
./scripts/init-env.sh vault.example.com     # writes .env with random secrets (never overwrites)
docker compose up -d --wait
```

Open `https://vault.example.com`, enter the setup token printed by `init-env.sh` (also in `.env`),
and create the owner account. Caddy obtains and renews certificates automatically.

What the default `compose.yaml` does:

| Setting | Why |
| --- | --- |
| App container has **no published ports**; it sits on an `internal` network | Only Caddy can reach it, so `X-Forwarded-Proto` cannot be spoofed |
| `read_only: true`, `tmpfs /tmp`, `cap_drop: ALL`, `no-new-privileges`, uid 10001 | Limits the blast radius of any bug |
| Named volume `quancard-data` | SQLite database; owned by uid 10001 inside the image |
| `./data/caddy` | Certificates and ACME account |
| Caddy log filter | Drops query strings and headers, masks client IPs |

Prefer not to build locally? `docker compose pull` uses the published image; set `QC_IMAGE_TAG` in
`.env` to pin a version (recommended: pin, then upgrade deliberately).

### One-step installer

[`scripts/install.sh`](../scripts/install.sh) downloads the compose file, Caddyfile and scripts into
`~/quancard`, runs `init-env.sh` and starts the stack. Read it before running it:

```sh
curl -fsSL https://raw.githubusercontent.com/zoolapp/quancard-server/v0.1.0/scripts/install.sh -o install.sh
less install.sh
sh install.sh vault.example.com
```

## Option B — behind your own reverse proxy

Run only the `quancard` service and publish it on loopback:

```yaml
services:
  quancard:
    image: ghcr.io/zoolapp/quancard-server:latest
    environment:
      QC_SECRET: ${QC_SECRET}
      QC_SETUP_TOKEN: ${QC_SETUP_TOKEN}
      QC_PUBLIC_ORIGIN: https://vault.example.com
      QC_TRUST_PROXY: "1"
    ports: ["127.0.0.1:8080:8080"]
    volumes: [quancard-data:/data]
    read_only: true
    tmpfs: ["/tmp:size=16m"]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
volumes: { quancard-data: {} }
```

Your proxy must terminate TLS, forward `Host` unchanged, set `X-Forwarded-Proto: https` and
`X-Forwarded-For`, and allow request bodies up to 17 MB. `QC_TRUST_PROXY=1` trusts exactly one hop:
**never** expose port 8080 directly when it is set.

nginx example:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;
    client_max_body_size 17m;
}
```

Cloudflare Tunnel works the same way (`service: http://localhost:8080`); Cloudflare then terminates
TLS and can see traffic metadata, but vault contents remain encrypted end to end.

## Option C — local evaluation

```sh
./scripts/init-env.sh localhost
docker compose -f compose.local.yaml up -d
open http://localhost:8080
```

Binds only to `127.0.0.1`. Browsers treat `http://localhost` as a secure context. Use Chrome, Edge or
Firefox for the local trial: the session cookie is always `Secure`, and Safari may refuse it over plain
`http://localhost`. Do not use this for real data on a shared machine.

## Configuration reference

| Variable | Required | Meaning |
| --- | --- | --- |
| `QC_DOMAIN` | compose | Host name for Caddy and `QC_PUBLIC_ORIGIN` |
| `QC_SECRET` | yes | ≥ 32 random bytes in hex. Keys TOTP-at-rest encryption and HMACs. **Back it up**; losing it disables everyone's 2FA |
| `QC_SETUP_TOKEN` | first run | One-time owner setup token (≥ 24 chars). Without it, setup is closed |
| `QC_PUBLIC_ORIGIN` | yes* | `https://…` origin users browse to (*or `QC_ALLOW_INSECURE_LOCALHOST=1`) |
| `QC_TRUST_PROXY` | behind proxy | `1` to trust one proxy hop for `X-Forwarded-*` |
| `QC_ALLOW_INSECURE_LOCALHOST` | dev only | `1` accepts plain HTTP for `localhost` / `127.0.0.1` |
| `QC_DATA_DIR`, `QC_PORT`, `QC_HOST`, `QC_WEB_ROOT` | no | Defaults `/data`, `8080`, `0.0.0.0`, `/app/web` in the image |
| `QC_IMAGE_TAG` | no | Image tag used by compose |

## Accounts

The first account (owner) is created with the setup token. The owner can create single-use invite
links (Settings → Members) for family members; each member has a separate account and vault the
owner cannot read. There is **no password reset**: the server never knows the password.

## Backups

```sh
./scripts/backup.sh                         # online, consistent snapshot → backups/quancard-<UTC>.sqlite
./scripts/restore.sh backups/quancard-….sqlite   # verifies, stops the app, swaps, restarts
```

Backups contain only ciphertext and verifiers, but keep them private anyway and store `.env`
(`QC_SECRET`) with them. Test a restore before you rely on it. For off-site copies, encrypt the
file again with your usual tool (restic, age, …). Use `COMPOSE="docker compose -f compose.local.yaml"`
for the local stack.

## Upgrades

```sh
docker compose pull && docker compose up -d --wait
```

Migrations run automatically at start-up inside a transaction. The server refuses to start on a
database written by a newer version (`downgrade refused`) instead of corrupting it; restore the
matching backup if you need to roll back. Take a backup before every upgrade.

## Monitoring

`GET /healthz` returns `{"ok":true}` without touching data (the container healthcheck uses it).
Application logs are JSON lines with route, status and duration only.

## Hardening checklist

- [ ] DNS points to the host; `https://` loads with a valid certificate; `http://` redirects.
- [ ] Port 8080 is not reachable from the internet.
- [ ] `.env` is `chmod 600`, backed up, not committed anywhere.
- [ ] Owner account uses a long passphrase and two-step verification.
- [ ] Backups are scheduled and a restore was tested.
- [ ] The host OS and Docker receive security updates; the image is upgraded regularly.
