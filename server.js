const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { Octokit } = require('@octokit/rest');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || "gameblocks_secret_key_change_in_production";

// Configuración de GitHub API para persistencia
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN || "NO_TOKEN" });
const REPO_OWNER = process.env.REPO_OWNER || "tu-usuario-github";
const REPO_NAME = process.env.REPO_NAME || "tu-repositorio";
const FILE_PATH = "database.json";
let fileSha = "";

app.use(cors());
app.use(express.json());

// Crear carpeta 'uploads' si no existe
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

app.use('/uploads', express.static(uploadDir));

// Configuración de Multer para archivos GLB locales
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '_'))
});
const upload = multer({ storage });

// BASE DE DATOS EN MEMORIA
let users = [];          // { id, username, password, avatar, bio, badges, coins, inventory, equippedAccessory, admin, owner }
let friendRequests = []; // { id, senderId, receiverId }
let friendships = [];    // { id, user1, user2 }
let gameCodes = {};      // { code: userId }
let accessories = [];    // { id, glbUrl, imageUrl, limited, maxPerUser, price }
let bannerText = "";

// Cargar base de datos desde repositorio Git al iniciar
async function loadDataFromGit() {
    if (!process.env.GITHUB_TOKEN) {
        console.log("⚠️ GITHUB_TOKEN no configurado. Operando con memoria local temporal.");
        return;
    }
    try {
        const res = await octokit.repos.getContent({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            path: FILE_PATH
        });
        fileSha = res.data.sha;
        const content = Buffer.from(res.data.content, 'base64').toString('utf-8');
        const parsed = JSON.parse(content);
        
        users = (parsed.users || []).map(u => ({
            ...u,
            inventory: u.inventory || [],
            badges: u.badges || [],
            coins: typeof u.coins === 'number' ? u.coins : 100,
            equippedAccessory: u.equippedAccessory || null
        }));
        friendships = parsed.friendships || [];
        accessories = parsed.accessories || [];
        bannerText = parsed.bannerText || "";
        console.log("✅ Datos persistidos cargados correctamente desde Git.");
    } catch (err) {
        console.log("⚠️ No se encontró la base de datos previa en Git o hubo un error. Se creará al guardar:", err.message);
    }
}

// Guardar base de datos actualizada en el repositorio Git
async function saveDataToGit() {
    if (!process.env.GITHUB_TOKEN) return;
    try {
        const dataToSave = JSON.stringify({ users, friendships, accessories, bannerText }, null, 2);
        const contentEncoded = Buffer.from(dataToSave).toString('base64');

        const params = {
            owner: REPO_OWNER,
            repo: REPO_NAME,
            path: FILE_PATH,
            message: "bot: actualización de datos (cuentas/compras/inventario)",
            content: contentEncoded
        };

        if (fileSha) params.sha = fileSha;

        const res = await octokit.repos.createOrUpdateFileContents(params);
        fileSha = res.data.content.sha;
    } catch (err) {
        console.error("❌ Error al persistir cambios en Git:", err.message);
    }
}

// MIDDLEWARE DE AUTENTICACIÓN JWT
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) return res.status(401).json({ error: "Acceso no autorizado. Inicia sesión." });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: "Sesión expirada o inválida." });
        
        const foundUser = users.find(u => u.id === user.id);
        if (!foundUser) return res.status(404).json({ error: "Usuario no encontrado." });
        
        if (!foundUser.inventory) foundUser.inventory = [];
        if (!foundUser.badges) foundUser.badges = [];

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

app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Completa todos los campos." });

    const existing = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (existing) return res.status(400).json({ error: "El nombre de usuario ya existe." });

    const isOwner = users.length === 0;

    const newUser = {
        id: Date.now().toString(),
        username,
        password,
        avatar: "https://via.placeholder.com/110",
        bio: "",
        badges: isOwner ? ["🛠️ Admin", "🎮 Owner"] : [],
        coins: 100,
        inventory: [],
        equippedAccessory: null,
        admin: isOwner,
        owner: isOwner
    };

    users.push(newUser);
    await saveDataToGit();

    const token = jwt.sign({ id: newUser.id, username: newUser.username }, JWT_SECRET);
    res.json({ success: true, token });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Introduce usuario y contraseña." });

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

app.post('/api/profile/avatar', authenticateToken, async (req, res) => {
    const { avatar } = req.body;
    if (!avatar) return res.status(400).json({ error: "URL de avatar requerida." });
    req.user.avatar = avatar;
    await saveDataToGit();
    res.json({ success: true, avatar });
});

app.post('/api/profile/bio', authenticateToken, async (req, res) => {
    req.user.bio = req.body.bio || "";
    await saveDataToGit();
    res.json({ success: true, bio: req.user.bio });
});

app.get('/api/badges/me', authenticateToken, (req, res) => {
    res.json({ badges: req.user.badges || [] });
});

app.get('/api/users/profile/:id', (req, res) => {
    const user = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });
    res.json({
        id: user.id,
        username: user.username,
        avatar: user.avatar,
        bio: user.bio,
        badges: user.badges || []
    });
});

