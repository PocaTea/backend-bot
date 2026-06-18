const express = require("express");
const { WebSocketServer } = require("ws");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const http = require("http");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ── State ────────────────────────────────────────────────────────────────────
const bots = new Map(); // id → { meta, client, timeout }
const wsClients = new Set();

// ── Broadcast to all dashboard clients ───────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

function botList() {
  return [...bots.entries()].map(([id, b]) => ({
    id,
    username: b.meta.username,
    host: b.meta.host,
    port: b.meta.port,
    type: b.meta.type,
    status: b.meta.status,
    connectedAt: b.meta.connectedAt,
    logoutAt: b.meta.logoutAt,
  }));
}

function log(id, msg, level = "info") {
  broadcast({ event: "log", id, msg, level, ts: Date.now() });
}

// ── Random username generator ─────────────────────────────────────────────────
const adjectives = ["Shadow", "Pixel", "Void", "Nether", "Ender", "Blazing", "Creepy", "Silent", "Swift", "Iron"];
const nouns = ["Steve", "Walker", "Miner", "Creeper", "Ghast", "Wither", "Golem", "Zombie", "Rider", "Wolf"];

function randomUsername() {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 999);
  return `${adj}${noun}${num}`;
}

// ── Schedule random logout (30s – 5min) ───────────────────────────────────────
function scheduleLogout(id) {
  const delay = Math.floor(Math.random() * (5 * 60 * 1000 - 30 * 1000) + 30 * 1000);
  const logoutAt = Date.now() + delay;

  const bot = bots.get(id);
  if (!bot) return;
  bot.meta.logoutAt = logoutAt;

  bot.timeout = setTimeout(() => {
    disconnectBot(id, "scheduled");
  }, delay);

  log(id, `Bot akan logout dalam ${Math.round(delay / 1000)}s`, "info");
  broadcast({ event: "update", bots: botList() });
}

// ── Connect Java bot ──────────────────────────────────────────────────────────
async function connectJava(id, host, port, username, version) {
  const mc = require("minecraft-protocol");

  const bot = bots.get(id);
  bot.meta.status = "connecting";
  broadcast({ event: "update", bots: botList() });

  try {
    const client = mc.createClient({
      host,
      port: parseInt(port),
      username,
      version: version || "1.20.1",
      auth: "offline",
      hideErrors: false,
    });

    bot.client = client;

    client.on("connect", () => {
      bot.meta.status = "connected";
      bot.meta.connectedAt = Date.now();
      log(id, `Connected ke ${host}:${port} (Java)`, "success");
      broadcast({ event: "update", bots: botList() });
      scheduleLogout(id);
    });

    client.on("packet", (data, meta) => {
      if (meta.name === "chat" || meta.name === "system_chat") {
        const text = data.message || data.formattedMessage || "";
        if (text) log(id, `[CHAT] ${text.substring(0, 100)}`, "chat");
      }
      if (meta.name === "kick_disconnect") {
        log(id, `Kicked: ${data.reason}`, "error");
        cleanupBot(id);
      }
    });

    client.on("error", (err) => {
      log(id, `Error: ${err.message}`, "error");
      bot.meta.status = "error";
      broadcast({ event: "update", bots: botList() });
      cleanupBot(id);
    });

    client.on("end", () => {
      if (bot.meta.status !== "disconnected") {
        log(id, "Koneksi terputus", "warn");
        cleanupBot(id);
      }
    });
  } catch (err) {
    log(id, `Gagal konek: ${err.message}`, "error");
    bot.meta.status = "error";
    broadcast({ event: "update", bots: botList() });
  }
}

