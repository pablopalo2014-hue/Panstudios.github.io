const express = require('express');
const cors = require('cors');
const jwt = require('jwt-simple');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.JWT_SECRET || "secreto_game_blocks_super_seguro";

app.use(cors());
app.use(express.json());

// Base de datos simulada en memoria
const users = [];
const friendRequests = [];
const gameCodes = {};

// Middleware de autenticación
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: "No token proporcionado." });

    try {
        const decoded = jwt.decode(token, SECRET_KEY);
        const user = users.find(u => u.id === decoded.id);
        if (!user) return res.status(404).json({ error: "Usuario no encontrado." });
        req.user = user;
        next();
    } catch (err) {
        return res.status(403).json({ error: "Token inválido o expirado." });
    }
}

// Middleware de administrador
function requireAdmin(req, res, next) {
    if (!req.user || !req.user.admin) {
        return res.status(403).json({ error: "Acceso denegado. Requiere privilegios de administrador." });
    }
    next();
}

function formatPublicUser(user) {
    return {
        id: user.id,
        username: user.username,
        avatar: user.avatar || "https://via.placeholder.com/110",
        bio: user.bio || "",
        badges: user.badges || []
    };
}

// Rutas de Sesión
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Usuario y contraseña requeridos." });

    const existingUser = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (existingUser) return res.status(400).json({ error: "El usuario ya existe." });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
        id: Date.now().toString(),
        username,
        password: hashedPassword,
        avatar: "https://via.placeholder.com/110",
        bio: "",
        badges: ["🧱 Blocker"],
        friends: [],
        admin: users.length === 0
    };

    users.push(newUser);
    const token = jwt.encode({ id: newUser.id }, SECRET_KEY);
    res.json({ message: "Cuenta creada.", token });
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());

    if (!user) return res.status(400).json({ error: "Credenciales incorrectas." });

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(400).json({ error: "Credenciales incorrectas." });

    const token = jwt.encode({ id: user.id }, SECRET_KEY);
    res.json({ message: "Inicio de sesión exitoso.", token });
});

app.post('/api/logout', authenticateToken, (req, res) => {
    res.json({ message: "Sesión cerrada." });
});

app.get('/api/me', authenticateToken, (req, res) => {
    res.json({
        id: req.user.id,
        username: req.user.username,
        avatar: req.user.avatar,
        bio: req.user.bio,
        badges: req.user.badges,
        admin: req.user.admin
    });
});

// Rutas Perfil y Búsqueda
app.post('/api/profile/avatar', authenticateToken, (req, res) => {
    const { avatar } = req.body;
    if (!avatar) return res.status(400).json({ error: "URL inválida." });
    req.user.avatar = avatar;
    res.json({ message: "Avatar actualizado." });
});

app.post('/api/profile/bio', authenticateToken, (req, res) => {
    const { bio } = req.body;
    req.user.bio = bio || "";
    res.json({ message: "Biografía actualizada." });
});

app.get('/api/badges/me', authenticateToken, (req, res) => {
    res.json({ badges: req.user.badges || [] });
});

app.get('/api/users/profile/:id', (req, res) => {
    const user = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });
    res.json(formatPublicUser(user));
});

app.get('/api/users/search', (req, res) => {
    const query = (req.query.q || "").toLowerCase();
    if (!query) return res.json({ users: [] });

    const results = users
        .filter(u => u.username.toLowerCase().includes(query))
        .map(formatPublicUser);

    res.json({ users: results });
});

// Rutas Amigos
app.get('/api/friends', authenticateToken, (req, res) => {
    const friendList = users
        .filter(u => req.user.friends.includes(u.id))
        .map(formatPublicUser);
    res.json({ friends: friendList });
});

app.get('/api/friends/requests', authenticateToken, (req, res) => {
    const requests = friendRequests
        .filter(r => r.toUserId === req.user.id && r.status === 'pending')
        .map(r => {
            const sender = users.find(u => u.id === r.fromUserId);
            return {
                id: r.id,
                username: sender ? sender.username : "Desconocido"
            };
        });
    res.json({ requests });
});

