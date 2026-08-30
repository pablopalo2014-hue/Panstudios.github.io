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

process.on('unhandledRejection', (reason) => {
    console.error("⚠️ Promesa rechazada sin manejar:", reason);
});
process.on('uncaughtException', (err) => {
    console.error("⚠️ Excepción no controlada:", err);
});

function wrapAsync(fn) {
    if (fn.length >= 3) return fn;
    return function (req, res, next) {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}
['get', 'post', 'put', 'delete', 'patch'].forEach((method) => {
    const original = app[method].bind(app);
    app[method] = (path, ...handlers) => original(path, ...handlers.map((h) => (typeof h === 'function' ? wrapAsync(h) : h)));
});

const octokit = process.env.GITHUB_TOKEN ? new Octokit({ auth: process.env.GITHUB_TOKEN }) : null;
const GIST_ID = process.env.GIST_ID; 
const LOCAL_DB_PATH = path.join(__dirname, 'database.json');

app.use(cors());

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use((req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    if (req.path.startsWith('/api/') || req.path === '/register' || req.path === '/login') return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return res.status(405).json({ error: `Método ${req.method} no permitido en ${req.path}.` });
    }
    next();
});

app.use(express.static(__dirname));
 
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

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
let promoCodes = [];     
let bannerText = "";     
let chatMessages = [];
let blockSubscriptionRewardItemId = null;

let currencyPackages = [
    { coins: 100, dollars: 1 },
    { coins: 500, dollars: 5 },
    { coins: 1000, dollars: 10 },
    { coins: 2500, dollars: 25 },
    { coins: 6000, dollars: 60 }
];

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

function hasActiveBlockSub(user) {
    if (!user || !user.blockSubExpiresAt) return false;
    return Date.now() < user.blockSubExpiresAt;
}

function loadLocalData() {
    if (fs.existsSync(LOCAL_DB_PATH)) {
        try {
            const content = fs.readFileSync(LOCAL_DB_PATH, 'utf8');
            const parsed = JSON.parse(content);
            users = (parsed.users || []).map(u => ({
                ...u,
                inventory: u.inventory || [],
                badges: u.badges || [],
                likes: u.likes || [],
                dislikes: u.dislikes || [],
                reports: u.reports || [],
                coins: typeof u.coins === 'number' ? u.coins : 100,
                dollars: typeof u.dollars === 'number' ? u.dollars : 0,
                blockSubExpiresAt: u.blockSubExpiresAt || null,
                lastDailyReward: u.lastDailyReward || 0
            }));
            friendships = parsed.friendships || [];
            friendRequests = parsed.friendRequests || [];
            accessories = (parsed.accessories || []).map(a => ({
                ...a,
                type: a.type || "hat",
                isGhost: Boolean(a.isGhost),
                onlyBlock: Boolean(a.onlyBlock)
            }));
            resaleListings = parsed.resaleListings || [];
            tradeOffers = parsed.tradeOffers || [];
            promoCodes = parsed.promoCodes || [];
            bannerText = parsed.bannerText || "";
            chatMessages = parsed.chatMessages || [];
            blockSubscriptionRewardItemId = parsed.blockSubscriptionRewardItemId || null;
            console.log("✅ Datos cargados localmente desde database.json");
        } catch (err) {
            console.error("⚠️ Error al leer database.json local:", err.message);
        }
    }
}

async function loadDataFromGit() {
    if (!octokit || !GIST_ID) {
        console.log("⚠️ GITHUB_TOKEN o GIST_ID no configurados. Usando almacenamiento en archivo local.");
        loadLocalData();
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
                likes: u.likes || [],
                dislikes: u.dislikes || [],
                reports: u.reports || [],
                coins: typeof u.coins === 'number' ? u.coins : 100,
                dollars: typeof u.dollars === 'number' ? u.dollars : 0,
                blockSubExpiresAt: u.blockSubExpiresAt || null,
                equippedAccessory: u.equippedAccessory || null,
                profileBgColor: u.profileBgColor || null,
                profileSoundUrl: u.profileSoundUrl || null,
                banned: u.banned || false,
                lastDailyReward: u.lastDailyReward || 0
            }));
            friendships = parsed.friendships || [];
            friendRequests = parsed.friendRequests || [];
            accessories = (parsed.accessories || []).map(a => ({
                ...a,
                type: a.type || "hat",
                isGhost: Boolean(a.isGhost),
                onlyBlock: Boolean(a.onlyBlock)
            }));
            resaleListings = parsed.resaleListings || [];
            tradeOffers = parsed.tradeOffers || [];
            promoCodes = parsed.promoCodes || [];
            bannerText = parsed.bannerText || "";
            chatMessages = parsed.chatMessages || [];
            blockSubscriptionRewardItemId = parsed.blockSubscriptionRewardItemId || null;
            console.log("✅ Datos cargados correctamente desde el Gist privado.");
        } else {
            loadLocalData();
        }
    } catch (err) {
        console.log("⚠️ Error al cargar desde Gist, usando copia local:", err.message);
        loadLocalData();
    }
}

async function saveDataToGit() {
    const dataObj = {
        users,
        friendships,
        friendRequests,
        accessories,
        resaleListings,
        tradeOffers,
        promoCodes,
        bannerText,
        chatMessages,
        blockSubscriptionRewardItemId
    };
    const dataToSave = JSON.stringify(dataObj, null, 2);

    try {
        fs.writeFileSync(LOCAL_DB_PATH, dataToSave, 'utf8');
    } catch (e) {
        console.error("❌ Error al guardar copia local:", e.message);
    }

    if (!octokit || !GIST_ID) return;
    try {
        await octokit.gists.update({
            gist_id: GIST_ID,
            files: { "database.json": { content: dataToSave } }
        });
        console.log("✅ Cambios sincronizados con Gist.");
    } catch (err) {
        console.error("❌ Error al guardar en Gist:", err.message);
    }
}

setInterval(async () => {
    await saveDataToGit();
}, 20000);

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
        if (!foundUser.likes) foundUser.likes = [];
        if (!foundUser.dislikes) foundUser.dislikes = [];
        if (!foundUser.reports) foundUser.reports = [];

        req.user = foundUser;
        next();
    });
}

function requireAdmin(req, res, next) {
    if (!req.user) return res.status(403).json({ error: "Acceso denegado." });
    
    const hasAdminBadge = req.user.badges && req.user.badges.some(b => {
        const name = typeof b === 'object' ? b.name : b;
        return name === "🛡️admin" || name === "🛡️ admin" || name === "🛠️ Admin";
    });

    if (!req.user.admin && !req.user.owner && !hasAdminBadge) {
        return res.status(403).json({ error: "Requiere permisos de administrador, Owner o la insignia 🛡️admin." });
    }
    next();
}

app.get('/api/ping', (req, res) => {
    res.json({ message: "hola" });
});

const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || `http://localhost:${PORT}`;

setInterval(() => {
    try {
        if (typeof fetch !== 'function') return;
        fetch(`${SELF_URL}/api/ping`).then(r => r.json()).catch(() => {});
    } catch (err) {
        console.error("⚠️ Error en auto-ping:", err.message);
    }
}, 40000);

// AUTENTICACIÓN Y PERFIL
app.post(['/api/register', '/register'], async (req, res) => {
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
        badges: isOwner ? ["🛠️ Admin", "🎮 Owner", "🛡️admin"] : [],
        coins: 0,
        dollars: 0,
        inventory: [],
        likes: [],
        dislikes: [],
        reports: [],
        blockSubExpiresAt: null,
        equippedAccessory: null,
        profileBgColor: null,
        profileSoundUrl: null,
        admin: isOwner,
        owner: isOwner,
        banned: false,
        lastDailyReward: Date.now()
    };

    users.push(newUser);
    await saveDataToGit();

    const token = jwt.sign({ id: newUser.id, username: newUser.username }, JWT_SECRET);
    res.json({ success: true, token });
});

app.post(['/api/login', '/login'], async (req, res) => {
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

app.get('/api/me', authenticateToken, async (req, res) => {
    if (req.user.banned) {
        return res.status(403).json({ banned: true, error: "Has sido baneado de Game Blocks." });
    }

    const NOW = Date.now();
    const DAY_MS = 86400000;
    let dailyClaimed = false;
    const isBlockSub = hasActiveBlockSub(req.user);
    const dailyAmount = isBlockSub ? 34 : 10;

    if (!req.user.lastDailyReward || (NOW - req.user.lastDailyReward) >= DAY_MS) {
        req.user.coins = (req.user.coins || 0) + dailyAmount;
        req.user.lastDailyReward = NOW;
        dailyClaimed = true;
        await saveDataToGit();
    }

    const { password, ...safeUserData } = req.user;
    res.json({ 
        ...safeUserData, 
        dailyClaimed, 
        dailyAmount,
        hasBlockSub: isBlockSub 
    });
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

// LIKES, DISLIKES Y REPORTES
app.post('/api/users/:id/like', authenticateToken, async (req, res) => {
    const target = users.find(u => String(u.id) === String(req.params.id));
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    if (!target.likes) target.likes = [];
    if (!target.dislikes) target.dislikes = [];

    const myId = req.user.id;
    target.dislikes = target.dislikes.filter(id => String(id) !== String(myId));

    const idx = target.likes.findIndex(id => String(id) === String(myId));
    if (idx !== -1) {
        target.likes.splice(idx, 1);
    } else {
        target.likes.push(myId);
    }

    await saveDataToGit();
    res.json({ success: true, likes: target.likes.length, dislikes: target.dislikes.length });
});

app.post('/api/users/:id/dislike', authenticateToken, async (req, res) => {
    const target = users.find(u => String(u.id) === String(req.params.id));
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    if (!target.likes) target.likes = [];
    if (!target.dislikes) target.dislikes = [];

    const myId = req.user.id;
    target.likes = target.likes.filter(id => String(id) !== String(myId));

    const idx = target.dislikes.findIndex(id => String(id) === String(myId));
    if (idx !== -1) {
        target.dislikes.splice(idx, 1);
    } else {
        target.dislikes.push(myId);
    }

    await saveDataToGit();
    res.json({ success: true, likes: target.likes.length, dislikes: target.dislikes.length });
});

app.post('/api/users/:id/report', authenticateToken, async (req, res) => {
    const target = users.find(u => String(u.id) === String(req.params.id));
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });
    if (String(target.id) === String(req.user.id)) return res.status(400).json({ error: "No puedes denunciarte a ti mismo." });

    if (!target.reports) target.reports = [];
    if (target.reports.includes(req.user.id)) {
        return res.status(400).json({ error: "Ya has denunciado a este usuario." });
    }

    target.reports.push(req.user.id);
    await saveDataToGit();
    res.json({ success: true, message: "Denuncia enviada.", totalReports: target.reports.length });
});

// SUSCRIPCIÓN BLOCK
app.post('/api/subscription/buy-block', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });

    const currentDollars = req.user.dollars || 0;
    if (currentDollars < 5) {
        return res.status(400).json({ error: "Necesitas al menos 5 💲 para la Suscripción Block." });
    }

    req.user.dollars = currentDollars - 5;
    const monthMs = 30 * 86400000;
    const currentSubEnd = (req.user.blockSubExpiresAt && req.user.blockSubExpiresAt > Date.now()) 
        ? req.user.blockSubExpiresAt 
        : Date.now();

    req.user.blockSubExpiresAt = currentSubEnd + monthMs;

    let freeItemGiven = null;
    if (blockSubscriptionRewardItemId) {
        const rewardItem = accessories.find(a => String(a.id) === String(blockSubscriptionRewardItemId));
        if (rewardItem) {
            req.user.inventory.push(rewardItem.id);
            freeItemGiven = rewardItem.name;
        }
    }

    await saveDataToGit();
    res.json({
        success: true,
        message: "¡Te has suscrito a Block con éxito!",
        dollars: req.user.dollars,
        blockSubExpiresAt: req.user.blockSubExpiresAt,
        freeItemGiven
    });
});

// CHAT CON AMIGOS
app.get('/api/chat/:friendId', authenticateToken, (req, res) => {
    const friendId = String(req.params.friendId);
    const myId = String(req.user.id);

    const isFriend = friendships.some(f => 
        (String(f.user1) === myId && String(f.user2) === friendId) ||
        (String(f.user2) === myId && String(f.user1) === friendId)
    );

    if (!isFriend) return res.status(403).json({ error: "Solo puedes chatear con amigos." });

    const msgs = chatMessages.filter(m => 
        (String(m.senderId) === myId && String(m.receiverId) === friendId) ||
        (String(m.senderId) === friendId && String(m.receiverId) === myId)
    );

    res.json({ messages: msgs });
});