app.get('/api/users/search', (req, res) => {
    const q = (req.query.q || "").toLowerCase();
    const matches = users
        .filter(u => u.username.toLowerCase().includes(q))
        .map(u => ({ id: u.id, username: u.username, avatar: u.avatar, bio: u.bio, badges: u.badges || [] }));
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

app.post('/api/friends/accept', authenticateToken, async (req, res) => {
    const { requestId } = req.body;
    const index = friendRequests.findIndex(r => r.id === requestId && r.receiverId === req.user.id);
    if (index === -1) return res.status(404).json({ error: "Solicitud no encontrada." });

    const reqData = friendRequests[index];
    friendships.push({ id: Date.now().toString(), user1: reqData.senderId, user2: req.user.id });
    friendRequests.splice(index, 1);
    await saveDataToGit();
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

app.post('/api/friends/remove', authenticateToken, async (req, res) => {
    const { userId } = req.body;
    friendships = friendships.filter(f => 
        !( (f.user1 === req.user.id && f.user2 === userId) || (f.user2 === req.user.id && f.user1 === userId) )
    );
    await saveDataToGit();
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
// TIENDA, COMPRA Y EQUIPAMIENTO DE ACCESORIOS
// -------------------------------------------------------------

app.get('/api/accessories', (req, res) => {
    res.json({ items: accessories });
});

app.post('/api/accessories/buy', authenticateToken, async (req, res) => {
    const { itemId } = req.body;
    const item = accessories.find(a => Number(a.id) === Number(itemId));

    if (!item) return res.status(404).json({ error: "Accesorio no encontrado." });

    if (!req.user.inventory) req.user.inventory = [];
    if (req.user.inventory.includes(item.id)) {
        return res.status(400).json({ error: "Ya posees este accesorio." });
    }

    if ((req.user.coins || 0) < item.price) {
        return res.status(400).json({ error: "Monedas insuficientes." });
    }

    req.user.coins -= item.price;
    req.user.inventory.push(item.id);

    await saveDataToGit();
    res.json({ success: true, newBalance: req.user.coins });
});

app.post('/api/accessories/equip', authenticateToken, async (req, res) => {
    const { itemId } = req.body;
    const targetId = Number(itemId);

    if (!req.user.inventory || !req.user.inventory.includes(targetId)) {
        return res.status(400).json({ error: "No posees este accesorio." });
    }

    req.user.equippedAccessory = targetId;
    await saveDataToGit();
    res.json({ success: true, equipped: targetId });
});

app.post('/api/accessories/unequip', authenticateToken, async (req, res) => {
    req.user.equippedAccessory = null;
    await saveDataToGit();
    res.json({ success: true });
});

app.post('/api/admin/accessories/upload', authenticateToken, requireAdmin, (req, res) => {
    upload.single('glb')(req, res, async (err) => {
        if (err) {
            return res.status(500).json({ error: "Error al guardar el archivo GLB: " + err.message });
        }

        if (!req.file) {
            return res.status(400).json({ error: "Debes adjuntar un archivo .GLB local." });
        }

        const { imageUrl, limited, maxPerUser, price } = req.body;
        if (!imageUrl || !price) {
            return res.status(400).json({ error: "Faltan datos obligatorios (URL de imagen o precio)." });
        }

        try {
            const newAccessory = {
                id: Date.now(),
                glbUrl: `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`,
                imageUrl: imageUrl.trim(),
                limited: limited === 'true' || limited === true,
                maxPerUser: parseInt(maxPerUser) || 1,
                price: parseInt(price) || 0
            };

            accessories.push(newAccessory);
            await saveDataToGit();
            res.json({ success: true, accessory: newAccessory });
        } catch (error) {
            res.status(500).json({ error: "Error al procesar los datos del accesorio." });
        }
    });
});

// -------------------------------------------------------------
// PANEL DE ADMINISTRACIÓN / OWNER
// -------------------------------------------------------------

app.post('/api/admin/coins/add', authenticateToken, requireAdmin, async (req, res) => {
    const { username, amount } = req.body;
    const target = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    target.coins = (target.coins || 0) + parseInt(amount || 0);
    await saveDataToGit();
    res.json({ success: true, newBalance: target.coins });
});

app.post('/api/admin/change-username', authenticateToken, requireAdmin, async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: "Escribe un nombre válido." });
    req.user.username = username;
    await saveDataToGit();
    res.json({ success: true });
});

app.get('/api/admin/users', authenticateToken, requireAdmin, (req, res) => {
    const q = (req.query.q || "").toLowerCase();
    const list = users
        .filter(u => u.username.toLowerCase().includes(q))
        .map(u => ({ id: u.id, username: u.username }));
    res.json({ users: list });
});

app.post('/api/admin/users/change-username', authenticateToken, requireAdmin, async (req, res) => {
    const { userId, username } = req.body;
    const target = users.find(u => u.id === userId);
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });
    target.username = username;
    await saveDataToGit();
    res.json({ success: true });
});

app.post('/api/admin/users/delete', authenticateToken, requireAdmin, async (req, res) => {
    const { userId } = req.body;
    users = users.filter(u => u.id !== userId);
    await saveDataToGit();
    res.json({ success: true });
});

app.post('/api/admin/badges/add', authenticateToken, requireAdmin, async (req, res) => {
    const { username, badge } = req.body;
    const target = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    if (!target.badges) target.badges = [];
    if (!target.badges.includes(badge)) target.badges.push(badge);
    await saveDataToGit();
    res.json({ success: true });
});

app.post('/api/admin/badges/remove', authenticateToken, requireAdmin, async (req, res) => {
    const { username, badge } = req.body;
    const target = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    if (!target.badges) target.badges = [];
    target.badges = target.badges.filter(b => b !== badge);
    await saveDataToGit();
    res.json({ success: true });
});

app.post('/api/admin/banner', authenticateToken, requireAdmin, async (req, res) => {
    bannerText = req.body.text || "";
    await saveDataToGit();
    res.json({ success: true, text: bannerText });
});

app.get('/api/banner', (req, res) => {
    res.json({ text: bannerText });
});

// -------------------------------------------------------------
// MANEJADORES GLOBALES DE ERROR
// -------------------------------------------------------------

app.use((req, res) => {
    res.status(404).json({ error: "La ruta solicitada no existe en el servidor." });
});

app.use((err, req, res, next) => {
    console.error("Error del Servidor:", err);
    res.status(500).json({ error: "Error interno del servidor." });
});

// INICIAR SERVIDOR Y CARGAR DATOS PERSISTIDOS
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    await loadDataFromGit();
    console.log(`🎮 Servidor Game Blocks corriendo en el puerto ${PORT}`);
});
// -------------------------------------------------------------
// TIENDA, COMPRA Y EQUIPAMIENTO DE ACCESORIOS (SISTEMA DE COMPRAS)
// -------------------------------------------------------------

