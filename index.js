require('dotenv').config();

// Use built-in fetch (Node 18+) or require node-fetch
const fetch = globalThis.fetch ?? require('node-fetch');

const express         = require('express');
const http            = require('http');
const { Server }      = require('socket.io');
const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode          = require('qrcode');
const cors            = require('cors');
const PhpSessionStore = require('./PhpSessionStore');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout:  60000,
  pingInterval: 25000,
});

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

// ── Singleton guard — prevent multiple initClient() calls ──────────────────
let client         = null;
let qrCodeData     = null;
let isReady        = false;
let isInitializing = false;
let initLock       = false;  // hard lock

const store = new PhpSessionStore(
  process.env.PHP_API_URL,
  process.env.PHP_API_KEY,
);

// ── Init ───────────────────────────────────────────────────────────────────
async function initClient() {
  if (initLock) {
    console.log('[Init] Already locked, skipping');
    return;
  }
  initLock       = true;
  isInitializing = true;
  qrCodeData     = null;
  isReady        = false;

  // Destroy existing client cleanly
  if (client) {
    console.log('[Init] Destroying old client...');
    try {
      client.removeAllListeners();
      await client.destroy();
    } catch (_) {}
    client = null;
    // Wait for puppeteer to fully close
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log('[Init] Creating new client...');
  io.emit('loading', { percent: 0, message: 'Starting WhatsApp...' });

  try {
    client = new Client({
      authStrategy: new RemoteAuth({
        clientId:             'main',
        store,
        backupSyncIntervalMs: 5 * 60 * 1000,
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-extensions',
          '--disable-background-networking',
        ],
      },
      restartOnAuthFail: false,
    });
  } catch (err) {
    console.error('[Init] Client creation failed:', err.message);
    initLock       = false;
    isInitializing = false;
    setTimeout(initClient, 10000);
    return;
  }

  // ── QR ─────────────────────────────────────────────────────────────────
  client.on('qr', async (qr) => {
    console.log('[QR] New QR generated');
    try {
      qrCodeData = await qrcode.toDataURL(qr);
    } catch (e) {
      qrCodeData = qr; // fallback to raw string
    }
    isReady        = false;
    isInitializing = false;
    io.emit('qr', qrCodeData);
  });

  // ── Loading ─────────────────────────────────────────────────────────────
  client.on('loading_screen', (percent, message) => {
    console.log(`[Loading] ${percent}% — ${message}`);
    io.emit('loading', { percent, message });
  });

  // ── Authenticated ───────────────────────────────────────────────────────
  client.once('authenticated', () => {   // use once() to prevent duplicate fires
    console.log('[Auth] Authenticated ✓');
    qrCodeData = null;
    io.emit('authenticated');
  });

  // ── Session saved ───────────────────────────────────────────────────────
  client.on('remote_session_saved', () => {
    console.log('[Session] Saved to PHP DB ✓');
  });

  // ── Auth failure ────────────────────────────────────────────────────────
  client.once('auth_failure', async (msg) => {
    console.error('[Auth] Failure:', msg);
    isReady        = false;
    isInitializing = false;
    initLock       = false;
    await store.delete({ session: 'main' }).catch(() => {});
    io.emit('auth_failure', { message: msg });
    setTimeout(initClient, 5000);
  });

  // ── Ready ───────────────────────────────────────────────────────────────
  client.once('ready', () => {
    isReady        = true;
    isInitializing = false;
    initLock       = false;
    qrCodeData     = null;
    const info     = client.info;
    console.log('[Ready] WhatsApp Ready ✓ —', info?.wid?.user);
    io.emit('ready', {
      phone: info?.wid?.user,
      name:  info?.pushname,
    });
  });

  // ── Disconnected ────────────────────────────────────────────────────────
  client.on('disconnected', async (reason) => {
    console.log('[Disconnected]', reason);
    isReady  = false;
    initLock = false;
    io.emit('disconnected', { reason });

    if (reason === 'LOGOUT') {
      await store.delete({ session: 'main' }).catch(() => {});
      console.log('[Disconnected] Manual logout — session cleared');
    } else {
      console.log('[Disconnected] Reconnecting in 8s...');
      setTimeout(initClient, 8000);
    }
  });

  // ── Messages ────────────────────────────────────────────────────────────
  client.on('message', async (msg) => {
    try {
      const contact = await msg.getContact();
      const chat    = await msg.getChat();
      const payload = {
        id:          msg.id._serialized,
        from:        msg.from,
        to:          msg.to,
        body:        msg.body,
        type:        msg.type,
        timestamp:   msg.timestamp,
        isGroup:     msg.from.includes('@g.us'),
        fromMe:      false,
        contactName: contact.pushname || contact.number,
        chatName:    chat.name,
        hasMedia:    msg.hasMedia,
      };
      io.emit('message', payload);
      if (process.env.PHP_API_URL) {
        fetch(`${process.env.PHP_API_URL}/v1/whatsapp/save-message`, {
          method:  'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.PHP_API_KEY}`,
          },
          body: JSON.stringify(payload),
        }).catch(e => console.error('[Message] Save error:', e.message));
      }
    } catch (err) {
      console.error('[Message] Error:', err.message);
    }
  });

  client.on('message_ack', (msg, ack) => {
    io.emit('message_ack', { id: msg.id._serialized, ack });
  });

  // ── Initialize ──────────────────────────────────────────────────────────
  try {
    console.log('[Init] Calling client.initialize()...');
    await client.initialize();
  } catch (err) {
    console.error('[Init] initialize() error:', err.message);
    isInitializing = false;
    initLock       = false;
    setTimeout(initClient, 10000);
  }
}

