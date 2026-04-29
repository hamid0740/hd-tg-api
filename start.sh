#!/bin/sh

echo "Starting Telegram Bot API..."
mkdir -p /var/lib/telegram-bot-api

# Start Bot API in background
telegram-bot-api \
  --api-id=$TELEGRAM_API_ID \
  --api-hash=$TELEGRAM_API_HASH \
  --http-port=8085 \
  --local \
  --dir=/var/lib/telegram-bot-api &

echo "Starting file server on port 10000..."
# Start Node.js file server on port 10000 (Render's requirement)
PORT=10000 node /server.js