// Obtenemos el catálogo de accesorios
app.get('/api/accessories', (req, res) => {
    res.json({ items: accessories });
});

// Alias por si el frontend busca '/api/shop' o '/api/store'
app.get('/api/shop', (req, res) => {
    res.json({ items: accessories });
});

// Ruta principal para comprar accesorios
app.post('/api/accessories/buy', authenticateToken, async (req, res) => {
    const { itemId } = req.body;
    
    if (itemId === undefined || itemId === null) {
        return res.status(400).json({ error: "Debes enviar el itemId del producto." });
    }

    // Buscamos el ítem convirtiendo ambos a número o string para evitar fallos de tipo
    const item = accessories.find(a => String(a.id) === String(itemId));

    if (!item) {
        return res.status(404).json({ error: "El accesorio especificado no existe en el catálogo." });
    }

    if (!req.user.inventory) req.user.inventory = [];

    // Verificamos si el usuario ya tiene el artículo
    const yaLoTiene = req.user.inventory.some(id => String(id) === String(item.id));
    if (yaLoTiene) {
        return res.status(400).json({ error: "Ya posees este accesorio en tu inventario." });
    }

    // Verificación del saldo de monedas
    const userCoins = Number(req.user.coins) || 0;
    const itemPrice = Number(item.price) || 0;

    if (userCoins < itemPrice) {
        return res.status(400).json({ error: "Monedas insuficientes para realizar la compra." });
    }

    // Procesar la transacción
    req.user.coins = userCoins - itemPrice;
    req.user.inventory.push(item.id);

    await saveDataToGit();

    return res.json({ 
        success: true, 
        message: "¡Compra realizada con éxito!",
        newBalance: req.user.coins,
        inventory: req.user.inventory
    });
});

// Rutas alternativas para evitar fallos por URL en el frontend
app.post('/api/shop/buy', authenticateToken, async (req, res) => {
    req.url = '/api/accessories/buy';
    return app._router.handle(req, res);
});

app.post('/api/buy', authenticateToken, async (req, res) => {
    req.url = '/api/accessories/buy';
    return app._router.handle(req, res);
});

// Equipar objeto del inventario
app.post('/api/accessories/equip', authenticateToken, async (req, res) => {
    const { itemId } = req.body;
    
    if (itemId === undefined || itemId === null) {
        return res.status(400).json({ error: "Debes enviar el itemId." });
    }

    const poseeObjeto = req.user.inventory && req.user.inventory.some(id => String(id) === String(itemId));

    if (!poseeObjeto) {
        return res.status(400).json({ error: "No tienes este objeto en tu inventario." });
    }

    req.user.equippedAccessory = itemId;
    await saveDataToGit();

    res.json({ success: true, equipped: itemId });
});

// Desequipar objeto
app.post('/api/accessories/unequip', authenticateToken, async (req, res) => {
    req.user.equippedAccessory = null;
    await saveDataToGit();
    res.json({ success: true });
});
