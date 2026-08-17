const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "db.json");

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "10mb" })); // Límite aumentado para fotos de perfil en Base64

const OWNER_NAMES = ["game_blocks_oficial", "game blocks oficial"];

function normalizeUsername(username) {
    return String(username || "").toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

function isOwner(user) {
    if (!user) return false;
    return OWNER_NAMES.some(name => normalizeUsername(name) === normalizeUsername(user.username));
}

function isAdmin(user) {
    if (!user) return false;
    return isOwner(user) || user.admin === true || (Array.isArray(user.badges) && user.badges.includes("admin"));
}

const BADGES = {
    server_booster: { name: "Server Booster", icon: "⭐" },
    admin: { name: "Admin", icon: "🛡️" },
    game_blocks: { name: "Game Blocks", icon: "🟥" },
    creator_content: { name: "Creador de Contenido", icon: "▶️" }
};

function createEmptyDatabase() {
    return { users: [], friendships: [], sessions: [], gameCodes: [] };
}

function loadDatabase() {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify(createEmptyDatabase(), null, 2), "utf8");
    }
    try {
        const content = fs.readFileSync(DB_FILE, "utf8");
        const db = JSON.parse(content);
        db.users = db.users || [];
        db.friendships = db.friendships || [];
        db.sessions = db.sessions || [];
        db.gameCodes = db.gameCodes || [];
        db.users.forEach(u => {
            u.badges = u.badges || [];
            u.bio = u.bio || "";
            u.avatar = u.avatar || "";
            if (isOwner(u) && !u.badges.includes("game_blocks")) {
                u.badges.push("game_blocks");
            }
        });
        return db;
    } catch {
        return createEmptyDatabase();
    }
}

function saveDatabase(database) {
    try {
        const tempFile = DB_FILE + ".tmp";
        fs.writeFileSync(tempFile, JSON.stringify(database, null, 2), "utf8");
        fs.renameSync(tempFile, DB_FILE);
        return true;
    } catch (e) {
        console.error("Error guardando DB:", e);
        return false;
    }
}

let database = loadDatabase();

function getUserFromRequest(req) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) return null;
    const session = database.sessions.find(s => s.token === auth.substring(7));
    if (!session) return null;
    return database.users.find(u => u.id === session.userId) || null;
}

function requireLogin(req, res, next) {
    const user = getUserFromRequest(req);
    if (!user) return res.status(401).json({ error: "No has iniciado sesión." });
    req.user = user;
    next();
}

function requireAdmin(req, res, next) {
    const user = getUserFromRequest(req);
    if (!user || !isAdmin(user)) return res.status(403).json({ error: "Sin permisos de administrador." });
    req.user = user;
    next();
}

function hashPassword(password) {
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(16).toString("hex");
        crypto.scrypt(password, salt, 64, (err, derivedKey) => {
            if (err) reject(err);
            else resolve(salt + ":" + derivedKey.toString("hex"));
        });
    });
}

function checkPassword(password, stored) {
    return new Promise(resolve => {
        const parts = stored.split(":");
        if (parts.length !== 2) return resolve(false);
        crypto.scrypt(password, parts[0], 64, (err, derivedKey) => {
            if (err) return resolve(false);
            resolve(crypto.timingSafeEqual(Buffer.from(parts[1], "hex"), derivedKey));
        });
    });
}

// Autenticación
app.post("/api/register", async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Datos incompletos." });
    if (database.users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
        return res.status(409).json({ error: "El usuario ya existe." });
    }
    const hash = await hashPassword(password);
    const badges = [];
    if (OWNER_NAMES.some(n => normalizeUsername(n) === normalizeUsername(username))) {
        badges.push("game_blocks", "admin");
    }
    const newUser = {
        id: crypto.randomUUID(),
        username,
        passwordHash: hash,
        badges,
        bio: "",
        avatar: "",
        admin: badges.includes("admin")
    };
    database.users.push(newUser);
    saveDatabase(database);
    const token = crypto.randomBytes(48).toString("hex");
    database.sessions.push({ token, userId: newUser.id, createdAt: Date.now() });
    saveDatabase(database);
    res.json({ success: true, token, user: newUser });
});

app.post("/api/login", async (req, res) => {
    const { username, password } = req.body;
    const user = database.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user || !(await checkPassword(password, user.passwordHash))) {
        return res.status(401).json({ error: "Credenciales incorrectas." });
    }
    const token = crypto.randomBytes(48).toString("hex");
    database.sessions.push({ token, userId: user.id, createdAt: Date.now() });
    saveDatabase(database);
    res.json({ success: true, token, user });
});

app.get("/api/me", requireLogin, (req, res) => {
    res.json(req.user);
});

// Actualizar perfil (Bio y Foto)
app.post("/api/profile/update", requireLogin, (req, res) => {
    const { bio, avatar } = req.body;
    if (typeof bio === "string") req.user.bio = bio;
    if (typeof avatar === "string") req.user.avatar = avatar;
    saveDatabase(database);
    res.json({ success: true, user: req.user });
});

// Búsqueda global de usuarios
app.get("/api/users/search", requireLogin, (req, res) => {
    const q = String(req.query.q || "").toLowerCase();
    const results = database.users
        .filter(u => u.username.toLowerCase().includes(q))
        .map(u => ({ id: u.id, username: u.username, badges: u.badges, avatar: u.avatar, bio: u.bio }));
    res.json({ users: results });
});

// Gestión de insignias
app.post("/api/admin/badges/add", requireAdmin, (req, res) => {
    const { username, badge } = req.body;
    if (!BADGES[badge]) return res.status(400).json({ error: "Insignia inválida." });
    if (badge === "admin" && !isOwner(req.user)) {
        return res.status(403).json({ error: "Solo el Owner puede otorgar la insignia Admin." });
    }
    if (badge === "game_blocks") {
        return res.status(403).json({ error: "La insignia Game Blocks es exclusiva." });
    }
    const user = database.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });
    if (!user.badges.includes(badge)) {
        user.badges.push(badge);
        if (badge === "admin") user.admin = true;
        saveDatabase(database);
    }
    res.json({ success: true, badges: user.badges });
});

app.post("/api/admin/badges/remove", requireAdmin, (req, res) => {
    const { username, badge } = req.body;
    const user = database.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });
    user.badges = user.badges.filter(b => b !== badge);
    if (badge === "admin") user.admin = false;
    saveDatabase(database);
    res.json({ success: true, badges: user.badges });
});

// Amigos
app.get("/api/friends", requireLogin, (req, res) => {
    const friendIds = database.friendships
        .filter(f => f.status === "accepted" && (f.from === req.user.id || f.to === req.user.id))
        .map(f => (f.from === req.user.id ? f.to : f.from));
    const friends = database.users.filter(u => friendIds.includes(u.id));
    res.json({ friends });
});

app.listen(PORT, () => console.log(`Servidor iniciado en puerto ${PORT}`));
