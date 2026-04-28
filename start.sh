#!/bin/sh
exec telegram-bot-api \
  --api-id=$TELEGRAM_API_ID \
  --api-hash=$TELEGRAM_API_HASH \
  --http-port=8081 \
  --local \
  --dir=/
