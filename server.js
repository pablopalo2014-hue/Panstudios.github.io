const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "db.json");

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "15mb" })); // Soporte para imágenes de perfil

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
    server_booster: { name: "Server Booster", icon: "⭐", description: "Ha mejorado el servidor de Discord." },
    admin: { name: "Admin", icon: "🛡️", description: "Forma parte del equipo de administración." },
    game_blocks: { name: "Game Blocks", icon: "🟥", description: "Cuenta oficial de Game Blocks." },
    creator_content: { name: "Creador de Contenido", icon: "▶️", description: "Creador de contenido de Game Blocks." }
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
        const database = JSON.parse(content);
        database.users = database.users || [];
        database.friendships = database.friendships || [];
        database.sessions = database.sessions || [];
        database.gameCodes = database.gameCodes || [];
        
        database.users.forEach(user => {
            user.badges = user.badges || [];
            user.bio = user.bio || "";
            user.avatar = user.avatar || "";
            if (isOwner(user) && !user.badges.includes("game_blocks")) {
                user.badges.push("game_blocks");
            }
        });
        return database;
    } catch (error) {
        console.error("Error leyendo db.json:", error);
        return createEmptyDatabase();
    }
}

function saveDatabase(database) {
    try {
        const temporaryFile = DB_FILE + ".tmp";
        fs.writeFileSync(temporaryFile, JSON.stringify(database, null, 2), "utf8");
        fs.renameSync(temporaryFile, DB_FILE);
        return true;
    } catch (error) {
        console.error("[DB] Error guardando:", error);
        return false;
    }
}

let database = loadDatabase();

setInterval(() => { saveDatabase(database); }, 60 * 1000);

function hashPassword(password) {
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(16).toString("hex");
        crypto.scrypt(password, salt, 64, (error, derivedKey) => {
            if (error) reject(error);
            else resolve(salt + ":" + derivedKey.toString("hex"));
        });
    });
}

function checkPassword(password, storedPassword) {
    return new Promise((resolve) => {
        const parts = storedPassword.split(":");
        if (parts.length !== 2) return resolve(false);
        crypto.scrypt(password, parts[0], 64, (error, derivedKey) => {
            if (error) return resolve(false);
            try {
                resolve(crypto.timingSafeEqual(Buffer.from(parts[1], "hex"), derivedKey));
            } catch {
                resolve(false);
            }
        });
    });
}

function createSession(userId) {
    const token = crypto.randomBytes(48).toString("hex");
    database.sessions.push({ token, userId, createdAt: Date.now() });
    saveDatabase(database);
    return token;
}

function getUserFromRequest(req) {
    const authorization = req.headers.authorization;
    if (!authorization || !authorization.startsWith("Bearer ")) return null;
    const token = authorization.substring(7);
    const session = database.sessions.find(s => s.token === token);
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
    if (!user || !isAdmin(user)) return res.status(403).json({ error: "No tienes permisos de administrador." });
    req.user = user;
    next();
}

function validUsername(username) {
    return /^[a-zA-Z0-9_]{3,40}$/.test(username);
}

// Rutas básicas
app.get("/", (req, res) => res.json({ status: "online", message: "Game Blocks API" }));
app.get("/api/test", (req, res) => res.json({ success: true }));

// Autenticación
app.post("/api/register", async (req, res) => {
    try {
        const username = String(req.body.username || "").trim();
        const password = String(req.body.password || "");

        if (!validUsername(username)) return res.status(400).json({ error: "Nombre de usuario inválido." });
        if (password.length < 6) return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres." });

        if (database.users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
            return res.status(409).json({ error: "El usuario ya existe." });
        }

        const passwordHash = await hashPassword(password);
        const badges = [];
        if (isOwner({ username })) badges.push("game_blocks", "admin");

        const user = {
            id: crypto.randomUUID(),
            username,
            passwordHash,
            badges,
            bio: "",
            avatar: "",
            admin: badges.includes("admin"),
            createdAt: Date.now()
        };

        database.users.push(user);
        saveDatabase(database);

        const token = createSession(user.id);
        res.status(201).json({ success: true, token, user: { id: user.id, username: user.username, badges: user.badges, admin: isAdmin(user), bio: user.bio, avatar: user.avatar } });
    } catch {
        res.status(500).json({ error: "Error interno del servidor." });
    }
});

app.post("/api/login", async (req, res) => {
    try {
        const username = String(req.body.username || "").trim();
        const password = String(req.body.password || "");

        const user = database.users.find(u => u.username.toLowerCase() === username.toLowerCase());
        if (!user || !(await checkPassword(password, user.passwordHash))) {
            return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
        }

        const token = createSession(user.id);
        res.json({ success: true, token, user: { id: user.id, username: user.username, badges: user.badges || [], admin: isAdmin(user), bio: user.bio || "", avatar: user.avatar || "" } });
    } catch {
        res.status(500).json({ error: "Error interno del servidor." });
    }
});

app.post("/api/logout", requireLogin, (req, res) => {
    const token = req.headers.authorization.substring(7);
    database.sessions = database.sessions.filter(s => s.token !== token);
    saveDatabase(database);
    res.json({ success: true });
});

app.get("/api/me", requireLogin, (req, res) => {
    res.json({ id: req.user.id, username: req.user.username, badges: req.user.badges || [], admin: isAdmin(req.user), bio: req.user.bio || "", avatar: req.user.avatar || "", createdAt: req.user.createdAt });
});