app.post('/api/chat/send', authenticateToken, async (req, res) => {
    const { friendId, text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: "Mensaje vacío." });

    const myId = String(req.user.id);
    const targetId = String(friendId);

    const isFriend = friendships.some(f => 
        (String(f.user1) === myId && String(f.user2) === targetId) ||
        (String(f.user2) === myId && String(f.user1) === targetId)
    );

    if (!isFriend) return res.status(403).json({ error: "Solo puedes enviar mensajes a amigos." });

    const containsEmoji = /(\p{Extended_Pictographic}|\p{Emoji_Presentation})/u.test(text);
    if (containsEmoji && !hasActiveBlockSub(req.user)) {
        return res.status(403).json({ 
            error: "🔒 Emojis bloqueados. Requiere la Suscripción Block (5 💲/mes) para usarlos o pegarlos." 
        });
    }

    const newMessage = {
        id: Date.now().toString(),
        senderId: req.user.id,
        senderUsername: req.user.username,
        receiverId: targetId,
        text: sanitizeText(text.trim()),
        timestamp: Date.now()
    };

    chatMessages.push(newMessage);
    await saveDataToGit();
    res.json({ success: true, message: newMessage });
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

app.get('/api/users/profile/:id', (req, res) => {
    const target = users.find(u => String(u.id) === String(req.params.id));
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    const userInventory = (target.inventory || []).map(itemId => {
        const item = accessories.find(a => String(a.id) === String(itemId));
        return item ? { id: item.id, name: item.name, imageUrl: item.imageUrl, type: item.type } : { id: itemId, name: "Objeto #" + itemId, imageUrl: "https://via.placeholder.com/80" };
    });

    res.json({
        id: target.id,
        username: target.username,
        avatar: target.avatar,
        bio: target.bio,
        badges: target.badges || [],
        inventory: userInventory,
        profileBgColor: target.profileBgColor || null,
        profileSoundUrl: target.profileSoundUrl || null,
        likesCount: (target.likes || []).length,
        dislikesCount: (target.dislikes || []).length,
        reportsCount: (target.reports || []).length,
        isAlert: (target.reports || []).length >= 5
    });
});

// CANJEAR CÓDIGOS
app.post('/api/codes/redeem', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "Ingresa un código." });

    const cleanCode = code.trim().toUpperCase();
    const promo = promoCodes.find(c => c.code.toUpperCase() === cleanCode);

    if (!promo) return res.status(404).json({ error: "Código inválido o inexistente." });

    if (promo.expiresAt && Date.now() > promo.expiresAt) {
        return res.status(400).json({ error: "El código ha expirado." });
    }

    if (promo.maxUses !== null && promo.currentUses >= promo.maxUses) {
        return res.status(400).json({ error: "El código ha alcanzado el límite máximo de usos." });
    }

    if (!promo.usedBy) promo.usedBy = [];
    if (promo.usedBy.includes(req.user.id)) {
        return res.status(400).json({ error: "Ya has canjeado este código anteriormente." });
    }

    promo.usedBy.push(req.user.id);
    promo.currentUses = (promo.currentUses || 0) + 1;

    if (promo.coins) req.user.coins = (req.user.coins || 0) + Number(promo.coins);
    if (promo.dollars) req.user.dollars = (req.user.dollars || 0) + Number(promo.dollars);
    if (promo.rewardItemId) {
        if (!req.user.inventory.includes(promo.rewardItemId)) {
            req.user.inventory.push(promo.rewardItemId);
        }
    }

    await saveDataToGit();
    res.json({ success: true, message: `¡Código canjeado con éxito! Monedas: +${promo.coins || 0}, Dollars: +${promo.dollars || 0}` });
});

// ELIMINAR CUENTA BANEADA
app.post('/api/account/delete-banned', authenticateToken, async (req, res) => {
    if (!req.user.banned) return res.status(400).json({ error: "Tu cuenta no está baneada." });
    users = users.filter(u => String(u.id) !== String(req.user.id));
    await saveDataToGit();
    res.json({ success: true, message: "Cuenta eliminada correctamente." });
});

// PAQUETES Y COMPRA DE MONEDAS
app.get('/api/coins/packages', (req, res) => {
    res.json({ packages: currencyPackages });
});

app.post('/api/coins/purchase', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { coins } = req.body;
    const pkg = currencyPackages.find(p => p.coins === Number(coins));
    if (!pkg) return res.status(400).json({ error: "Paquete de monedas no válido." });

    if ((req.user.dollars || 0) < pkg.dollars) {
        return res.status(400).json({ error: "No tienes suficientes 💲 para comprar este paquete." });
    }

    req.user.dollars -= pkg.dollars;
    req.user.coins = (req.user.coins || 0) + pkg.coins;
    await saveDataToGit();
    res.json({ success: true, coins: req.user.coins, dollars: req.user.dollars });
});

// SUBIR CAMISETAS (UGC Y ADMIN)
app.post('/api/tshirts/upload', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { name, imageUrl, price, onlyBlock } = req.body;
    if (!name || !imageUrl) return res.status(400).json({ error: "Nombre e imagen requeridos." });

    const cost = Math.max(1, Number(price) || 1);
    const newTshirt = {
        id: Date.now().toString(),
        name: sanitizeText(name),
        imageUrl,
        price: cost,
        type: "tshirt",
        createdByAdmin: false,
        creatorUsername: req.user.username,
        creatorId: req.user.id,
        onlyBlock: Boolean(onlyBlock),
        limited: false,
        offsale: false,
        totalSold: 0
    };

    accessories.push(newTshirt);
    await saveDataToGit();
    res.json({ success: true, tshirt: newTshirt });
});

// CÓDIGO DE JUEGO
app.post('/api/game/create-code', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    gameCodes[code] = { userId: req.user.id, username: req.user.username, createdAt: Date.now() };
    res.json({ success: true, code });
});

// ACCESORIOS Y TIENDA
app.get('/api/accessories', (req, res) => {
    const publicItems = accessories.filter(a => !a.isGhost);
    res.json({ items: publicItems });
});

app.get('/api/accessories/all', (req, res) => {
    res.json({ items: accessories });
});

app.post('/api/accessories/buy', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { itemId } = req.body;
    const item = accessories.find(a => String(a.id) === String(itemId));
    if (!item) return res.status(404).json({ error: "Artículo no encontrado." });
    if (item.offsale) return res.status(400).json({ error: "Este artículo está fuera de venta (Offsale)." });

    if (item.onlyBlock && !hasActiveBlockSub(req.user)) {
        return res.status(403).json({ error: "Este artículo requiere Suscripción Block activa." });
    }

    if ((req.user.coins || 0) < item.price) {
        return res.status(400).json({ error: "No tienes suficientes monedas." });
    }

    if (item.limited) {
        const userCopies = req.user.inventory.filter(id => String(id) === String(item.id)).length;
        if (item.maxPerUser && userCopies >= item.maxPerUser) {
            return res.status(400).json({ error: `Has alcanzado el límite máximo de ${item.maxPerUser} copia(s) por usuario para este Limited.` });
        }
        if (item.maxGlobal && (item.totalSold || 0) >= item.maxGlobal) {
            return res.status(400).json({ error: "Agotado: se ha alcanzado el stock global total." });
        }
        if (item.expiresAt && Date.now() > item.expiresAt) {
            return res.status(400).json({ error: "Este artículo Limited ha expirado." });
        }
    }

    req.user.coins -= item.price;
    req.user.inventory.push(item.id);
    item.totalSold = (item.totalSold || 0) + 1;

    await saveDataToGit();
    res.json({ success: true, newBalance: req.user.coins, inventory: req.user.inventory });
});

app.post('/api/accessories/equip', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { itemId } = req.body;
    if (!req.user.inventory.some(id => String(id) === String(itemId))) {
        return res.status(400).json({ error: "No posees este artículo en tu inventario." });
    }

    const item = accessories.find(a => String(a.id) === String(itemId));
    req.user.equippedAccessory = itemId;

    if (item) {
        if (item.bgColor) req.user.profileBgColor = item.bgColor;
        if (item.soundUrl) req.user.profileSoundUrl = item.soundUrl;
    }

    await saveDataToGit();
    res.json({
        success: true,
        equippedAccessory: itemId,
        profileBgColor: req.user.profileBgColor,
        profileSoundUrl: req.user.profileSoundUrl
    });
});

app.post('/api/accessories/unequip', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    req.user.equippedAccessory = null;
    req.user.profileBgColor = null;
    req.user.profileSoundUrl = null;
    await saveDataToGit();
    res.json({ success: true });
});

app.post('/api/accessories/sell', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { itemId } = req.body;
    const idx = req.user.inventory.findIndex(id => String(id) === String(itemId));
    if (idx === -1) return res.status(400).json({ error: "No posees este artículo." });

    const item = accessories.find(a => String(a.id) === String(itemId));
    const originalPrice = item ? item.price : 0;
    const refundAmount = Math.floor(originalPrice * 0.5);

    req.user.inventory.splice(idx, 1);
    req.user.coins = (req.user.coins || 0) + refundAmount;

    if (String(req.user.equippedAccessory) === String(itemId)) {
        req.user.equippedAccessory = null;
        req.user.profileBgColor = null;
        req.user.profileSoundUrl = null;
    }

    await saveDataToGit();
    res.json({ success: true, refundAmount, coins: req.user.coins });
});

app.post('/api/accessories/resell-list', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { itemId, price } = req.body;
    const item = accessories.find(a => String(a.id) === String(itemId));
    if (!item) return res.status(404).json({ error: "Artículo no encontrado." });
    if (!item.limited || !item.offsale) {
        return res.status(400).json({ error: "Solo puedes revender artículos marcados como Limited y Offsale." });
    }

    const idx = req.user.inventory.findIndex(id => String(id) === String(itemId));
    if (idx === -1) return res.status(400).json({ error: "No posees este artículo." });

    const listingPrice = Math.max(1, Number(price) || 1);
    req.user.inventory.splice(idx, 1);

    const newListing = {
        id: Date.now().toString(),
        sellerId: req.user.id,
        sellerUsername: req.user.username,
        itemId: item.id,
        price: listingPrice,
        createdAt: Date.now()
    };

    resaleListings.push(newListing);
    await saveDataToGit();
    res.json({ success: true, listing: newListing });
});

app.get('/api/accessories/resale-market', (req, res) => {
    const list = resaleListings.map(l => {
        const item = accessories.find(a => String(a.id) === String(l.itemId));
        return { ...l, item };
    });
    res.json({ listings: list });
});

app.post('/api/accessories/resell-buy', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { listingId } = req.body;
    const idx = resaleListings.findIndex(l => String(l.id) === String(listingId));
    if (idx === -1) return res.status(404).json({ error: "Oferta de reventa no encontrada." });

    const listing = resaleListings[idx];
    if (String(listing.sellerId) === String(req.user.id)) {
        return res.status(400).json({ error: "No puedes comprar tu propia oferta de reventa." });
    }

    if ((req.user.coins || 0) < listing.price) {
        return res.status(400).json({ error: "No tienes suficientes monedas." });
    }

    const seller = users.find(u => String(u.id) === String(listing.sellerId));

    req.user.coins -= listing.price;
    req.user.inventory.push(listing.itemId);

    if (seller) {
        seller.coins = (seller.coins || 0) + listing.price;
    }

    resaleListings.splice(idx, 1);
    await saveDataToGit();
    res.json({ success: true, message: "¡Compra de reventa realizada con éxito!" });
});

// BANNER
app.get('/api/banner', (req, res) => {
    res.json({ text: bannerText });
});

// AMIGOS Y SOLICITUDES
app.get('/api/friends/requests', authenticateToken, (req, res) => {
    const myId = String(req.user.id);
    const reqs = friendRequests
        .filter(r => String(r.targetId) === myId)
        .map(r => {
            const sender = users.find(u => String(u.id) === String(r.senderId));
            return { id: r.id, senderId: r.senderId, username: sender ? sender.username : "Usuario" };
        });
    res.json({ requests: reqs });
});

app.get('/api/friends', authenticateToken, (req, res) => {
    const myId = String(req.user.id);
    const list = friendships
        .filter(f => String(f.user1) === myId || String(f.user2) === myId)
        .map(f => {
            const friendId = String(f.user1) === myId ? f.user2 : f.user1;
            const friend = users.find(u => String(u.id) === String(friendId));
            return friend ? { id: friend.id, username: friend.username, avatar: friend.avatar } : null;
        })
        .filter(Boolean);
    res.json({ friends: list });
});

app.post('/api/friends/request', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { userId } = req.body;
    const targetId = String(userId);
    const myId = String(req.user.id);

    if (targetId === myId) return res.status(400).json({ error: "No puedes agregarte a ti mismo." });

    const alreadyFriends = friendships.some(f => 
        (String(f.user1) === myId && String(f.user2) === targetId) ||
        (String(f.user2) === myId && String(f.user1) === targetId)
    );
    if (alreadyFriends) return res.status(400).json({ error: "Ya son amigos." });

    const existingReq = friendRequests.some(r => String(r.senderId) === myId && String(r.targetId) === targetId);
    if (existingReq) return res.status(400).json({ error: "Ya has enviado una solicitud a este usuario." });

    friendRequests.push({
        id: Date.now().toString(),
        senderId: req.user.id,
        targetId
    });

    await saveDataToGit();
    res.json({ success: true, message: "Solicitud de amistad enviada." });
});

app.post('/api/friends/accept', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { requestId } = req.body;
    const idx = friendRequests.findIndex(r => String(r.id) === String(requestId));
    if (idx === -1) return res.status(404).json({ error: "Solicitud no encontrada." });

    const r = friendRequests[idx];
    if (String(r.targetId) !== String(req.user.id)) {
        return res.status(403).json({ error: "No puedes aceptar esta solicitud." });
    }

    friendships.push({
        id: Date.now().toString(),
        user1: r.senderId,
        user2: r.targetId
    });

    friendRequests.splice(idx, 1);
    await saveDataToGit();
    res.json({ success: true, message: "Solicitud de amistad aceptada." });
});

// INTERCAMBIOS (TRADES)
app.post('/api/trade/offer', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { targetUserId, offeredItemId, offeredCoins, requestedItemId, requestedCoins } = req.body;

    const targetId = String(targetUserId);
    if (targetId === String(req.user.id)) return res.status(400).json({ error: "No puedes intercambiar contigo mismo." });

    const targetUser = users.find(u => String(u.id) === targetId);
    if (!targetUser) return res.status(404).json({ error: "Usuario destinatario no encontrado." });

    const coinsOffered = Math.max(0, Number(offeredCoins) || 0);
    const coinsRequested = Math.max(0, Number(requestedCoins) || 0);

    if (coinsOffered > (req.user.coins || 0)) {
        return res.status(400).json({ error: "No tienes suficientes monedas para ofrecer." });
    }

    if (offeredItemId && !req.user.inventory.some(id => String(id) === String(offeredItemId))) {
        return res.status(400).json({ error: "No posees el artículo ofrecido." });
    }

    if (requestedItemId && !targetUser.inventory.some(id => String(id) === String(requestedItemId))) {
        return res.status(400).json({ error: "El destinatario no posee el artículo solicitado." });
    }

    const trade = {
        id: Date.now().toString(),
        senderId: req.user.id,
        senderUsername: req.user.username,
        targetId,
        offeredItemId: offeredItemId || null,
        offeredCoins: coinsOffered,
        requestedItemId: requestedItemId || null,
        requestedCoins: coinsRequested,
        status: "pending"
    };

    tradeOffers.push(trade);
    await saveDataToGit();
    res.json({ success: true, message: "Oferta de intercambio enviada con éxito." });
});

