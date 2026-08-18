const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const jwt = require('jsonwebtoken');

const app = express();
const JWT_SECRET = "gameblocks_secret_key_change_in_production";

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Configuración de Multer para archivos GLB locales
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// BASE DE DATOS EN MEMORIA
let users = [];          // { id, username, password, avatar, bio, badges, coins, admin, owner }
let friendRequests = []; // { id, senderId, receiverId }
let friendships = [];    // { id, user1, user2 }
let gameCodes = {};      // { code: userId }
let accessories = [];    // { id, glbUrl, imageUrl, limited, maxPerUser, price }
let bannerText = "";

// MIDDLEWARE DE AUTENTICACIÓN JWT
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) return res.status(401).json({ error: "Acceso no autorizado. Inicia sesión." });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: "Sesión expirada o inválida." });
        
        const foundUser = users.find(u => u.id === user.id);
        if (!foundUser) return res.status(404).json({ error: "Usuario no encontrado." });
        
        req.user = foundUser;
        next();
    });
}

// MIDDLEWARE SOLO OWNER / ADMIN
function requireAdmin(req, res, next) {
    if (!req.user || (!req.user.admin && !req.user.owner)) {
        return res.status(403).json({ error: "Requiere permisos de administrador u Owner." });
    }
    next();
}

// -------------------------------------------------------------
// RUTAS DE AUTENTICACIÓN Y PERFIL
// -------------------------------------------------------------

app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Completa todos los campos." });

    const existing = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (existing) return res.status(400).json({ error: "El nombre de usuario ya existe." });

    // El primer usuario creado se registra como Owner/Admin
    const isOwner = users.length === 0;

    const newUser = {
        id: Date.now().toString(),
        username,
        password, // Nota: Se recomienda hashear contraseñas en producción
        avatar: "https://via.placeholder.com/110",
        bio: "",
        badges: isOwner ? ["🛠️ Admin", "🎮 Owner"] : [],
        coins: 100,
        admin: isOwner,
        owner: isOwner
    };

    users.push(newUser);

    const token = jwt.sign({ id: newUser.id, username: newUser.username }, JWT_SECRET);
    res.json({ success: true, token });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username.toLowerCase() === username.toLowerCase() && u.password === password);
    
    if (!user) return res.status(400).json({ error: "Usuario o contraseña incorrectos." });

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
    res.json({ success: true, token });
});

app.get('/api/me', authenticateToken, (req, res) => {
    res.json(req.user);
});

app.post('/api/logout', (req, res) => {
    res.json({ success: true });
});

app.post('/api/profile/avatar', authenticateToken, (req, res) => {
    const { avatar } = req.body;
    if (!avatar) return res.status(400).json({ error: "URL de avatar requerida." });
    req.user.avatar = avatar;
    res.json({ success: true, avatar });
});

app.post('/api/profile/bio', authenticateToken, (req, res) => {
    req.user.bio = req.body.bio || "";
    res.json({ success: true, bio: req.user.bio });
});

app.get('/api/badges/me', authenticateToken, (req, res) => {
    res.json({ badges: req.user.badges });
});

