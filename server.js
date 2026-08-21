const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken'); 
const bcrypt = require('bcryptjs');
const { Octokit } = require('@octokit/rest');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || "gameblocks_secret_key_change_in_production";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const GIST_ID = process.env.GIST_ID; 

app.use(cors());
app.use(express.json());

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

app.use('/uploads', express.static(uploadDir));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '_'))
});
const upload = multer({ storage });

let users = [];          
let friendRequests = []; 
let friendships = [];    
let gameCodes = {};      
let accessories = [];    
let tradeOffers = [];    
let resaleListings = []; 
let bannerText = "";     

function sanitizeText(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/[&<>"']/g, (m) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    })[m]);
}

// Persistencia mediante GitHub Gist Privado (database.json)
async function loadDataFromGit() {
    if (!process.env.GITHUB_TOKEN || !GIST_ID) {
        console.log("⚠️ GITHUB_TOKEN o GIST_ID no configurados en el entorno. Funcionando en memoria local.");
        return;
    }
    try {
        const res = await octokit.gists.get({ gist_id: GIST_ID });
        const file = res.data.files["database.json"];
        if (file && file.content) {
            const parsed = JSON.parse(file.content);
            users = (parsed.users || []).map(u => ({
                ...u,
                password: u.password,
                inventory: u.inventory || [],
                badges: u.badges || [],
                coins: typeof u.coins === 'number' ? u.coins : 100,
                equippedAccessory: u.equippedAccessory || null,
                banned: u.banned || false
            }));
            friendships = parsed.friendships || [];
            friendRequests = parsed.friendRequests || [];
            accessories = parsed.accessories || [];
            resaleListings = parsed.resaleListings || [];
            tradeOffers = parsed.tradeOffers || [];
            bannerText = parsed.bannerText || "";
            console.log("✅ Datos cargados correctamente desde el Gist privado (database.json).");
        }
    } catch (err) {
        console.log("⚠️ Error al cargar la base de datos desde el Gist:", err.message);
    }
}

async function saveDataToGit() {
    if (!process.env.GITHUB_TOKEN || !GIST_ID) return;
    try {
        const dataToSave = JSON.stringify({
            users,
            friendships,
            friendRequests,
            accessories,
            resaleListings,
            tradeOffers,
            bannerText
        }, null, 2);

        await octokit.gists.update({
            gist_id: GIST_ID,
            files: {
                "database.json": {
                    content: dataToSave
                }
            }
        });
        console.log("✅ Cambios de la base de datos guardados en database.json (Gist).");
    } catch (err) {
        console.error("❌ Error al guardar datos en el Gist:", err.message);
    }
}

// Sincronización automática con Gist cada 1 minuto (60,000 ms)
setInterval(async () => {
    await saveDataToGit();
}, 60000);

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) return res.status(401).json({ error: "Acceso no autorizado." });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: "Sesión expirada o inválida." });
        
        const foundUser = users.find(u => String(u.id) === String(user.id));
        if (!foundUser) return res.status(404).json({ error: "Usuario no encontrado." });
        
        if (!foundUser.inventory) foundUser.inventory = [];
        if (!foundUser.badges) foundUser.badges = [];

        req.user = foundUser;
        next();
    });
}

function requireAdmin(req, res, next) {
    if (!req.user || (!req.user.admin && !req.user.owner)) {
        return res.status(403).json({ error: "Requiere permisos de administrador u Owner." });
    }
    next();
}

app.get('/api/ping', (req, res) => {
    res.send("hola");
});

const PORT = process.env.PORT || 3000;

setInterval(() => {
    fetch(`http://localhost:${PORT}/api/ping`).then(r => r.text()).catch(() => {});
}, 40000);

