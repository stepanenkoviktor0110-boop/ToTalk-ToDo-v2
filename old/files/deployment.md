# Deployment: VoiceTask Bot

## Платформа

- **VPS:** 37.233.82.205, user `xander_bot`, Ubuntu 24.04
- **Runtime:** Node.js v22.22.1
- **Процесс-менеджер:** systemd service (аналогично другим ботам на сервере)

## Переменные окружения (.env)

```
TELEGRAM_BOT_TOKEN=       # токен бота от @BotFather
ANTHROPIC_API_KEY=        # ключ Claude API
WHISPER_URL=http://localhost:8765  # faster-whisper уже запущен
NODE_ENV=production
```

## Зависимости на VPS

| Сервис | Статус | Порт |
|--------|--------|------|
| faster-whisper (Flask) | ✅ запущен | 8765 |
| n8n | ✅ запущен | 5678 |
| Node.js v22 | ✅ установлен | — |

faster-whisper уже развёрнут и обрабатывает голосовые — **не нужно поднимать заново**.

## Systemd Service

Файл: `/etc/systemd/system/voice-task-bot.service`

```ini
[Unit]
Description=VoiceTask Telegram Bot
After=network.target

[Service]
Type=simple
User=xander_bot
WorkingDirectory=/home/xander_bot/voice-task-bot
ExecStart=/usr/bin/node src/bot.js
Restart=on-failure
RestartSec=10
EnvironmentFile=/home/xander_bot/voice-task-bot/.env

[Install]
WantedBy=multi-user.target
```

## Deploy процедура (ручной деплой, MVP)

```bash
# На VPS
cd /home/xander_bot/voice-task-bot
git pull origin main
npm install --production
systemctl restart voice-task-bot
systemctl status voice-task-bot
```

## Мониторинг

```bash
# Логи
journalctl -u voice-task-bot -f

# Проверка, что бот живой
systemctl is-active voice-task-bot
```

## Директория на VPS

```
/home/xander_bot/voice-task-bot/
```

## CI/CD

В MVP — ручной деплой через SSH. 
GitHub Actions — в v2 (после стабилизации кода).
