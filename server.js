const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// =========================================================
// MIDDLEWARES FUNDAMENTALES (Evitan la respuesta inválida)
// =========================================================

// Habilitar CORS para que el frontend pueda realizar peticiones desde cualquier origen
app.use(cors());

// Procesar el cuerpo de las peticiones en formato JSON
app.use(express.json());

// Base de datos temporal en memoria (Sustituir por Base de Datos real si se requiere)
const users = [];
const tokens = {};
const gameCodes = {};
const friendRequests = [];
const friendships = [];

/* =========================================================
   MIDDLEWARE DE AUTENTICACIÓN
========================================================= */
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token || !tokens[token]) {
        return res.status(401).json({ error: 'Sesión no válida o expirada.' });
    }

    req.user = tokens[token];
    next();
}

/* =========================================================
   ENDPOINTS DE AUTENTICACIÓN Y CUENTA
========================================================= */

// Registrar usuario
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Completa todos los campos.' });
    }

    const existingUser = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (existingUser) {
        return res.status(400).json({ error: 'El nombre de usuario ya existe.' });
    }

    const newUser = {
        id: Date.now().toString(),
        username,
        password,
        admin: users.length === 0, // El primer usuario registrado será Administrador
        avatar: 'https://via.placeholder.com/110',
        bio: '',
        badges: ['game_blocks']
    };

    users.push(newUser);

    const token = 'token_' + Math.random().toString(36).substr(2);
    tokens[token] = newUser;

    res.json({ token, user: newUser });
});

// Iniciar sesión
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    const user = users.find(u => u.username.toLowerCase() === username?.toLowerCase() && u.password === password);
    if (!user) {
        return res.status(400).json({ error: 'Usuario o contraseña incorrectos.' });
    }

    const token = 'token_' + Math.random().toString(36).substr(2);
    tokens[token] = user;

    res.json({ token, user });
});

// Obtener datos del usuario actual
app.get('/api/me', authenticateToken, (req, res) => {
    res.json(req.user);
});

// Cerrar sesión
app.post('/api/logout', authenticateToken, (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    delete tokens[token];
    res.json({ success: true });
});

/* =========================================================
   ENDPOINTS DE PERFIL Y BIO
========================================================= */

// Cambiar foto de perfil
app.post('/api/profile/avatar', authenticateToken, (req, res) => {
    const { avatar } = req.body;
    if (!avatar) {
        return res.status(400).json({ error: 'Proporciona una URL válida.' });
    }

    req.user.avatar = avatar;
    res.json({ success: true, avatar: req.user.avatar });
});

// Cambiar biografía
app.post('/api/profile/bio', authenticateToken, (req, res) => {
    const { bio } = req.body;
    req.user.bio = bio || '';
    res.json({ success: true, bio: req.user.bio });
});

// Mis insignias
app.get('/api/badges/me', authenticateToken, (req, res) => {
    res.json({ badges: req.user.badges || [] });
});

/* =========================================================
   ENDPOINTS DE JUEGO (GODOT) Y BÚSQUEDA
========================================================= */

// Generar código de conexión
app.post('/api/game/create-code', authenticateToken, (req, res) => {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    gameCodes[code] = req.user.id;
    res.json({ code });
});

// Buscar usuarios
app.get('/api/users/search', authenticateToken, (req, res) => {
    const query = req.query.q || '';
    const results = users
        .filter(u => u.id !== req.user.id && u.username.toLowerCase().includes(query.toLowerCase()))
        .map(u => ({ id: u.id, username: u.username }));

    res.json({ users: results });
});

/* =========================================================
   ENDPOINTS DE AMIGOS Y SOLICITUDES
========================================================= */

app.post('/api/friends/request', authenticateToken, (req, res) => {
    const { userId } = req.body;
    if (!userId || userId === req.user.id) {
        return res.status(400).json({ error: 'ID de usuario inválido.' });
    }

    const requestExists = friendRequests.some(r => r.from === req.user.id && r.to === userId);
    if (requestExists) {
        return res.status(400).json({ error: 'La solicitud ya fue enviada.' });
    }

    friendRequests.push({ id: Date.now().toString(), from: req.user.id, to: userId });
    res.json({ success: true });
});

app.get('/api/friends/requests', authenticateToken, (req, res) => {
    const myRequests = friendRequests
        .filter(r => r.to === req.user.id)
        .map(r => {
            const sender = users.find(u => u.id === r.from);
            return { id: r.id, username: sender ? sender.username : 'Usuario desconocido' };
        });

    res.json({ requests: myRequests });
});

