const express = require("express");
const cors = require("cors");
const jwt = require("jwt-simple");
const bcrypt = require("bcryptjs");

const app = express();
app.use(express.json());
app.use(cors());

const SECRET_KEY = "gameblocks_secret_key_change_in_production";

// Base de datos en memoria (para persistencia real, usa MongoDB o PostgreSQL)
const users = [];
const gameCodes = {};

// Middleware de autenticación
function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Token no proporcionado." });

    const token = authHeader.split(" ")[1];
    try {
        const payload = jwt.decode(token, SECRET_KEY);
        const user = users.find(u => u.id === payload.id);
        if (!user) return res.status(401).json({ error: "Usuario no encontrado." });
        req.user = user;
        next();
    } catch {
        res.status(401).json({ error: "Token inválido o expirado." });
    }
}

// Middleware para verificar admin
function requireAdmin(req, res, next) {
    if (!req.user.admin) {
        return res.status(403).json({ error: "Acceso denegado. Requiere permisos de administrador." });
    }
    next();
}

// --- RUTAS DE AUTENTICACIÓN ---

app.post("/api/register", async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: "Nombre de usuario y contraseña obligatorios." });
    }

    const existingUser = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (existingUser) {
        return res.status(400).json({ error: "El nombre de usuario ya está registrado." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
        id: Date.now().toString(),
        username,
        password: hashedPassword,
        avatar: "",
        bio: "",
        badges: ["game_blocks"],
        friends: [],
        friendRequests: [],
        admin: users.length === 0 // El primer usuario es admin por defecto
    };

    users.push(newUser);

    const token = jwt.encode({ id: newUser.id }, SECRET_KEY);
    res.json({ token, message: "Usuario creado con éxito." });
});

app.post("/api/login", async (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());

    if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(400).json({ error: "Credenciales incorrectas." });
    }

    const token = jwt.encode({ id: user.id }, SECRET_KEY);
    res.json({ token });
});

app.get("/api/me", authenticate, (req, res) => {
    const { password, ...userData } = req.user;
    res.json(userData);
});

app.post("/api/logout", authenticate, (req, res) => {
    res.json({ message: "Sesión cerrada correctamente." });
});

// --- PERFIL Y FOTO ---

app.post("/api/profile/avatar", authenticate, (req, res) => {
    const { avatar } = req.body;
    if (!avatar) return res.status(400).json({ error: "URL de imagen requerida." });
    
    req.user.avatar = avatar;
    res.json({ message: "Foto de perfil actualizada.", avatar: req.user.avatar });
});

app.post("/api/profile/bio", authenticate, (req, res) => {
    const { bio } = req.body;
    req.user.bio = bio || "";
    res.json({ message: "Biografía actualizada." });
});

app.get("/api/users/profile/:id", (req, res) => {
    const user = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    res.json({
        id: user.id,
        username: user.username,
        avatar: user.avatar,
        bio: user.bio,
        badges: user.badges
    });
});

app.get("/api/badges/me", authenticate, (req, res) => {
    res.json({ badges: req.user.badges });
});

// --- BÚSQUEDA Y AMIGOS ---

app.get("/api/users/search", authenticate, (req, res) => {
    const query = (req.query.q || "").toLowerCase();
    const results = users
        .filter(u => u.id !== req.user.id && u.username.toLowerCase().includes(query))
        .map(u => ({
            id: u.id,
            username: u.username,
            avatar: u.avatar,
            bio: u.bio,
            badges: u.badges
        }));

    res.json({ users: results });
});

app.post("/api/friends/request", authenticate, (req, res) => {
    const { userId } = req.body;
    const targetUser = users.find(u => u.id === userId);

    if (!targetUser) return res.status(404).json({ error: "Usuario no encontrado." });
    if (targetUser.id === req.user.id) return res.status(400).json({ error: "No puedes agregarte a ti mismo." });
    if (req.user.friends.includes(targetUser.id)) return res.status(400).json({ error: "Ya sois amigos." });

    const alreadySent = targetUser.friendRequests.some(r => r.fromId === req.user.id);
    if (alreadySent) return res.status(400).json({ error: "Solicitud ya enviada previamente." });

    targetUser.friendRequests.push({
        id: Date.now().toString(),
        fromId: req.user.id,
        username: req.user.username
    });

    res.json({ message: "Solicitud enviada." });
});