// ── Keep-alive ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (process.env.RENDER_EXTERNAL_URL) {
    fetch(`${process.env.RENDER_EXTERNAL_URL}/ping`).catch(() => {});
  }
}, 14 * 60 * 1000);

// ── REST ───────────────────────────────────────────────────────────────────
app.get('/ping', (_, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/status', (_, res) => res.json({
  isReady,
  isInitializing,
  qrCode: qrCodeData,
  phone:  isReady ? client?.info?.wid?.user : null,
  name:   isReady ? client?.info?.pushname  : null,
}));

app.post('/send', async (req, res) => {
  const { to, message } = req.body;
  if (!isReady)        return res.status(503).json({ success: false, message: 'Not connected' });
  if (!to || !message) return res.status(400).json({ success: false, message: 'Missing to or message' });
  try {
    const chatId = to.includes('@') ? to : `${to.replace(/\D/g, '')}@c.us`;
    const sent   = await client.sendMessage(chatId, message);
    res.json({ success: true, id: sent.id._serialized });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/send-media', async (req, res) => {
  const { to, base64, mimetype, filename, caption } = req.body;
  if (!isReady) return res.status(503).json({ success: false, message: 'Not connected' });
  try {
    const chatId = to.includes('@') ? to : `${to.replace(/\D/g, '')}@c.us`;
    const media  = new MessageMedia(mimetype, base64, filename);
    const sent   = await client.sendMessage(chatId, media, { caption });
    res.json({ success: true, id: sent.id._serialized });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/chats', async (_, res) => {
  if (!isReady) return res.status(503).json({ success: false, message: 'Not connected' });
  try {
    const chats = await client.getChats();
    res.json({
      success: true,
      chats: chats.slice(0, 100).map(c => ({
        id:              c.id._serialized,
        name:            c.name,
        isGroup:         c.isGroup,
        unreadCount:     c.unreadCount,
        lastMessage:     c.lastMessage?.body ?? '',
        lastMessageTime: c.lastMessage?.timestamp ?? 0,
        pinned:          c.pinned,
        archived:        c.archived,
      })),
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/messages', async (req, res) => {
  const { chatId, limit = 50 } = req.body;
  if (!isReady) return res.status(503).json({ success: false, message: 'Not connected' });
  if (!chatId)  return res.status(400).json({ success: false, message: 'Missing chatId' });
  try {
    const chat     = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit });
    res.json({
      success: true,
      messages: messages.map(m => ({
        id:        m.id._serialized,
        body:      m.body,
        type:      m.type,
        fromMe:    m.fromMe,
        timestamp: m.timestamp,
        hasMedia:  m.hasMedia,
        ack:       m.ack,
        author:    m.author ?? null,
      })),
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/read', async (req, res) => {
  const { chatId } = req.body;
  if (!isReady) return res.status(503).json({ success: false, message: 'Not connected' });
  try {
    const chat = await client.getChatById(chatId);
    await chat.sendSeen();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/logout', async (_, res) => {
  try {
    await client.logout();
    isReady  = false;
    initLock = false;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── Socket ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[Socket] Connected:', socket.id);
  socket.emit('init', {
    isReady,
    isInitializing,
    qrCode: qrCodeData,
    phone:  isReady ? client?.info?.wid?.user : null,
    name:   isReady ? client?.info?.pushname  : null,
  });
  socket.on('disconnect', () => console.log('[Socket] Disconnected:', socket.id));
});

app.get('/test-php', async (req, res) => {
  try {
    const response = await fetch(`${process.env.PHP_API_URL}/v1/whatsapp/session-load`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.PHP_API_KEY}` },
      body: JSON.stringify({ session_id: 'test' })
    });
    const text = await response.text();
    res.json({ ok: true, status: response.status, body: text });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Boot ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  // Small delay to let server fully bind before puppeteer starts
  setTimeout(initClient, 2000);
});