app.post('/api/friends/accept', authenticateToken, (req, res) => {
    const { requestId } = req.body;
    const index = friendRequests.findIndex(r => r.id === requestId && r.to === req.user.id);

    if (index === -1) {
        return res.status(400).json({ error: 'Solicitud no encontrada.' });
    }

    const reqData = friendRequests[index];
    friendships.push({ user1: reqData.from, user2: reqData.to });
    friendRequests.splice(index, 1);

    res.json({ success: true });
});

app.post('/api/friends/reject', authenticateToken, (req, res) => {
    const { requestId } = req.body;
    const index = friendRequests.findIndex(r => r.id === requestId && r.to === req.user.id);

    if (index !== -1) {
        friendRequests.splice(index, 1);
    }

    res.json({ success: true });
});

app.get('/api/friends', authenticateToken, (req, res) => {
    const myFriends = friendships
        .filter(f => f.user1 === req.user.id || f.user2 === req.user.id)
        .map(f => {
            const friendId = f.user1 === req.user.id ? f.user2 : f.user1;
            const friendUser = users.find(u => u.id === friendId);
            return { id: friendId, username: friendUser ? friendUser.username : 'Desconocido' };
        });

    res.json({ friends: myFriends });
});

app.post('/api/friends/remove', authenticateToken, (req, res) => {
    const { userId } = req.body;
    const index = friendships.findIndex(
        f => (f.user1 === req.user.id && f.user2 === userId) || (f.user1 === userId && f.user2 === req.user.id)
    );

    if (index !== -1) {
        friendships.splice(index, 1);
    }

    res.json({ success: true });
});

/* =========================================================
   ENDPOINTS DE ADMINISTRADOR
========================================================= */

app.post('/api/admin/change-username', authenticateToken, (req, res) => {
    if (!req.user.admin) return res.status(403).json({ error: 'Sin permisos de admin.' });
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Nombre no válido.' });

    req.user.username = username;
    res.json({ success: true });
});

app.get('/api/admin/users', authenticateToken, (req, res) => {
    if (!req.user.admin) return res.status(403).json({ error: 'Sin permisos de admin.' });
    const query = req.query.q || '';
    const filtered = users.filter(u => u.username.toLowerCase().includes(query.toLowerCase()));
    res.json({ users: filtered });
});

app.post('/api/admin/users/change-username', authenticateToken, (req, res) => {
    if (!req.user.admin) return res.status(403).json({ error: 'Sin permisos de admin.' });
    const { userId, username } = req.body;
    const targetUser = users.find(u => u.id === userId);

    if (!targetUser) return res.status(404).json({ error: 'Usuario no encontrado.' });
    targetUser.username = username;
    res.json({ success: true });
});

app.post('/api/admin/users/delete', authenticateToken, (req, res) => {
    if (!req.user.admin) return res.status(403).json({ error: 'Sin permisos de admin.' });
    const { userId } = req.body;
    const index = users.findIndex(u => u.id === userId);

    if (index !== -1) {
        users.splice(index, 1);
    }

    res.json({ success: true });
});

app.post('/api/admin/badges/add', authenticateToken, (req, res) => {
    if (!req.user.admin) return res.status(403).json({ error: 'Sin permisos de admin.' });
    const { username, badge } = req.body;
    const targetUser = users.find(u => u.username.toLowerCase() === username?.toLowerCase());

    if (!targetUser) return res.status(404).json({ error: 'Usuario no encontrado.' });
    if (!targetUser.badges.includes(badge)) {
        targetUser.badges.push(badge);
    }

    res.json({ success: true });
});

app.post('/api/admin/badges/remove', authenticateToken, (req, res) => {
    if (!req.user.admin) return res.status(403).json({ error: 'Sin permisos de admin.' });
    const { username, badge } = req.body;
    const targetUser = users.find(u => u.username.toLowerCase() === username?.toLowerCase());

    if (!targetUser) return res.status(404).json({ error: 'Usuario no encontrado.' });
    targetUser.badges = targetUser.badges.filter(b => b !== badge);

    res.json({ success: true });
});

/* =========================================================
   MANEJO GLOBAL DE ERRORES (Garantiza respuestas JSON)
========================================================= */

// Capturar rutas no encontradas (404)
app.use((req, res) => {
    res.status(404).json({ error: 'Ruta de API no encontrada.' });
});

// Capturar errores no controlados (500)
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Error interno del servidor.' });
});

/* =========================================================
   INICIO DEL SERVIDOR
========================================================= */
app.listen(PORT, () => {
    console.log(`Servidor de Game Blocks corriendo en el puerto ${PORT}`);
});
