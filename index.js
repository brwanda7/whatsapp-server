require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode     = require('qrcode');
const cors       = require('cors');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

// ── State ──────────────────────────────────────────────────────────────────
let qrCodeData    = null;
let isReady       = false;
let isInitializing = false;

// ── WhatsApp Client ────────────────────────────────────────────────────────
// On Render: mount a persistent disk at /data and set dataPath there
// On Render free tier: use /tmp (will reset on restart but at least won't crash)
const SESSION_PATH = process.env.SESSION_PATH || './wa_session';

function createClient() {
  return new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_PATH, clientId: 'main' }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--single-process',         // important for Render
      ],
    },
    restartOnAuthFail: true,        // auto-restart if auth fails instead of logout loop
  });
}

let client = createClient();

// ── QR ─────────────────────────────────────────────────────────────────────
client.on('qr', async (qr) => {
  console.log('QR received');
  qrCodeData = await qrcode.toDataURL(qr);
  isReady    = false;
  io.emit('qr', qrCodeData);
});

// ── Loading screen ─────────────────────────────────────────────────────────
client.on('loading_screen', (percent, message) => {
  console.log(`Loading: ${percent}% — ${message}`);
  io.emit('loading', { percent, message });
});

// ── Authenticated ──────────────────────────────────────────────────────────
client.on('authenticated', () => {
  console.log('Authenticated ✓');
  qrCodeData = null;
  io.emit('authenticated');
});

// ── Auth failure ───────────────────────────────────────────────────────────
client.on('auth_failure', (msg) => {
  console.error('Auth failure:', msg);
  isReady = false;
  io.emit('auth_failure', { message: msg });
});

// ── Ready ──────────────────────────────────────────────────────────────────
client.on('ready', async () => {
  isReady        = true;
  isInitializing = false;
  qrCodeData     = null;
  const info     = client.info;
  console.log('WhatsApp ready ✓', info?.wid?.user);
  io.emit('ready', {
    phone:  info?.wid?.user,
    name:   info?.pushname,
  });
});

// ── Disconnected ───────────────────────────────────────────────────────────
client.on('disconnected', async (reason) => {
  console.log('Disconnected:', reason);
  isReady = false;
  io.emit('disconnected', { reason });

  // Only auto-reinitialize for non-manual logouts
  if (reason !== 'LOGOUT') {
    console.log('Attempting reconnect in 5s...');
    setTimeout(() => {
      if (!isReady && !isInitializing) {
        isInitializing = true;
        client.initialize().catch(console.error);
      }
    }, 5000);
  }
});

// ── Incoming message ───────────────────────────────────────────────────────
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

    // Save to PHP API if configured
    if (process.env.PHP_API_URL) {
      fetch(`${process.env.PHP_API_URL}/v1/whatsapp/save-message`, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization:  `Bearer ${process.env.PHP_API_KEY}`,
        },
        body: JSON.stringify(payload),
      }).catch(err => console.error('Save message failed:', err.message));
    }
  } catch (err) {
    console.error('Message event error:', err.message);
  }
});

// ── Message ACK ────────────────────────────────────────────────────────────
client.on('message_ack', (msg, ack) => {
  io.emit('message_ack', { id: msg.id._serialized, ack });
});

// ── Keep-alive ping (prevents Render free tier from sleeping) ──────────────
setInterval(() => {
  if (process.env.RENDER_EXTERNAL_URL) {
    fetch(`${process.env.RENDER_EXTERNAL_URL}/ping`)
      .catch(() => {}); // silent fail
  }
}, 14 * 60 * 1000); // every 14 minutes

// ────────────────────────────────────────────────────────────────────────────
// REST API
// ────────────────────────────────────────────────────────────────────────────

// Health / keep-alive
app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Status
app.get('/status', (req, res) => {
  res.json({
    isReady,
    isInitializing,
    qrCode: qrCodeData,
    phone:  isReady ? client.info?.wid?.user  : null,
    name:   isReady ? client.info?.pushname   : null,
  });
});

// Send text message
app.post('/send', async (req, res) => {
  const { to, message } = req.body;
  if (!isReady)   return res.status(503).json({ success: false, message: 'WhatsApp not connected' });
  if (!to || !message) return res.status(400).json({ success: false, message: 'Missing to or message' });
  try {
    const chatId = to.includes('@') ? to : `${to.replace(/\D/g, '')}@c.us`;
    const sent   = await client.sendMessage(chatId, message);
    res.json({ success: true, id: sent.id._serialized });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Send media
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

// Get chats
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

// Get messages for a chat
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

// Mark chat as read
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

// Logout
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
  // Immediately push current state
  socket.emit('init', {
    isReady,
    isInitializing,
    qrCode: qrCodeData,
    phone:  isReady ? client.info?.wid?.user : null,
    name:   isReady ? client.info?.pushname  : null,
  });
  socket.on('disconnect', () => console.log('Socket disconnected:', socket.id));
});

// ── Start ──────────────────────────────────────────────────────────────────
isInitializing = true;
client.initialize().catch(err => {
  console.error('Init error:', err);
  isInitializing = false;
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`WA server on port ${PORT}`));