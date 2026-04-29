FROM aiogram/telegram-bot-api:latest
 
# Install Node.js (lightweight)
RUN apt-get update && apt-get install -y nodejs npm && rm -rf /var/lib/apt/lists/*
 
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
