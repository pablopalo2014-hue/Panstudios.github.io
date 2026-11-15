// Game Blocks - Panel de administración
// Requiere: express, cors, helmet, bcryptjs, jsonwebtoken
// IMPORTANTE: configura JWT_SECRET y, en Render, almacenamiento persistente para database.json.

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;
const PANEL_ORIGIN = (process.env.PANEL_ORIGIN || "https://www.gameblocks.panstudios.es").replace(/\/$/, "");
const RENDER_ORIGIN = "https://panstudios-github-io-1.onrender.com";
const JWT_SECRET = process.env.JWT_SECRET;
const BOOTSTRAP_CODE = process.env.BOOTSTRAP_CODE || "";
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "database.json");
const COOKIE_NAME = "gb_panel_session";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const REQUEST_LIFETIME_MS = 60 * 1000;

if (!JWT_SECRET && process.env.NODE_ENV === "production") {
  throw new Error("Falta configurar JWT_SECRET en las variables de entorno de Render.");
}
const SIGNING_SECRET = JWT_SECRET || crypto.randomBytes(48).toString("hex");

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

const allowedOrigins = new Set([
  PANEL_ORIGIN,
  "https://www.gameblocks.panstudios.es",
  "https://gameblocks.panstudios.es",
  RENDER_ORIGIN
]);
app.use(cors({
  origin(origin, callback) {
    // Godot y clientes nativos normalmente no envían Origin.
    if (!origin || allowedOrigins.has(origin.replace(/\/$/, ""))) return callback(null, true);
    return callback(new Error("Origen no permitido por CORS."));
  },
  credentials: true
}));

function initialDatabase() {
  return { bootstrapUsed: false, users: [], godotRequests: [] };
}

function loadDatabase() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(initialDatabase(), null, 2));
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return {
      bootstrapUsed: Boolean(parsed.bootstrapUsed),
      users: Array.isArray(parsed.users) ? parsed.users : [],
      godotRequests: Array.isArray(parsed.godotRequests) ? parsed.godotRequests : []
    };
  } catch (error) {
    console.error("No se pudo leer database.json:", error);
    throw new Error("La base de datos no es válida. No se sobrescribirá automáticamente.");
  }
}

let db = loadDatabase();

function saveDatabase() {
  const temporary = `${DATA_FILE}.tmp`;
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify(db, null, 2));
  fs.renameSync(temporary, DATA_FILE);
}

function cleanExpiredRequests() {
  const now = Date.now();
  let changed = false;

  for (const request of db.godotRequests) {
    if (request.status === "pending" && request.expiresAt <= now) {
      request.status = "expired";
      changed = true;
    }
  }

  // Conserva las respuestas aprobadas/rechazadas durante 10 minutos
  // para que Godot pueda recibirlas aunque el siguiente sondeo llegue tarde.
  const before = db.godotRequests.length;
  db.godotRequests = db.godotRequests.filter(request => request.expiresAt + 10 * 60 * 1000 > now);
  if (db.godotRequests.length !== before) changed = true;

  if (changed) saveDatabase();
}

function safeUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt
  };
}

function createSessionToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role },
    SIGNING_SECRET,
    { expiresIn: SESSION_SECONDS }
  );
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: SESSION_SECONDS * 1000,
    path: "/"
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    path: "/"
  });
}

function requireLogin(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Inicia sesión primero." });

  try {
    const payload = jwt.verify(token, SIGNING_SECRET);
    const user = db.users.find(item => item.id === payload.sub);
    if (!user) return res.status(401).json({ error: "La cuenta ya no existe." });
    req.user = user;
    next();
  } catch {
    clearSessionCookie(res);
    return res.status(401).json({ error: "La sesión ha caducado. Inicia sesión de nuevo." });
  }
}

function requireOpMod(req, res, next) {
  if (!req.user || req.user.role !== "op_mod") {
    return res.status(403).json({ error: "Solo OP MOD puede crear cuentas." });
  }
  next();
}

const rateBuckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const current = rateBuckets.get(key);
  if (!current || current.until <= now) {
    rateBuckets.set(key, { count: 1, until: now + windowMs });
    return false;
  }
  current.count += 1;
  return current.count > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of rateBuckets) if (value.until <= now) rateBuckets.delete(key);
}, 60_000).unref();

function validUsername(username) {
  return typeof username === "string" &&
    username.trim().length >= 3 &&
    username.trim().length <= 20 &&
    /^[a-zA-Z0-9_-]+$/.test(username.trim());
}

function validPassword(password) {
  return typeof password === "string" && password.length >= 8 && password.length <= 100;
}

function usernameTaken(username) {
  const normalized = username.trim().toLowerCase();
  return db.users.some(user => user.username.toLowerCase() === normalized);
}

function makeUser(username, passwordHash, role) {
  return {
    id: crypto.randomUUID(),
    username: username.trim(),
    passwordHash,
    role,
    createdAt: new Date().toISOString()
  };
}

// La página del panel se sirve desde este mismo servicio.
// No se publica la carpeta completa para evitar exponer database.json.
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});
app.get("/health", (req, res) => res.json({ ok: true, service: "gameblocks-panel" }));

app.get("/api/auth/bootstrap-status", (req, res) => {
  res.json({ available: !db.bootstrapUsed && db.users.length === 0 });
});

app.post("/api/auth/bootstrap", async (req, res) => {
  const ip = req.ip || "unknown";
  if (rateLimit(`bootstrap:${ip}`, 5, 10 * 60 * 1000)) {
    return res.status(429).json({ error: "Demasiados intentos. Espera un poco." });
  }

  const { code, username, password } = req.body || {};
  if (!BOOTSTRAP_CODE) {
    return res.status(503).json({ error: "El registro inicial no está configurado en el servidor." });
  }
  if (db.bootstrapUsed || db.users.length > 0) {
    return res.status(409).json({ error: "El código de registro inicial ya fue utilizado." });
  }
  if (typeof code !== "string" || code !== BOOTSTRAP_CODE) {
    return res.status(400).json({ error: "Código incorrecto." });
  }
  if (!validUsername(username)) {
    return res.status(400).json({ error: "El nombre debe tener entre 3 y 20 caracteres: letras, números, guion o guion bajo." });
  }
  if (!validPassword(password)) {
    return res.status(400).json({ error: "La contraseña debe tener entre 8 y 100 caracteres." });
  }
  if (usernameTaken(username)) return res.status(409).json({ error: "Ese nombre ya está ocupado." });

  const passwordHash = await bcrypt.hash(password, 12);
  const user = makeUser(username, passwordHash, "op_mod");
  db.users.push(user);
  db.bootstrapUsed = true;
  saveDatabase();

  setSessionCookie(res, createSessionToken(user));
  res.json({ ok: true, user: safeUser(user) });
});

app.post("/api/auth/login", async (req, res) => {
  const ip = req.ip || "unknown";
  if (rateLimit(`login:${ip}`, 10, 10 * 60 * 1000)) {
    return res.status(429).json({ error: "Demasiados intentos. Espera unos minutos." });
  }

  const { username, password } = req.body || {};
  if (typeof username !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "Introduce nombre y contraseña." });
  }

  const user = db.users.find(item => item.username.toLowerCase() === username.trim().toLowerCase());
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: "Nombre o contraseña incorrectos." });
  }

  setSessionCookie(res, createSessionToken(user));
  res.json({ ok: true, user: safeUser(user) });
});

app.post("/api/auth/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/me", requireLogin, (req, res) => {
  res.json({ user: safeUser(req.user) });
});

// OP MOD crea cuentas de asistente o moderador.
app.post("/api/admin/users", requireLogin, requireOpMod, async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!["assistant", "moderator"].includes(role)) {
    return res.status(400).json({ error: "El rango debe ser assistant o moderator." });
  }
  if (!validUsername(username)) {
    return res.status(400).json({ error: "Nombre no válido." });
  }
  if (!validPassword(password)) {
    return res.status(400).json({ error: "La contraseña debe tener entre 8 y 100 caracteres." });
  }
  if (usernameTaken(username)) return res.status(409).json({ error: "Ese nombre ya está ocupado." });

  const passwordHash = await bcrypt.hash(password, 12);
  const user = makeUser(username, passwordHash, role);
  db.users.push(user);
  saveDatabase();
  res.json({ ok: true, user: safeUser(user) });
});

