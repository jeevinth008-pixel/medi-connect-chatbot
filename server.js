
import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler } from './lib/handler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const chatHandler = createHandler();

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost:3000').pathname;

  if (pathname === '/api/chat') {
  if (req.method !== 'POST') {
    await chatHandler(req, res);
    return;
  }

  let rawBody = '';

  req.on('data', (chunk) => {
    rawBody += chunk;
  });

  req.on('end', async () => {
    try {
      req.body = JSON.parse(rawBody);
      await chatHandler(req, res);
    } catch (error) {
      if (!res.writableEnded) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          error: {
            code: 'INVALID_JSON',
            message: 'The request body is not valid JSON.'
          }
        }));
      }
    }
  });

  return;
 }

  const files = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/config.js': 'config.js'
  };

  const filename = files[pathname];

  if (!filename) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }

  const filePath = path.join(__dirname, filename);

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('Could not load the file.');
    }

    const contentType = filename.endsWith('.js')
      ? 'text/javascript; charset=utf-8'
      : 'text/html; charset=utf-8';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
});

server.listen(3000, '127.0.0.1', () => {
  console.log('MediConnect running at http://localhost:3000');
});
