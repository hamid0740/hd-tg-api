FROM aiogram/telegram-bot-api:latest

EXPOSE 8081

ENTRYPOINT ["telegram-bot-api", "--local"]