app.get("/api/friends/requests", authenticate, (req, res) => {
    res.json({ requests: req.user.friendRequests });
});

app.post("/api/friends/accept", authenticate, (req, res) => {
    const { requestId } = req.body;
    const requestIndex = req.user.friendRequests.findIndex(r => r.id === requestId);

    if (requestIndex === -1) return res.status(404).json({ error: "Solicitud no encontrada." });

    const reqData = req.user.friendRequests[requestIndex];
    const friend = users.find(u => u.id === reqData.fromId);

    if (friend) {
        if (!req.user.friends.includes(friend.id)) req.user.friends.push(friend.id);
        if (!friend.friends.includes(req.user.id)) friend.friends.push(req.user.id);
    }

    req.user.friendRequests.splice(requestIndex, 1);
    res.json({ message: "Solicitud aceptada." });
});

app.post("/api/friends/reject", authenticate, (req, res) => {
    const { requestId } = req.body;
    req.user.friendRequests = req.user.friendRequests.filter(r => r.id !== requestId);
    res.json({ message: "Solicitud rechazada." });
});

app.get("/api/friends", authenticate, (req, res) => {
    const friendList = users
        .filter(u => req.user.friends.includes(u.id))
        .map(u => ({ id: u.id, username: u.username, avatar: u.avatar, bio: u.bio }));

    res.json({ friends: friendList });
});

app.post("/api/friends/remove", authenticate, (req, res) => {
    const { userId } = req.body;
    req.user.friends = req.user.friends.filter(id => id !== userId);
    
    const friend = users.find(u => u.id === userId);
    if (friend) {
        friend.friends = friend.friends.filter(id => id !== req.user.id);
    }

    res.json({ message: "Amigo eliminado." });
});

// --- CÓDIGO DE CONEXIÓN AL JUEGO ---

app.post("/api/game/create-code", authenticate, (req, res) => {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    gameCodes[code] = req.user.id;
    res.json({ code });
});

// --- ADMINISTRACIÓN ---

app.post("/api/admin/change-username", authenticate, requireAdmin, (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: "Nombre requerido." });

    req.user.username = username;
    res.json({ message: "Nombre actualizado." });
});

app.get("/api/admin/users", authenticate, requireAdmin, (req, res) => {
    const query = (req.query.q || "").toLowerCase();
    const list = users.filter(u => u.username.toLowerCase().includes(query));
    res.json({ users: list });
});

app.post("/api/admin/users/change-username", authenticate, requireAdmin, (req, res) => {
    const { userId, username } = req.body;
    const target = users.find(u => u.id === userId);
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    target.username = username;
    res.json({ message: "Nombre cambiado." });
});

app.post("/api/admin/users/delete", authenticate, requireAdmin, (req, res) => {
    const { userId } = req.body;
    const index = users.findIndex(u => u.id === userId);
    if (index === -1) return res.status(404).json({ error: "Usuario no encontrado." });

    users.splice(index, 1);
    res.json({ message: "Usuario borrado." });
});

app.post("/api/admin/badges/add", authenticate, requireAdmin, (req, res) => {
    const { username, badge } = req.body;
    const target = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    if (!target.badges.includes(badge)) {
        target.badges.push(badge);
    }
    res.json({ message: "Insignia asignada." });
});

app.post("/api/admin/badges/remove", authenticate, requireAdmin, (req, res) => {
    const { username, badge } = req.body;
    const target = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    target.badges = target.badges.filter(b => b !== badge);
    res.json({ message: "Insignia retirada." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor activo en puerto ${PORT}`);
});
