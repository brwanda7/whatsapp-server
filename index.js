require('dotenv').config();
const express          = require('express');
const http             = require('http');
const { Server }       = require('socket.io');
const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode           = require('qrcode');
const cors             = require('cors');
const PhpSessionStore  = require('./PhpSessionStore');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout:  60000,
  pingInterval: 25000,
});

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

// ── State ──────────────────────────────────────────────────────────────────
let client         = null;
let qrCodeData     = null;
let isReady        = false;
let isInitializing = false;

// ── PHP Store ──────────────────────────────────────────────────────────────
const store = new PhpSessionStore(
  process.env.PHP_API_URL,
  process.env.PHP_API_KEY,
);

// ── Init client ────────────────────────────────────────────────────────────
async function initClient() {
  if (isInitializing) return;
  isInitializing = true;
  qrCodeData     = null;
  isReady        = false;

  if (client) {
    try { await client.destroy(); } catch (_) {}
    client = null;
  }

  io.emit('loading', { percent: 0, message: 'Starting WhatsApp...' });

  client = new Client({
    authStrategy: new RemoteAuth({
      clientId:             'main',
      store,
      backupSyncIntervalMs: 60000 * 5, // save every 5 min
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
      ],
    },
    restartOnAuthFail: false,
  });

  // ── QR ───────────────────────────────────────────────────────────────────
  client.on('qr', async (qr) => {
    console.log('New QR code generated');
    qrCodeData     = await qrcode.toDataURL(qr);
    isReady        = false;
    isInitializing = false;
    io.emit('qr', qrCodeData);
  });

  // ── Loading ───────────────────────────────────────────────────────────────
  client.on('loading_screen', (percent, message) => {
    console.log(`Loading ${percent}% — ${message}`);
    io.emit('loading', { percent, message });
  });

  // ── Authenticated ─────────────────────────────────────────────────────────
  client.on('authenticated', () => {
    console.log('Authenticated ✓');
    qrCodeData = null;
    io.emit('authenticated');
  });

  // ── Remote session saved ──────────────────────────────────────────────────
  client.on('remote_session_saved', () => {
    console.log('Session saved to PHP DB ✓');
  });

  // ── Auth failure ──────────────────────────────────────────────────────────
  client.on('auth_failure', async (msg) => {
    console.error('Auth failure:', msg);
    isReady        = false;
    isInitializing = false;
    // Delete bad session from DB so fresh QR is shown
    await store.delete({ session: 'main' });
    io.emit('auth_failure', { message: msg });
    setTimeout(() => initClient(), 3000);
  });

  // ── Ready ─────────────────────────────────────────────────────────────────
  client.on('ready', () => {
    isReady        = true;
    isInitializing = false;
    qrCodeData     = null;
    const info     = client.info;
    console.log('WhatsApp Ready ✓ —', info?.wid?.user);
    io.emit('ready', {
      phone: info?.wid?.user,
      name:  info?.pushname,
    });
  });

  // ── Disconnected ──────────────────────────────────────────────────────────
  client.on('disconnected', async (reason) => {
    console.log('Disconnected:', reason);
    isReady = false;
    io.emit('disconnected', { reason });

    if (reason === 'LOGOUT') {
      // User manually logged out — delete session from DB
      await store.delete({ session: 'main' });
    } else {
      // Unexpected disconnect — try reconnect after 5s
      console.log('Reconnecting in 5s...');
      setTimeout(() => initClient(), 5000);
    }
  });

  // ── Incoming message ──────────────────────────────────────────────────────
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
        fromMe:      msg.fromMe,
        contactName: contact.pushname || contact.number,
        chatName:    chat.name,
        hasMedia:    msg.hasMedia,
      };
      io.emit('message', payload);
      // Save to PHP
      if (process.env.PHP_API_URL) {
        fetch(`${process.env.PHP_API_URL}/v1/whatsapp/save-message`, {
          method:  'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization:  `Bearer ${process.env.PHP_API_KEY}`,
          },
          body: JSON.stringify(payload),
        }).catch(e => console.error('Save msg error:', e.message));
      }
    } catch (err) {
      console.error('Message event error:', err.message);
    }
  });

  // ── Message ACK ───────────────────────────────────────────────────────────
  client.on('message_ack', (msg, ack) => {
    io.emit('message_ack', { id: msg.id._serialized, ack });
  });

  // ── Initialize ────────────────────────────────────────────────────────────
  try {
    await client.initialize();
  } catch (err) {
    console.error('Initialize error:', err.message);
    isInitializing = false;
    setTimeout(() => initClient(), 5000);
  }
}

// ── Keep-alive ping ────────────────────────────────────────────────────────
setInterval(() => {
  if (process.env.RENDER_EXTERNAL_URL) {
    fetch(`${process.env.RENDER_EXTERNAL_URL}/ping`).catch(() => {});
  }
}, 14 * 60 * 1000);

// ── REST endpoints ─────────────────────────────────────────────────────────

app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/status', (req, res) => {
  res.json({
    isReady,
    isInitializing,
    qrCode: qrCodeData,
    phone:  isReady ? client?.info?.wid?.user  : null,
    name:   isReady ? client?.info?.pushname   : null,
  });
});

app.post('/send', async (req, res) => {
  const { to, message } = req.body;
  if (!isReady)        return res.status(503).json({ success: false, message: 'WhatsApp not connected' });
  if (!to || !message) return res.status(400).json({ success: false, message: 'Missing to or message' });
  try {
    const chatId = to.includes('@') ? to : `${to.replace(/\D/g, '')}@c.us`;
    const sent   = await client.sendMessage(chatId, message);
    res.json({ success: true, id: sent.id._serialized });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/send-media', async (req, res) => {
  const { to, base64, mimetype, filename, caption } = req.body;
  if (!isReady) return res.status(503).json({ success: false, message: 'WhatsApp not connected' });
  try {
    const chatId = to.includes('@') ? to : `${to.replace(/\D/g, '')}@c.us`;
    const media  = new MessageMedia(mimetype, base64, filename);
    const sent   = await client.sendMessage(chatId, media, { caption });
    res.json({ success: true, id: sent.id._serialized });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/chats', async (req, res) => {
  if (!isReady) return res.status(503).json({ success: false, message: 'WhatsApp not connected' });
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
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/messages', async (req, res) => {
  const { chatId, limit = 50 } = req.body;
  if (!isReady) return res.status(503).json({ success: false, message: 'WhatsApp not connected' });
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
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/read', async (req, res) => {
  const { chatId } = req.body;
  if (!isReady) return res.status(503).json({ success: false, message: 'WhatsApp not connected' });
  try {
    const chat = await client.getChatById(chatId);
    await chat.sendSeen();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/logout', async (req, res) => {
  try {
    await client.logout();
    isReady = false;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Socket.io ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);
  socket.emit('init', {
    isReady,
    isInitializing,
    qrCode: qrCodeData,
    phone:  isReady ? client?.info?.wid?.user : null,
    name:   isReady ? client?.info?.pushname  : null,
  });
  socket.on('disconnect', () => console.log('Socket disconnected:', socket.id));
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`WA server on port ${PORT}`);
  initClient();
});