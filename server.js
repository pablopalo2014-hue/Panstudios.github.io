// Game Blocks - Panel de administración
// Node.js 18 o superior. GitHub Contents API para almacenamiento permanente.
// Variables necesarias en Render: JWT_SECRET, BOOTSTRAP_CODE,
// GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO.
// Opcionales: GITHUB_BRANCH, GITHUB_DATABASE_PATH, GITHUB_GAMES_PATH, PANEL_ORIGIN.

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

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_OWNER = process.env.GITHUB_OWNER || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GITHUB_DATABASE_PATH = process.env.GITHUB_DATABASE_PATH || "database.json";
const GITHUB_GAMES_PATH = process.env.GITHUB_GAMES_PATH || "games.json";
const GITHUB_ENABLED = Boolean(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO);

if (!JWT_SECRET && process.env.NODE_ENV === "production") {
  throw new Error("Falta configurar JWT_SECRET en las variables de entorno de Render.");
}
if (process.env.NODE_ENV === "production" && !GITHUB_ENABLED) {
  throw new Error("Falta configurar GITHUB_TOKEN, GITHUB_OWNER y GITHUB_REPO. No se iniciará sin almacenamiento permanente.");
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
    if (!origin || allowedOrigins.has(origin.replace(/\/$/, ""))) return callback(null, true);
    return callback(new Error("Origen no permitido por CORS."));
  },
  credentials: true
}));

function initialDatabase() {
  return {
    bootstrapUsed: false,
    users: [],
    godotRequests: [],
    gameDeletionRequests: []
  };
}

function normalizeDatabase(parsed) {
  return {
    bootstrapUsed: Boolean(parsed.bootstrapUsed),
    users: Array.isArray(parsed.users) ? parsed.users : [],
    godotRequests: Array.isArray(parsed.godotRequests) ? parsed.godotRequests : [],
    gameDeletionRequests: Array.isArray(parsed.gameDeletionRequests) ? parsed.gameDeletionRequests : []
  };
}

function githubApiUrl(filePath, ref = GITHUB_BRANCH) {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
}

async function githubRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Game-Blocks-Admin-Panel",
      ...(options.headers || {})
    }
  });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) {
    const message = data.message || `GitHub respondió HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function githubReadJson(filePath) {
  const data = await githubRequest(githubApiUrl(filePath));
  if (!data.content) throw new Error(`GitHub no devolvió contenido para ${filePath}.`);
  const decoded = Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");
  return { value: JSON.parse(decoded), sha: data.sha };
}

async function githubWriteJson(filePath, value, message) {
  // Leer el SHA justo antes de guardar para actualizar el archivo existente.
  let sha = null;
  try {
    const current = await githubReadJson(filePath);
    sha = current.sha;
  } catch (error) {
    if (error.status !== 404) throw error;
  }

  const body = {
    message,
    content: Buffer.from(JSON.stringify(value, null, 2), "utf8").toString("base64"),
    branch: GITHUB_BRANCH
  };
  if (sha) body.sha = sha;

  await githubRequest(
    `https://api.github.com/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/contents/${filePath.split("/").map(encodeURIComponent).join("/")}`,
    { method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
  );
}

let db = null;
let saveQueue = Promise.resolve();

async function loadDatabase() {
  if (GITHUB_ENABLED) {
    try {
      const remote = await githubReadJson(GITHUB_DATABASE_PATH);
      db = normalizeDatabase(remote.value);
      console.log("Base de datos cargada desde GitHub.");
      return;
    } catch (error) {
      if (error.status !== 404) {
        throw new Error(`No se pudo cargar la base de datos de GitHub: ${error.message}`);
      }
      // Solo se crea una base vacía si el archivo realmente no existe.
      db = initialDatabase();
      await githubWriteJson(GITHUB_DATABASE_PATH, db, "Crear base de datos inicial de Game Blocks");
      console.log("Base de datos inicial creada en GitHub.");
      return;
    }
  }

  if (!fs.existsSync(DATA_FILE)) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(initialDatabase(), null, 2));
  }
  try {
    db = normalizeDatabase(JSON.parse(fs.readFileSync(DATA_FILE, "utf8")));
  } catch (error) {
    console.error("No se pudo leer database.json:", error);
    throw new Error("La base de datos local no es válida. No se sobrescribirá automáticamente.");
  }
}

