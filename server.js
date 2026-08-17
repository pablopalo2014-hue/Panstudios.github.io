const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "secreto_game_blocks_123";

app.use(cors());
app.use(express.json());

// Base de datos en memoria (Reemplazar con MongoDB/PostgreSQL en producción)
const users = [];
const friendRequests = [];
const gameCodes = [];

// Middlewares
function authenticateToken(req, res, next) {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) return res.status(401).json({ error: "Token no proporcionado." });

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(403).json({ error: "Token inválido o expirado." });
        const user = users.find(u => u.id === decoded.id);
        if (!user) return res.status(404).json({ error: "Usuario no encontrado." });
        req.user = user;
        next();
    });
}

function requireAdmin(req, res, next) {
    if (!req.user.admin) {
        return res.status(403).json({ error: "Acceso denegado: Se requieren permisos de administrador." });
    }
    next();
}

// ---------------- AUTENTICACIÓN ----------------

app.post("/api/register", (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: "Faltan campos obligatorios." });
    }

    const existingUser = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (existingUser) {
        return res.status(400).json({ error: "El nombre de usuario ya está registrado." });
    }

    const newUser = {
        id: "usr_" + Date.now() + Math.random().toString(36).substr(2, 4),
        username,
        password, // En producción usa bcrypt para hashear
        avatar: "https://via.placeholder.com/110",
        bio: "",
        badges: [],
        friends: [],
        admin: users.length === 0 // El primer usuario registrado es Admin automáticamente
    };

    users.push(newUser);
    const token = jwt.sign({ id: newUser.id }, JWT_SECRET);
    res.json({ token, user: { id: newUser.id, username: newUser.username } });
});

app.post("/api/login", (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username.toLowerCase() === username?.toLowerCase() && u.password === password);

    if (!user) {
        return res.status(400).json({ error: "Credenciales incorrectas." });
    }

    const token = jwt.sign({ id: user.id }, JWT_SECRET);
    res.json({ token, user: { id: user.id, username: user.username } });
});

app.post("/api/logout", authenticateToken, (req, res) => {
    res.json({ message: "Sesión cerrada correctamente." });
});

app.get("/api/me", authenticateToken, (req, res) => {
    const { password, ...userData } = req.user;
    res.json(userData);
});

// ---------------- PERFIL Y BÚSQUEDA ----------------

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

app.get("/api/users/search", (req, res) => {
    const query = (req.query.q || "").toLowerCase();
    if (!query) return res.json({ users: [] });

    const results = users
        .filter(u => u.username.toLowerCase().includes(query))
        .map(u => ({
            id: u.id,
            username: u.username,
            avatar: u.avatar,
            bio: u.bio,
            badges: u.badges
        }));

    res.json({ users: results });
});

app.post("/api/profile/avatar", authenticateToken, (req, res) => {
    const { avatar } = req.body;
    if (!avatar) return res.status(400).json({ error: "URL de avatar requerida." });

    req.user.avatar = avatar;
    res.json({ message: "Avatar actualizado correctamente." });
});

app.post("/api/profile/bio", authenticateToken, (req, res) => {
    const { bio } = req.body;
    req.user.bio = bio || "";
    res.json({ message: "Biografía actualizada correctamente." });
});

// ---------------- INSIGNIAS ----------------

app.get("/api/badges/me", authenticateToken, (req, res) => {
    res.json({ badges: req.user.badges });
});

// ---------------- SISTEMA DE AMIGOS ----------------

app.get("/api/friends", authenticateToken, (req, res) => {
    const friendList = users
        .filter(u => req.user.friends.includes(u.id))
        .map(u => ({
            id: u.id,
            username: u.username,
            avatar: u.avatar
        }));

    res.json({ friends: friendList });
});

app.post("/api/friends/request", authenticateToken, (req, res) => {
    const { userId } = req.body;
    if (userId === req.user.id) {
        return res.status(400).json({ error: "No puedes enviarte una solicitud a ti mismo." });
    }

    const targetUser = users.find(u => u.id === userId);
    if (!targetUser) return res.status(404).json({ error: "Usuario no encontrado." });

    if (req.user.friends.includes(userId)) {
        return res.status(400).json({ error: "Ya es tu amigo." });
    }

    const existingReq = friendRequests.find(r => r.from === req.user.id && r.to === userId);
    if (existingReq) {
        return res.status(400).json({ error: "Ya existe una solicitud pendiente." });
    }

    const newRequest = {
        id: "req_" + Date.now(),
        from: req.user.id,
        to: userId
    };

    friendRequests.push(newRequest);
    res.json({ message: "Solicitud enviada." });
});

