import crypto from 'crypto';
import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '.env');

dotenv.config({ path: envPath });

const app = express();
const port = Number(process.env.PORT) || 3000;
let botInfo = null;
const passcode = (process.env.APP_PASSCODE || '3108').trim();
const appSecret = (process.env.APP_SECRET || 'azhar-local-secret').trim();
const unlockTries = new Map();

app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'docs'), {
  maxAge: 0,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-cache');
  },
}));

function token() {
  return (process.env.TELEGRAM_BOT_TOKEN || '').trim();
}

function chatId() {
  return (process.env.TELEGRAM_CHAT_ID || '').trim();
}

function writeEnvValue(key, value) {
  const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  const next = pattern.test(current)
    ? current.replace(pattern, line)
    : `${current.replace(/\s*$/, '')}\n${line}\n`;
  fs.writeFileSync(envPath, next);
  process.env[key] = value;
}

function sign(value) {
  const mac = crypto.createHmac('sha256', appSecret).update(value).digest('hex');
  return `${value}.${mac}`;
}

function readCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (!key) continue;
    out[key] = decodeURIComponent(rest.join('='));
  }
  return out;
}

function isUnlocked(req) {
  const cookie = readCookies(req).azhar || '';
  const [value, mac] = cookie.split('.');
  if (value !== 'ok' || !mac) return false;
  const expected = sign('ok').split('.')[1];
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireUnlock(req, res, next) {
  if (isUnlocked(req)) {
    next();
    return;
  }
  res.status(401).json({ ok: false, error: 'Locked.' });
}

app.get('/api/session', (req, res) => {
  res.json({ ok: isUnlocked(req) });
});

app.post('/api/unlock', (req, res) => {
  const ip = req.ip || 'local';
  const now = Date.now();
  const attempt = unlockTries.get(ip) || { count: 0, reset: now + 60000 };
  if (now > attempt.reset) {
    attempt.count = 0;
    attempt.reset = now + 60000;
  }
  if (attempt.count >= 8) {
    unlockTries.set(ip, attempt);
    res.status(429).json({ ok: false, error: 'Too many tries. Wait a minute.' });
    return;
  }

  const code = String(req.body?.code ?? '').trim();
  const given = Buffer.from(code);
  const expected = Buffer.from(passcode);
  const match = given.length === expected.length && crypto.timingSafeEqual(given, expected);
  if (!match) {
    attempt.count += 1;
    unlockTries.set(ip, attempt);
    res.status(401).json({ ok: false, error: 'Wrong code.' });
    return;
  }

  unlockTries.delete(ip);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `azhar=${sign('ok')}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});

async function telegram(botToken, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  return response.json();
}

app.get('/api/status', async (_req, res) => {
  const hasToken = Boolean(token());
  let username = '';
  let name = '';

  if (hasToken) {
    try {
      if (!botInfo) {
        const data = await telegram(token(), 'getMe');
        if (data.ok) botInfo = data.result;
      }
      username = botInfo?.username || '';
      name = botInfo?.first_name || '';
    } catch {
      username = '';
    }
  }

  res.json({
    ok: true,
    hasToken,
    hasChat: Boolean(chatId()),
    username,
    name,
  });
});

app.post('/api/token', async (req, res) => {
  if (process.env.ALLOW_SETUP !== 'true') {
    res.status(404).json({ ok: false, error: 'Not available.' });
    return;
  }
  const value = String(req.body?.token ?? '').trim();
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(value)) {
    res.status(400).json({ ok: false, error: 'That does not look like a bot token.' });
    return;
  }

  try {
    const data = await telegram(value, 'getMe');
    if (!data.ok) {
      res.status(400).json({ ok: false, error: 'Telegram did not accept that token.' });
      return;
    }

    writeEnvValue('TELEGRAM_BOT_TOKEN', value);
    botInfo = data.result;
    res.json({
      ok: true,
      username: data.result.username,
      name: data.result.first_name,
    });
  } catch {
    res.status(502).json({ ok: false, error: 'Could not reach Telegram.' });
  }
});

app.get('/api/discover', async (_req, res) => {
  if (process.env.ALLOW_SETUP !== 'true') {
    res.status(404).json({ ok: false, error: 'Not available.' });
    return;
  }
  if (!token()) {
    res.status(503).json({ ok: false, error: 'Save the bot token first.' });
    return;
  }

  try {
    const data = await telegram(token(), 'getUpdates', {
      timeout: 0,
      allowed_updates: ['message'],
    });
    if (!data.ok) {
      res.status(502).json({ ok: false, error: data.description || 'Telegram rejected the token.' });
      return;
    }

    const chats = new Map();
    for (const update of data.result || []) {
      const chat = update.message?.chat;
      if (!chat || chat.type !== 'private') continue;
      const person = [chat.first_name, chat.last_name].filter(Boolean).join(' ').trim();
      chats.set(String(chat.id), {
        id: chat.id,
        name: person || chat.username || 'Telegram user',
        username: chat.username || '',
      });
    }

    res.json({ ok: true, chats: [...chats.values()] });
  } catch {
    res.status(502).json({ ok: false, error: 'Could not reach Telegram.' });
  }
});

app.post('/api/chat', (req, res) => {
  if (process.env.ALLOW_SETUP !== 'true') {
    res.status(404).json({ ok: false, error: 'Not available.' });
    return;
  }
  const id = String(req.body?.chatId ?? '').trim();
  if (!/^-?\d+$/.test(id)) {
    res.status(400).json({ ok: false, error: 'That chat is not valid.' });
    return;
  }

  writeEnvValue('TELEGRAM_CHAT_ID', id);
  res.json({ ok: true });
});

app.post('/api/send', requireUnlock, async (req, res) => {
  const text = String(req.body?.text ?? '').trim().slice(0, 1000);
  if (!text) {
    res.status(400).json({ ok: false, error: 'Write a message first.' });
    return;
  }
  if (!token() || !chatId()) {
    res.status(503).json({ ok: false, error: 'The bot is not connected yet.' });
    return;
  }

  try {
    const data = await telegram(token(), 'sendMessage', {
      chat_id: chatId(),
      text,
    });
    if (!data.ok) {
      res.status(502).json({ ok: false, error: data.description || 'Telegram did not send it.' });
      return;
    }
    res.json({ ok: true });
  } catch {
    res.status(502).json({ ok: false, error: 'Could not reach Telegram.' });
  }
});

app.get('/api/updates', requireUnlock, async (req, res) => {
  if (!token() || !chatId()) {
    res.json({ ok: true, messages: [], nextOffset: 0, configured: false });
    return;
  }

  const offset = Number(req.query.offset) || 0;

  try {
    const data = await telegram(token(), 'getUpdates', {
      offset: offset || undefined,
      timeout: 0,
      allowed_updates: ['message'],
    });

    if (!data.ok) {
      res.status(502).json({ ok: false, error: data.description || 'Could not read messages.' });
      return;
    }

    const updates = data.result || [];
    const messages = [];
    for (const update of updates) {
      const message = update.message;
      if (!message?.text) continue;
      if (String(message.chat?.id) !== chatId()) continue;
      if (message.from?.is_bot) continue;
      messages.push({
        id: update.update_id,
        text: message.text,
        date: message.date,
      });
    }

    const nextOffset = updates.length ? updates[updates.length - 1].update_id + 1 : offset;
    res.json({ ok: true, messages, nextOffset, configured: true });
  } catch {
    res.status(502).json({ ok: false, error: 'Could not reach Telegram.' });
  }
});

app.listen(port, '0.0.0.0', () => {
  const ips = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) ips.push(entry.address);
    }
  }

  console.log(`Princess Azhar is running at http://localhost:${port}`);
  for (const ip of ips) console.log(`On your phone, open http://${ip}:${port}`);
});
