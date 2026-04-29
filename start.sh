#!/bin/sh
mkdir -p /var/lib/telegram-bot-api

# Start Bot API locally (only needs to be accessible inside container)
telegram-bot-api \
  --api-id=$TELEGRAM_API_ID \
  --api-hash=$TELEGRAM_API_HASH \
  --http-port=8085 \
  --local \
  --dir=/var/lib/telegram-bot-api &

# Wait for Bot API to be ready
echo "Waiting for Bot API to start..."
sleep 5

# Start your bot
node index.js