app.get('/api/trade/pending', authenticateToken, (req, res) => {
    const myId = String(req.user.id);
    const pending = tradeOffers
        .filter(t => String(t.targetId) === myId && t.status === "pending")
        .map(t => {
            const offered = accessories.find(a => String(a.id) === String(t.offeredItemId));
            const requested = accessories.find(a => String(a.id) === String(t.requestedItemId));
            return {
                ...t,
                offeredItemName: offered ? offered.name : "Ninguno",
                requestedItemName: requested ? requested.name : "Ninguno"
            };
        });
    res.json({ trades: pending });
});

app.post('/api/trade/accept', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { tradeId } = req.body;
    const idx = tradeOffers.findIndex(t => String(t.id) === String(tradeId));
    if (idx === -1) return res.status(404).json({ error: "Intercambio no encontrado." });

    const trade = tradeOffers[idx];
    if (String(trade.targetId) !== String(req.user.id)) {
        return res.status(403).json({ error: "No puedes aceptar este intercambio." });
    }

    const sender = users.find(u => String(u.id) === String(trade.senderId));
    if (!sender) return res.status(404).json({ error: "El remitente del intercambio ya no existe." });

    if (trade.offeredCoins > (sender.coins || 0)) {
        return res.status(400).json({ error: "El remitente ya no tiene las monedas ofrecidas." });
    }
    if (trade.requestedCoins > (req.user.coins || 0)) {
        return res.status(400).json({ error: "No tienes suficientes monedas para completar el trato." });
    }

    if (trade.offeredItemId) {
        const offerIdx = sender.inventory.findIndex(id => String(id) === String(trade.offeredItemId));
        if (offerIdx === -1) return res.status(400).json({ error: "El remitente ya no posee el artículo ofrecido." });
        sender.inventory.splice(offerIdx, 1);
        req.user.inventory.push(trade.offeredItemId);
    }

    if (trade.requestedItemId) {
        const reqIdx = req.user.inventory.findIndex(id => String(id) === String(trade.requestedItemId));
        if (reqIdx === -1) return res.status(400).json({ error: "Ya no posees el artículo solicitado." });
        req.user.inventory.splice(reqIdx, 1);
        sender.inventory.push(trade.requestedItemId);
    }

    sender.coins = (sender.coins || 0) - trade.offeredCoins + trade.requestedCoins;
    req.user.coins = (req.user.coins || 0) - trade.requestedCoins + trade.offeredCoins;

    trade.status = "accepted";
    tradeOffers.splice(idx, 1);

    await saveDataToGit();
    res.json({ success: true, message: "¡Intercambio realizado con éxito!" });
});

// RUTAS DE ADMINISTRACIÓN
app.get('/api/admin/reports', authenticateToken, requireAdmin, (req, res) => {
    const reportedUsers = users
        .filter(u => (u.reports || []).length >= 10)
        .map(u => ({
            id: u.id,
            username: u.username,
            reportsCount: u.reports.length,
            banned: Boolean(u.banned)
        }));
    res.json({ reportedUsers });
});

app.post('/api/admin/reports/rename', authenticateToken, requireAdmin, async (req, res) => {
    const { userId } = req.body;
    const target = users.find(u => String(u.id) === String(userId));
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    target.username = "[contenido baneado]";
    await saveDataToGit();
    res.json({ success: true, message: "Nombre cambiado a [contenido baneado]." });
});

app.post('/api/admin/reports/ban', authenticateToken, requireAdmin, async (req, res) => {
    const { userId } = req.body;
    const target = users.find(u => String(u.id) === String(userId));
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    target.banned = true;
    await saveDataToGit();
    res.json({ success: true, message: "Usuario baneado." });
});

app.post('/api/admin/reports/clear', authenticateToken, requireAdmin, async (req, res) => {
    const { userId } = req.body;
    const target = users.find(u => String(u.id) === String(userId));
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    target.reports = [];
    await saveDataToGit();
    res.json({ success: true, message: "Denuncias borradas." });
});

app.post('/api/admin/settings/block-reward', authenticateToken, requireAdmin, async (req, res) => {
    const { itemId } = req.body;
    blockSubscriptionRewardItemId = itemId || null;
    await saveDataToGit();
    res.json({ success: true, blockSubscriptionRewardItemId });
});

app.post('/api/admin/codes/create', authenticateToken, requireAdmin, async (req, res) => {
    const { code, coins, dollars, maxUses, expiresInDays, rewardItemId } = req.body;
    if (!code) return res.status(400).json({ error: "Código requerido." });

    const expiresAt = expiresInDays ? Date.now() + (Number(expiresInDays) * 86400000) : null;

    const newCode = {
        id: Date.now().toString(),
        code: code.trim().toUpperCase(),
        coins: Number(coins) || 0,
        dollars: Number(dollars) || 0,
        maxUses: maxUses ? Number(maxUses) : null,
        currentUses: 0,
        expiresAt,
        rewardItemId: rewardItemId || null,
        usedBy: []
    };

    promoCodes.push(newCode);
    await saveDataToGit();
    res.json({ success: true, code: newCode });
});

app.post('/api/admin/tshirts/upload', authenticateToken, requireAdmin, async (req, res) => {
    const { name, limited, maxPerUser, maxGlobal, expiresInDays, offsale, onlyBlock, imageUrl, price } = req.body;
    if (!name || !imageUrl) return res.status(400).json({ error: "Nombre e imagen requeridos." });

    const expiresAt = expiresInDays ? Date.now() + (Number(expiresInDays) * 86400000) : null;

    const newTshirt = {
        id: Date.now().toString(),
        name: sanitizeText(name),
        imageUrl,
        price: Math.max(0, Number(price) || 0),
        type: "tshirt",
        createdByAdmin: true,
        creatorUsername: req.user.username,
        creatorId: req.user.id,
        onlyBlock: Boolean(onlyBlock),
        limited: Boolean(limited),
        maxPerUser: maxPerUser ? Number(maxPerUser) : 1,
        maxGlobal: maxGlobal ? Number(maxGlobal) : null,
        expiresAt,
        offsale: Boolean(offsale),
        totalSold: 0
    };

    accessories.push(newTshirt);
    await saveDataToGit();
    res.json({ success: true, tshirt: newTshirt });
});

app.post('/api/admin/accessories/edit', authenticateToken, requireAdmin, async (req, res) => {
    const { itemId, price, limited, offsale, isGhost, onlyBlock, bgColor, soundUrl } = req.body;
    const item = accessories.find(a => String(a.id) === String(itemId));
    if (!item) return res.status(404).json({ error: "Artículo no encontrado." });

    if (price !== undefined && price !== "") item.price = Number(price);
    if (limited === "true") item.limited = true;
    if (limited === "false") item.limited = false;
    if (offsale === "true") item.offsale = true;
    if (offsale === "false") item.offsale = false;
    if (isGhost === "true") item.isGhost = true;
    if (isGhost === "false") item.isGhost = false;
    if (onlyBlock === "true") item.onlyBlock = true;
    if (onlyBlock === "false") item.onlyBlock = false;
    if (bgColor) item.bgColor = bgColor;
    if (soundUrl) item.soundUrl = soundUrl;

    await saveDataToGit();
    res.json({ success: true, item });
});

app.post('/api/admin/accessories/upload', authenticateToken, requireAdmin, upload.single('glb'), async (req, res) => {
    const { name, limited, offsale, onlyBlock, maxPerUser, maxGlobal, expiresInDays, bgColor, soundUrl, price, imageUrl } = req.body;

    if (!req.file && !imageUrl) {
        return res.status(400).json({ error: "Archivo GLB o imagen requeridos." });
    }

    const glbUrl = req.file ? `/uploads/${req.file.filename}` : null;
    const expiresAt = expiresInDays ? Date.now() + (Number(expiresInDays) * 86400000) : null;

    const newAcc = {
        id: Date.now().toString(),
        name: sanitizeText(name || "Nuevo Accesorio"),
        glbUrl,
        imageUrl: imageUrl || "https://via.placeholder.com/80",
        price: Math.max(0, Number(price) || 0),
        type: "hat",
        createdByAdmin: true,
        creatorUsername: req.user.username,
        creatorId: req.user.id,
        onlyBlock: onlyBlock === "true" || onlyBlock === true,
        limited: limited === "true" || limited === true,
        maxPerUser: maxPerUser ? Number(maxPerUser) : 1,
        maxGlobal: maxGlobal ? Number(maxGlobal) : null,
        expiresAt,
        offsale: offsale === "true" || offsale === true,
        bgColor: bgColor || null,
        soundUrl: soundUrl || null,
        totalSold: 0
    };

    accessories.push(newAcc);
    await saveDataToGit();
    res.json({ success: true, accessory: newAcc });
});

app.post('/api/admin/coins/add', authenticateToken, requireAdmin, async (req, res) => {
    const { username, amount } = req.body;
    const target = users.find(u => u.username.toLowerCase() === (username || "").trim().toLowerCase());
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    target.coins = (target.coins || 0) + (Number(amount) || 0);
    await saveDataToGit();
    res.json({ success: true, coins: target.coins });
});

app.post('/api/admin/dollars/add', authenticateToken, requireAdmin, async (req, res) => {
    const { username, amount } = req.body;
    const target = users.find(u => u.username.toLowerCase() === (username || "").trim().toLowerCase());
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    target.dollars = (target.dollars || 0) + (Number(amount) || 0);
    await saveDataToGit();
    res.json({ success: true, dollars: target.dollars });
});

app.post('/api/admin/banner', authenticateToken, requireAdmin, async (req, res) => {
    bannerText = req.body.text || "";
    await saveDataToGit();
    res.json({ success: true, bannerText });
});

// INICIO DEL SERVIDOR
loadDataFromGit().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Servidor de Game Blocks ejecutándose en el puerto ${PORT}`);
    });
});const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken'); 
const bcrypt = require('bcryptjs');
const { Octokit } = require('@octokit/rest');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || "gameblocks_secret_key_change_in_production";

process.on('unhandledRejection', (reason) => {
    console.error("⚠️ Promesa rechazada sin manejar:", reason);
});
process.on('uncaughtException', (err) => {
    console.error("⚠️ Excepción no controlada:", err);
});

function wrapAsync(fn) {
    if (fn.length >= 3) return fn;
    return function (req, res, next) {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}
['get', 'post', 'put', 'delete', 'patch'].forEach((method) => {
    const original = app[method].bind(app);
    app[method] = (path, ...handlers) => original(path, ...handlers.map((h) => (typeof h === 'function' ? wrapAsync(h) : h)));
});

const octokit = process.env.GITHUB_TOKEN ? new Octokit({ auth: process.env.GITHUB_TOKEN }) : null;
const GIST_ID = process.env.GIST_ID; 
const LOCAL_DB_PATH = path.join(__dirname, 'database.json');

app.use(cors());

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use((req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    if (req.path.startsWith('/api/') || req.path === '/register' || req.path === '/login') return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return res.status(405).json({ error: `Método ${req.method} no permitido en ${req.path}.` });
    }
    next();
});

app.use(express.static(__dirname));
 
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

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
let promoCodes = [];     
let bannerText = "";     
let chatMessages = [];
let blockSubscriptionRewardItemId = null;

let currencyPackages = [
    { coins: 100, dollars: 1 },
    { coins: 500, dollars: 5 },
    { coins: 1000, dollars: 10 },
    { coins: 2500, dollars: 25 },
    { coins: 6000, dollars: 60 }
];

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

function hasActiveBlockSub(user) {
    if (!user || !user.blockSubExpiresAt) return false;
    return Date.now() < user.blockSubExpiresAt;
}

function loadLocalData() {
    if (fs.existsSync(LOCAL_DB_PATH)) {
        try {
            const content = fs.readFileSync(LOCAL_DB_PATH, 'utf8');
            const parsed = JSON.parse(content);
            users = (parsed.users || []).map(u => ({
                ...u,
                inventory: u.inventory || [],
                badges: u.badges || [],
                likes: u.likes || [],
                dislikes: u.dislikes || [],
                reports: u.reports || [],
                coins: typeof u.coins === 'number' ? u.coins : 100,
                dollars: typeof u.dollars === 'number' ? u.dollars : 0,
                blockSubExpiresAt: u.blockSubExpiresAt || null,
                lastDailyReward: u.lastDailyReward || 0
            }));
            friendships = parsed.friendships || [];
            friendRequests = parsed.friendRequests || [];
            accessories = (parsed.accessories || []).map(a => ({
                ...a,
                type: a.type || "hat",
                isGhost: Boolean(a.isGhost),
                onlyBlock: Boolean(a.onlyBlock)
            }));
            resaleListings = parsed.resaleListings || [];
            tradeOffers = parsed.tradeOffers || [];
            promoCodes = parsed.promoCodes || [];
            bannerText = parsed.bannerText || "";
            chatMessages = parsed.chatMessages || [];
            blockSubscriptionRewardItemId = parsed.blockSubscriptionRewardItemId || null;
            console.log("✅ Datos cargados localmente desde database.json");
        } catch (err) {
            console.error("⚠️ Error al leer database.json local:", err.message);
        }
    }
}

async function loadDataFromGit() {
    if (!octokit || !GIST_ID) {
        console.log("⚠️ GITHUB_TOKEN o GIST_ID no configurados. Usando almacenamiento en archivo local.");
        loadLocalData();
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
                likes: u.likes || [],
                dislikes: u.dislikes || [],
                reports: u.reports || [],
                coins: typeof u.coins === 'number' ? u.coins : 100,
                dollars: typeof u.dollars === 'number' ? u.dollars : 0,
                blockSubExpiresAt: u.blockSubExpiresAt || null,
                equippedAccessory: u.equippedAccessory || null,
                profileBgColor: u.profileBgColor || null,
                profileSoundUrl: u.profileSoundUrl || null,
                banned: u.banned || false,
                lastDailyReward: u.lastDailyReward || 0
            }));
            friendships = parsed.friendships || [];
            friendRequests = parsed.friendRequests || [];
            accessories = (parsed.accessories || []).map(a => ({
                ...a,
                type: a.type || "hat",
                isGhost: Boolean(a.isGhost),
                onlyBlock: Boolean(a.onlyBlock)
            }));
            resaleListings = parsed.resaleListings || [];
            tradeOffers = parsed.tradeOffers || [];
            promoCodes = parsed.promoCodes || [];
            bannerText = parsed.bannerText || "";
            chatMessages = parsed.chatMessages || [];
            blockSubscriptionRewardItemId = parsed.blockSubscriptionRewardItemId || null;
            console.log("✅ Datos cargados correctamente desde el Gist privado.");
        } else {
            loadLocalData();
        }
    } catch (err) {
        console.log("⚠️ Error al cargar desde Gist, usando copia local:", err.message);
        loadLocalData();
    }
}

async function saveDataToGit() {
    const dataObj = {
        users,
        friendships,
        friendRequests,
        accessories,
        resaleListings,
        tradeOffers,
        promoCodes,
        bannerText,
        chatMessages,
        blockSubscriptionRewardItemId
    };
    const dataToSave = JSON.stringify(dataObj, null, 2);

    try {
        fs.writeFileSync(LOCAL_DB_PATH, dataToSave, 'utf8');
    } catch (e) {
        console.error("❌ Error al guardar copia local:", e.message);
    }

    if (!octokit || !GIST_ID) return;
    try {
        await octokit.gists.update({
            gist_id: GIST_ID,
            files: { "database.json": { content: dataToSave } }
        });
        console.log("✅ Cambios sincronizados con Gist.");
    } catch (err) {
        console.error("❌ Error al guardar en Gist:", err.message);
    }
}

setInterval(async () => {
    await saveDataToGit();
}, 20000);

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
        if (!foundUser.likes) foundUser.likes = [];
        if (!foundUser.dislikes) foundUser.dislikes = [];
        if (!foundUser.reports) foundUser.reports = [];

        req.user = foundUser;
        next();
    });
}

function requireAdmin(req, res, next) {
    if (!req.user) return res.status(403).json({ error: "Acceso denegado." });
    
    const hasAdminBadge = req.user.badges && req.user.badges.some(b => {
        const name = typeof b === 'object' ? b.name : b;
        return name === "🛡️admin" || name === "🛡️ admin" || name === "🛠️ Admin";
    });

    if (!req.user.admin && !req.user.owner && !hasAdminBadge) {
        return res.status(403).json({ error: "Requiere permisos de administrador, Owner o la insignia 🛡️admin." });
    }
    next();
}

app.get('/api/ping', (req, res) => {
    res.json({ message: "hola" });
});

const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || `http://localhost:${PORT}`;

