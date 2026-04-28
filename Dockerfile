FROM aiogram/telegram-bot-api:latest

COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE 8081

CMD ["/start.sh"]