// AUTENTICACIÓN Y PERFIL
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Completa todos los campos." });

    const cleanUsername = username.trim();
    const validRegex = /^[a-zA-Z0-9_]+$/;
    if (!validRegex.test(cleanUsername)) {
        return res.status(400).json({ error: "El usuario solo puede tener letras, números y _" });
    }

    const existing = users.find(u => u.username.toLowerCase() === cleanUsername.toLowerCase());
    if (existing) return res.status(400).json({ error: "El usuario ya existe." });

    const isOwner = users.length === 0;
    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = {
        id: Date.now().toString(),
        username: cleanUsername,
        password: hashedPassword,
        avatar: "https://via.placeholder.com/110",
        bio: "",
        badges: isOwner ? ["🛠️ Admin", "🎮 Owner"] : [],
        coins: 100,
        inventory: [],
        equippedAccessory: null,
        admin: isOwner,
        owner: isOwner,
        banned: false
    };

    users.push(newUser);
    await saveDataToGit();

    const token = jwt.sign({ id: newUser.id, username: newUser.username }, JWT_SECRET);
    res.json({ success: true, token });
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Introduce usuario y contraseña." });

    const user = users.find(u => u.username.toLowerCase() === username.trim().toLowerCase());
    if (!user) return res.status(400).json({ error: "Credenciales incorrectas." });

    const isPasswordValid = await bcrypt.compare(password, user.password).catch(() => user.password === password);
    if (!isPasswordValid) return res.status(400).json({ error: "Credenciales incorrectas." });

    if (user.banned) {
        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
        return res.status(403).json({ banned: true, token, error: "Has sido baneado de Game Blocks." });
    }

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
    res.json({ success: true, token });
});

app.get('/api/me', authenticateToken, (req, res) => {
    if (req.user.banned) {
        return res.status(403).json({ banned: true, error: "Has sido baneado de Game Blocks." });
    }
    const { password, ...safeUserData } = req.user;
    res.json(safeUserData);
});

app.post('/api/logout', (req, res) => res.json({ success: true }));

app.post('/api/profile/avatar', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    if (!req.body.avatar) return res.status(400).json({ error: "Avatar requerido." });
    req.user.avatar = req.body.avatar;
    await saveDataToGit();
    res.json({ success: true, avatar: req.user.avatar });
});

app.post('/api/profile/bio', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    req.user.bio = sanitizeText(req.body.bio || "");
    await saveDataToGit();
    res.json({ success: true, bio: req.user.bio });
});

app.get('/api/badges/me', authenticateToken, (req, res) => {
    res.json({ badges: req.user.badges || [] });
});

app.get('/api/users/search', (req, res) => {
    const q = (req.query.q || "").toLowerCase();
    const matches = users
        .filter(u => u.username.toLowerCase().includes(q) && !u.banned)
        .map(u => ({ id: u.id, username: u.username, avatar: u.avatar, bio: u.bio, badges: u.badges || [], inventory: u.inventory || [] }));
    res.json({ users: matches });
});

// ACCIONES DE USUARIO BANEADO
app.post('/api/account/delete-banned', authenticateToken, async (req, res) => {
    if (!req.user.banned) {
        return res.status(400).json({ error: "Solo los usuarios baneados pueden borrar su cuenta con esta opción." });
    }

    const deleteId = req.user.id;
    users = users.filter(u => String(u.id) !== String(deleteId));
    friendships = friendships.filter(f => String(f.user1) !== String(deleteId) && String(f.user2) !== String(deleteId));
    friendRequests = friendRequests.filter(r => String(r.senderId) !== String(deleteId) && String(r.receiverId) !== String(deleteId));
    tradeOffers = tradeOffers.filter(t => String(t.senderId) !== String(deleteId) && String(t.targetUserId) !== String(deleteId));
    resaleListings = resaleListings.filter(l => String(l.sellerId) !== String(deleteId));

    await saveDataToGit();
    res.json({ success: true, message: "Tu cuenta ha sido eliminada permanentemente." });
});

// AMIGOS & CÓDIGOS DE JUEGO
app.post('/api/friends/request', authenticateToken, (req, res) => {
    const { userId } = req.body;
    if (String(userId) === String(req.user.id)) return res.status(400).json({ error: "No puedes agregarte a ti mismo." });
    friendRequests.push({ id: Date.now().toString(), senderId: req.user.id, receiverId: userId });
    res.json({ success: true, message: "Solicitud enviada." });
});