// Perfil
app.post("/api/profile/update", requireLogin, (req, res) => {
    const { bio, avatar } = req.body;
    if (typeof bio === "string") req.user.bio = bio;
    if (typeof avatar === "string") req.user.avatar = avatar;
    saveDatabase(database);
    res.json({ success: true, bio: req.user.bio, avatar: req.user.avatar });
});

// Búsqueda
app.get("/api/users/search", requireLogin, (req, res) => {
    const query = String(req.query.q || "").trim().toLowerCase();
    if (!query) return res.json({ users: [] });

    const users = database.users
        .filter(u => u.username.toLowerCase().includes(query))
        .slice(0, 20)
        .map(u => ({ id: u.id, username: u.username, badges: u.badges || [], avatar: u.avatar || "", bio: u.bio || "" }));

    res.json({ users });
});

// Amigos
app.post("/api/friends/request", requireLogin, (req, res) => {
    const targetId = String(req.body.userId || "");
    if (!targetId || targetId === req.user.id) return res.status(400).json({ error: "Petición inválida." });

    const existing = database.friendships.find(f => (f.from === req.user.id && f.to === targetId) || (f.from === targetId && f.to === req.user.id));
    if (existing) return res.status(400).json({ error: existing.status === "accepted" ? "Ya sois amigos." : "Solicitud pendiente." });

    database.friendships.push({ id: crypto.randomUUID(), from: req.user.id, to: targetId, status: "pending", createdAt: Date.now() });
    saveDatabase(database);
    res.json({ success: true });
});

app.get("/api/friends/requests", requireLogin, (req, res) => {
    const requests = database.friendships
        .filter(f => f.to === req.user.id && f.status === "pending")
        .map(f => {
            const u = database.users.find(user => user.id === f.from);
            return { id: f.id, userId: u?.id, username: u?.username, badges: u?.badges || [], avatar: u?.avatar || "" };
        });
    res.json({ requests });
});

app.post("/api/friends/accept", requireLogin, (req, res) => {
    const friendship = database.friendships.find(f => f.id === req.body.requestId && f.to === req.user.id && f.status === "pending");
    if (!friendship) return res.status(404).json({ error: "Solicitud no encontrada." });
    friendship.status = "accepted";
    saveDatabase(database);
    res.json({ success: true });
});

app.post("/api/friends/reject", requireLogin, (req, res) => {
    const index = database.friendships.findIndex(f => f.id === req.body.requestId && f.to === req.user.id && f.status === "pending");
    if (index === -1) return res.status(404).json({ error: "Solicitud no encontrada." });
    database.friendships.splice(index, 1);
    saveDatabase(database);
    res.json({ success: true });
});

app.get("/api/friends", requireLogin, (req, res) => {
    const friendships = database.friendships.filter(f => f.status === "accepted" && (f.from === req.user.id || f.to === req.user.id));
    const friends = friendships.map(f => {
        const friendId = f.from === req.user.id ? f.to : f.from;
        const u = database.users.find(user => user.id === friendId);
        return u ? { id: u.id, username: u.username, badges: u.badges || [], avatar: u.avatar || "", bio: u.bio || "" } : null;
    }).filter(Boolean);
    res.json({ friends });
});

app.post("/api/friends/remove", requireLogin, (req, res) => {
    const targetId = String(req.body.userId || "");
    const index = database.friendships.findIndex(f => f.status === "accepted" && ((f.from === req.user.id && f.to === targetId) || (f.from === targetId && f.to === req.user.id)));
    if (index === -1) return res.status(404).json({ error: "No sois amigos." });
    database.friendships.splice(index, 1);
    saveDatabase(database);
    res.json({ success: true });
});

// Insignias y Juego
app.get("/api/badges", (req, res) => res.json({ badges: BADGES }));

app.post("/api/game/create-code", requireLogin, (req, res) => {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    database.gameCodes.push({ code, userId: req.user.id, createdAt: Date.now() });
    saveDatabase(database);
    res.json({ success: true, code });
});

// Admin
app.get("/api/admin/users", requireAdmin, (req, res) => {
    const query = String(req.query.q || "").trim().toLowerCase();
    const users = database.users
        .filter(u => u.username.toLowerCase().includes(query))
        .map(u => ({ id: u.id, username: u.username, badges: u.badges || [], admin: isAdmin(u) }));
    res.json({ users });
});

app.post("/api/admin/badges/add", requireAdmin, (req, res) => {
    const { username, badge } = req.body;
    if (!BADGES[badge]) return res.status(400).json({ error: "Insignia no válida." });

    if (badge === "admin" && !isOwner(req.user)) {
        return res.status(403).json({ error: "Solo la cuenta Owner puede dar la insignia de Admin." });
    }
    if (badge === "game_blocks") {
        return res.status(403).json({ error: "Insignia reservada." });
    }

    const user = database.users.find(u => u.username.toLowerCase() === String(username).toLowerCase());
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
    const user = database.users.find(u => u.username.toLowerCase() === String(username).toLowerCase());
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    user.badges = user.badges.filter(b => b !== badge);
    if (badge === "admin") user.admin = false;
    saveDatabase(database);
    res.json({ success: true, badges: user.badges });
});

app.post("/api/admin/users/delete", requireAdmin, (req, res) => {
    const userId = String(req.body.userId || "");
    database.users = database.users.filter(u => u.id !== userId);
    database.sessions = database.sessions.filter(s => s.userId !== userId);
    database.friendships = database.friendships.filter(f => f.from !== userId && f.to !== userId);
    saveDatabase(database);
    res.json({ success: true });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Servidor de Game Blocks ejecutándose en el puerto ${PORT}`);
});