setInterval(() => {
    try {
        if (typeof fetch !== 'function') return;
        fetch(`${SELF_URL}/api/ping`).then(r => r.json()).catch(() => {});
    } catch (err) {
        console.error("⚠️ Error en auto-ping:", err.message);
    }
}, 40000);

// AUTENTICACIÓN Y PERFIL
app.post(['/api/register', '/register'], async (req, res) => {
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
        badges: isOwner ? ["🛠️ Admin", "🎮 Owner", "🛡️admin"] : [],
        coins: 0,
        dollars: 0,
        inventory: [],
        likes: [],
        dislikes: [],
        reports: [],
        blockSubExpiresAt: null,
        equippedAccessory: null,
        profileBgColor: null,
        profileSoundUrl: null,
        admin: isOwner,
        owner: isOwner,
        banned: false,
        lastDailyReward: Date.now()
    };

    users.push(newUser);
    await saveDataToGit();

    const token = jwt.sign({ id: newUser.id, username: newUser.username }, JWT_SECRET);
    res.json({ success: true, token });
});

app.post(['/api/login', '/login'], async (req, res) => {
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

app.get('/api/me', authenticateToken, async (req, res) => {
    if (req.user.banned) {
        return res.status(403).json({ banned: true, error: "Has sido baneado de Game Blocks." });
    }

    const NOW = Date.now();
    const DAY_MS = 86400000;
    let dailyClaimed = false;
    const isBlockSub = hasActiveBlockSub(req.user);
    const dailyAmount = isBlockSub ? 34 : 10;

    if (!req.user.lastDailyReward || (NOW - req.user.lastDailyReward) >= DAY_MS) {
        req.user.coins = (req.user.coins || 0) + dailyAmount;
        req.user.lastDailyReward = NOW;
        dailyClaimed = true;
        await saveDataToGit();
    }

    const { password, ...safeUserData } = req.user;
    res.json({ 
        ...safeUserData, 
        dailyClaimed, 
        dailyAmount,
        hasBlockSub: isBlockSub 
    });
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

// LIKES, DISLIKES Y REPORTES
app.post('/api/users/:id/like', authenticateToken, async (req, res) => {
    const target = users.find(u => String(u.id) === String(req.params.id));
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    if (!target.likes) target.likes = [];
    if (!target.dislikes) target.dislikes = [];

    const myId = req.user.id;
    target.dislikes = target.dislikes.filter(id => String(id) !== String(myId));

    const idx = target.likes.findIndex(id => String(id) === String(myId));
    if (idx !== -1) {
        target.likes.splice(idx, 1);
    } else {
        target.likes.push(myId);
    }

    await saveDataToGit();
    res.json({ success: true, likes: target.likes.length, dislikes: target.dislikes.length });
});

app.post('/api/users/:id/dislike', authenticateToken, async (req, res) => {
    const target = users.find(u => String(u.id) === String(req.params.id));
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    if (!target.likes) target.likes = [];
    if (!target.dislikes) target.dislikes = [];

    const myId = req.user.id;
    target.likes = target.likes.filter(id => String(id) !== String(myId));

    const idx = target.dislikes.findIndex(id => String(id) === String(myId));
    if (idx !== -1) {
        target.dislikes.splice(idx, 1);
    } else {
        target.dislikes.push(myId);
    }

    await saveDataToGit();
    res.json({ success: true, likes: target.likes.length, dislikes: target.dislikes.length });
});

app.post('/api/users/:id/report', authenticateToken, async (req, res) => {
    const target = users.find(u => String(u.id) === String(req.params.id));
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });
    if (String(target.id) === String(req.user.id)) return res.status(400).json({ error: "No puedes denunciarte a ti mismo." });

    if (!target.reports) target.reports = [];
    if (target.reports.includes(req.user.id)) {
        return res.status(400).json({ error: "Ya has denunciado a este usuario." });
    }

    target.reports.push(req.user.id);
    await saveDataToGit();
    res.json({ success: true, message: "Denuncia enviada.", totalReports: target.reports.length });
});

// SUSCRIPCIÓN BLOCK
app.post('/api/subscription/buy-block', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });

    const currentDollars = req.user.dollars || 0;
    if (currentDollars < 5) {
        return res.status(400).json({ error: "Necesitas al menos 5 💲 para la Suscripción Block." });
    }

    req.user.dollars = currentDollars - 5;
    const monthMs = 30 * 86400000;
    const currentSubEnd = (req.user.blockSubExpiresAt && req.user.blockSubExpiresAt > Date.now()) 
        ? req.user.blockSubExpiresAt 
        : Date.now();

    req.user.blockSubExpiresAt = currentSubEnd + monthMs;

    let freeItemGiven = null;
    if (blockSubscriptionRewardItemId) {
        const rewardItem = accessories.find(a => String(a.id) === String(blockSubscriptionRewardItemId));
        if (rewardItem) {
            req.user.inventory.push(rewardItem.id);
            freeItemGiven = rewardItem.name;
        }
    }

    await saveDataToGit();
    res.json({
        success: true,
        message: "¡Te has suscrito a Block con éxito!",
        dollars: req.user.dollars,
        blockSubExpiresAt: req.user.blockSubExpiresAt,
        freeItemGiven
    });
});

// CHAT CON AMIGOS
app.get('/api/chat/:friendId', authenticateToken, (req, res) => {
    const friendId = String(req.params.friendId);
    const myId = String(req.user.id);

    const isFriend = friendships.some(f => 
        (String(f.user1) === myId && String(f.user2) === friendId) ||
        (String(f.user2) === myId && String(f.user1) === friendId)
    );

    if (!isFriend) return res.status(403).json({ error: "Solo puedes chatear con amigos." });

    const msgs = chatMessages.filter(m => 
        (String(m.senderId) === myId && String(m.receiverId) === friendId) ||
        (String(m.senderId) === friendId && String(m.receiverId) === myId)
    );

    res.json({ messages: msgs });
});

app.post('/api/chat/send', authenticateToken, async (req, res) => {
    const { friendId, text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: "Mensaje vacío." });

    const myId = String(req.user.id);
    const targetId = String(friendId);

    const isFriend = friendships.some(f => 
        (String(f.user1) === myId && String(f.user2) === targetId) ||
        (String(f.user2) === myId && String(f.user1) === targetId)
    );

    if (!isFriend) return res.status(403).json({ error: "Solo puedes enviar mensajes a amigos." });

    const containsEmoji = /(\p{Extended_Pictographic}|\p{Emoji_Presentation})/u.test(text);
    if (containsEmoji && !hasActiveBlockSub(req.user)) {
        return res.status(403).json({ 
            error: "🔒 Emojis bloqueados. Requiere la Suscripción Block (5 💲/mes) para usarlos o pegarlos." 
        });
    }

    const newMessage = {
        id: Date.now().toString(),
        senderId: req.user.id,
        senderUsername: req.user.username,
        receiverId: targetId,
        text: sanitizeText(text.trim()),
        timestamp: Date.now()
    };

    chatMessages.push(newMessage);
    await saveDataToGit();
    res.json({ success: true, message: newMessage });
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

app.get('/api/users/profile/:id', (req, res) => {
    const target = users.find(u => String(u.id) === String(req.params.id));
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    const userInventory = (target.inventory || []).map(itemId => {
        const item = accessories.find(a => String(a.id) === String(itemId));
        return item ? { id: item.id, name: item.name, imageUrl: item.imageUrl, type: item.type } : { id: itemId, name: "Objeto #" + itemId, imageUrl: "https://via.placeholder.com/80" };
    });

    res.json({
        id: target.id,
        username: target.username,
        avatar: target.avatar,
        bio: target.bio,
        badges: target.badges || [],
        inventory: userInventory,
        profileBgColor: target.profileBgColor || null,
        profileSoundUrl: target.profileSoundUrl || null,
        likesCount: (target.likes || []).length,
        dislikesCount: (target.dislikes || []).length,
        reportsCount: (target.reports || []).length,
        isAlert: (target.reports || []).length >= 5
    });
});

// CANJEAR CÓDIGOS
app.post('/api/codes/redeem', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "Ingresa un código." });

    const cleanCode = code.trim().toUpperCase();
    const promo = promoCodes.find(c => c.code.toUpperCase() === cleanCode);

    if (!promo) return res.status(404).json({ error: "Código inválido o inexistente." });

    if (promo.expiresAt && Date.now() > promo.expiresAt) {
        return res.status(400).json({ error: "El código ha expirado." });
    }

    if (promo.maxUses !== null && promo.currentUses >= promo.maxUses) {
        return res.status(400).json({ error: "El código ha alcanzado el límite máximo de usos." });
    }

    if (!promo.usedBy) promo.usedBy = [];
    if (promo.usedBy.includes(req.user.id)) {
        return res.status(400).json({ error: "Ya has canjeado este código anteriormente." });
    }

    promo.usedBy.push(req.user.id);
    promo.currentUses = (promo.currentUses || 0) + 1;

    if (promo.coins) req.user.coins = (req.user.coins || 0) + Number(promo.coins);
    if (promo.dollars) req.user.dollars = (req.user.dollars || 0) + Number(promo.dollars);
    if (promo.rewardItemId) {
        if (!req.user.inventory.includes(promo.rewardItemId)) {
            req.user.inventory.push(promo.rewardItemId);
        }
    }

    await saveDataToGit();
    res.json({ success: true, message: `¡Código canjeado con éxito! Monedas: +${promo.coins || 0}, Dollars: +${promo.dollars || 0}` });
});

// ELIMINAR CUENTA BANEADA
app.post('/api/account/delete-banned', authenticateToken, async (req, res) => {
    if (!req.user.banned) return res.status(400).json({ error: "Tu cuenta no está baneada." });
    users = users.filter(u => String(u.id) !== String(req.user.id));
    await saveDataToGit();
    res.json({ success: true, message: "Cuenta eliminada correctamente." });
});

// PAQUETES Y COMPRA DE MONEDAS
app.get('/api/coins/packages', (req, res) => {
    res.json({ packages: currencyPackages });
});

app.post('/api/coins/purchase', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { coins } = req.body;
    const pkg = currencyPackages.find(p => p.coins === Number(coins));
    if (!pkg) return res.status(400).json({ error: "Paquete de monedas no válido." });

    if ((req.user.dollars || 0) < pkg.dollars) {
        return res.status(400).json({ error: "No tienes suficientes 💲 para comprar este paquete." });
    }

    req.user.dollars -= pkg.dollars;
    req.user.coins = (req.user.coins || 0) + pkg.coins;
    await saveDataToGit();
    res.json({ success: true, coins: req.user.coins, dollars: req.user.dollars });
});