// ── Connect Bedrock bot ───────────────────────────────────────────────────────
async function connectBedrock(id, host, port, username) {
  const bedrock = require("bedrock-protocol");

  const bot = bots.get(id);
  bot.meta.status = "connecting";
  broadcast({ event: "update", bots: botList() });

  try {
    const client = bedrock.createClient({
      host,
      port: parseInt(port) || 19132,
      username,
      offline: true,
      connectTimeout: 10000,
    });

    bot.client = client;

    client.on("join", () => {
      bot.meta.status = "connected";
      bot.meta.connectedAt = Date.now();
      log(id, `Connected ke ${host}:${port} (Bedrock)`, "success");
      broadcast({ event: "update", bots: botList() });
      scheduleLogout(id);
    });

    client.on("text", (packet) => {
      const msg = packet.message || "";
      if (msg) log(id, `[CHAT] ${msg.substring(0, 100)}`, "chat");
    });

    client.on("disconnect", (reason) => {
      log(id, `Disconnect: ${typeof reason === "object" ? JSON.stringify(reason) : reason}`, "warn");
      cleanupBot(id);
    });

    client.on("error", (err) => {
      log(id, `Error: ${err.message}`, "error");
      bot.meta.status = "error";
      broadcast({ event: "update", bots: botList() });
      cleanupBot(id);
    });
  } catch (err) {
    log(id, `Gagal konek: ${err.message}`, "error");
    bot.meta.status = "error";
    broadcast({ event: "update", bots: botList() });
  }
}

// ── Disconnect / cleanup ──────────────────────────────────────────────────────
function disconnectBot(id, reason = "manual") {
  const bot = bots.get(id);
  if (!bot) return;

  log(id, `Disconnect (${reason})`, "warn");

  if (bot.timeout) clearTimeout(bot.timeout);

  try {
    if (bot.client) {
      if (bot.meta.type === "java") {
        bot.client.end("Disconnect");
      } else {
        bot.client.close();
      }
    }
  } catch (_) {}

  cleanupBot(id);
}

function cleanupBot(id) {
  const bot = bots.get(id);
  if (!bot) return;
  if (bot.timeout) clearTimeout(bot.timeout);
  bot.meta.status = "disconnected";
  bot.client = null;
  broadcast({ event: "update", bots: botList() });

  // Auto-remove after 10s
  setTimeout(() => {
    bots.delete(id);
    broadcast({ event: "update", bots: botList() });
  }, 10000);
}

// ── REST API ──────────────────────────────────────────────────────────────────
app.get("/", (_, res) => res.json({ status: "ok", bots: bots.size }));

app.get("/bots", (_, res) => res.json(botList()));

app.post("/bots", async (req, res) => {
  const { host, port, type, username, version, count = 1 } = req.body;

  if (!host || !type || !["java", "bedrock"].includes(type)) {
    return res.status(400).json({ error: "host dan type (java/bedrock) wajib diisi" });
  }

  const actualPort = port || (type === "bedrock" ? 19132 : 25565);
  const ids = [];

  for (let i = 0; i < Math.min(count, 20); i++) {
    const id = uuidv4().substring(0, 8);
    const uname = username || randomUsername();

    bots.set(id, {
      meta: {
        id,
        username: count > 1 ? `${uname}_${i + 1}` : uname,
        host,
        port: actualPort,
        type,
        status: "pending",
        connectedAt: null,
        logoutAt: null,
      },
      client: null,
      timeout: null,
    });

    ids.push(id);

    const botUsername = count > 1 ? `${uname}_${i + 1}` : uname;

    // Stagger connections 1.5s apart
    setTimeout(() => {
      if (type === "java") {
        connectJava(id, host, actualPort, botUsername, version);
      } else {
        connectBedrock(id, host, actualPort, botUsername);
      }
    }, i * 1500);
  }

  broadcast({ event: "update", bots: botList() });
  res.json({ ok: true, ids });
});

app.delete("/bots/:id", (req, res) => {
  const { id } = req.params;
  if (!bots.has(id)) return res.status(404).json({ error: "Bot tidak ditemukan" });
  disconnectBot(id, "manual");
  res.json({ ok: true });
});

app.delete("/bots", (_, res) => {
  for (const id of bots.keys()) disconnectBot(id, "manual");
  res.json({ ok: true });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on("connection", (ws) => {
  wsClients.add(ws);
  ws.send(JSON.stringify({ event: "init", bots: botList() }));

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.action === "disconnect" && msg.id) disconnectBot(msg.id, "dashboard");
      if (msg.action === "disconnectAll") {
        for (const id of bots.keys()) disconnectBot(id, "dashboard");
      }
    } catch (_) {}
  });

  ws.on("close", () => wsClients.delete(ws));
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`MC Bot Backend running on :${PORT}`));
               
