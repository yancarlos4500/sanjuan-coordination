import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server); // same-origin; no CORS

// ---- Realtime in-memory state ----
let boardState = {
  lanes: { Unassigned: [], 'New York': [], Curacao: [], Piarco: [], Maiquetia: [] },
  items: {},
  lastUpdated: Date.now()
};

io.on('connection', (socket) => {
  socket.on('board:pull', () => socket.emit('board:state', boardState));

  socket.on('board:update', (incoming) => {
    if ((incoming?.lastUpdated || 0) >= (boardState?.lastUpdated || 0)) {
      boardState = incoming;
      socket.broadcast.emit('board:state', boardState);
    }
  });

  socket.on('item:patch', ({ id, patch, mtime }) => {
    if (!id || !patch || !boardState.items[id]) return;
    boardState.items[id] = { ...boardState.items[id], ...patch };
    boardState.lastUpdated = mtime || Date.now();
    socket.broadcast.emit('item:patch:apply', { id, patch, mtime: boardState.lastUpdated });
  });

  socket.on('lanes:move', ({ id, from, to, index, mtime }) => {
    if (!id || !from || !to) return;
    const fromArr = (boardState.lanes[from] || []).filter((x) => x !== id);
    const toArr = [...(boardState.lanes[to] || [])];
    if (typeof index === 'number') toArr.splice(index, 0, id); else toArr.unshift(id);
    boardState.lanes = { ...boardState.lanes, [from]: fromArr, [to]: toArr };
    boardState.lastUpdated = mtime || Date.now();
    socket.broadcast.emit('lanes:move:apply', { id, from, to, index, mtime: boardState.lastUpdated });
  });
});

// ---- Serve built client from /dist ----
const distPath = path.join(__dirname, 'dist');
app.use(express.static(distPath));

// ✅ Express 5-friendly SPA fallback (no route pattern)
app.use((req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server + Socket.IO on :${PORT}`));