// SUBIR CAMISETAS (UGC Y ADMIN)
app.post('/api/tshirts/upload', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { name, imageUrl, price, onlyBlock } = req.body;
    if (!name || !imageUrl) return res.status(400).json({ error: "Nombre e imagen requeridos." });

    const cost = Math.max(1, Number(price) || 1);
    const newTshirt = {
        id: Date.now().toString(),
        name: sanitizeText(name),
        imageUrl,
        price: cost,
        type: "tshirt",
        createdByAdmin: false,
        creatorUsername: req.user.username,
        creatorId: req.user.id,
        onlyBlock: Boolean(onlyBlock),
        limited: false,
        offsale: false,
        totalSold: 0
    };

    accessories.push(newTshirt);
    await saveDataToGit();
    res.json({ success: true, tshirt: newTshirt });
});

// CÓDIGO DE JUEGO
app.post('/api/game/create-code', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    gameCodes[code] = { userId: req.user.id, username: req.user.username, createdAt: Date.now() };
    res.json({ success: true, code });
});

// ACCESORIOS Y TIENDA
app.get('/api/accessories', (req, res) => {
    const publicItems = accessories.filter(a => !a.isGhost);
    res.json({ items: publicItems });
});

app.get('/api/accessories/all', (req, res) => {
    res.json({ items: accessories });
});

app.post('/api/accessories/buy', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { itemId } = req.body;
    const item = accessories.find(a => String(a.id) === String(itemId));
    if (!item) return res.status(404).json({ error: "Artículo no encontrado." });
    if (item.offsale) return res.status(400).json({ error: "Este artículo está fuera de venta (Offsale)." });

    if (item.onlyBlock && !hasActiveBlockSub(req.user)) {
        return res.status(403).json({ error: "Este artículo requiere Suscripción Block activa." });
    }

    if ((req.user.coins || 0) < item.price) {
        return res.status(400).json({ error: "No tienes suficientes monedas." });
    }

    if (item.limited) {
        const userCopies = req.user.inventory.filter(id => String(id) === String(item.id)).length;
        if (item.maxPerUser && userCopies >= item.maxPerUser) {
            return res.status(400).json({ error: `Has alcanzado el límite máximo de ${item.maxPerUser} copia(s) por usuario para este Limited.` });
        }
        if (item.maxGlobal && (item.totalSold || 0) >= item.maxGlobal) {
            return res.status(400).json({ error: "Agotado: se ha alcanzado el stock global total." });
        }
        if (item.expiresAt && Date.now() > item.expiresAt) {
            return res.status(400).json({ error: "Este artículo Limited ha expirado." });
        }
    }

    req.user.coins -= item.price;
    req.user.inventory.push(item.id);
    item.totalSold = (item.totalSold || 0) + 1;

    await saveDataToGit();
    res.json({ success: true, newBalance: req.user.coins, inventory: req.user.inventory });
});

app.post('/api/accessories/equip', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { itemId } = req.body;
    if (!req.user.inventory.some(id => String(id) === String(itemId))) {
        return res.status(400).json({ error: "No posees este artículo en tu inventario." });
    }

    const item = accessories.find(a => String(a.id) === String(itemId));
    req.user.equippedAccessory = itemId;

    if (item) {
        if (item.bgColor) req.user.profileBgColor = item.bgColor;
        if (item.soundUrl) req.user.profileSoundUrl = item.soundUrl;
    }

    await saveDataToGit();
    res.json({
        success: true,
        equippedAccessory: itemId,
        profileBgColor: req.user.profileBgColor,
        profileSoundUrl: req.user.profileSoundUrl
    });
});

app.post('/api/accessories/unequip', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    req.user.equippedAccessory = null;
    req.user.profileBgColor = null;
    req.user.profileSoundUrl = null;
    await saveDataToGit();
    res.json({ success: true });
});

app.post('/api/accessories/sell', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { itemId } = req.body;
    const idx = req.user.inventory.findIndex(id => String(id) === String(itemId));
    if (idx === -1) return res.status(400).json({ error: "No posees este artículo." });

    const item = accessories.find(a => String(a.id) === String(itemId));
    const originalPrice = item ? item.price : 0;
    const refundAmount = Math.floor(originalPrice * 0.5);

    req.user.inventory.splice(idx, 1);
    req.user.coins = (req.user.coins || 0) + refundAmount;

    if (String(req.user.equippedAccessory) === String(itemId)) {
        req.user.equippedAccessory = null;
        req.user.profileBgColor = null;
        req.user.profileSoundUrl = null;
    }

    await saveDataToGit();
    res.json({ success: true, refundAmount, coins: req.user.coins });
});

app.post('/api/accessories/resell-list', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { itemId, price } = req.body;
    const item = accessories.find(a => String(a.id) === String(itemId));
    if (!item) return res.status(404).json({ error: "Artículo no encontrado." });
    if (!item.limited || !item.offsale) {
        return res.status(400).json({ error: "Solo puedes revender artículos marcados como Limited y Offsale." });
    }

    const idx = req.user.inventory.findIndex(id => String(id) === String(itemId));
    if (idx === -1) return res.status(400).json({ error: "No posees este artículo." });

    const listingPrice = Math.max(1, Number(price) || 1);
    req.user.inventory.splice(idx, 1);

    const newListing = {
        id: Date.now().toString(),
        sellerId: req.user.id,
        sellerUsername: req.user.username,
        itemId: item.id,
        price: listingPrice,
        createdAt: Date.now()
    };

    resaleListings.push(newListing);
    await saveDataToGit();
    res.json({ success: true, listing: newListing });
});

app.get('/api/accessories/resale-market', (req, res) => {
    const list = resaleListings.map(l => {
        const item = accessories.find(a => String(a.id) === String(l.itemId));
        return { ...l, item };
    });
    res.json({ listings: list });
});

app.post('/api/accessories/resell-buy', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { listingId } = req.body;
    const idx = resaleListings.findIndex(l => String(l.id) === String(listingId));
    if (idx === -1) return res.status(404).json({ error: "Oferta de reventa no encontrada." });

    const listing = resaleListings[idx];
    if (String(listing.sellerId) === String(req.user.id)) {
        return res.status(400).json({ error: "No puedes comprar tu propia oferta de reventa." });
    }

    if ((req.user.coins || 0) < listing.price) {
        return res.status(400).json({ error: "No tienes suficientes monedas." });
    }

    const seller = users.find(u => String(u.id) === String(listing.sellerId));

    req.user.coins -= listing.price;
    req.user.inventory.push(listing.itemId);

    if (seller) {
        seller.coins = (seller.coins || 0) + listing.price;
    }

    resaleListings.splice(idx, 1);
    await saveDataToGit();
    res.json({ success: true, message: "¡Compra de reventa realizada con éxito!" });
});

// BANNER
app.get('/api/banner', (req, res) => {
    res.json({ text: bannerText });
});

// AMIGOS Y SOLICITUDES
app.get('/api/friends/requests', authenticateToken, (req, res) => {
    const myId = String(req.user.id);
    const reqs = friendRequests
        .filter(r => String(r.targetId) === myId)
        .map(r => {
            const sender = users.find(u => String(u.id) === String(r.senderId));
            return { id: r.id, senderId: r.senderId, username: sender ? sender.username : "Usuario" };
        });
    res.json({ requests: reqs });
});

app.get('/api/friends', authenticateToken, (req, res) => {
    const myId = String(req.user.id);
    const list = friendships
        .filter(f => String(f.user1) === myId || String(f.user2) === myId)
        .map(f => {
            const friendId = String(f.user1) === myId ? f.user2 : f.user1;
            const friend = users.find(u => String(u.id) === String(friendId));
            return friend ? { id: friend.id, username: friend.username, avatar: friend.avatar } : null;
        })
        .filter(Boolean);
    res.json({ friends: list });
});

app.post('/api/friends/request', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { userId } = req.body;
    const targetId = String(userId);
    const myId = String(req.user.id);

    if (targetId === myId) return res.status(400).json({ error: "No puedes agregarte a ti mismo." });

    const alreadyFriends = friendships.some(f => 
        (String(f.user1) === myId && String(f.user2) === targetId) ||
        (String(f.user2) === myId && String(f.user1) === targetId)
    );
    if (alreadyFriends) return res.status(400).json({ error: "Ya son amigos." });

    const existingReq = friendRequests.some(r => String(r.senderId) === myId && String(r.targetId) === targetId);
    if (existingReq) return res.status(400).json({ error: "Ya has enviado una solicitud a este usuario." });

    friendRequests.push({
        id: Date.now().toString(),
        senderId: req.user.id,
        targetId
    });

    await saveDataToGit();
    res.json({ success: true, message: "Solicitud de amistad enviada." });
});

app.post('/api/friends/accept', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { requestId } = req.body;
    const idx = friendRequests.findIndex(r => String(r.id) === String(requestId));
    if (idx === -1) return res.status(404).json({ error: "Solicitud no encontrada." });

    const r = friendRequests[idx];
    if (String(r.targetId) !== String(req.user.id)) {
        return res.status(403).json({ error: "No puedes aceptar esta solicitud." });
    }

    friendships.push({
        id: Date.now().toString(),
        user1: r.senderId,
        user2: r.targetId
    });

    friendRequests.splice(idx, 1);
    await saveDataToGit();
    res.json({ success: true, message: "Solicitud de amistad aceptada." });
});

// INTERCAMBIOS (TRADES)
app.post('/api/trade/offer', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { targetUserId, offeredItemId, offeredCoins, requestedItemId, requestedCoins } = req.body;

    const targetId = String(targetUserId);
    if (targetId === String(req.user.id)) return res.status(400).json({ error: "No puedes intercambiar contigo mismo." });

    const targetUser = users.find(u => String(u.id) === targetId);
    if (!targetUser) return res.status(404).json({ error: "Usuario destinatario no encontrado." });

    const coinsOffered = Math.max(0, Number(offeredCoins) || 0);
    const coinsRequested = Math.max(0, Number(requestedCoins) || 0);

    if (coinsOffered > (req.user.coins || 0)) {
        return res.status(400).json({ error: "No tienes suficientes monedas para ofrecer." });
    }

    if (offeredItemId && !req.user.inventory.some(id => String(id) === String(offeredItemId))) {
        return res.status(400).json({ error: "No posees el artículo ofrecido." });
    }

    if (requestedItemId && !targetUser.inventory.some(id => String(id) === String(requestedItemId))) {
        return res.status(400).json({ error: "El destinatario no posee el artículo solicitado." });
    }

    const trade = {
        id: Date.now().toString(),
        senderId: req.user.id,
        senderUsername: req.user.username,
        targetId,
        offeredItemId: offeredItemId || null,
        offeredCoins: coinsOffered,
        requestedItemId: requestedItemId || null,
        requestedCoins: coinsRequested,
        status: "pending"
    };

    tradeOffers.push(trade);
    await saveDataToGit();
    res.json({ success: true, message: "Oferta de intercambio enviada con éxito." });
});

app.get('/api/trade/pending', authenticateToken, (req, res) => {
    const myId = String(req.user.id);
    const pending = tradeOffers
        .filter(t => String(t.targetId) === myId && t.status === "pending")
        .map(t => {
            const offered = accessories.find(a => String(a.id) === String(t.offeredItemId));
            const requested = accessories.find(a => String(a.id) === String(t.requestedItemId));
            return {
                ...t,
                offeredItemName: offered ? offered.name : "Ninguno",
                requestedItemName: requested ? requested.name : "Ninguno"
            };
        });
    res.json({ trades: pending });
});

app.post('/api/trade/accept', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { tradeId } = req.body;
    const idx = tradeOffers.findIndex(t => String(t.id) === String(tradeId));
    if (idx === -1) return res.status(404).json({ error: "Intercambio no encontrado." });

    const trade = tradeOffers[idx];
    if (String(trade.targetId) !== String(req.user.id)) {
        return res.status(403).json({ error: "No puedes aceptar este intercambio." });
    }

    const sender = users.find(u => String(u.id) === String(trade.senderId));
    if (!sender) return res.status(404).json({ error: "El remitente del intercambio ya no existe." });

    if (trade.offeredCoins > (sender.coins || 0)) {
        return res.status(400).json({ error: "El remitente ya no tiene las monedas ofrecidas." });
    }
    if (trade.requestedCoins > (req.user.coins || 0)) {
        return res.status(400).json({ error: "No tienes suficientes monedas para completar el trato." });
    }

    if (trade.offeredItemId) {
        const offerIdx = sender.inventory.findIndex(id => String(id) === String(trade.offeredItemId));
        if (offerIdx === -1) return res.status(400).json({ error: "El remitente ya no posee el artículo ofrecido." });
        sender.inventory.splice(offerIdx, 1);
        req.user.inventory.push(trade.offeredItemId);
    }

    if (trade.requestedItemId) {
        const reqIdx = req.user.inventory.findIndex(id => String(id) === String(trade.requestedItemId));
        if (reqIdx === -1) return res.status(400).json({ error: "Ya no posees el artículo solicitado." });
        req.user.inventory.splice(reqIdx, 1);
        sender.inventory.push(trade.requestedItemId);
    }

    sender.coins = (sender.coins || 0) - trade.offeredCoins + trade.requestedCoins;
    req.user.coins = (req.user.coins || 0) - trade.requestedCoins + trade.offeredCoins;

    trade.status = "accepted";
    tradeOffers.splice(idx, 1);

    await saveDataToGit();
    res.json({ success: true, message: "¡Intercambio realizado con éxito!" });
});