app.get('/api/friends/requests', authenticateToken, (req, res) => {
    const reqs = friendRequests
        .filter(r => String(r.receiverId) === String(req.user.id))
        .map(r => ({ id: r.id, username: (users.find(u => String(u.id) === String(r.senderId)) || {}).username || "Desconocido" }));
    res.json({ requests: reqs });
});

app.get('/api/friends', authenticateToken, (req, res) => {
    const myFriends = friendships
        .filter(f => String(f.user1) === String(req.user.id) || String(f.user2) === String(req.user.id))
        .map(f => {
            const friendId = String(f.user1) === String(req.user.id) ? f.user2 : f.user1;
            const friendUser = users.find(u => String(u.id) === String(friendId));
            return friendUser ? { id: friendUser.id, username: friendUser.username, avatar: friendUser.avatar } : null;
        }).filter(Boolean);
    res.json({ friends: myFriends });
});

app.post('/api/game/create-code', authenticateToken, (req, res) => {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    gameCodes[code] = req.user.id;
    res.json({ success: true, code });
});

// TIENDA, LIMITEDS, REVENTA E INTERCAMBIOS
app.get(['/api/accessories', '/api/shop', '/api/store'], (req, res) => {
    const enrichedItems = accessories.map(item => {
        let totalSold = 0;
        users.forEach(u => {
            totalSold += (u.inventory || []).filter(id => String(id) === String(item.id)).length;
        });
        return { ...item, totalSold };
    });
    res.json({ items: enrichedItems });
});

app.post('/api/accessories/buy', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const itemId = req.body.itemId || req.body.id;
    const item = accessories.find(a => String(a.id) === String(itemId));

    if (!item) return res.status(404).json({ error: "Accesorio no encontrado." });
    if (item.offsale) return res.status(400).json({ error: "Este artículo está Offsale." });

    if (item.expiresAt && Date.now() > item.expiresAt) {
        return res.status(400).json({ error: "Este artículo ha expirado y ya no se puede comprar." });
    }

    let totalSold = 0;
    users.forEach(u => {
        totalSold += (u.inventory || []).filter(id => String(id) === String(item.id)).length;
    });

    if (item.maxGlobal && totalSold >= item.maxGlobal) {
        return res.status(400).json({ error: "Se ha agotado el stock global de este artículo." });
    }

    const userOwnedCount = (req.user.inventory || []).filter(id => String(id) === String(item.id)).length;
    if (item.maxPerUser && userOwnedCount >= item.maxPerUser) {
        return res.status(400).json({ error: `Alcanzaste el límite de ${item.maxPerUser} copia(s) por usuario.` });
    }

    if ((req.user.coins || 0) < item.price) {
        return res.status(400).json({ error: "Monedas insuficientes." });
    }

    req.user.coins -= item.price;
    req.user.inventory.push(item.id);

    await saveDataToGit();
    res.json({ success: true, newBalance: req.user.coins, inventory: req.user.inventory });
});

app.post('/api/accessories/sell', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { itemId } = req.body;
    const item = accessories.find(a => String(a.id) === String(itemId));

    if (!item) return res.status(404).json({ error: "Accesorio no encontrado." });

    const index = req.user.inventory.indexOf(itemId);
    if (index === -1) return res.status(400).json({ error: "No posees este accesorio." });

    req.user.inventory.splice(index, 1);
    const refundAmount = Math.floor(item.price * 0.5);
    req.user.coins += refundAmount;

    if (String(req.user.equippedAccessory) === String(itemId)) {
        req.user.equippedAccessory = null;
    }

    await saveDataToGit();
    res.json({ success: true, newBalance: req.user.coins, refundAmount });
});

app.post(['/api/accessories/equip', '/api/equip'], authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const itemId = req.body.itemId || req.body.id;
    if (!req.user.inventory.includes(itemId)) return res.status(403).json({ error: "No posees este accesorio." });
    req.user.equippedAccessory = itemId;
    await saveDataToGit();
    res.json({ success: true, equipped: itemId });
});

