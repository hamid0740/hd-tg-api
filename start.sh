#!/bin/sh
mkdir -p /var/lib/telegram-bot-api
exec telegram-bot-api \
  --api-id=$TELEGRAM_API_ID \
  --api-hash=$TELEGRAM_API_HASH \
  --http-port=8085 \
  --local \
  --dir=/var/lib/telegram-bot-api
