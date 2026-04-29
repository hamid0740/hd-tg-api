FROM aiogram/telegram-bot-api:latest

# Install Node.js (lightweight)
RUN apk add --no-cache nodejs npm

# Copy start script and file server
COPY start.sh /start.sh
COPY server.js /server.js
COPY package.json /package.json

RUN chmod +x /start.sh

# Install npm dependencies
WORKDIR /
RUN npm install

EXPOSE 8085 3000

CMD ["/start.sh"]