app.post(['/api/accessories/unequip', '/api/unequip'], authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    req.user.equippedAccessory = null;
    await saveDataToGit();
    res.json({ success: true });
});

// INTERCAMBIOS (TRADES - SOLO LIMITEDS OFFSALE)
app.post('/api/trade/offer', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });

    const { targetUserId, offeredItemId, offeredCoins, requestedItemId, requestedCoins } = req.body;
    const target = users.find(u => String(u.id) === String(targetUserId));

    if (!target) return res.status(404).json({ error: "Usuario destino no encontrado." });
    if (String(target.id) === String(req.user.id)) return res.status(400).json({ error: "No puedes tradear contigo mismo." });

    if (offeredItemId) {
        const itemOff = accessories.find(a => String(a.id) === String(offeredItemId));
        if (!itemOff) return res.status(404).json({ error: "Artículo ofrecido no existe." });
        if (!itemOff.limited || !itemOff.offsale) {
            return res.status(400).json({ error: "Solo se pueden intercambiar artículos que sean LIMITEDS y estén OFFSALE." });
        }
        if (!req.user.inventory.includes(offeredItemId)) {
            return res.status(400).json({ error: "No posees el ítem ofrecido." });
        }
    }

    if (requestedItemId) {
        const itemReq = accessories.find(a => String(a.id) === String(requestedItemId));
        if (!itemReq) return res.status(404).json({ error: "Artículo solicitado no existe." });
        if (!itemReq.limited || !itemReq.offsale) {
            return res.status(400).json({ error: "Solo puedes solicitar artículos que sean LIMITEDS y estén OFFSALE." });
        }
        if (!target.inventory.includes(requestedItemId)) {
            return res.status(400).json({ error: "El usuario destino no posee el ítem solicitado." });
        }
    }

    const offerCoinsParsed = parseInt(offeredCoins) || 0;
    const reqCoinsParsed = parseInt(requestedCoins) || 0;

    if (offerCoinsParsed > 0 && (req.user.coins || 0) < offerCoinsParsed) {
        return res.status(400).json({ error: "No tienes suficientes monedas para ofrecer." });
    }

    const trade = {
        id: Date.now().toString(),
        senderId: req.user.id,
        senderUsername: req.user.username,
        targetUserId: target.id,
        offeredItemId: offeredItemId || null,
        offeredCoins: offerCoinsParsed,
        requestedItemId: requestedItemId || null,
        requestedCoins: reqCoinsParsed
    };

    tradeOffers.push(trade);
    await saveDataToGit();
    res.json({ success: true, trade });
});

app.get('/api/trade/pending', authenticateToken, (req, res) => {
    const pending = tradeOffers.filter(t => String(t.targetUserId) === String(req.user.id));
    res.json({ trades: pending });
});

app.post('/api/trade/accept', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });

    const { tradeId } = req.body;
    const index = tradeOffers.findIndex(t => String(t.id) === String(tradeId) && String(t.targetUserId) === String(req.user.id));

    if (index === -1) return res.status(404).json({ error: "Oferta de intercambio no encontrada." });

    const trade = tradeOffers[index];
    const sender = users.find(u => String(u.id) === String(trade.senderId));

    if (!sender) return res.status(404).json({ error: "El usuario emisor ya no existe." });

    if ((sender.coins || 0) < trade.offeredCoins || (req.user.coins || 0) < trade.requestedCoins) {
        return res.status(400).json({ error: "Uno de los usuarios ya no tiene suficientes monedas." });
    }
    if (trade.offeredItemId && !sender.inventory.includes(trade.offeredItemId)) {
        return res.status(400).json({ error: "El emisor ya no posee el ítem ofrecido." });
    }
    if (trade.requestedItemId && !req.user.inventory.includes(trade.requestedItemId)) {
        return res.status(400).json({ error: "Ya no posees el ítem solicitado." });
    }

    sender.coins -= trade.offeredCoins;
    req.user.coins += trade.offeredCoins;

    req.user.coins -= trade.requestedCoins;
    sender.coins += trade.requestedCoins;

    if (trade.offeredItemId) {
        sender.inventory.splice(sender.inventory.indexOf(trade.offeredItemId), 1);
        req.user.inventory.push(trade.offeredItemId);
    }
    if (trade.requestedItemId) {
        req.user.inventory.splice(req.user.inventory.indexOf(trade.requestedItemId), 1);
        sender.inventory.push(trade.requestedItemId);
    }

    tradeOffers.splice(index, 1);
    await saveDataToGit();
    res.json({ success: true });
});