app.get('/api/users/profile/:id', (req, res) => {
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

app.get('/api/users/search', (req, res) => {
    const q = (req.query.q || "").toLowerCase();
    const matches = users
        .filter(u => u.username.toLowerCase().includes(q))
        .map(u => ({ id: u.id, username: u.username, avatar: u.avatar, bio: u.bio, badges: u.badges }));
    res.json({ users: matches });
});

// -------------------------------------------------------------
// SISTEMA DE AMIGOS
// -------------------------------------------------------------

app.post('/api/friends/request', authenticateToken, (req, res) => {
    const { userId } = req.body;
    if (userId === req.user.id) return res.status(400).json({ error: "No puedes agregarte a ti mismo." });

    const existingReq = friendRequests.find(r => r.senderId === req.user.id && r.receiverId === userId);
    if (existingReq) return res.status(400).json({ error: "Ya enviaste una solicitud a este usuario." });

    friendRequests.push({ id: Date.now().toString(), senderId: req.user.id, receiverId: userId });
    res.json({ success: true });
});

app.get('/api/friends/requests', authenticateToken, (req, res) => {
    const reqs = friendRequests
        .filter(r => r.receiverId === req.user.id)
        .map(r => {
            const sender = users.find(u => u.id === r.senderId);
            return { id: r.id, username: sender ? sender.username : "Desconocido" };
        });
    res.json({ requests: reqs });
});

app.post('/api/friends/accept', authenticateToken, (req, res) => {
    const { requestId } = req.body;
    const index = friendRequests.findIndex(r => r.id === requestId && r.receiverId === req.user.id);
    if (index === -1) return res.status(404).json({ error: "Solicitud no encontrada." });

    const reqData = friendRequests[index];
    friendships.push({ id: Date.now().toString(), user1: reqData.senderId, user2: req.user.id });
    friendRequests.splice(index, 1);
    res.json({ success: true });
});

app.post('/api/friends/reject', authenticateToken, (req, res) => {
    const { requestId } = req.body;
    friendRequests = friendRequests.filter(r => !(r.id === requestId && r.receiverId === req.user.id));
    res.json({ success: true });
});

app.get('/api/friends', authenticateToken, (req, res) => {
    const myFriends = friendships
        .filter(f => f.user1 === req.user.id || f.user2 === req.user.id)
        .map(f => {
            const friendId = f.user1 === req.user.id ? f.user2 : f.user1;
            const friendUser = users.find(u => u.id === friendId);
            return friendUser ? { id: friendUser.id, username: friendUser.username, avatar: friendUser.avatar } : null;
        })
        .filter(Boolean);
    res.json({ friends: myFriends });
});

app.post('/api/friends/remove', authenticateToken, (req, res) => {
    const { userId } = req.body;
    friendships = friendships.filter(f => 
        !( (f.user1 === req.user.id && f.user2 === userId) || (f.user2 === req.user.id && f.user1 === userId) )
    );
    res.json({ success: true });
});

// -------------------------------------------------------------
// CONEXIÓN CON EL JUEGO Y CÓDIGOS
// -------------------------------------------------------------

app.post('/api/game/create-code', authenticateToken, (req, res) => {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    gameCodes[code] = req.user.id;
    res.json({ success: true, code });
});

// -------------------------------------------------------------
// TIENDA Y ACCESORIOS AVATAR (NUEVO)
// -------------------------------------------------------------

app.get('/api/accessories', (req, res) => {
    res.json({ items: accessories });
});

app.post('/api/admin/accessories/upload', authenticateToken, requireAdmin, upload.single('glb'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Debes adjuntar un archivo .GLB local." });

    const newAccessory = {
        id: Date.now(),
        glbUrl: `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`,
        imageUrl: req.body.imageUrl,
        limited: req.body.limited === 'true',
        maxPerUser: parseInt(req.body.maxPerUser) || 1,
        price: parseInt(req.body.price) || 0
    };

    accessories.push(newAccessory);
    res.json({ success: true, accessory: newAccessory });
});

// -------------------------------------------------------------
// PANEL DE ADMINISTRACIÓN / OWNER
// -------------------------------------------------------------

app.post('/api/admin/coins/add', authenticateToken, requireAdmin, (req, res) => {
    const { username, amount } = req.body;
    const target = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    target.coins = (target.coins || 0) + parseInt(amount);
    res.json({ success: true, newBalance: target.coins });
});

app.post('/api/admin/change-username', authenticateToken, requireAdmin, (req, res) => {
    const { username } = req.body;
    req.user.username = username;
    res.json({ success: true });
});

app.get('/api/admin/users', authenticateToken, requireAdmin, (req, res) => {
    const q = (req.query.q || "").toLowerCase();
    const list = users
        .filter(u => u.username.toLowerCase().includes(q))
        .map(u => ({ id: u.id, username: u.username }));
    res.json({ users: list });
});

app.post('/api/admin/users/change-username', authenticateToken, requireAdmin, (req, res) => {
    const { userId, username } = req.body;
    const target = users.find(u => u.id === userId);
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });
    target.username = username;
    res.json({ success: true });
});

app.post('/api/admin/users/delete', authenticateToken, requireAdmin, (req, res) => {
    const { userId } = req.body;
    users = users.filter(u => u.id !== userId);
    res.json({ success: true });
});

app.post('/api/admin/badges/add', authenticateToken, requireAdmin, (req, res) => {
    const { username, badge } = req.body;
    const target = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    if (!target.badges.includes(badge)) target.badges.push(badge);
    res.json({ success: true });
});

app.post('/api/admin/badges/remove', authenticateToken, requireAdmin, (req, res) => {
    const { username, badge } = req.body;
    const target = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    target.badges = target.badges.filter(b => b !== badge);
    res.json({ success: true });
});

app.post('/api/admin/banner', authenticateToken, requireAdmin, (req, res) => {
    bannerText = req.body.text || "";
    res.json({ success: true, text: bannerText });
});

app.get('/api/banner', (req, res) => {
    res.json({ text: bannerText });
});

// -------------------------------------------------------------
// MANEJADORES GLOBALES DE ERROR (PREVIENE RESPUESTAS HTML 404)
// -------------------------------------------------------------

app.use((req, res) => {
    res.status(404).json({ error: "La ruta solicitada no existe en el servidor." });
});

app.use((err, req, res, next) => {
    console.error("Error del Servidor:", err);
    res.status(500).json({ error: "Error interno del servidor." });
});

// INICIAR SERVIDOR
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🎮 Servidor Game Blocks corriendo en el puerto ${PORT}`);
});
