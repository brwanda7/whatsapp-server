require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, RemoteAuth, MessageMedia, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');
const PhpSessionStore = require('./PhpSessionStore');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

// ---------- Configuration ----------
const USE_PHP_STORE = process.env.USE_PHP_STORE === 'true'; // set false to use LocalAuth
const PHP_API_URL = process.env.PHP_API_URL;
const PHP_API_KEY = process.env.PHP_API_KEY;

let client = null;
let qrCodeData = null;
let isReady = false;
let isInitializing = false;
let initLock = false;

// ---------- Session Store (PHP or Local) ----------
let store = null;
if (USE_PHP_STORE && PHP_API_URL && PHP_API_KEY) {
  store = new PhpSessionStore(PHP_API_URL, PHP_API_KEY);
  console.log('[Store] Using PHP RemoteAuth store');
} else {
  console.log('[Store] Using LocalAuth (filesystem)');
}

// ---------- Initialize WhatsApp Client ----------
async function initClient() {
  if (initLock) {
    console.log('[Init] Already locking, skipping');
    return;
  }
  initLock = true;
  isInitializing = true;
  qrCodeData = null;
  isReady = false;

  // Destroy old client properly
  if (client) {
    console.log('[Init] Destroying old client...');
    try {
      client.removeAllListeners();
      await client.destroy();
    } catch (e) {}
    // Force kill any stray Chromium processes (Linux)
    const { exec } = require('child_process');
    exec('pkill -f chromium || true', () => {});
    await new Promise(r => setTimeout(r, 3000));
    client = null;
  }

  console.log('[Init] Creating new client...');
  io.emit('loading', { percent: 0, message: 'Starting WhatsApp...' });

  // Puppeteer arguments to reduce memory
  const puppeteerArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
    '--no-first-run',
    '--no-zygote',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-translate',
    '--disable-features=TranslateUI,BlinkGenPropertyTrees',
    '--disable-ipc-flooding-protection',
    '--memory-pressure-off',
    '--max_old_space_size=256',
  ];

  try {
    if (store) {
      // RemoteAuth with PHP store
      client = new Client({
        authStrategy: new RemoteAuth({
          clientId: 'main',
          store: store,
          backupSyncIntervalMs: 10 * 60 * 1000,
          dataPath: './.wwebjs_auth',
        }),
        puppeteer: { headless: true, args: puppeteerArgs },
        restartOnAuthFail: false,
      });
    } else {
      // LocalAuth – more reliable for small deployments
      client = new Client({
        authStrategy: new LocalAuth({ clientId: 'main', dataPath: './.wwebjs_auth' }),
        puppeteer: { headless: true, args: puppeteerArgs },
        restartOnAuthFail: false,
      });
    }
  } catch (err) {
    console.error('[Init] Client creation failed:', err.message);
    initLock = false;
    isInitializing = false;
    setTimeout(initClient, 10000);
    return;
  }

  // ---------- Event handlers ----------
  client.on('qr', async (qr) => {
    console.log('[QR] New QR generated');
    try {
      qrCodeData = await qrcode.toDataURL(qr);
    } catch (e) {
      qrCodeData = qr;
    }
    isReady = false;
    isInitializing = false;
    io.emit('qr', qrCodeData);
  });

  client.on('loading_screen', (percent, message) => {
    console.log(`[Loading] ${percent}% — ${message}`);
    io.emit('loading', { percent, message });
  });

  client.on('authenticated', () => {
    console.log('[Auth] Authenticated ✓');
    qrCodeData = null;
    io.emit('authenticated');
  });

  client.on('remote_session_saved', () => {
    console.log('[Session] Saved to remote store ✓');
  });

  client.on('auth_failure', async (msg) => {
    console.error('[Auth] Failure:', msg);
    isReady = false;
    isInitializing = false;
    initLock = false;
    if (store) await store.delete({ session: 'main' }).catch(() => {});
    io.emit('auth_failure', { message: msg });
    setTimeout(initClient, 5000);
  });

  client.on('ready', () => {
    isReady = true;
    isInitializing = false;
    initLock = false;
    qrCodeData = null;
    const info = client.info;
    console.log('[Ready] WhatsApp Ready ✓ —', info?.wid?.user);
    io.emit('ready', { phone: info?.wid?.user, name: info?.pushname });
  });

  client.on('disconnected', async (reason) => {
    console.log('[Disconnected]', reason);
    isReady = false;
    initLock = false;
    io.emit('disconnected', { reason });
    if (reason === 'LOGOUT') {
      if (store) await store.delete({ session: 'main' }).catch(() => {});
      console.log('[Disconnected] Manual logout – session cleared');
    } else {
      console.log('[Disconnected] Reconnecting in 8 seconds...');
      setTimeout(initClient, 8000);
    }
  });

  client.on('message', async (msg) => {
    try {
      const contact = await msg.getContact();
      const chat = await msg.getChat();
      const payload = {
        id: msg.id._serialized,
        from: msg.from,
        to: msg.to,
        body: msg.body,
        type: msg.type,
        timestamp: msg.timestamp,
        isGroup: msg.from.includes('@g.us'),
        fromMe: false,
        contactName: contact.pushname || contact.number,
        chatName: chat.name,
        hasMedia: msg.hasMedia,
      };
      io.emit('message', payload);
      if (USE_PHP_STORE && PHP_API_URL) {
        fetch(`${PHP_API_URL}/v1/whatsapp/save-message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PHP_API_KEY}` },
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

  try {
    console.log('[Init] Calling client.initialize()...');
    await client.initialize();
  } catch (err) {
    console.error('[Init] initialize() error:', err.message);
    isInitializing = false;
    initLock = false;
    setTimeout(initClient, 10000);
  }
}

// ---------- Keep‑alive (prevents Render from spinning down) ----------
setInterval(() => {
  if (process.env.RENDER_EXTERNAL_URL) {
    fetch(`${process.env.RENDER_EXTERNAL_URL}/ping`).catch(() => {});
  }
}, 14 * 60 * 1000);

// ---------- REST endpoints ----------
app.get('/ping', (_, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/status', (_, res) => res.json({
  isReady, isInitializing,
  qrCode: qrCodeData,
  phone: isReady ? client?.info?.wid?.user : null,
  name: isReady ? client?.info?.pushname : null,
}));

app.post('/send', async (req, res) => {
  const { to, message } = req.body;
  if (!isReady) return res.status(503).json({ success: false, message: 'Not connected' });
  if (!to || !message) return res.status(400).json({ success: false, message: 'Missing to or message' });
  try {
    const chatId = to.includes('@') ? to : `${to.replace(/\D/g, '')}@c.us`;
    const sent = await client.sendMessage(chatId, message);
    res.json({ success: true, id: sent.id._serialized });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/send-media', async (req, res) => {
  const { to, base64, mimetype, filename, caption } = req.body;
  if (!isReady) return res.status(503).json({ success: false, message: 'Not connected' });
  try {
    const chatId = to.includes('@') ? to : `${to.replace(/\D/g, '')}@c.us`;
    const media = new MessageMedia(mimetype, base64, filename);
    const sent = await client.sendMessage(chatId, media, { caption });
    res.json({ success: true, id: sent.id._serialized });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/chats', async (_, res) => {
  if (!isReady) return res.status(503).json({ success: false, message: 'Not connected' });
  try {
    const chats = await client.getChats();
    res.json({ success: true, chats: chats.slice(0, 100).map(c => ({
      id: c.id._serialized, name: c.name, isGroup: c.isGroup,
      unreadCount: c.unreadCount, lastMessage: c.lastMessage?.body ?? '',
      lastMessageTime: c.lastMessage?.timestamp ?? 0, pinned: c.pinned, archived: c.archived,
    })) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/messages', async (req, res) => {
  const { chatId, limit = 50 } = req.body;
  if (!isReady) return res.status(503).json({ success: false, message: 'Not connected' });
  if (!chatId) return res.status(400).json({ success: false, message: 'Missing chatId' });
  try {
    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit });
    res.json({ success: true, messages: messages.map(m => ({
      id: m.id._serialized, body: m.body, type: m.type, fromMe: m.fromMe,
      timestamp: m.timestamp, hasMedia: m.hasMedia, ack: m.ack, author: m.author ?? null,
    })) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/read', async (req, res) => {
  const { chatId } = req.body;
  if (!isReady) return res.status(503).json({ success: false, message: 'Not connected' });
  try {
    const chat = await client.getChatById(chatId);
    await chat.sendSeen();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/logout', async (_, res) => {
  if (!client) return res.json({ success: false, message: 'No client' });
  try {
    await client.logout();
    isReady = false;
    initLock = false;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
  console.log('[Socket] Connected:', socket.id);
  socket.emit('init', {
    isReady, isInitializing,
    qrCode: qrCodeData,
    phone: isReady ? client?.info?.wid?.user : null,
    name: isReady ? client?.info?.pushname : null,
  });
  socket.on('disconnect', () => console.log('[Socket] Disconnected:', socket.id));
});

// ---------- Boot ----------
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  setTimeout(initClient, 2000);
});