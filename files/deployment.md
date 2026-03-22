# Deployment & Operations

## Purpose
Deployment process, infrastructure, and production operations for AI agents.

---

## Deployment Platform

**Platform:** VPS (Ubuntu 24.04)

**Type:** systemd service (same as other bots on this server)

**Why this platform:** Existing server with Node.js and faster-whisper already running. Full server control, no additional costs.

---

## Access Information

**SSH Access:**
- Production: `ssh xander_bot@37.233.82.205`

**Credentials location:** `.env` file on VPS at `/home/xander_bot/totalk-todo/.env`

---

## Environment Variables

**See:** [.env.example](../../.env.example) in project root

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `GIGACHAT_AUTH_KEY` | GigaChat OAuth2 credentials (base64-encoded client credentials for Basic auth) |
| `GIGACHAT_MODEL` | GigaChat model name (default: `GigaChat-2`) |
| `WHISPER_URL` | faster-whisper endpoint (default: `http://localhost:8765`) |
| `DB_PATH` | SQLite database file path (default: `data/bot.db`) |

---

## Deployment Triggers

**Production:** Manual deploy via SSH — `git pull origin main && npm install --production && systemctl restart totalk-todo`

**Staging:** Not configured. Development happens on `dev` branch, tested locally or on VPS directly.

---

## Pre-Deploy Checklist

- [ ] Run `npm test` locally before pushing
- [ ] Verify env vars set on VPS if new ones were added
- [ ] Check faster-whisper is running: `systemctl is-active faster-whisper`

---

## Rollback Procedure

**Platform rollback:** `git checkout <prev-commit> && npm install --production && systemctl restart totalk-todo`

**Approximate time:** ~2 minutes

---

## Environments

**Production:** VPS 37.233.82.205 — Deploys from `main` branch

**Working directory:** `/home/xander_bot/totalk-todo/`

---

## Systemd Service

File: `/etc/systemd/system/totalk-todo.service`

```ini
[Unit]
Description=ToTalk-ToDo Telegram Bot
After=network.target

[Service]
Type=simple
User=xander_bot
WorkingDirectory=/home/xander_bot/totalk-todo
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=10
EnvironmentFile=/home/xander_bot/totalk-todo/.env

[Install]
WantedBy=multi-user.target
```

---

## Existing Services on VPS

| Service | Status | Port |
|---------|--------|------|
| faster-whisper (Flask) | Running | 8765 |
| n8n | Running | 5678 |
| Node.js v22 | Installed | — |

faster-whisper is already deployed and processing voice — **no need to set up again**.

---

## Monitoring & Observability

### Logging

**Where:** journalctl (`journalctl -u totalk-todo -f`)
**Format:** Default console output

### Error Tracking

**Tool:** None configured in MVP
**Config:** Logs to stdout only, visible via journalctl

### Health Checks

**Endpoint:** None in MVP
**Checks:** `systemctl is-active totalk-todo`

## CI/CD

Manual deploy in MVP. GitHub Actions planned for v2 after code stabilization.