// RUTAS DE ADMINISTRACIÓN
app.get('/api/admin/reports', authenticateToken, requireAdmin, (req, res) => {
    const reportedUsers = users
        .filter(u => (u.reports || []).length >= 10)
        .map(u => ({
            id: u.id,
            username: u.username,
            reportsCount: u.reports.length,
            banned: Boolean(u.banned)
        }));
    res.json({ reportedUsers });
});

app.post('/api/admin/reports/rename', authenticateToken, requireAdmin, async (req, res) => {
    const { userId } = req.body;
    const target = users.find(u => String(u.id) === String(userId));
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    target.username = "[contenido baneado]";
    await saveDataToGit();
    res.json({ success: true, message: "Nombre cambiado a [contenido baneado]." });
});

app.post('/api/admin/reports/ban', authenticateToken, requireAdmin, async (req, res) => {
    const { userId } = req.body;
    const target = users.find(u => String(u.id) === String(userId));
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    target.banned = true;
    await saveDataToGit();
    res.json({ success: true, message: "Usuario baneado." });
});

app.post('/api/admin/reports/clear', authenticateToken, requireAdmin, async (req, res) => {
    const { userId } = req.body;
    const target = users.find(u => String(u.id) === String(userId));
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    target.reports = [];
    await saveDataToGit();
    res.json({ success: true, message: "Denuncias borradas." });
});

app.post('/api/admin/settings/block-reward', authenticateToken, requireAdmin, async (req, res) => {
    const { itemId } = req.body;
    blockSubscriptionRewardItemId = itemId || null;
    await saveDataToGit();
    res.json({ success: true, blockSubscriptionRewardItemId });
});

app.post('/api/admin/codes/create', authenticateToken, requireAdmin, async (req, res) => {
    const { code, coins, dollars, maxUses, expiresInDays, rewardItemId } = req.body;
    if (!code) return res.status(400).json({ error: "Código requerido." });

    const expiresAt = expiresInDays ? Date.now() + (Number(expiresInDays) * 86400000) : null;

    const newCode = {
        id: Date.now().toString(),
        code: code.trim().toUpperCase(),
        coins: Number(coins) || 0,
        dollars: Number(dollars) || 0,
        maxUses: maxUses ? Number(maxUses) : null,
        currentUses: 0,
        expiresAt,
        rewardItemId: rewardItemId || null,
        usedBy: []
    };

    promoCodes.push(newCode);
    await saveDataToGit();
    res.json({ success: true, code: newCode });
});

app.post('/api/admin/tshirts/upload', authenticateToken, requireAdmin, async (req, res) => {
    const { name, limited, maxPerUser, maxGlobal, expiresInDays, offsale, onlyBlock, imageUrl, price } = req.body;
    if (!name || !imageUrl) return res.status(400).json({ error: "Nombre e imagen requeridos." });

    const expiresAt = expiresInDays ? Date.now() + (Number(expiresInDays) * 86400000) : null;

    const newTshirt = {
        id: Date.now().toString(),
        name: sanitizeText(name),
        imageUrl,
        price: Math.max(0, Number(price) || 0),
        type: "tshirt",
        createdByAdmin: true,
        creatorUsername: req.user.username,
        creatorId: req.user.id,
        onlyBlock: Boolean(onlyBlock),
        limited: Boolean(limited),
        maxPerUser: maxPerUser ? Number(maxPerUser) : 1,
        maxGlobal: maxGlobal ? Number(maxGlobal) : null,
        expiresAt,
        offsale: Boolean(offsale),
        totalSold: 0
    };

    accessories.push(newTshirt);
    await saveDataToGit();
    res.json({ success: true, tshirt: newTshirt });
});

app.post('/api/admin/accessories/edit', authenticateToken, requireAdmin, async (req, res) => {
    const { itemId, price, limited, offsale, isGhost, onlyBlock, bgColor, soundUrl } = req.body;
    const item = accessories.find(a => String(a.id) === String(itemId));
    if (!item) return res.status(404).json({ error: "Artículo no encontrado." });

    if (price !== undefined && price !== "") item.price = Number(price);
    if (limited === "true") item.limited = true;
    if (limited === "false") item.limited = false;
    if (offsale === "true") item.offsale = true;
    if (offsale === "false") item.offsale = false;
    if (isGhost === "true") item.isGhost = true;
    if (isGhost === "false") item.isGhost = false;
    if (onlyBlock === "true") item.onlyBlock = true;
    if (onlyBlock === "false") item.onlyBlock = false;
    if (bgColor) item.bgColor = bgColor;
    if (soundUrl) item.soundUrl = soundUrl;

    await saveDataToGit();
    res.json({ success: true, item });
});

app.post('/api/admin/accessories/upload', authenticateToken, requireAdmin, upload.single('glb'), async (req, res) => {
    const { name, limited, offsale, onlyBlock, maxPerUser, maxGlobal, expiresInDays, bgColor, soundUrl, price, imageUrl } = req.body;

    if (!req.file && !imageUrl) {
        return res.status(400).json({ error: "Archivo GLB o imagen requeridos." });
    }

    const glbUrl = req.file ? `/uploads/${req.file.filename}` : null;
    const expiresAt = expiresInDays ? Date.now() + (Number(expiresInDays) * 86400000) : null;

    const newAcc = {
        id: Date.now().toString(),
        name: sanitizeText(name || "Nuevo Accesorio"),
        glbUrl,
        imageUrl: imageUrl || "https://via.placeholder.com/80",
        price: Math.max(0, Number(price) || 0),
        type: "hat",
        createdByAdmin: true,
        creatorUsername: req.user.username,
        creatorId: req.user.id,
        onlyBlock: onlyBlock === "true" || onlyBlock === true,
        limited: limited === "true" || limited === true,
        maxPerUser: maxPerUser ? Number(maxPerUser) : 1,
        maxGlobal: maxGlobal ? Number(maxGlobal) : null,
        expiresAt,
        offsale: offsale === "true" || offsale === true,
        bgColor: bgColor || null,
        soundUrl: soundUrl || null,
        totalSold: 0
    };

    accessories.push(newAcc);
    await saveDataToGit();
    res.json({ success: true, accessory: newAcc });
});

app.post('/api/admin/coins/add', authenticateToken, requireAdmin, async (req, res) => {
    const { username, amount } = req.body;
    const target = users.find(u => u.username.toLowerCase() === (username || "").trim().toLowerCase());
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    target.coins = (target.coins || 0) + (Number(amount) || 0);
    await saveDataToGit();
    res.json({ success: true, coins: target.coins });
});

app.post('/api/admin/dollars/add', authenticateToken, requireAdmin, async (req, res) => {
    const { username, amount } = req.body;
    const target = users.find(u => u.username.toLowerCase() === (username || "").trim().toLowerCase());
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    target.dollars = (target.dollars || 0) + (Number(amount) || 0);
    await saveDataToGit();
    res.json({ success: true, dollars: target.dollars });
});

app.post('/api/admin/banner', authenticateToken, requireAdmin, async (req, res) => {
    bannerText = req.body.text || "";
    await saveDataToGit();
    res.json({ success: true, bannerText });
});

// INICIO DEL SERVIDOR
loadDataFromGit().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Servidor de Game Blocks ejecutándose en el puerto ${PORT}`);
    });
});const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken'); 
const bcrypt = require('bcryptjs');
const { Octokit } = require('@octokit/rest');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || "gameblocks_secret_key_change_in_production";

process.on('unhandledRejection', (reason) => {
    console.error("⚠️ Promesa rechazada sin manejar:", reason);
});
process.on('uncaughtException', (err) => {
    console.error("⚠️ Excepción no controlada:", err);
});

function wrapAsync(fn) {
    if (fn.length >= 3) return fn;
    return function (req, res, next) {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}
['get', 'post', 'put', 'delete', 'patch'].forEach((method) => {
    const original = app[method].bind(app);
    app[method] = (path, ...handlers) => original(path, ...handlers.map((h) => (typeof h === 'function' ? wrapAsync(h) : h)));
});

const octokit = process.env.GITHUB_TOKEN ? new Octokit({ auth: process.env.GITHUB_TOKEN }) : null;
const GIST_ID = process.env.GIST_ID; 
const LOCAL_DB_PATH = path.join(__dirname, 'database.json');

app.use(cors());

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use((req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    if (req.path.startsWith('/api/') || req.path === '/register' || req.path === '/login') return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return res.status(405).json({ error: `Método ${req.method} no permitido en ${req.path}.` });
    }
    next();
});

// --- ENGANCHE A INDEX Y ARCHIVOS ESTÁTICOS ---
app.use(express.static(__dirname));
 
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

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
let promoCodes = [];     
let bannerText = "";     
let chatMessages = [];
let blockSubscriptionRewardItemId = null;

let currencyPackages = [
    { coins: 100, dollars: 1 },
    { coins: 500, dollars: 5 },
    { coins: 1000, dollars: 10 },
    { coins: 2500, dollars: 25 },
    { coins: 6000, dollars: 60 }
];

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

function hasActiveBlockSub(user) {
    if (!user || !user.blockSubExpiresAt) return false;
    return Date.now() < user.blockSubExpiresAt;
}

function loadLocalData() {
    if (fs.existsSync(LOCAL_DB_PATH)) {
        try {
            const content = fs.readFileSync(LOCAL_DB_PATH, 'utf8');
            const parsed = JSON.parse(content);
            users = (parsed.users || []).map(u => ({
                ...u,
                inventory: u.inventory || [],
                badges: u.badges || [],
                likes: u.likes || [],
                dislikes: u.dislikes || [],
                reports: u.reports || [],
                coins: typeof u.coins === 'number' ? u.coins : 100,
                dollars: typeof u.dollars === 'number' ? u.dollars : 0,
                blockSubExpiresAt: u.blockSubExpiresAt || null,
                lastDailyReward: u.lastDailyReward || 0
            }));
            friendships = parsed.friendships || [];
            friendRequests = parsed.friendRequests || [];
            accessories = (parsed.accessories || []).map(a => ({
                ...a,
                type: a.type || "hat",
                isGhost: Boolean(a.isGhost),
                onlyBlock: Boolean(a.onlyBlock)
            }));
            resaleListings = parsed.resaleListings || [];
            tradeOffers = parsed.tradeOffers || [];
            promoCodes = parsed.promoCodes || [];
            bannerText = parsed.bannerText || "";
            chatMessages = parsed.chatMessages || [];
            blockSubscriptionRewardItemId = parsed.blockSubscriptionRewardItemId || null;
            console.log("✅ Datos cargados localmente desde database.json");
        } catch (err) {
            console.error("⚠️ Error al leer database.json local:", err.message);
        }
    }
}

async function loadDataFromGit() {
    if (!octokit || !GIST_ID) {
        console.log("⚠️ GITHUB_TOKEN o GIST_ID no configurados. Usando almacenamiento en archivo local.");
        loadLocalData();
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
                likes: u.likes || [],
                dislikes: u.dislikes || [],
                reports: u.reports || [],
                coins: typeof u.coins === 'number' ? u.coins : 100,
                dollars: typeof u.dollars === 'number' ? u.dollars : 0,
                blockSubExpiresAt: u.blockSubExpiresAt || null,
                equippedAccessory: u.equippedAccessory || null,
                profileBgColor: u.profileBgColor || null,
                profileSoundUrl: u.profileSoundUrl || null,
                banned: u.banned || false,
                lastDailyReward: u.lastDailyReward || 0
            }));
            friendships = parsed.friendships || [];
            friendRequests = parsed.friendRequests || [];
            accessories = (parsed.accessories || []).map(a => ({
                ...a,
                type: a.type || "hat",
                isGhost: Boolean(a.isGhost),
                onlyBlock: Boolean(a.onlyBlock)
            }));
            resaleListings = parsed.resaleListings || [];
            tradeOffers = parsed.tradeOffers || [];
            promoCodes = parsed.promoCodes || [];
            bannerText = parsed.bannerText || "";
            chatMessages = parsed.chatMessages || [];
            blockSubscriptionRewardItemId = parsed.blockSubscriptionRewardItemId || null;
            console.log("✅ Datos cargados correctamente desde el Gist privado.");
        } else {
            loadLocalData();
        }
    } catch (err) {
        console.log("⚠️ Error al cargar desde Gist, usando copia local:", err.message);
        loadLocalData();
    }
}

async function saveDataToGit() {
    const dataObj = {
        users,
        friendships,
        friendRequests,
        accessories,
        resaleListings,
        tradeOffers,
        promoCodes,
        bannerText,
        chatMessages,
        blockSubscriptionRewardItemId
    };
    const dataToSave = JSON.stringify(dataObj, null, 2);

    try {
        fs.writeFileSync(LOCAL_DB_PATH, dataToSave, 'utf8');
    } catch (e) {
        console.error("❌ Error al guardar copia local:", e.message);
    }

    if (!octokit || !GIST_ID) return;
    try {
        await octokit.gists.update({
            gist_id: GIST_ID,
            files: { "database.json": { content: dataToSave } }
        });
        console.log("✅ Cambios sincronizados con Gist.");
    } catch (err) {
        console.error("❌ Error al guardar en Gist:", err.message);
    }
}

setInterval(async () => {
    await saveDataToGit();
}, 20000);

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
        if (!foundUser.likes) foundUser.likes = [];
        if (!foundUser.dislikes) foundUser.dislikes = [];
        if (!foundUser.reports) foundUser.reports = [];

        req.user = foundUser;
        next();
    });
}

function requireAdmin(req, res, next) {
    if (!req.user) return res.status(403).json({ error: "Acceso denegado." });
    
    const hasAdminBadge = req.user.badges && req.user.badges.some(b => {
        const name = typeof b === 'object' ? b.name : b;
        return name === "🛡️admin" || name === "🛡️ admin" || name === "🛠️ Admin";
    });

    if (!req.user.admin && !req.user.owner && !hasAdminBadge) {
        return res.status(403).json({ error: "Requiere permisos de administrador, Owner o la insignia 🛡️admin." });
    }
    next();
}

app.get('/api/ping', (req, res) => {
    res.json({ message: "hola" });
});

const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || `http://localhost:${PORT}`;