app.get("/api/friends/requests", authenticateToken, (req, res) => {
    const pending = friendRequests.filter(r => r.to === req.user.id);
    const result = pending.map(r => {
        const sender = users.find(u => u.id === r.from);
        return {
            id: r.id,
            username: sender ? sender.username : "Usuario desconocido"
        };
    });

    res.json({ requests: result });
});

app.post("/api/friends/accept", authenticateToken, (req, res) => {
    const { requestId } = req.body;
    const reqIndex = friendRequests.findIndex(r => r.id === requestId && r.to === req.user.id);

    if (reqIndex === -1) return res.status(404).json({ error: "Solicitud no encontrada." });

    const requestData = friendRequests[reqIndex];
    const sender = users.find(u => u.id === requestData.from);

    if (sender) {
        if (!req.user.friends.includes(sender.id)) req.user.friends.push(sender.id);
        if (!sender.friends.includes(req.user.id)) sender.friends.push(req.user.id);
    }

    friendRequests.splice(reqIndex, 1);
    res.json({ message: "Solicitud aceptada." });
});

app.post("/api/friends/reject", authenticateToken, (req, res) => {
    const { requestId } = req.body;
    const reqIndex = friendRequests.findIndex(r => r.id === requestId && r.to === req.user.id);

    if (reqIndex === -1) return res.status(404).json({ error: "Solicitud no encontrada." });

    friendRequests.splice(reqIndex, 1);
    res.json({ message: "Solicitud rechazada." });
});

app.post("/api/friends/remove", authenticateToken, (req, res) => {
    const { userId } = req.body;

    req.user.friends = req.user.friends.filter(id => id !== userId);
    const otherUser = users.find(u => u.id === userId);
    if (otherUser) {
        otherUser.friends = otherUser.friends.filter(id => id !== req.user.id);
    }

    res.json({ message: "Amigo eliminado." });
});

// ---------------- CONEXIÓN CON EL JUEGO ----------------

app.post("/api/game/create-code", authenticateToken, (req, res) => {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    gameCodes.push({ code, userId: req.user.id, createdAt: Date.now() });
    res.json({ code });
});

// ---------------- PANEL DE ADMINISTRACIÓN ----------------

app.post("/api/admin/change-username", authenticateToken, requireAdmin, (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: "Nombre no válido." });

    req.user.username = username;
    res.json({ message: "Nombre cambiado con éxito." });
});

app.get("/api/admin/users", authenticateToken, requireAdmin, (req, res) => {
    const query = (req.query.q || "").toLowerCase();
    const result = users.filter(u => u.username.toLowerCase().includes(query));
    res.json({ users: result });
});

app.post("/api/admin/users/change-username", authenticateToken, requireAdmin, (req, res) => {
    const { userId, username } = req.body;
    const targetUser = users.find(u => u.id === userId);
    if (!targetUser) return res.status(404).json({ error: "Usuario no encontrado." });

    targetUser.username = username;
    res.json({ message: "Nombre de usuario actualizado." });
});

app.post("/api/admin/users/delete", authenticateToken, requireAdmin, (req, res) => {
    const { userId } = req.body;
    const index = users.findIndex(u => u.id === userId);

    if (index === -1) return res.status(404).json({ error: "Usuario no encontrado." });

    users.splice(index, 1);
    res.json({ message: "Cuenta eliminada correctamente." });
});

app.post("/api/admin/badges/add", authenticateToken, requireAdmin, (req, res) => {
    const { username, badge } = req.body;
    const targetUser = users.find(u => u.username.toLowerCase() === username?.toLowerCase());

    if (!targetUser) return res.status(404).json({ error: "Usuario no encontrado." });

    if (!targetUser.badges.includes(badge)) {
        targetUser.badges.push(badge);
    }

    res.json({ message: "Insignia añadida correctamente." });
});

app.post("/api/admin/badges/remove", authenticateToken, requireAdmin, (req, res) => {
    const { username, badge } = req.body;
    const targetUser = users.find(u => u.username.toLowerCase() === username?.toLowerCase());

    if (!targetUser) return res.status(404).json({ error: "Usuario no encontrado." });

    targetUser.badges = targetUser.badges.filter(b => b !== badge);
    res.json({ message: "Insignia eliminada correctamente." });
});

// Arrancar Servidor
app.listen(PORT, () => {
    console.log(`Servidor de Game Blocks ejecutándose en el puerto ${PORT}`);
});
