const allowedOrigins = new Set([
  'https://pazhar.live',
  'https://www.pazhar.live',
  'https://abodi22.github.io',
]);

const hits = new Map();

function json(data, status, origin) {
  const response = new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
  if (allowedOrigins.has(origin)) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Vary', 'Origin');
  }
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  return response;
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

async function sign(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return hex(mac);
}

async function sessionToken(secret) {
  const expires = String(Date.now() + 12 * 60 * 60 * 1000);
  return `${expires}.${await sign(secret, expires)}`;
}

async function validSession(token, secret) {
  const [expires, mac] = String(token || '').split('.');
  if (!expires || !mac || Number(expires) < Date.now()) return false;
  return timingSafeEqual(mac, await sign(secret, expires));
}

function limited(ip, bucket, max, windowMs) {
  const now = Date.now();
  const id = `${ip}:${bucket}`;
  const row = hits.get(id);
  if (!row || now > row.reset) {
    hits.set(id, { count: 1, reset: now + windowMs });
    return false;
  }
  row.count += 1;
  return row.count > max;
}

async function telegram(env, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  return response.json();
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return json({ ok: true }, 204, origin);

    const url = new URL(request.url);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const secret = env.APP_SECRET || '';
    const passcode = env.APP_PASSCODE || '3108';

    if (url.pathname === '/api/status' && request.method === 'GET') {
      const hasToken = Boolean(env.TELEGRAM_BOT_TOKEN);
      const hasChat = Boolean(env.TELEGRAM_CHAT_ID);
      return json({ ok: true, hasToken, hasChat }, 200, origin);
    }

    if (url.pathname === '/api/session' && request.method === 'GET') {
      const header = request.headers.get('Authorization') || '';
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      const ok = Boolean(secret) && await validSession(token, secret);
      return json({ ok }, 200, origin);
    }

    if (url.pathname === '/api/unlock' && request.method === 'POST') {
      if (limited(ip, 'unlock', 8, 60000)) {
        return json({ ok: false, error: 'Too many tries. Wait a minute.' }, 429, origin);
      }
      let body = {};
      try {
        body = await request.json();
      } catch {
        body = {};
      }
      const code = String(body.code ?? '').trim();
      if (!secret || !timingSafeEqual(code, passcode)) {
        return json({ ok: false, error: 'Wrong code.' }, 401, origin);
      }
      return json({ ok: true, session: await sessionToken(secret) }, 200, origin);
    }

    const header = request.headers.get('Authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!secret || !(await validSession(token, secret))) {
      return json({ ok: false, error: 'Enter the passcode again.' }, 401, origin);
    }

    if (url.pathname === '/api/send' && request.method === 'POST') {
      if (limited(ip, 'send', 60, 60000)) {
        return json({ ok: false, error: 'Wait a moment, then try again.' }, 429, origin);
      }
      let body = {};
      try {
        body = await request.json();
      } catch {
        body = {};
      }
      const text = String(body.text ?? '').trim().slice(0, 1000);
      if (!text) return json({ ok: false, error: 'Write a message first.' }, 400, origin);
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
        return json({ ok: false, error: 'The bot is not connected yet.' }, 503, origin);
      }
      try {
        const data = await telegram(env, 'sendMessage', {
          chat_id: env.TELEGRAM_CHAT_ID,
          text,
        });
        if (!data.ok) return json({ ok: false, error: data.description || 'Telegram did not send it.' }, 502, origin);
        return json({ ok: true }, 200, origin);
      } catch {
        return json({ ok: false, error: 'Could not reach Telegram.' }, 502, origin);
      }
    }

    if (url.pathname === '/api/updates' && request.method === 'GET') {
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
        return json({ ok: true, messages: [], nextOffset: 0, configured: false }, 200, origin);
      }
      const offset = Number(url.searchParams.get('offset')) || 0;
      try {
        const data = await telegram(env, 'getUpdates', {
          offset: offset || undefined,
          timeout: 0,
          allowed_updates: ['message'],
        });
        if (!data.ok) return json({ ok: false, error: data.description || 'Could not read messages.' }, 502, origin);
        const updates = data.result || [];
        const messages = [];
        for (const update of updates) {
          const message = update.message;
          if (!message?.text) continue;
          if (String(message.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) continue;
          if (message.from?.is_bot) continue;
          messages.push({ id: update.update_id, text: message.text, date: message.date });
        }
        const nextOffset = updates.length ? updates[updates.length - 1].update_id + 1 : offset;
        return json({ ok: true, messages, nextOffset, configured: true }, 200, origin);
      } catch {
        return json({ ok: false, error: 'Could not reach Telegram.' }, 502, origin);
      }
    }

    return json({ ok: false, error: 'Not available.' }, 404, origin);
  },
};