function saveDatabase() {
  const snapshot = JSON.parse(JSON.stringify(db));
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    if (GITHUB_ENABLED) {
      await githubWriteJson(GITHUB_DATABASE_PATH, snapshot, "Actualizar base de datos de Game Blocks");
    } else {
      const temporary = `${DATA_FILE}.tmp`;
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(snapshot, null, 2));
      fs.renameSync(temporary, DATA_FILE);
    }
  });
  return saveQueue;
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

  const before = db.godotRequests.length;
  db.godotRequests = db.godotRequests.filter(request => request.expiresAt + 10 * 60 * 1000 > now);
  if (db.godotRequests.length !== before) changed = true;

  if (changed) saveDatabase().catch(error => console.error("Error guardando caducidad:", error));
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
    return res.status(403).json({ error: "Solo OP MOD puede realizar esta acción." });
  }
  next();
}

function requireModerator(req, res, next) {
  if (!req.user || req.user.role !== "moderator") {
    return res.status(403).json({ error: "Esta sección es exclusiva de Moderador." });
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

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/health", (req, res) => res.json({ ok: true, service: "gameblocks-panel", storage: GITHUB_ENABLED ? "github" : "local" }));

app.get("/api/auth/bootstrap-status", (req, res) => {
  res.json({ available: !db.bootstrapUsed && db.users.length === 0 });
});

app.post("/api/auth/bootstrap", async (req, res) => {
  try {
    const ip = req.ip || "unknown";
    if (rateLimit(`bootstrap:${ip}`, 5, 10 * 60 * 1000)) {
      return res.status(429).json({ error: "Demasiados intentos. Espera un poco." });
    }
    const { code, username, password } = req.body || {};
    if (!BOOTSTRAP_CODE) return res.status(503).json({ error: "El registro inicial no está configurado en el servidor." });
    if (db.bootstrapUsed || db.users.length > 0) return res.status(409).json({ error: "El código de registro inicial ya fue utilizado." });
    if (typeof code !== "string" || code !== BOOTSTRAP_CODE) return res.status(400).json({ error: "Código incorrecto." });
    if (!validUsername(username)) return res.status(400).json({ error: "El nombre debe tener entre 3 y 20 caracteres: letras, números, guion o guion bajo." });
    if (!validPassword(password)) return res.status(400).json({ error: "La contraseña debe tener entre 8 y 100 caracteres." });
    if (usernameTaken(username)) return res.status(409).json({ error: "Ese nombre ya está ocupado." });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = makeUser(username, passwordHash, "op_mod");
    db.users.push(user);
    db.bootstrapUsed = true;
    await saveDatabase();
    setSessionCookie(res, createSessionToken(user));
    res.json({ ok: true, user: safeUser(user) });
  } catch (error) {
    console.error("Error creando OP MOD:", error);
    res.status(500).json({ error: "No se pudo guardar la cuenta. Comprueba la conexión con GitHub." });
  }
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
app.get("/api/me", requireLogin, (req, res) => res.json({ user: safeUser(req.user) }));

// OP MOD crea cuentas de asistente o moderador.
app.post("/api/admin/users", requireLogin, requireOpMod, async (req, res) => {
  try {
    const { username, password, role } = req.body || {};
    if (!["assistant", "moderator"].includes(role)) return res.status(400).json({ error: "El rango debe ser assistant o moderator." });
    if (!validUsername(username)) return res.status(400).json({ error: "Nombre no válido." });
    if (!validPassword(password)) return res.status(400).json({ error: "La contraseña debe tener entre 8 y 100 caracteres." });
    if (usernameTaken(username)) return res.status(409).json({ error: "Ese nombre ya está ocupado." });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = makeUser(username, passwordHash, role);
    db.users.push(user);
    await saveDatabase();
    res.json({ ok: true, user: safeUser(user) });
  } catch (error) {
    console.error("Error creando cuenta:", error);
    res.status(500).json({ error: "No se pudo guardar la cuenta en GitHub." });
  }
});

app.get("/api/admin/users", requireLogin, requireOpMod, (req, res) => {
  res.json({ users: db.users.map(safeUser) });
});

// OP MOD puede borrar asistentes y moderadores, pero no cuentas OP MOD.
app.delete("/api/admin/users/:id", requireLogin, requireOpMod, async (req, res) => {
  const target = db.users.find(user => user.id === req.params.id);
  if (!target) return res.status(404).json({ error: "La cuenta no existe." });
  if (target.role === "op_mod") return res.status(403).json({ error: "Las cuentas OP MOD están protegidas." });
  if (target.id === req.user.id) return res.status(403).json({ error: "No puedes eliminar tu propia cuenta desde aquí." });

  const previousUsers = db.users;
  db.users = db.users.filter(user => user.id !== target.id);
  try {
    await saveDatabase();
    res.json({ ok: true, message: `La cuenta ${target.username} ha sido eliminada.` });
  } catch (error) {
    db.users = previousUsers;
    console.error("Error eliminando cuenta:", error);
    res.status(500).json({ error: "No se pudo guardar el cambio en GitHub. La cuenta no se ha eliminado permanentemente." });
  }
});

// Godot crea una solicitud de autorización administrativa.
app.post("/api/godot/request", async (req, res) => {
  try {
    cleanExpiredRequests();
    const id = crypto.randomBytes(24).toString("hex");
    const pollSecret = crypto.randomBytes(32).toString("hex");
    const now = Date.now();
    db.godotRequests.push({
      id, pollSecret, status: "pending", createdAt: now,
      expiresAt: now + REQUEST_LIFETIME_MS,
      approvedRole: null, approvedUsername: null
    });
    await saveDatabase();
    res.json({ ok: true, request_id: id, poll_secret: pollSecret, expires_in: 60 });
  } catch (error) {
    console.error("Error creando solicitud Godot:", error);
    res.status(500).json({ error: "No se pudo guardar la solicitud." });
  }
});

app.get("/api/godot/status", (req, res) => {
  const { id, secret } = req.query;
  if (typeof id !== "string" || typeof secret !== "string") {
    return res.status(400).json({ error: "Falta el identificador de solicitud." });
  }
  cleanExpiredRequests();
  const request = db.godotRequests.find(item => item.id === id);
  if (!request || request.pollSecret !== secret) return res.status(404).json({ status: "not_found", error: "Solicitud no encontrada." });
  if (request.expiresAt <= Date.now() && request.status === "pending") {
    request.status = "expired";
    saveDatabase().catch(error => console.error("Error guardando solicitud caducada:", error));
  }
  if (request.status === "approved") {
    return res.json({ status: "approved", role: request.approvedRole, username: request.approvedUsername });
  }
  return res.json({ status: request.status });
});

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

app.post("/api/admin/requests/:id/approve", requireLogin, async (req, res) => {
  cleanExpiredRequests();
  const request = db.godotRequests.find(item => item.id === req.params.id);
  if (!request) return res.status(404).json({ error: "La solicitud no existe o ha caducado." });
  if (request.expiresAt <= Date.now() || request.status !== "pending") return res.status(410).json({ error: "La solicitud ya no está disponible." });
  request.status = "approved";
  request.approvedRole = req.user.role;
  request.approvedUsername = req.user.username;
  request.approvedAt = Date.now();
  try {
    await saveDatabase();
    res.json({ ok: true, message: `Solicitud aprobada para ${req.user.username} (${req.user.role}).` });
  } catch (error) {
    console.error("Error respondiendo solicitud:", error);
    res.status(500).json({ error: "No se pudo guardar la respuesta." });
  }
});

app.post("/api/admin/requests/:id/reject", requireLogin, async (req, res) => {
  cleanExpiredRequests();
  const request = db.godotRequests.find(item => item.id === req.params.id);
  if (!request) return res.status(404).json({ error: "La solicitud no existe o ha caducado." });
  if (request.status !== "pending" || request.expiresAt <= Date.now()) return res.status(410).json({ error: "La solicitud ya no está disponible." });
  request.status = "rejected";
  try {
    await saveDatabase();
    res.json({ ok: true });
  } catch (error) {
    console.error("Error rechazando solicitud:", error);
    res.status(500).json({ error: "No se pudo guardar la respuesta." });
  }
});

// Godot enviará aquí el ID del juego cuando el usuario pulse "Borrar juego".
// Ejemplo de JSON: { "gameId": "12345", "gameName": "Mi juego" }
app.post("/api/games/delete-request", async (req, res) => {
  try {
    const ip = req.ip || "unknown";
    if (rateLimit(`game-delete:${ip}`, 20, 10 * 60 * 1000)) {
      return res.status(429).json({ error: "Demasiadas solicitudes. Espera un poco." });
    }
    const { gameId, gameName } = req.body || {};
    if ((typeof gameId !== "string" && typeof gameId !== "number") || String(gameId).trim().length < 1 || String(gameId).length > 100) {
      return res.status(400).json({ error: "Falta un ID de juego válido." });
    }
    const normalizedId = String(gameId).trim();
    const alreadyPending = db.gameDeletionRequests.some(item => item.gameId === normalizedId && item.status === "pending");
    if (alreadyPending) return res.status(409).json({ error: "Ya existe una solicitud pendiente para ese juego." });

    const request = {
      id: crypto.randomUUID(),
      gameId: normalizedId,
      gameName: typeof gameName === "string" ? gameName.trim().slice(0, 100) : "",
      status: "pending",
      createdAt: new Date().toISOString()
    };
    db.gameDeletionRequests.push(request);
    await saveDatabase();
    res.json({ ok: true, request_id: request.id, status: "pending", message: "Solicitud enviada a moderación." });
  } catch (error) {
    console.error("Error creando solicitud de borrado:", error);
    res.status(500).json({ error: "No se pudo guardar la solicitud de borrado." });
  }
});

app.get("/api/moderation/game-deletions", requireLogin, requireModerator, (req, res) => {
  const requests = db.gameDeletionRequests
    .filter(item => item.status === "pending")
    .map(item => ({
      id: item.id,
      gameId: item.gameId,
      gameName: item.gameName || "",
      createdAt: item.createdAt
    }));
  res.json({ requests });
});

async function deleteGameFromGithub(gameId) {
  if (!GITHUB_ENABLED) throw new Error("El almacenamiento de GitHub no está configurado.");
  const remote = await githubReadJson(GITHUB_GAMES_PATH);
  const original = remote.value;
  let updated = null;
  let removed = false;

  const matchesId = game => game && typeof game === "object" &&
    [game.id, game.gameId, game.ID, game.Id].some(value => value !== undefined && String(value) === String(gameId));

  if (Array.isArray(original)) {
    updated = original.filter(game => {
      if (matchesId(game)) { removed = true; return false; }
      return true;
    });
  } else if (original && typeof original === "object" && Array.isArray(original.games)) {
    updated = { ...original, games: original.games.filter(game => {
      if (matchesId(game)) { removed = true; return false; }
      return true;
    }) };
  } else if (original && typeof original === "object" && original.games && typeof original.games === "object") {
    updated = { ...original, games: { ...original.games } };
    for (const [key, game] of Object.entries(updated.games)) {
      if (String(key) === String(gameId) || matchesId(game)) {
        delete updated.games[key];
        removed = true;
      }
    }
  } else if (original && typeof original === "object") {
    updated = { ...original };
    for (const [key, game] of Object.entries(updated)) {
      if (String(key) === String(gameId) || matchesId(game)) {
        delete updated[key];
        removed = true;
      }
    }
  } else {
    throw new Error("Formato de games.json no reconocido. No se ha modificado el archivo.");
  }

  if (!removed) {
    const error = new Error(`No se encontró el juego con ID ${gameId} en games.json. No se ha borrado nada.`);
    error.status = 404;
    throw error;
  }

  const body = {
    message: `Eliminar juego ${gameId} desde Game Blocks Admin`,
    content: Buffer.from(JSON.stringify(updated, null, 2), "utf8").toString("base64"),
    sha: remote.sha,
    branch: GITHUB_BRANCH
  };
  const url = `https://api.github.com/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/contents/${GITHUB_GAMES_PATH.split("/").map(encodeURIComponent).join("/")}`;
  await githubRequest(url, { method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
}

app.post("/api/moderation/game-deletions/:id/approve", requireLogin, requireModerator, async (req, res) => {
  const request = db.gameDeletionRequests.find(item => item.id === req.params.id);
  if (!request || request.status !== "pending") return res.status(404).json({ error: "La solicitud ya no existe o ya fue respondida." });

  try {
    // Primero se elimina en GitHub. Solo después se marca como aprobada.
    await deleteGameFromGithub(request.gameId);
    request.status = "approved";
    request.answeredAt = new Date().toISOString();
    request.answeredBy = req.user.username;
    await saveDatabase();
    res.json({ ok: true, message: `El juego ${request.gameId} se ha eliminado de games.json.` });
  } catch (error) {
    console.error("Error aprobando borrado de juego:", error);
    const status = error.status === 404 ? 404 : 500;
    res.status(status).json({ error: error.message || "No se pudo borrar el juego de games.json." });
  }
});

app.post("/api/moderation/game-deletions/:id/reject", requireLogin, requireModerator, async (req, res) => {
  const request = db.gameDeletionRequests.find(item => item.id === req.params.id);
  if (!request || request.status !== "pending") return res.status(404).json({ error: "La solicitud ya no existe o ya fue respondida." });
  request.status = "rejected";
  request.answeredAt = new Date().toISOString();
  request.answeredBy = req.user.username;
  try {
    await saveDatabase();
    res.json({ ok: true, message: "Solicitud de borrado rechazada." });
  } catch (error) {
    console.error("Error rechazando borrado:", error);
    res.status(500).json({ error: "No se pudo guardar la respuesta." });
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "Error interno del servidor." });
});

async function start() {
  await loadDatabase();
  app.listen(PORT, () => {
    console.log(`Game Blocks Panel escuchando en el puerto ${PORT}`);
    console.log(`Almacenamiento: ${GITHUB_ENABLED ? "GitHub permanente" : `local (${DATA_FILE})`}`);
    if (GITHUB_ENABLED) console.log(`Repositorio: ${GITHUB_OWNER}/${GITHUB_REPO} · Rama: ${GITHUB_BRANCH}`);
  });
}
start().catch(error => {
  console.error("No se pudo iniciar el panel:", error);
  process.exit(1);
});