setInterval(() => {
    try {
        if (typeof fetch !== 'function') return;
        fetch(`${SELF_URL}/api/ping`).then(r => r.json()).catch(() => {});
    } catch (err) {
        console.error("⚠️ Error en auto-ping:", err.message);
    }
}, 40000);

// AUTENTICACIÓN Y PERFIL
app.post(['/api/register', '/register'], async (req, res) => {
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
        badges: isOwner ? ["🛠️ Admin", "🎮 Owner", "🛡️admin"] : [],
        coins: 0,
        dollars: 0,
        inventory: [],
        likes: [],
        dislikes: [],
        reports: [],
        blockSubExpiresAt: null,
        equippedAccessory: null,
        profileBgColor: null,
        profileSoundUrl: null,
        admin: isOwner,
        owner: isOwner,
        banned: false,
        lastDailyReward: Date.now()
    };

    users.push(newUser);
    await saveDataToGit();

    const token = jwt.sign({ id: newUser.id, username: newUser.username }, JWT_SECRET);
    res.json({ success: true, token });
});

app.post(['/api/login', '/login'], async (req, res) => {
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

app.get('/api/me', authenticateToken, async (req, res) => {
    if (req.user.banned) {
        return res.status(403).json({ banned: true, error: "Has sido baneado de Game Blocks." });
    }

    const NOW = Date.now();
    const DAY_MS = 86400000;
    let dailyClaimed = false;
    const isBlockSub = hasActiveBlockSub(req.user);
    const dailyAmount = isBlockSub ? 34 : 10;

    if (!req.user.lastDailyReward || (NOW - req.user.lastDailyReward) >= DAY_MS) {
        req.user.coins = (req.user.coins || 0) + dailyAmount;
        req.user.lastDailyReward = NOW;
        dailyClaimed = true;
        await saveDataToGit();
    }

    const { password, ...safeUserData } = req.user;
    res.json({ 
        ...safeUserData, 
        dailyClaimed, 
        dailyAmount,
        hasBlockSub: isBlockSub 
    });
});

app.post('/api/logout', (req, res) => res.json({ success: true }));

app.post('/api/account/delete-banned', authenticateToken, async (req, res) => {
    if (!req.user.banned) return res.status(400).json({ error: "Tu cuenta no está baneada." });
    users = users.filter(u => String(u.id) !== String(req.user.id));
    await saveDataToGit();
    res.json({ success: true, message: "Cuenta eliminada correctamente." });
});

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

// LIKES, DISLIKES Y REPORTES
app.post('/api/users/:id/like', authenticateToken, async (req, res) => {
    const target = users.find(u => String(u.id) === String(req.params.id));
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    if (!target.likes) target.likes = [];
    if (!target.dislikes) target.dislikes = [];

    const myId = req.user.id;
    target.dislikes = target.dislikes.filter(id => String(id) !== String(myId));

    const idx = target.likes.findIndex(id => String(id) === String(myId));
    if (idx !== -1) {
        target.likes.splice(idx, 1);
    } else {
        target.likes.push(myId);
    }

    await saveDataToGit();
    res.json({ success: true, likes: target.likes.length, dislikes: target.dislikes.length });
});

app.post('/api/users/:id/dislike', authenticateToken, async (req, res) => {
    const target = users.find(u => String(u.id) === String(req.params.id));
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    if (!target.likes) target.likes = [];
    if (!target.dislikes) target.dislikes = [];

    const myId = req.user.id;
    target.likes = target.likes.filter(id => String(id) !== String(myId));

    const idx = target.dislikes.findIndex(id => String(id) === String(myId));
    if (idx !== -1) {
        target.dislikes.splice(idx, 1);
    } else {
        target.dislikes.push(myId);
    }

    await saveDataToGit();
    res.json({ success: true, likes: target.likes.length, dislikes: target.dislikes.length });
});

app.post('/api/users/:id/report', authenticateToken, async (req, res) => {
    const target = users.find(u => String(u.id) === String(req.params.id));
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });
    if (String(target.id) === String(req.user.id)) return res.status(400).json({ error: "No puedes denunciarte a ti mismo." });

    if (!target.reports) target.reports = [];
    if (target.reports.includes(req.user.id)) {
        return res.status(400).json({ error: "Ya has denunciado a este usuario." });
    }

    target.reports.push(req.user.id);
    await saveDataToGit();
    res.json({ success: true, message: "Denuncia enviada.", totalReports: target.reports.length });
});

// SUSCRIPCIÓN BLOCK
app.post('/api/subscription/buy-block', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });

    const currentDollars = req.user.dollars || 0;
    if (currentDollars < 5) {
        return res.status(400).json({ error: "Necesitas al menos 5 💲 para la Suscripción Block." });
    }

    req.user.dollars = currentDollars - 5;
    const monthMs = 30 * 86400000;
    const currentSubEnd = (req.user.blockSubExpiresAt && req.user.blockSubExpiresAt > Date.now()) 
        ? req.user.blockSubExpiresAt 
        : Date.now();

    req.user.blockSubExpiresAt = currentSubEnd + monthMs;

    let freeItemGiven = null;
    if (blockSubscriptionRewardItemId) {
        const rewardItem = accessories.find(a => String(a.id) === String(blockSubscriptionRewardItemId));
        if (rewardItem) {
            req.user.inventory.push(rewardItem.id);
            freeItemGiven = rewardItem.name;
        }
    }

    await saveDataToGit();
    res.json({
        success: true,
        message: "¡Te has suscrito a Block con éxito!",
        dollars: req.user.dollars,
        blockSubExpiresAt: req.user.blockSubExpiresAt,
        freeItemGiven
    });
});

// PAQUETES Y COMPRA DE MONEDAS
app.get('/api/coins/packages', (req, res) => {
    res.json({ packages: currencyPackages });
});

app.post('/api/coins/purchase', authenticateToken, async (req, res) => {
    const coinsReq = Number(req.body.coins);
    const pkg = currencyPackages.find(p => p.coins === coinsReq);
    if (!pkg) return res.status(400).json({ error: "Paquete de monedas no válido." });

    if ((req.user.dollars || 0) < pkg.dollars) {
        return res.status(400).json({ error: `No tienes suficientes 💲. Necesitas ${pkg.dollars} 💲.` });
    }

    req.user.dollars -= pkg.dollars;
    req.user.coins = (req.user.coins || 0) + pkg.coins;
    await saveDataToGit();

    res.json({ success: true, coins: req.user.coins, dollars: req.user.dollars });
});

// CHAT CON AMIGOS
app.get('/api/chat/:friendId', authenticateToken, (req, res) => {
    const friendId = String(req.params.friendId);
    const myId = String(req.user.id);

    const isFriend = friendships.some(f => 
        (String(f.user1) === myId && String(f.user2) === friendId) ||
        (String(f.user2) === myId && String(f.user1) === friendId)
    );

    if (!isFriend) return res.status(403).json({ error: "Solo puedes chatear con amigos." });

    const msgs = chatMessages.filter(m => 
        (String(m.senderId) === myId && String(m.receiverId) === friendId) ||
        (String(m.senderId) === friendId && String(m.receiverId) === myId)
    );

    res.json({ messages: msgs });
});

app.post('/api/chat/send', authenticateToken, async (req, res) => {
    const { friendId, text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: "Mensaje vacío." });

    const myId = String(req.user.id);
    const targetId = String(friendId);

    const isFriend = friendships.some(f => 
        (String(f.user1) === myId && String(f.user2) === targetId) ||
        (String(f.user2) === myId && String(f.user1) === targetId)
    );

    if (!isFriend) return res.status(403).json({ error: "Solo puedes enviar mensajes a amigos." });

    const containsEmoji = /(\p{Extended_Pictographic}|\p{Emoji_Presentation})/u.test(text);
    if (containsEmoji && !hasActiveBlockSub(req.user)) {
        return res.status(403).json({ 
            error: "🔒 Emojis bloqueados. Requiere la Suscripción Block (5 💲/mes) para usarlos o pegarlos." 
        });
    }

    const newMessage = {
        id: Date.now().toString(),
        senderId: req.user.id,
        senderUsername: req.user.username,
        receiverId: targetId,
        text: sanitizeText(text.trim()),
        timestamp: Date.now()
    };

    chatMessages.push(newMessage);
    await saveDataToGit();
    res.json({ success: true, message: newMessage });
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

app.get('/api/users/profile/:id', (req, res) => {
    const target = users.find(u => String(u.id) === String(req.params.id));
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    const userInventory = (target.inventory || []).map(itemId => {
        const item = accessories.find(a => String(a.id) === String(itemId));
        return item ? { id: item.id, name: item.name, imageUrl: item.imageUrl, type: item.type } : { id: itemId, name: "Objeto #" + itemId, imageUrl: "https://via.placeholder.com/80" };
    });

    res.json({
        id: target.id,
        username: target.username,
        avatar: target.avatar,
        bio: target.bio,
        badges: target.badges || [],
        inventory: userInventory,
        profileBgColor: target.profileBgColor || null,
        profileSoundUrl: target.profileSoundUrl || null,
        likesCount: (target.likes || []).length,
        dislikesCount: (target.dislikes || []).length,
        reportsCount: (target.reports || []).length,
        isAlert: (target.reports || []).length >= 5
    });
});

// CANJEAR CÓDIGOS
app.post('/api/codes/redeem', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "Ingresa un código." });

    const cleanCode = code.trim().toUpperCase();
    const promo = promoCodes.find(c => c.code.toUpperCase() === cleanCode);

    if (!promo) return res.status(404).json({ error: "Código inválido o inexistente." });

    if (promo.expiresAt && Date.now() > promo.expiresAt) {
        return res.status(400).json({ error: "El código ha expirado." });
    }

    if (promo.maxUses !== null && promo.currentUses >= promo.maxUses) {
        return res.status(400).json({ error: "El código ha alcanzado el límite máximo de usos." });
    }

    if (!promo.usedBy) promo.usedBy = [];
    if (promo.usedBy.includes(req.user.id)) {
        return res.status(400).json({ error: "Ya has canjeado este código anteriormente." });
    }

    promo.currentUses = (promo.currentUses || 0) + 1;
    promo.usedBy.push(req.user.id);

    if (promo.coins) req.user.coins = (req.user.coins || 0) + Number(promo.coins);
    if (promo.dollars) req.user.dollars = (req.user.dollars || 0) + Number(promo.dollars);
    if (promo.rewardItemId) {
        req.user.inventory.push(promo.rewardItemId);
    }

    await saveDataToGit();
    res.json({ success: true, message: `¡Código canjeado con éxito! +${promo.coins || 0}🪙 +${promo.dollars || 0}💲` });
});

// ACCESORIOS Y TIENDA
app.get('/api/accessories', (req, res) => {
    const publicItems = accessories.filter(a => !a.isGhost);
    res.json({ items: publicItems });
});

app.get('/api/accessories/all', (req, res) => {
    res.json({ items: accessories });
});

app.post('/api/accessories/buy', authenticateToken, async (req, res) => {
    const { itemId } = req.body;
    const item = accessories.find(a => String(a.id) === String(itemId));
    if (!item) return res.status(404).json({ error: "Artículo no encontrado." });
    if (item.offsale) return res.status(400).json({ error: "Este artículo está fuera de venta (Offsale)." });

    if (item.onlyBlock && !hasActiveBlockSub(req.user)) {
        return res.status(403).json({ error: "Este artículo requiere Suscripción Block activa." });
    }

    if ((req.user.coins || 0) < item.price) {
        return res.status(400).json({ error: "No tienes suficientes monedas." });
    }

    req.user.coins -= item.price;
    req.user.inventory.push(item.id);
    item.totalSold = (item.totalSold || 0) + 1;

    await saveDataToGit();
    res.json({ success: true, newBalance: req.user.coins });
});

app.post('/api/accessories/equip', authenticateToken, async (req, res) => {
    const { itemId } = req.body;
    if (!req.user.inventory.map(String).includes(String(itemId))) {
        return res.status(400).json({ error: "No posees este artículo." });
    }

    const item = accessories.find(a => String(a.id) === String(itemId));
    if (item && item.onlyBlock && !hasActiveBlockSub(req.user)) {
        return res.status(403).json({ error: "Requiere Suscripción Block activa para equipar." });
    }

    req.user.equippedAccessory = itemId;
    if (item) {
        req.user.profileBgColor = item.bgColor || null;
        req.user.profileSoundUrl = item.soundUrl || null;
    }

    await saveDataToGit();
    res.json({ success: true, profileBgColor: req.user.profileBgColor, profileSoundUrl: req.user.profileSoundUrl });
});

app.post('/api/accessories/unequip', authenticateToken, async (req, res) => {
    req.user.equippedAccessory = null;
    req.user.profileBgColor = null;
    req.user.profileSoundUrl = null;
    await saveDataToGit();
    res.json({ success: true });
});

app.post('/api/accessories/sell', authenticateToken, async (req, res) => {
    const { itemId } = req.body;
    const idx = req.user.inventory.findIndex(id => String(id) === String(itemId));
    if (idx === -1) return res.status(400).json({ error: "No tienes este artículo para vender." });

    const item = accessories.find(a => String(a.id) === String(itemId));
    const refund = item ? Math.floor(item.price * 0.5) : 0;

    req.user.inventory.splice(idx, 1);
    req.user.coins = (req.user.coins || 0) + refund;

    if (String(req.user.equippedAccessory) === String(itemId)) {
        req.user.equippedAccessory = null;
        req.user.profileBgColor = null;
        req.user.profileSoundUrl = null;
    }

    await saveDataToGit();
    res.json({ success: true, refundAmount: refund, newBalance: req.user.coins });
});

