#!/bin/sh
mkdir -p /var/lib/telegram-bot-api
exec telegram-bot-api \
  --api-id=$TELEGRAM_API_ID \
  --api-hash=$TELEGRAM_API_HASH \
  --http-port=10000 \
  --local \
  --dir=/var/lib/telegram-bot-api
