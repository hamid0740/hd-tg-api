const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_API_DIR = '/var/lib/telegram-bot-api';

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// File download endpoint
app.get('/download/:botToken/*', (req, res) => {
  const botToken = req.params.botToken;
  const filePath = req.params[0]; // Captures the rest of the path
  
  // Construct full file path
  const fullPath = path.join(BOT_API_DIR, botToken, filePath);
  
  // Security: prevent directory traversal
  if (!fullPath.startsWith(BOT_API_DIR)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  // Check if file exists
  fs.access(fullPath, fs.constants.F_OK, (err) => {
    if (err) {
      console.log(`File not found: ${fullPath}`);
      return res.status(404).json({ error: 'File not found' });
    }
    
    // Stream the file
    res.download(fullPath, (err) => {
      if (err) {
        console.error(`Download error for ${fullPath}:`, err);
      }
    });
  });
});

app.listen(PORT, () => {
  console.log(`File server listening on port ${PORT}`);
});
