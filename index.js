const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));

let qrCodeData = null;
let isReady = false;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './wa_session' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  }
});

// ── QR Code ────────────────────────────────────────────────────────────────
client.on('qr', async (qr) => {
  qrCodeData = await qrcode.toDataURL(qr);
  isReady = false;
  io.emit('qr', qrCodeData);
  console.log('QR code generated');
});

// ── Ready ──────────────────────────────────────────────────────────────────
client.on('ready', () => {
  isReady = true;
  qrCodeData = null;
  io.emit('ready', { message: 'WhatsApp connected!' });
  console.log('WhatsApp client ready');
});

// ── Disconnected ───────────────────────────────────────────────────────────
client.on('disconnected', (reason) => {
  isReady = false;
  io.emit('disconnected', { reason });
  console.log('WhatsApp disconnected:', reason);
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

    // Save to your PHP API
    await fetch(`${process.env.PHP_API_URL}/v1/whatsapp/save-message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.PHP_API_KEY}`,
      },
      body: JSON.stringify(payload),
    }).catch(err => console.error('Failed to save message:', err));

    io.emit('message', payload);
  } catch (err) {
    console.error('Message handling error:', err);
  }
});

// ── Message ACK (sent/delivered/read) ─────────────────────────────────────
client.on('message_ack', (msg, ack) => {
  io.emit('message_ack', { id: msg.id._serialized, ack });
});

// ── REST endpoints ─────────────────────────────────────────────────────────

// Status
app.get('/status', (req, res) => {
  res.json({ isReady, qrCode: qrCodeData });
});

// Send message
app.post('/send', async (req, res) => {
  const { to, message } = req.body;
  if (!isReady) return res.status(503).json({ success: false, message: 'WhatsApp not connected' });
  if (!to || !message) return res.status(400).json({ success: false, message: 'Missing to or message' });
  try {
    const chatId = to.includes('@c.us') ? to : `${to.replace(/\D/g, '')}@c.us`;
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
    const chatId = to.includes('@c.us') ? to : `${to.replace(/\D/g, '')}@c.us`;
    const media  = new MessageMedia(mimetype, base64, filename);
    const sent   = await client.sendMessage(chatId, media, { caption });
    res.json({ success: true, id: sent.id._serialized });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Get all chats
app.get('/chats', async (req, res) => {
  if (!isReady) return res.status(503).json({ success: false, message: 'WhatsApp not connected' });
  try {
    const chats = await client.getChats();
    const data  = chats.slice(0, 50).map(chat => ({
      id:             chat.id._serialized,
      name:           chat.name,
      isGroup:        chat.isGroup,
      unreadCount:    chat.unreadCount,
      lastMessage:    chat.lastMessage?.body ?? '',
      lastMessageTime: chat.lastMessage?.timestamp ?? 0,
    }));
    res.json({ success: true, chats: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Get messages for a chat
app.post('/messages', async (req, res) => {
  const { chatId, limit = 30 } = req.body;
  if (!isReady) return res.status(503).json({ success: false, message: 'WhatsApp not connected' });
  try {
    const chat     = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit });
    const data     = messages.map(msg => ({
      id:        msg.id._serialized,
      body:      msg.body,
      type:      msg.type,
      fromMe:    msg.fromMe,
      timestamp: msg.timestamp,
      hasMedia:  msg.hasMedia,
      ack:       msg.ack,
    }));
    res.json({ success: true, messages: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Logout
app.post('/logout', async (req, res) => {
  try {
    await client.logout();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Socket.io ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  // Send current state to newly connected client
  if (qrCodeData) socket.emit('qr', qrCodeData);
  if (isReady)    socket.emit('ready', { message: 'WhatsApp connected!' });
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

client.initialize();

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`WhatsApp server running on port ${PORT}`));