app.post('/api/friends/request', authenticateToken, (req, res) => {
    const { userId } = req.body;
    if (userId === req.user.id) return res.status(400).json({ error: "Operación inválida." });

    const targetUser = users.find(u => u.id === userId);
    if (!targetUser) return res.status(404).json({ error: "Usuario no encontrado." });

    if (req.user.friends.includes(userId)) return res.status(400).json({ error: "Ya son amigos." });

    friendRequests.push({
        id: Date.now().toString(),
        fromUserId: req.user.id,
        toUserId: userId,
        status: 'pending'
    });

    res.json({ message: "Solicitud enviada." });
});

app.post('/api/friends/accept', authenticateToken, (req, res) => {
    const { requestId } = req.body;
    const reqIndex = friendRequests.findIndex(r => r.id === requestId && r.toUserId === req.user.id);

    if (reqIndex === -1) return res.status(404).json({ error: "Solicitud no encontrada." });

    const requestData = friendRequests[reqIndex];
    const sender = users.find(u => u.id === requestData.fromUserId);

    if (sender) {
        if (!req.user.friends.includes(sender.id)) req.user.friends.push(sender.id);
        if (!sender.friends.includes(req.user.id)) sender.friends.push(req.user.id);
    }

    friendRequests.splice(reqIndex, 1);
    res.json({ message: "Solicitud aceptada." });
});

app.post('/api/friends/reject', authenticateToken, (req, res) => {
    const { requestId } = req.body;
    const reqIndex = friendRequests.findIndex(r => r.id === requestId && r.toUserId === req.user.id);

    if (reqIndex === -1) return res.status(404).json({ error: "Solicitud no encontrada." });

    friendRequests.splice(reqIndex, 1);
    res.json({ message: "Solicitud rechazada." });
});

app.post('/api/friends/remove', authenticateToken, (req, res) => {
    const { userId } = req.body;
    req.user.friends = req.user.friends.filter(id => id !== userId);

    const targetUser = users.find(u => u.id === userId);
    if (targetUser) {
        targetUser.friends = targetUser.friends.filter(id => id !== req.user.id);
    }

    res.json({ message: "Amigo eliminado." });
});

// Código del Juego
app.post('/api/game/create-code', authenticateToken, (req, res) => {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    gameCodes[code] = { userId: req.user.id, createdAt: Date.now() };
    res.json({ code });
});

// Rutas Admin
app.post('/api/admin/change-username', authenticateToken, requireAdmin, (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: "Nombre inválido." });

    req.user.username = username;
    res.json({ message: "Nombre de usuario actualizado." });
});

app.get('/api/admin/users', authenticateToken, requireAdmin, (req, res) => {
    const query = (req.query.q || "").toLowerCase();
    const result = users
        .filter(u => u.username.toLowerCase().includes(query))
        .map(u => ({ id: u.id, username: u.username }));
    res.json({ users: result });
});

app.post('/api/admin/users/change-username', authenticateToken, requireAdmin, (req, res) => {
    const { userId, username } = req.body;
    const user = users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    user.username = username;
    res.json({ message: "Nombre de usuario actualizado." });
});

app.post('/api/admin/users/delete', authenticateToken, requireAdmin, (req, res) => {
    const { userId } = req.body;
    const index = users.findIndex(u => u.id === userId);
    if (index === -1) return res.status(404).json({ error: "Usuario no encontrado." });

    users.splice(index, 1);
    res.json({ message: "Usuario eliminado." });
});

app.post('/api/admin/badges/add', authenticateToken, requireAdmin, (req, res) => {
    const { username, badge } = req.body;
    const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    if (!user.badges.includes(badge)) user.badges.push(badge);
    res.json({ message: "Insignia añadida." });
});

app.post('/api/admin/badges/remove', authenticateToken, requireAdmin, (req, res) => {
    const { username, badge } = req.body;
    const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    user.badges = user.badges.filter(b => b !== badge);
    res.json({ message: "Insignia eliminada." });
});

app.listen(PORT, () => {
    console.log(`Servidor activo en el puerto ${PORT}`);
});
