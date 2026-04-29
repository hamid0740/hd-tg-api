FROM aiogram/telegram-bot-api:latest

RUN apk add --no-cache nodejs npm

WORKDIR /app
COPY package.json ./
RUN npm install

COPY start.sh /start.sh
COPY index.js ./
COPY wrangler.toml ./

RUN chmod +x /start.sh

EXPOSE 10000
CMD ["/start.sh"]
