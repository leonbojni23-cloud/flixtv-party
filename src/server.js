'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const ROOM_TTL_MS = Math.max(60_000, Number(process.env.ROOM_TTL_MS) || 12 * 60 * 60 * 1000);
const MAX_ROOM_MEMBERS = 30;
const MAX_CHAT_LENGTH = 500;
const MAX_QUEUE_ITEMS = 50;
const origins = (process.env.CORS_ORIGINS || '*').split(',').map((value) => value.trim()).filter(Boolean);

const app = express();
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || origins.includes('*') || origins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed by CORS'));
  },
  methods: ['GET', 'POST'],
}));
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: origins.includes('*') ? '*' : origins,
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
  pingInterval: 25_000,
  pingTimeout: 20_000,
  maxHttpBufferSize: 1e5,
});

const rooms = new Map();
const socketMembership = new Map();

const now = () => Date.now();
const makeId = (bytes = 6) => crypto.randomBytes(bytes).toString('base64url');
const cleanText = (value, max = 80) => String(value ?? '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max);
const hashToken = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const safeEqual = (a, b) => {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

function publicRoom(room) {
  return {
    id: room.id,
    name: room.name,
    visibility: room.visibility,
    movie: room.movie,
    host: room.hostName,
    memberCount: room.members.size,
    createdAt: room.createdAt,
    playback: { status: room.playback.status, position: room.playback.position, updatedAt: room.playback.updatedAt },
  };
}

function roomSnapshot(room) {
  return {
    ...publicRoom(room),
    members: [...room.members.values()].map(({ userId, username, isHost, joinedAt }) => ({ userId, username, isHost, joinedAt })),
    playback: room.playback,
    queue: room.queue,
    chat: room.chat.slice(-50),
  };
}

function emitPresence(room) {
  io.to(room.id).emit('presence:update', {
    members: [...room.members.values()].map(({ userId, username, isHost, joinedAt }) => ({ userId, username, isHost, joinedAt })),
    memberCount: room.members.size,
  });
}

function removeMember(room, userId, reason = 'left') {
  const member = room.members.get(userId);
  if (!member) return;
  room.members.delete(userId);
  if (member.socketId) {
    socketMembership.delete(member.socketId);
    const memberSocket = io.sockets.sockets.get(member.socketId);
    if (memberSocket) memberSocket.leave(room.id);
  }
  io.to(room.id).emit('presence:left', { userId, username: member.username, reason });
  emitPresence(room);

  if (room.members.size === 0) {
    room.emptySince = now();
  } else if (room.hostUserId === userId) {
    const nextHost = room.members.values().next().value;
    room.hostUserId = nextHost.userId;
    nextHost.isHost = true;
    room.hostName = nextHost.username;
    io.to(room.id).emit('room:host-changed', { userId: nextHost.userId, username: nextHost.username });
    emitPresence(room);
  }
}

function getRoom(req, res) {
  const room = rooms.get(req.params.id);
  if (!room) {
    res.status(404).json({ error: 'ROOM_NOT_FOUND' });
    return null;
  }
  return room;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'flixtv-party', uptime: Math.round(process.uptime()), rooms: rooms.size, timestamp: new Date().toISOString() });
});

app.get('/api/rooms', (_req, res) => {
  const publicRooms = [...rooms.values()]
    .filter((room) => room.visibility === 'public' && room.members.size > 0)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicRoom);
  res.json({ rooms: publicRooms });
});

app.post('/api/rooms', (req, res) => {
  const username = cleanText(req.body?.username, 32);
  const name = cleanText(req.body?.name, 60) || `${username || 'Someone'}'s Watch Party`;
  const visibility = req.body?.visibility === 'public' ? 'public' : 'private';
  const movieInput = req.body?.movie && typeof req.body.movie === 'object' ? req.body.movie : {};
  const movie = {
    id: cleanText(movieInput.id, 80),
    title: cleanText(movieInput.title, 160),
    type: movieInput.type === 'tv' ? 'tv' : 'movie',
    season: Number.isInteger(movieInput.season) ? movieInput.season : null,
    episode: Number.isInteger(movieInput.episode) ? movieInput.episode : null,
  };

  if (!username) return res.status(400).json({ error: 'USERNAME_REQUIRED' });
  if (!movie.title) return res.status(400).json({ error: 'MOVIE_TITLE_REQUIRED' });

  const id = makeId(6);
  const hostToken = makeId(32);
  const inviteCode = makeId(5).toUpperCase();
  const room = {
    id, name, visibility, movie, hostName: username,
    hostUserId: null,
    hostTokenHash: hashToken(hostToken),
    inviteCodeHash: hashToken(inviteCode),
    createdAt: now(),
    emptySince: null,
    members: new Map(),
    playback: { status: 'paused', position: 0, duration: 0, updatedAt: now(), updatedBy: null, revision: 0 },
    queue: [],
    chat: [],
  };
  rooms.set(id, room);
  res.status(201).json({
    room: publicRoom(room),
    hostToken,
    inviteCode: visibility === 'private' ? inviteCode : null,
    joinUrlPath: `/party/${id}`,
  });
});