app.post('/api/accessories/resell-list', authenticateToken, async (req, res) => {
    const { itemId, price } = req.body;
    const numPrice = Number(price);
    if (!numPrice || numPrice <= 0) return res.status(400).json({ error: "Precio no válido." });

    const idx = req.user.inventory.findIndex(id => String(id) === String(itemId));
    if (idx === -1) return res.status(400).json({ error: "No posees este artículo." });

    const item = accessories.find(a => String(a.id) === String(itemId));
    if (!item || !item.limited || !item.offsale) {
        return res.status(400).json({ error: "Solo puedes revender artículos Limited Offsale." });
    }

    req.user.inventory.splice(idx, 1);
    const listing = {
        id: Date.now().toString(),
        sellerId: req.user.id,
        sellerUsername: req.user.username,
        itemId: item.id,
        price: numPrice,
        item
    };

    resaleListings.push(listing);
    await saveDataToGit();
    res.json({ success: true, message: "Artículo publicado en reventa." });
});

app.get('/api/accessories/resale-market', (req, res) => {
    res.json({ listings: resaleListings });
});

app.post('/api/accessories/resell-buy', authenticateToken, async (req, res) => {
    const { listingId } = req.body;
    const idx = resaleListings.findIndex(l => String(l.id) === String(listingId));
    if (idx === -1) return res.status(404).json({ error: "Oferta de reventa no encontrada." });

    const listing = resaleListings[idx];
    if ((req.user.coins || 0) < listing.price) {
        return res.status(400).json({ error: "Monedas insuficientes." });
    }

    req.user.coins -= listing.price;
    req.user.inventory.push(listing.itemId);

    const seller = users.find(u => String(u.id) === String(listing.sellerId));
    if (seller) {
        seller.coins = (seller.coins || 0) + listing.price;
    }

    resaleListings.splice(idx, 1);
    await saveDataToGit();
    res.json({ success: true, message: "Reventa comprada con éxito." });
});

// SUBIR CAMISETA UGC
app.post('/api/tshirts/upload', authenticateToken, async (req, res) => {
    const { name, imageUrl, price, onlyBlock } = req.body;
    if (!name || !imageUrl) return res.status(400).json({ error: "Nombre e imagen requeridos." });

    const numPrice = Math.max(1, Number(price) || 1);
    const newTshirt = {
        id: "ts_" + Date.now().toString(),
        name: sanitizeText(name),
        type: "tshirt",
        imageUrl,
        price: numPrice,
        creatorUsername: req.user.username,
        createdByAdmin: false,
        onlyBlock: Boolean(onlyBlock),
        limited: false,
        offsale: false,
        totalSold: 0
    };

    accessories.push(newTshirt);
    await saveDataToGit();
    res.json({ success: true, item: newTshirt });
});

// BANNER
app.get('/api/banner', (req, res) => {
    res.json({ text: bannerText });
});

// CONEXIÓN A JUEGO
app.post('/api/game/create-code', authenticateToken, (req, res) => {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    gameCodes[code] = req.user.id;
    res.json({ success: true, code });
});

// AMISTADES & SOLICITUDES
app.get('/api/friends/requests', authenticateToken, (req, res) => {
    const reqs = friendRequests
        .filter(r => String(r.targetId) === String(req.user.id))
        .map(r => {
            const sender = users.find(u => String(u.id) === String(r.senderId));
            return { id: r.id, username: sender ? sender.username : "Desconocido" };
        });
    res.json({ requests: reqs });
});

app.get('/api/friends', authenticateToken, (req, res) => {
    const myId = String(req.user.id);
    const list = friendships.filter(f => String(f.user1) === myId || String(f.user2) === myId).map(f => {
        const otherId = String(f.user1) === myId ? f.user2 : f.user1;
        const other = users.find(u => String(u.id) === String(otherId));
        return other ? { id: other.id, username: other.username, avatar: other.avatar } : null;
    }).filter(Boolean);

    res.json({ friends: list });
});

app.post('/api/friends/request', authenticateToken, async (req, res) => {
    const { userId } = req.body;
    if (String(userId) === String(req.user.id)) return res.status(400).json({ error: "No puedes agregarte a ti mismo." });

    const existingReq = friendRequests.find(r => String(r.senderId) === String(req.user.id) && String(r.targetId) === String(userId));
    if (existingReq) return res.status(400).json({ error: "Ya enviaste una solicitud a este usuario." });

    friendRequests.push({ id: Date.now().toString(), senderId: req.user.id, targetId: userId });
    await saveDataToGit();
    res.json({ success: true, message: "Solicitud enviada." });
});

app.post('/api/friends/accept', authenticateToken, async (req, res) => {
    const { requestId } = req.body;
    const idx = friendRequests.findIndex(r => String(r.id) === String(requestId) && String(r.targetId) === String(req.user.id));
    if (idx === -1) return res.status(404).json({ error: "Solicitud no encontrada." });

    const reqObj = friendRequests[idx];
    friendships.push({ user1: reqObj.senderId, user2: reqObj.targetId });
    friendRequests.splice(idx, 1);

    await saveDataToGit();
    res.json({ success: true, message: "Solicitud aceptada." });
});

// TRADES (INTERCAMBIOS)
app.post('/api/trade/offer', authenticateToken, async (req, res) => {
    const { targetUserId, offeredItemId, offeredCoins, requestedItemId, requestedCoins } = req.body;
    const offer = {
        id: Date.now().toString(),
        senderId: req.user.id,
        senderUsername: req.user.username,
        targetUserId,
        offeredItemId,
        offeredCoins: Number(offeredCoins) || 0,
        requestedItemId,
        requestedCoins: Number(requestedCoins) || 0,
        offeredItemName: (accessories.find(a => String(a.id) === String(offeredItemId)) || {}).name || "Ninguno",
        requestedItemName: (accessories.find(a => String(a.id) === String(requestedItemId)) || {}).name || "Ninguno"
    };

    tradeOffers.push(offer);
    await saveDataToGit();
    res.json({ success: true, message: "Oferta de intercambio enviada." });
});

app.get('/api/trade/pending', authenticateToken, (req, res) => {
    const pending = tradeOffers.filter(t => String(t.targetUserId) === String(req.user.id));
    res.json({ trades: pending });
});

app.post('/api/trade/accept', authenticateToken, async (req, res) => {
    const { tradeId } = req.body;
    const idx = tradeOffers.findIndex(t => String(t.id) === String(tradeId) && String(t.targetUserId) === String(req.user.id));
    if (idx === -1) return res.status(404).json({ error: "Oferta no encontrada." });

    const trade = tradeOffers[idx];
    const sender = users.find(u => String(u.id) === String(trade.senderId));
    if (!sender) return res.status(404).json({ error: "El remitente ya no existe." });

    if (trade.offeredItemId) {
        const sIdx = sender.inventory.findIndex(id => String(id) === String(trade.offeredItemId));
        if (sIdx !== -1) {
            sender.inventory.splice(sIdx, 1);
            req.user.inventory.push(trade.offeredItemId);
        }
    }
    if (trade.requestedItemId) {
        const rIdx = req.user.inventory.findIndex(id => String(id) === String(trade.requestedItemId));
        if (rIdx !== -1) {
            req.user.inventory.splice(rIdx, 1);
            sender.inventory.push(trade.requestedItemId);
        }
    }

    if (trade.offeredCoins > 0 && sender.coins >= trade.offeredCoins) {
        sender.coins -= trade.offeredCoins;
        req.user.coins = (req.user.coins || 0) + trade.offeredCoins;
    }
    if (trade.requestedCoins > 0 && req.user.coins >= trade.requestedCoins) {
        req.user.coins -= trade.requestedCoins;
        sender.coins = (sender.coins || 0) + trade.requestedCoins;
    }

    tradeOffers.splice(idx, 1);
    await saveDataToGit();
    res.json({ success: true, message: "Intercambio completado con éxito." });
});

// RUTAS DE ADMINISTRACIÓN
app.get('/api/admin/reports', authenticateToken, requireAdmin, (req, res) => {
    const reported = users
        .filter(u => (u.reports || []).length >= 10)
        .map(u => ({ id: u.id, username: u.username, reportsCount: u.reports.length, banned: u.banned }));
    res.json({ reportedUsers: reported });
});

app.post('/api/admin/reports/rename', authenticateToken, requireAdmin, async (req, res) => {
    const target = users.find(u => String(u.id) === String(req.body.userId));
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });
    target.username = "[contenido baneado]";
    await saveDataToGit();
    res.json({ success: true });
});

app.post('/api/admin/reports/ban', authenticateToken, requireAdmin, async (req, res) => {
    const target = users.find(u => String(u.id) === String(req.body.userId));
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });
    target.banned = true;
    await saveDataToGit();
    res.json({ success: true });
});

app.post('/api/admin/reports/clear', authenticateToken, requireAdmin, async (req, res) => {
    const target = users.find(u => String(u.id) === String(req.body.userId));
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });
    target.reports = [];
    await saveDataToGit();
    res.json({ success: true });
});

app.post('/api/admin/settings/block-reward', authenticateToken, requireAdmin, async (req, res) => {
    blockSubscriptionRewardItemId = req.body.itemId || null;
    await saveDataToGit();
    res.json({ success: true });
});

app.post('/api/admin/codes/create', authenticateToken, requireAdmin, async (req, res) => {
    const { code, coins, dollars, maxUses, expiresInDays, rewardItemId } = req.body;
    if (!code) return res.status(400).json({ error: "Código requerido." });

    const newCode = {
        code: code.trim().toUpperCase(),
        coins: Number(coins) || 0,
        dollars: Number(dollars) || 0,
        maxUses: maxUses ? Number(maxUses) : null,
        currentUses: 0,
        expiresAt: expiresInDays ? Date.now() + (Number(expiresInDays) * 86400000) : null,
        rewardItemId: rewardItemId || null,
        usedBy: []
    };

    promoCodes.push(newCode);
    await saveDataToGit();
    res.json({ success: true, promoCode: newCode });
});

app.post('/api/admin/tshirts/upload', authenticateToken, requireAdmin, async (req, res) => {
    const { name, limited, offsale, onlyBlock, imageUrl, price } = req.body;
    if (!name || !imageUrl) return res.status(400).json({ error: "Datos requeridos." });

    const tshirt = {
        id: "ts_admin_" + Date.now().toString(),
        name: sanitizeText(name),
        type: "tshirt",
        imageUrl,
        price: Number(price) || 0,
        creatorUsername: req.user.username,
        createdByAdmin: true,
        limited: Boolean(limited),
        offsale: Boolean(offsale),
        onlyBlock: Boolean(onlyBlock),
        totalSold: 0
    };

    accessories.push(tshirt);
    await saveDataToGit();
    res.json({ success: true, item: tshirt });
});

app.post('/api/admin/accessories/edit', authenticateToken, requireAdmin, async (req, res) => {
    const { itemId, price, limited, offsale, isGhost, onlyBlock, bgColor, soundUrl } = req.body;
    const item = accessories.find(a => String(a.id) === String(itemId));
    if (!item) return res.status(404).json({ error: "Artículo no encontrado." });

    if (price !== undefined && price !== "") item.price = Number(price);
    if (limited === "true") item.limited = true;
    if (limited === "false") item.limited = false;
    if (offsale === "true") item.offsale = true;
    if (offsale === "false") item.offsale = false;
    if (isGhost === "true") item.isGhost = true;
    if (isGhost === "false") item.isGhost = false;
    if (onlyBlock === "true") item.onlyBlock = true;
    if (onlyBlock === "false") item.onlyBlock = false;
    if (bgColor) item.bgColor = bgColor;
    if (soundUrl !== undefined) item.soundUrl = soundUrl;

    await saveDataToGit();
    res.json({ success: true, item });
});

app.post('/api/admin/accessories/upload', authenticateToken, requireAdmin, upload.single('glb'), async (req, res) => {
    const { name, limited, offsale, onlyBlock, bgColor, soundUrl, price, imageUrl } = req.body;
    if (!req.file && !imageUrl) return res.status(400).json({ error: "Archivo GLB o imagen requeridos." });

    const newAcc = {
        id: "acc_" + Date.now().toString(),
        name: sanitizeText(name),
        type: "hat",
        glbUrl: req.file ? `/uploads/${req.file.filename}` : "",
        imageUrl: imageUrl || "https://via.placeholder.com/80",
        price: Number(price) || 0,
        limited: String(limited) === "true",
        offsale: String(offsale) === "true",
        onlyBlock: String(onlyBlock) === "true",
        bgColor: bgColor || null,
        soundUrl: soundUrl || null,
        totalSold: 0
    };

    accessories.push(newAcc);
    await saveDataToGit();
    res.json({ success: true, item: newAcc });
});

app.post('/api/admin/coins/add', authenticateToken, requireAdmin, async (req, res) => {
    const { username, amount } = req.body;
    const target = users.find(u => u.username.toLowerCase() === (username || "").trim().toLowerCase());
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    target.coins = (target.coins || 0) + Number(amount);
    await saveDataToGit();
    res.json({ success: true, coins: target.coins });
});

app.post('/api/admin/dollars/add', authenticateToken, requireAdmin, async (req, res) => {
    const { username, amount } = req.body;
    const target = users.find(u => u.username.toLowerCase() === (username || "").trim().toLowerCase());
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    target.dollars = (target.dollars || 0) + Number(amount);
    await saveDataToGit();
    res.json({ success: true, dollars: target.dollars });
});

app.post('/api/admin/banner', authenticateToken, requireAdmin, async (req, res) => {
    bannerText = req.body.text || "";
    await saveDataToGit();
    res.json({ success: true, bannerText });
});

// Inicialización del servidor y carga de persistencia
(async () => {
    await loadDataFromGit();
    app.listen(PORT, () => {
        console.log(`🚀 Servidor ejecutándose en http://localhost:${PORT}`);
    });
})();