// MERCADO DE REVENTA PARA LIMITEDS OFFSALE
app.post('/api/accessories/resell-list', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });

    const { itemId, price } = req.body;
    const item = accessories.find(a => String(a.id) === String(itemId));

    if (!item) return res.status(404).json({ error: "Artículo no encontrado." });
    if (!item.limited) return res.status(400).json({ error: "Solo los artículos Limiteds se pueden revender." });
    if (!item.offsale) return res.status(400).json({ error: "El artículo debe estar Offsale para ponerlo en reventa." });

    const index = req.user.inventory.indexOf(itemId);
    if (index === -1) return res.status(400).json({ error: "No posees este accesorio." });

    const listingPrice = parseInt(price);
    if (isNaN(listingPrice) || listingPrice <= 0) return res.status(400).json({ error: "Precio inválido." });

    req.user.inventory.splice(index, 1);
    if (String(req.user.equippedAccessory) === String(itemId)) {
        req.user.equippedAccessory = null;
    }

    const listing = {
        id: Date.now().toString(),
        itemId: item.id,
        sellerId: req.user.id,
        sellerUsername: req.user.username,
        price: listingPrice
    };

    resaleListings.push(listing);
    await saveDataToGit();
    res.json({ success: true, listing });
});

app.get('/api/accessories/resale-market', (req, res) => {
    res.json({ listings: resaleListings });
});

app.post('/api/accessories/resell-buy', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });

    const { listingId } = req.body;
    const listIndex = resaleListings.findIndex(l => String(l.id) === String(listingId));
    if (listIndex === -1) return res.status(404).json({ error: "Oferta de reventa no disponible." });

    const listing = resaleListings[listIndex];
    if (String(listing.sellerId) === String(req.user.id)) return res.status(400).json({ error: "No puedes comprar tu propia oferta." });
    if ((req.user.coins || 0) < listing.price) return res.status(400).json({ error: "Monedas insuficientes." });

    const seller = users.find(u => String(u.id) === String(listing.sellerId));

    req.user.coins -= listing.price;
    if (seller) seller.coins = (seller.coins || 0) + listing.price;
    req.user.inventory.push(listing.itemId);

    resaleListings.splice(listIndex, 1);
    await saveDataToGit();
    res.json({ success: true, newBalance: req.user.coins });
});

// PANEL ADMIN
app.post('/api/admin/users/rename', authenticateToken, requireAdmin, async (req, res) => {
    const { targetUsername, newName } = req.body;
    if (!newName || !newName.trim()) return res.status(400).json({ error: "Ingresa el nuevo nombre." });

    let target = req.user;
    if (targetUsername && targetUsername.trim() !== "") {
        target = users.find(u => u.username.toLowerCase() === targetUsername.trim().toLowerCase());
        if (!target) return res.status(404).json({ error: "Usuario objetivo no encontrado." });
    }

    const cleanNewName = newName.trim();
    const existing = users.find(u => u.id !== target.id && u.username.toLowerCase() === cleanNewName.toLowerCase());
    if (existing) return res.status(400).json({ error: "El usuario ya existe." });

    target.username = cleanNewName;
    await saveDataToGit();
    res.json({ success: true, newUsername: target.username });
});

app.post('/api/admin/users/ban', authenticateToken, requireAdmin, async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: "Nombre de usuario requerido." });

    const target = users.find(u => u.username.toLowerCase() === username.trim().toLowerCase());
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    if (target.owner) return res.status(400).json({ error: "No se puede banear al Owner." });

    target.banned = true;
    await saveDataToGit();
    res.json({ success: true, message: `Usuario ${target.username} baneado con éxito.` });
});