app.get('/api/rooms/:id', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  if (room.visibility === 'private') return res.status(403).json({ error: 'PRIVATE_ROOM' });
  res.json({ room: publicRoom(room) });
});

io.on('connection', (socket) => {
  socket.on('room:join', (payload = {}, ack = () => {}) => {
    const roomId = cleanText(payload.roomId, 32);
    const username = cleanText(payload.username, 32);
    const userId = cleanText(payload.userId, 80) || makeId(12);
    const room = rooms.get(roomId);

    if (!room) return ack({ ok: false, error: 'ROOM_NOT_FOUND' });
    if (!username) return ack({ ok: false, error: 'USERNAME_REQUIRED' });
    if (room.visibility === 'private' && !safeEqual(hashToken(cleanText(payload.inviteCode, 32).toUpperCase()), room.inviteCodeHash)) {
      return ack({ ok: false, error: 'INVALID_INVITE_CODE' });
    }
    if (!room.members.has(userId) && room.members.size >= MAX_ROOM_MEMBERS) {
      return ack({ ok: false, error: 'ROOM_FULL' });
    }

    const previous = room.members.get(userId);
    if (previous?.socketId && previous.socketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(previous.socketId);
      if (oldSocket) {
        oldSocket.leave(room.id);
        oldSocket.emit('room:replaced', { reason: 'This account joined from another connection.' });
      }
      socketMembership.delete(previous.socketId);
    }

    const isHost = safeEqual(hashToken(String(payload.hostToken || '')), room.hostTokenHash);
    const member = {
      userId,
      username,
      socketId: socket.id,
      isHost: isHost || room.hostUserId === userId,
      joinedAt: previous?.joinedAt || now(),
    };
    if (isHost) {
      room.hostUserId = userId;
      room.hostName = username;
    }
    room.members.set(userId, member);
    room.emptySince = null;
    socketMembership.set(socket.id, { roomId, userId });
    socket.join(room.id);

    socket.emit('room:state', roomSnapshot(room));
    socket.to(room.id).emit('presence:joined', { userId, username, isHost: member.isHost });
    emitPresence(room);
    ack({ ok: true, userId, room: roomSnapshot(room) });
  });

  socket.on('playback:command', (payload = {}, ack = () => {}) => {
    const membership = socketMembership.get(socket.id);
    const room = membership && rooms.get(membership.roomId);
    const member = room?.members.get(membership.userId);
    if (!room || !member) return ack({ ok: false, error: 'NOT_IN_ROOM' });
    if (!member.isHost) return ack({ ok: false, error: 'HOST_ONLY' });

    const action = payload.action;
    if (!['play', 'pause', 'seek'].includes(action)) return ack({ ok: false, error: 'INVALID_ACTION' });
    const position = Number(payload.position);
    if (!Number.isFinite(position) || position < 0 || position > 60 * 60 * 12) return ack({ ok: false, error: 'INVALID_POSITION' });

    room.playback = {
      ...room.playback,
      status: action === 'play' ? 'playing' : action === 'pause' ? 'paused' : room.playback.status,
      position,
      duration: Number.isFinite(Number(payload.duration)) ? Math.max(0, Number(payload.duration)) : room.playback.duration,
      updatedAt: now(),
      updatedBy: member.userId,
      revision: room.playback.revision + 1,
    };
    io.to(room.id).emit('playback:state', { ...room.playback, action, serverTime: now() });
    ack({ ok: true, playback: room.playback });
  });

  socket.on('chat:send', (payload = {}, ack = () => {}) => {
    const membership = socketMembership.get(socket.id);
    const room = membership && rooms.get(membership.roomId);
    const member = room?.members.get(membership?.userId);
    const message = cleanText(payload.message, MAX_CHAT_LENGTH);
    if (!room || !member) return ack({ ok: false, error: 'NOT_IN_ROOM' });
    if (!message) return ack({ ok: false, error: 'EMPTY_MESSAGE' });
    const item = { id: makeId(10), userId: member.userId, username: member.username, message, createdAt: now() };
    room.chat.push(item);
    if (room.chat.length > 200) room.chat.splice(0, room.chat.length - 200);
    io.to(room.id).emit('chat:new', item);
    ack({ ok: true, message: item });
  });

  socket.on('reaction:send', (payload = {}, ack = () => {}) => {
    const membership = socketMembership.get(socket.id);
    const room = membership && rooms.get(membership.roomId);
    const member = room?.members.get(membership?.userId);
    const allowed = new Set(['❤️', '😂', '😮', '👏', '🔥', '😭', '🍿']);
    if (!room || !member) return ack({ ok: false, error: 'NOT_IN_ROOM' });
    if (!allowed.has(payload.emoji)) return ack({ ok: false, error: 'INVALID_REACTION' });
    io.to(room.id).emit('reaction:new', { userId: member.userId, username: member.username, emoji: payload.emoji, createdAt: now() });
    ack({ ok: true });
  });

  socket.on('queue:add', (payload = {}, ack = () => {}) => {
    const membership = socketMembership.get(socket.id);
    const room = membership && rooms.get(membership.roomId);
    const member = room?.members.get(membership?.userId);
    if (!room || !member) return ack({ ok: false, error: 'NOT_IN_ROOM' });
    if (room.queue.length >= MAX_QUEUE_ITEMS) return ack({ ok: false, error: 'QUEUE_FULL' });
    const title = cleanText(payload.title, 160);
    if (!title) return ack({ ok: false, error: 'TITLE_REQUIRED' });
    const item = { id: makeId(8), tmdbId: cleanText(payload.tmdbId, 40), title, type: payload.type === 'tv' ? 'tv' : 'movie', addedBy: member.username, addedAt: now() };
    room.queue.push(item);
    io.to(room.id).emit('queue:updated', { queue: room.queue });
    ack({ ok: true, item });
  });

  socket.on('queue:remove', (payload = {}, ack = () => {}) => {
    const membership = socketMembership.get(socket.id);
    const room = membership && rooms.get(membership.roomId);
    const member = room?.members.get(membership?.userId);
    if (!room || !member) return ack({ ok: false, error: 'NOT_IN_ROOM' });
    if (!member.isHost) return ack({ ok: false, error: 'HOST_ONLY' });
    room.queue = room.queue.filter((item) => item.id !== payload.id);
    io.to(room.id).emit('queue:updated', { queue: room.queue });
    ack({ ok: true });
  });

  socket.on('room:typing', (payload = {}) => {
    const membership = socketMembership.get(socket.id);
    const room = membership && rooms.get(membership.roomId);
    const member = room?.members.get(membership?.userId);
    if (!room || !member) return;
    socket.to(room.id).emit('room:typing', { userId: member.userId, username: member.username, typing: Boolean(payload.typing) });
  });

  socket.on('room:leave', () => {
    const membership = socketMembership.get(socket.id);
    const room = membership && rooms.get(membership.roomId);
    if (room) removeMember(room, membership.userId, 'left');
  });

  socket.on('disconnect', () => {
    const membership = socketMembership.get(socket.id);
    if (!membership) return;
    const room = rooms.get(membership.roomId);
    const member = room?.members.get(membership.userId);
    if (member?.socketId === socket.id) removeMember(room, membership.userId, 'disconnected');
    socketMembership.delete(socket.id);
  });
});

setInterval(() => {
  const cutoff = now() - ROOM_TTL_MS;
  for (const [id, room] of rooms) {
    if (room.createdAt < cutoff || (room.emptySince && room.emptySince < now() - 30 * 60 * 1000)) {
      io.to(id).emit('room:closed', { reason: 'Room expired or empty.' });
      rooms.delete(id);
    }
  }
}, 60_000).unref();

const serverError = (error, _req, res, _next) => {
  if (res.headersSent) return;
  res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
};
app.use(serverError);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`FLIXTV Party listening on port ${PORT}`);
});
