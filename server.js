const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;
const BOT_API_DIR = '/var/lib/telegram-bot-api';

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Serve files directly from disk
// Usage: /download/{botToken}/photos/file_3.jpg
app.get('/download/:botToken/*', (req, res) => {
  const botToken = req.params.botToken;
  const filePath = req.params[0];
  const fullPath = path.resolve(BOT_API_DIR, botToken, filePath);

  if (!fullPath.startsWith(path.resolve(BOT_API_DIR))) {
    return res.status(403).json({ error: 'Access denied' });
  }

  console.log(`Serving file: ${fullPath}`);

  if (!fs.existsSync(fullPath)) {
    try {
      const dir = path.dirname(fullPath);
      const contents = fs.existsSync(dir) ? fs.readdirSync(dir) : ['dir not found'];
      console.log(`Not found. Dir contents: ${contents.join(', ')}`);
    } catch (e) {}
    return res.status(404).json({ error: 'File not found', path: fullPath });
  }

  res.sendFile(fullPath);
});

// Debug: list ALL files the bot API has stored
app.get('/debug/files', (req, res) => {
  try {
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).flatMap(f => {
        const full = path.join(dir, f);
        return fs.statSync(full).isDirectory() ? walk(full) : [full];
      });
    };
    res.json({ files: walk(BOT_API_DIR) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`File server listening on port ${PORT}`);
});