// AÑADIR E INSIGNIAS DE USUARIO
app.post('/api/admin/badges/add', authenticateToken, requireAdmin, async (req, res) => {
    const { username, badgeName } = req.body;
    if (!username || !badgeName) return res.status(400).json({ error: "Usuario e insignia requeridos." });

    const target = users.find(u => u.username.toLowerCase() === username.trim().toLowerCase());
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    if (!target.badges) target.badges = [];
    const cleanBadge = badgeName.trim();

    const exists = target.badges.some(b => (typeof b === 'object' ? b.name : b) === cleanBadge);
    if (!exists) {
        target.badges.push(cleanBadge);
    }

    await saveDataToGit();
    res.json({ success: true, badges: target.badges });
});

app.post('/api/admin/badges/remove', authenticateToken, requireAdmin, async (req, res) => {
    const { username, badgeName } = req.body;
    if (!username || !badgeName) return res.status(400).json({ error: "Usuario e insignia requeridos." });

    const target = users.find(u => u.username.toLowerCase() === username.trim().toLowerCase());
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    if (target.badges) {
        const cleanBadge = badgeName.trim();
        target.badges = target.badges.filter(b => (typeof b === 'object' ? b.name : b) !== cleanBadge);
    }

    await saveDataToGit();
    res.json({ success: true, badges: target.badges });
});

app.post('/api/admin/accessories/upload', authenticateToken, requireAdmin, (req, res) => {
    upload.single('glb')(req, res, async (err) => {
        if (err || !req.file) return res.status(400).json({ error: "Archivo GLB requerido." });

        const { imageUrl, name, limited, offsale, maxPerUser, maxGlobal, expiresInDays, price } = req.body;
        if (!imageUrl || !price) return res.status(400).json({ error: "Campos obligatorios incompletos." });

        const expiresAt = expiresInDays ? Date.now() + (parseInt(expiresInDays) * 86400000) : null;

        const newAccessory = {
            id: Date.now().toString(),
            name: sanitizeText(name || "Accesorio"),
            glbUrl: `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`,
            imageUrl: imageUrl.trim(),
            limited: limited === 'true' || limited === true,
            offsale: offsale === 'true' || offsale === true,
            maxPerUser: parseInt(maxPerUser) || 1,
            maxGlobal: maxGlobal ? parseInt(maxGlobal) : null,
            expiresAt: expiresAt,
            price: parseInt(price) || 0
        };

        accessories.push(newAccessory);
        await saveDataToGit();
        res.json({ success: true, accessory: newAccessory });
    });
});

app.post('/api/admin/accessories/edit', authenticateToken, requireAdmin, async (req, res) => {
    const { itemId, price, limited, offsale } = req.body;
    const item = accessories.find(a => String(a.id) === String(itemId));

    if (!item) return res.status(404).json({ error: "Accesorio no encontrado." });

    if (price !== undefined && price !== "") item.price = parseInt(price);
    if (limited !== undefined) item.limited = (limited === 'true' || limited === true);
    if (offsale !== undefined) item.offsale = (offsale === 'true' || offsale === true);

    await saveDataToGit();
    res.json({ success: true, item });
});

app.post('/api/admin/coins/add', authenticateToken, requireAdmin, async (req, res) => {
    const { username, amount } = req.body;
    const target = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });
    target.coins = (target.coins || 0) + parseInt(amount || 0);
    await saveDataToGit();
    res.json({ success: true, newBalance: target.coins });
});

app.post('/api/admin/banner', authenticateToken, requireAdmin, async (req, res) => {
    bannerText = sanitizeText(req.body.text || "");
    await saveDataToGit();
    res.json({ success: true, text: bannerText });
});

app.get('/api/banner', (req, res) => res.json({ text: bannerText }));

app.listen(PORT, async () => {
    await loadDataFromGit();
    console.log(`🎮 Servidor Game Blocks activo en el puerto ${PORT}`);
});