app.get("/api/admin/users", requireLogin, requireOpMod, (req, res) => {
  res.json({ users: db.users.map(safeUser) });
});

// Godot crea una solicitud que caduca en 60 segundos.
// El secreto de consulta solo se entrega a la instancia de Godot que la creó.
app.post("/api/godot/request", (req, res) => {
  cleanExpiredRequests();
  const id = crypto.randomBytes(24).toString("hex");
  const pollSecret = crypto.randomBytes(32).toString("hex");
  const now = Date.now();

  db.godotRequests.push({
    id,
    pollSecret,
    status: "pending",
    createdAt: now,
    expiresAt: now + REQUEST_LIFETIME_MS,
    approvedRole: null,
    approvedUsername: null
  });
  saveDatabase();

  res.json({
    ok: true,
    request_id: id,
    poll_secret: pollSecret,
    expires_in: 60
  });
});

app.get("/api/godot/status", (req, res) => {
  const { id, secret } = req.query;
  if (typeof id !== "string" || typeof secret !== "string") {
    return res.status(400).json({ error: "Falta el identificador de solicitud." });
  }

  cleanExpiredRequests();
  const request = db.godotRequests.find(item => item.id === id);
  if (!request || request.pollSecret !== secret) {
    return res.status(404).json({ status: "not_found", error: "Solicitud no encontrada." });
  }
  if (request.expiresAt <= Date.now() && request.status === "pending") {
    request.status = "expired";
    saveDatabase();
  }

  if (request.status === "approved") {
    return res.json({
      status: "approved",
      role: request.approvedRole,
      username: request.approvedUsername
    });
  }
  return res.json({ status: request.status });
});

// Cualquier cuenta MOD autenticada puede responder a una solicitud.
// Godot recibe el rango real de esa cuenta, no un rango elegido por el navegador.
app.get("/api/admin/requests", requireLogin, (req, res) => {
  cleanExpiredRequests();
  const requests = db.godotRequests
    .filter(item => item.status === "pending" && item.expiresAt > Date.now())
    .map(item => ({
      id: item.id,
      createdAt: new Date(item.createdAt).toISOString(),
      expiresAt: new Date(item.expiresAt).toISOString(),
      secondsLeft: Math.max(0, Math.ceil((item.expiresAt - Date.now()) / 1000))
    }));
  res.json({ requests });
});

app.post("/api/admin/requests/:id/approve", requireLogin, (req, res) => {
  cleanExpiredRequests();
  const request = db.godotRequests.find(item => item.id === req.params.id);
  if (!request) return res.status(404).json({ error: "La solicitud no existe o ha caducado." });
  if (request.expiresAt <= Date.now() || request.status !== "pending") {
    return res.status(410).json({ error: "La solicitud ya no está disponible." });
  }

  request.status = "approved";
  request.approvedRole = req.user.role;
  request.approvedUsername = req.user.username;
  request.approvedAt = Date.now();
  saveDatabase();

  res.json({ ok: true, message: `Solicitud aprobada para ${req.user.username} (${req.user.role}).` });
});

app.post("/api/admin/requests/:id/reject", requireLogin, (req, res) => {
  cleanExpiredRequests();
  const request = db.godotRequests.find(item => item.id === req.params.id);
  if (!request) return res.status(404).json({ error: "La solicitud no existe o ha caducado." });
  if (request.status !== "pending" || request.expiresAt <= Date.now()) {
    return res.status(410).json({ error: "La solicitud ya no está disponible." });
  }
  request.status = "rejected";
  saveDatabase();
  res.json({ ok: true });
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "Error interno del servidor." });
});

app.listen(PORT, () => {
  console.log(`Game Blocks Panel escuchando en el puerto ${PORT}`);
  console.log(`Archivo de datos: ${DATA_FILE}`);
});
