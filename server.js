const express = require('express');
require('express-async-errors'); // Hace que los errores lanzados dentro de rutas "async" lleguen al manejador de errores en vez de colgar la petición o tirar el servidor
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken'); 
const bcrypt = require('bcryptjs');
const { Octokit } = require('@octokit/rest');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || "gameblocks_secret_key_change_in_production";

// Red de seguridad: evita que un error no controlado (fuera del ciclo de una petición Express,
// por ejemplo en los setInterval de abajo) tumbe todo el proceso y deje el servidor sin responder.
process.on('unhandledRejection', (reason) => {
    console.error("⚠️ Promesa rechazada sin manejar:", reason);
});
process.on('uncaughtException', (err) => {
    console.error("⚠️ Excepción no controlada:", err);
});

const octokit = process.env.GITHUB_TOKEN ? new Octokit({ auth: process.env.GITHUB_TOKEN }) : null;
const GIST_ID = process.env.GIST_ID; 
const LOCAL_DB_PATH = path.join(__dirname, 'database.json');

app.use(cors());

// Se aumenta el límite para aceptar cargas de imágenes o JSON pesados sin generar error HTML 413
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

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

// Cargar datos locales de respaldo
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

// Persistencia mediante GitHub Gist o respaldo en database.json local
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
        if (typeof fetch !== 'function') return; // Node sin fetch global (< 18): se omite en vez de crashear
        fetch(`${SELF_URL}/api/ping`).then(r => r.json()).catch(() => {});
    } catch (err) {
        console.error("⚠️ Error en auto-ping:", err.message);
    }
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

    promo.currentUses = (promo.currentUses || 0) + 1;
    promo.usedBy.push(req.user.id);

    req.user.coins = (req.user.coins || 0) + (promo.coins || 0);
    req.user.dollars = (req.user.dollars || 0) + (promo.dollars || 0);

    let rewardItemName = null;
    if (promo.rewardItemId) {
        const rewardItem = accessories.find(a => String(a.id) === String(promo.rewardItemId));
        if (rewardItem) {
            req.user.inventory.push(rewardItem.id);
            rewardItemName = rewardItem.name;
        }
    }

    await saveDataToGit();

    let msg = `¡Código canjeado! Ganaste ${promo.coins || 0} monedas`;
    if (promo.dollars) msg += ` y ${promo.dollars} 💲`;
    msg += ".";
    if (rewardItemName) msg += ` Además obtuviste el objeto: ${rewardItemName}.`;

    res.json({
        success: true,
        message: msg,
        newBalance: req.user.coins,
        newDollars: req.user.dollars || 0
    });
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
    
    const exists = friendRequests.some(r => String(r.senderId) === String(req.user.id) && String(r.receiverId) === String(userId));
    if (exists) return res.status(400).json({ error: "Ya enviaste una solicitud a este usuario." });

    friendRequests.push({ id: Date.now().toString(), senderId: req.user.id, receiverId: userId });
    res.json({ success: true, message: "Solicitud enviada." });
});

app.post('/api/friends/accept', authenticateToken, async (req, res) => {
    const { requestId } = req.body;
    const reqIndex = friendRequests.findIndex(r => String(r.id) === String(requestId) && String(r.receiverId) === String(req.user.id));

    if (reqIndex === -1) return res.status(404).json({ error: "Solicitud no encontrada." });

    const requestObj = friendRequests[reqIndex];
    friendships.push({
        id: Date.now().toString(),
        user1: requestObj.senderId,
        user2: requestObj.receiverId
    });

    friendRequests.splice(reqIndex, 1);
    await saveDataToGit();
    res.json({ success: true, message: "Solicitud de amistad aceptada." });
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

// TIENDA, LIMITEDS, REVENTA, CAMISETAS E INTERCAMBIOS
app.get(['/api/accessories', '/api/shop', '/api/store'], (req, res) => {
    const enrichedItems = accessories
        .filter(item => !item.isGhost) // NO sale en el catálogo si es fantasma
        .map(item => {
            let totalSold = 0;
            users.forEach(u => {
                totalSold += (u.inventory || []).filter(id => String(id) === String(item.id)).length;
            });
            resaleListings.forEach(r => {
                if (String(r.itemId) === String(item.id)) totalSold += 1;
            });
            return { ...item, totalSold, type: item.type || "hat" };
        });
    res.json({ items: enrichedItems });
});

app.get('/api/accessories/all', (req, res) => {
    const enrichedItems = accessories.map(item => {
        let totalSold = 0;
        users.forEach(u => {
            totalSold += (u.inventory || []).filter(id => String(id) === String(item.id)).length;
        });
        resaleListings.forEach(r => {
            if (String(r.itemId) === String(item.id)) totalSold += 1;
        });
        return { ...item, totalSold, type: item.type || "hat" };
    });
    res.json({ items: enrichedItems });
});

// SUBIR CAMISETA POR USUARIO UGC
app.post('/api/tshirts/upload', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });

    const { name, imageUrl, price, onlyBlock } = req.body;
    if (!name || !imageUrl || price === undefined) {
        return res.status(400).json({ error: "Completa el nombre, imagen y precio." });
    }

    const cost = parseInt(price);
    if (isNaN(cost) || cost < 1) {
        return res.status(400).json({ error: "El precio debe ser de al menos 1 moneda." });
    }

    const newTshirt = {
        id: Date.now().toString(),
        name: sanitizeText(name),
        type: "tshirt",
        imageUrl: imageUrl.trim(),
        glbUrl: null,
        price: cost,
        limited: false,
        offsale: false,
        isGhost: false,
        onlyBlock: Boolean(onlyBlock),
        bgColor: null,
        soundUrl: null,
        creatorId: req.user.id,
        creatorUsername: req.user.username,
        createdByAdmin: false
    };

    accessories.push(newTshirt);
    await saveDataToGit();
    res.json({ success: true, tshirt: newTshirt });
});

app.post('/api/accessories/buy', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const itemId = req.body.itemId || req.body.id;
    const item = accessories.find(a => String(a.id) === String(itemId));

    if (!item) return res.status(404).json({ error: "Artículo no encontrado." });
    if (item.offsale) return res.status(400).json({ error: "Este artículo está Offsale." });

    if (item.onlyBlock && !hasActiveBlockSub(req.user)) {
        return res.status(400).json({ error: "Este accesorio es exclusivo para usuarios con Suscripción Block." });
    }

    if (item.expiresAt && Date.now() > item.expiresAt) {
        return res.status(400).json({ error: "Este artículo ha expirado y ya no se puede comprar." });
    }

    let totalSold = 0;
    users.forEach(u => {
        totalSold += (u.inventory || []).filter(id => String(id) === String(item.id)).length;
    });
    resaleListings.forEach(r => {
        if (String(r.itemId) === String(item.id)) totalSold += 1;
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

    if (!item.createdByAdmin && item.creatorId && String(item.creatorId) !== String(req.user.id)) {
        const creator = users.find(u => String(u.id) === String(item.creatorId));
        if (creator) {
            creator.coins = (creator.coins || 0) + item.price;
        }
    }

    await saveDataToGit();
    res.json({ success: true, newBalance: req.user.coins, inventory: req.user.inventory });
});

app.post('/api/accessories/sell', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { itemId } = req.body;
    const item = accessories.find(a => String(a.id) === String(itemId));

    if (!item) return res.status(404).json({ error: "Artículo no encontrado." });

    const index = req.user.inventory.indexOf(itemId);
    if (index === -1) return res.status(400).json({ error: "No posees este accesorio." });

    req.user.inventory.splice(index, 1);
    const refundAmount = Math.floor(item.price * 0.5);
    req.user.coins += refundAmount;

    if (String(req.user.equippedAccessory) === String(itemId)) {
        req.user.equippedAccessory = null;
        req.user.profileBgColor = null;
        req.user.profileSoundUrl = null;
    }

    await saveDataToGit();
    res.json({ success: true, newBalance: req.user.coins, refundAmount });
});

app.post(['/api/accessories/equip', '/api/equip'], authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const itemId = req.body.itemId || req.body.id;
    if (!req.user.inventory.includes(itemId)) return res.status(403).json({ error: "No posees este accesorio." });

    const item = accessories.find(a => String(a.id) === String(itemId));
    if (item && item.onlyBlock && !hasActiveBlockSub(req.user)) {
        return res.status(400).json({ error: "Este accesorio es exclusivo de la Suscripción Block." });
    }
    
    req.user.equippedAccessory = itemId;
    
    if (item) {
        if (item.type === "tshirt") {
            req.user.profileBgColor = null;
            req.user.profileSoundUrl = null;
        } else {
            req.user.profileBgColor = item.bgColor || null;
            req.user.profileSoundUrl = item.soundUrl || null;
        }
    }

    await saveDataToGit();
    res.json({ 
        success: true, 
        equipped: itemId, 
        profileBgColor: req.user.profileBgColor, 
        profileSoundUrl: req.user.profileSoundUrl 
    });
});

app.post(['/api/accessories/unequip', '/api/unequip'], authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    req.user.equippedAccessory = null;
    req.user.profileBgColor = null;
    req.user.profileSoundUrl = null;
    await saveDataToGit();
    res.json({ success: true });
});

// INTERCAMBIOS (TRADES)
app.post('/api/trade/offer', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });

    const { targetUserId, offeredItemId, offeredCoins, requestedItemId, requestedCoins } = req.body;
    const target = users.find(u => String(u.id) === String(targetUserId));

    if (!target) return res.status(404).json({ error: "Usuario destino no encontrado." });
    if (String(target.id) === String(req.user.id)) return res.status(400).json({ error: "No puedes tradear contigo mismo." });

    let offeredItemObj = null;
    if (offeredItemId) {
        offeredItemObj = accessories.find(a => String(a.id) === String(offeredItemId));
        if (!offeredItemObj) return res.status(404).json({ error: "Artículo ofrecido no existe." });
        if (!offeredItemObj.limited || !offeredItemObj.offsale) {
            return res.status(400).json({ error: "Solo se pueden intercambiar artículos LIMITEDS y OFFSALE." });
        }
        if (!req.user.inventory.includes(offeredItemId)) {
            return res.status(400).json({ error: "No posees el ítem ofrecido." });
        }
    }

    let requestedItemObj = null;
    if (requestedItemId) {
        requestedItemObj = accessories.find(a => String(a.id) === String(requestedItemId));
        if (!requestedItemObj) return res.status(404).json({ error: "Artículo solicitado no existe." });
        if (!requestedItemObj.limited || !requestedItemObj.offsale) {
            return res.status(400).json({ error: "Solo puedes solicitar artículos LIMITEDS y OFFSALE." });
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
        offeredItemName: offeredItemObj ? offeredItemObj.name : null,
        offeredCoins: offerCoinsParsed,
        requestedItemId: requestedItemId || null,
        requestedItemName: requestedItemObj ? requestedItemObj.name : null,
        requestedCoins: reqCoinsParsed
    };

    tradeOffers.push(trade);
    await saveDataToGit();
    res.json({ success: true, message: "Oferta de intercambio enviada." });
});

app.get('/api/trade/pending', authenticateToken, (req, res) => {
    const pending = tradeOffers
        .filter(t => String(t.targetUserId) === String(req.user.id))
        .map(t => {
            const offItem = accessories.find(a => String(a.id) === String(t.offeredItemId));
            const reqItem = accessories.find(a => String(a.id) === String(t.requestedItemId));
            return {
                ...t,
                offeredItemName: offItem ? offItem.name : t.offeredItemName || "Ninguno",
                requestedItemName: reqItem ? reqItem.name : t.requestedItemName || "Ninguno"
            };
        });
    res.json({ trades: pending });
});

app.post('/api/trade/accept', authenticateToken, async (req, res) => {
    const { tradeId } = req.body;
    const tradeIndex = tradeOffers.findIndex(t => String(t.id) === String(tradeId) && String(t.targetUserId) === String(req.user.id));
    if (tradeIndex === -1) return res.status(404).json({ error: "Oferta de intercambio no encontrada." });

    const trade = tradeOffers[tradeIndex];
    const sender = users.find(u => String(u.id) === String(trade.senderId));
    if (!sender) return res.status(404).json({ error: "El usuario que envió la oferta ya no existe." });

    if (trade.offeredCoins > 0 && (sender.coins || 0) < trade.offeredCoins) {
        return res.status(400).json({ error: "El emisor ya no tiene suficientes monedas." });
    }
    if (trade.offeredItemId && !sender.inventory.includes(trade.offeredItemId)) {
        return res.status(400).json({ error: "El emisor ya no posee el objeto ofrecido." });
    }

    if (trade.requestedCoins > 0 && (req.user.coins || 0) < trade.requestedCoins) {
        return res.status(400).json({ error: "No tienes suficientes monedas para aceptar el intercambio." });
    }
    if (trade.requestedItemId && !req.user.inventory.includes(trade.requestedItemId)) {
        return res.status(400).json({ error: "Ya no posees el objeto solicitado." });
    }

    if (trade.offeredCoins > 0) {
        sender.coins -= trade.offeredCoins;
        req.user.coins = (req.user.coins || 0) + trade.offeredCoins;
    }
    if (trade.requestedCoins > 0) {
        req.user.coins -= trade.requestedCoins;
        sender.coins = (sender.coins || 0) + trade.requestedCoins;
    }

    if (trade.offeredItemId) {
        const idx = sender.inventory.indexOf(trade.offeredItemId);
        if (idx !== -1) sender.inventory.splice(idx, 1);
        req.user.inventory.push(trade.offeredItemId);
    }

    if (trade.requestedItemId) {
        const idx = req.user.inventory.indexOf(trade.requestedItemId);
        if (idx !== -1) req.user.inventory.splice(idx, 1);
        sender.inventory.push(trade.requestedItemId);
    }

    tradeOffers.splice(tradeIndex, 1);
    await saveDataToGit();
    res.json({ success: true, message: "Intercambio completado." });
});

// REVENTA / MERCADO
app.post('/api/accessories/resell-list', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { itemId, price } = req.body;
    const numericPrice = parseInt(price);
    if (isNaN(numericPrice) || numericPrice < 1) {
        return res.status(400).json({ error: "Precio inválido." });
    }

    const item = accessories.find(a => String(a.id) === String(itemId));
    if (!item) return res.status(404).json({ error: "Artículo no encontrado." });
    if (!item.limited || !item.offsale) {
        return res.status(400).json({ error: "Solo puedes poner en reventa artículos LIMITEDS y OFFSALE." });
    }

    const invIndex = req.user.inventory.indexOf(itemId);
    if (invIndex === -1) {
        return res.status(400).json({ error: "No posees este artículo en tu inventario." });
    }

    // Al revender se quita del inventario
    req.user.inventory.splice(invIndex, 1);
    if (String(req.user.equippedAccessory) === String(itemId)) {
        req.user.equippedAccessory = null;
        req.user.profileBgColor = null;
        req.user.profileSoundUrl = null;
    }

    const listing = {
        id: Date.now().toString(),
        sellerId: req.user.id,
        sellerUsername: req.user.username,
        itemId: item.id,
        price: numericPrice
    };

    resaleListings.push(listing);
    await saveDataToGit();
    res.json({ success: true, listing });
});

app.get('/api/accessories/resale-market', (req, res) => {
    const listingsEnriched = resaleListings.map(listing => {
        const item = accessories.find(a => String(a.id) === String(listing.itemId));
        let totalSold = 0;
        if (item) {
            users.forEach(u => {
                totalSold += (u.inventory || []).filter(id => String(id) === String(item.id)).length;
            });
            resaleListings.forEach(r => {
                if (String(r.itemId) === String(item.id)) totalSold += 1;
            });
        }
        return {
            ...listing,
            item: item ? { ...item, totalSold } : null
        };
    });
    res.json({ listings: listingsEnriched });
});

app.post('/api/accessories/resell-buy', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });
    const { listingId } = req.body;
    const listingIndex = resaleListings.findIndex(l => String(l.id) === String(listingId));

    if (listingIndex === -1) return res.status(404).json({ error: "Publicación de reventa no encontrada." });

    const listing = resaleListings[listingIndex];
    const isSelfBuy = String(listing.sellerId) === String(req.user.id);

    if (isSelfBuy) {
        // Comprar tu propia oferta de reventa (recuperar el objeto)
        req.user.inventory.push(listing.itemId);
        resaleListings.splice(listingIndex, 1);
        await saveDataToGit();
        return res.json({ success: true, message: "Has retirado/comprado de vuelta tu propia oferta." });
    }

    const seller = users.find(u => String(u.id) === String(listing.sellerId));
    if (!seller) {
        resaleListings.splice(listingIndex, 1);
        await saveDataToGit();
        return res.status(400).json({ error: "El vendedor ya no existe." });
    }

    if ((req.user.coins || 0) < listing.price) {
        return res.status(400).json({ error: "Monedas insuficientes." });
    }

    req.user.coins -= listing.price;
    seller.coins = (seller.coins || 0) + listing.price;
    req.user.inventory.push(listing.itemId);

    resaleListings.splice(listingIndex, 1);
    await saveDataToGit();
    res.json({ success: true, message: "¡Compra de reventa realizada!" });
});

// COMPRA DE MONEDAS CON 💲
app.get('/api/coins/packages', (req, res) => {
    res.json({ packages: currencyPackages });
});

app.post('/api/coins/purchase', authenticateToken, async (req, res) => {
    if (req.user.banned) return res.status(403).json({ error: "Cuenta baneada." });

    const coinsToBuy = parseInt(req.body.coins);
    const pkg = currencyPackages.find(p => p.coins === coinsToBuy);

    if (!pkg) return res.status(400).json({ error: "Paquete de monedas no válido." });

    const currentDollars = req.user.dollars || 0;
    if (currentDollars < pkg.dollars) {
        return res.status(400).json({ error: `Necesitas ${pkg.dollars} 💲 para comprar ${pkg.coins} monedas.` });
    }

    req.user.dollars = currentDollars - pkg.dollars;
    req.user.coins = (req.user.coins || 0) + pkg.coins;

    await saveDataToGit();

    res.json({
        success: true,
        coins: req.user.coins,
        dollars: req.user.dollars
    });
});

// PANEL DE ADMINISTRACIÓN Y REPORTES
app.get('/api/admin/reports', authenticateToken, requireAdmin, (req, res) => {
    const reportedUsers = users
        .filter(u => (u.reports || []).length >= 10)
        .map(u => ({
            id: u.id,
            username: u.username,
            avatar: u.avatar,
            reportsCount: u.reports.length,
            banned: u.banned
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
    res.json({ success: true, message: "Denuncias borradas y usuario removido de la bandeja." });
});

app.post('/api/admin/settings/block-reward', authenticateToken, requireAdmin, async (req, res) => {
    const { itemId } = req.body;
    blockSubscriptionRewardItemId = itemId || null;
    await saveDataToGit();
    res.json({ success: true, blockSubscriptionRewardItemId });
});

app.post('/api/admin/codes/create', authenticateToken, requireAdmin, async (req, res) => {
    const { code, coins, dollars, maxUses, expiresInDays, rewardItemId } = req.body;
    if (!code) return res.status(400).json({ error: "Nombre del código requerido." });

    const expiresAt = expiresInDays ? Date.now() + (parseInt(expiresInDays) * 86400000) : null;

    const newCode = {
        id: Date.now().toString(),
        code: code.trim().toUpperCase(),
        coins: parseInt(coins) || 0,
        dollars: parseInt(dollars) || 0,
        maxUses: maxUses ? parseInt(maxUses) : null,
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
    const { name, imageUrl, price, limited, offsale, onlyBlock, maxPerUser, maxGlobal, expiresInDays } = req.body;
    if (!name || !imageUrl || price === undefined) {
        return res.status(400).json({ error: "Nombre, imagen y precio requeridos." });
    }

    const expiresAt = expiresInDays ? Date.now() + (parseInt(expiresInDays) * 86400000) : null;

    const newTshirt = {
        id: Date.now().toString(),
        name: sanitizeText(name),
        type: "tshirt",
        imageUrl: imageUrl.trim(),
        glbUrl: null,
        price: parseInt(price) || 0,
        limited: Boolean(limited),
        offsale: Boolean(offsale),
        isGhost: false,
        onlyBlock: Boolean(onlyBlock),
        maxPerUser: maxPerUser ? parseInt(maxPerUser) : null,
        maxGlobal: maxGlobal ? parseInt(maxGlobal) : null,
        expiresAt,
        bgColor: null,
        soundUrl: null,
        creatorId: req.user.id,
        creatorUsername: req.user.username,
        createdByAdmin: true
    };

    accessories.push(newTshirt);
    await saveDataToGit();
    res.json({ success: true, tshirt: newTshirt });
});

app.post('/api/admin/accessories/upload', authenticateToken, requireAdmin, upload.single('glb'), async (req, res) => {
    try {
        const { name, limited, offsale, onlyBlock, maxPerUser, maxGlobal, expiresInDays, bgColor, soundUrl, price, imageUrl } = req.body;
        
        if (!req.file || !price || !imageUrl) {
            return res.status(400).json({ error: "Completa el archivo GLB, Precio e Imagen PNG." });
        }

        const glbUrl = '/uploads/' + req.file.filename;
        const expiresAt = expiresInDays ? Date.now() + (parseInt(expiresInDays) * 86400000) : null;

        const newAccessory = {
            id: Date.now().toString(),
            name: sanitizeText(name || "Accesorio 3D"),
            type: "hat",
            imageUrl: imageUrl.trim(),
            glbUrl,
            price: parseInt(price) || 0,
            limited: limited === 'true' || limited === true,
            offsale: offsale === 'true' || offsale === true,
            isGhost: false,
            onlyBlock: onlyBlock === 'true' || onlyBlock === true,
            maxPerUser: maxPerUser ? parseInt(maxPerUser) : 1,
            maxGlobal: maxGlobal ? parseInt(maxGlobal) : null,
            expiresAt,
            bgColor: bgColor ? bgColor.trim() : null,
            soundUrl: soundUrl ? soundUrl.trim() : null,
            creatorId: req.user.id,
            creatorUsername: req.user.username,
            createdByAdmin: true
        };

        accessories.push(newAccessory);
        await saveDataToGit();
        res.json({ success: true, accessory: newAccessory });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/badges/add', authenticateToken, requireAdmin, async (req, res) => {
    const { username, badgeName } = req.body;
    if (!username || !badgeName) return res.status(400).json({ error: "Usuario e insignia requeridos." });

    const target = users.find(u => u.username.toLowerCase() === username.trim().toLowerCase());
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    if (!target.badges) target.badges = [];
    if (!target.badges.includes(badgeName.trim())) {
        target.badges.push(badgeName.trim());
    }

    await saveDataToGit();
    res.json({ success: true, message: "Insignia añadida." });
});

app.post('/api/admin/badges/remove', authenticateToken, requireAdmin, async (req, res) => {
    const { username, badgeName } = req.body;
    if (!username || !badgeName) return res.status(400).json({ error: "Usuario e insignia requeridos." });

    const target = users.find(u => u.username.toLowerCase() === username.trim().toLowerCase());
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    if (target.badges) {
        target.badges = target.badges.filter(b => (typeof b === 'object' ? b.name : b) !== badgeName.trim());
    }

    await saveDataToGit();
    res.json({ success: true, message: "Insignia quitada." });
});

app.post('/api/admin/users/rename', authenticateToken, requireAdmin, async (req, res) => {
    const { targetUsername, newName } = req.body;
    if (!newName) return res.status(400).json({ error: "Nuevo nombre requerido." });

    const target = users.find(u => u.username.toLowerCase() === (targetUsername || "").trim().toLowerCase());
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    const cleanNewName = newName.trim();
    const existing = users.find(u => u.username.toLowerCase() === cleanNewName.toLowerCase() && String(u.id) !== String(target.id));
    if (existing) return res.status(400).json({ error: "Ese nombre ya está en uso." });

    target.username = cleanNewName;
    await saveDataToGit();
    res.json({ success: true, message: "Nombre actualizado." });
});

app.post('/api/admin/users/ban', authenticateToken, requireAdmin, async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: "Nombre de usuario requerido." });

    const target = users.find(u => u.username.toLowerCase() === username.trim().toLowerCase());
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    target.banned = true;
    await saveDataToGit();
    res.json({ success: true, message: "Usuario baneado." });
});

app.post('/api/admin/accessories/edit', authenticateToken, requireAdmin, async (req, res) => {
    const { itemId, price, limited, offsale, isGhost, onlyBlock, bgColor, soundUrl } = req.body;
    if (!itemId) return res.status(400).json({ error: "ID del accesorio requerido." });

    const item = accessories.find(a => String(a.id) === String(itemId));
    if (!item) return res.status(404).json({ error: "Accesorio no encontrado." });

    if (price !== undefined && price !== "") item.price = parseInt(price);
    if (limited !== undefined && limited !== "") item.limited = (limited === 'true' || limited === true);
    if (offsale !== undefined && offsale !== "") item.offsale = (offsale === 'true' || offsale === true);
    if (isGhost !== undefined && isGhost !== "") item.isGhost = (isGhost === 'true' || isGhost === true);
    if (onlyBlock !== undefined && onlyBlock !== "") item.onlyBlock = (onlyBlock === 'true' || onlyBlock === true);

    if (item.type === "tshirt") {
        item.bgColor = null;
        item.soundUrl = null;
    } else {
        if (bgColor !== undefined && bgColor !== "") item.bgColor = bgColor;
        if (soundUrl !== undefined && soundUrl !== "") item.soundUrl = soundUrl;
    }

    await saveDataToGit();
    res.json({ success: true, item });
});

app.post('/api/admin/coins/add', authenticateToken, requireAdmin, async (req, res) => {
    const { username, amount } = req.body;
    if (!username || !amount) return res.status(400).json({ error: "Usuario y cantidad requeridos." });

    const target = users.find(u => u.username.toLowerCase() === username.trim().toLowerCase());
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    target.coins = (target.coins || 0) + parseInt(amount);
    await saveDataToGit();
    res.json({ success: true, newBalance: target.coins });
});

app.post('/api/admin/dollars/add', authenticateToken, requireAdmin, async (req, res) => {
    const { username, amount } = req.body;
    const parsedAmount = parseInt(amount);
    if (!username || !parsedAmount || parsedAmount < 1) {
        return res.status(400).json({ error: "Usuario y cantidad válida requeridos." });
    }

    const target = users.find(u => u.username.toLowerCase() === username.trim().toLowerCase());
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    target.dollars = (target.dollars || 0) + parsedAmount;
    await saveDataToGit();
    res.json({ success: true, newBalance: target.dollars });
});

app.post('/api/admin/banner', authenticateToken, requireAdmin, async (req, res) => {
    bannerText = req.body.text || "";
    await saveDataToGit();
    res.json({ success: true, bannerText });
});

app.get('/api/banner', (req, res) => {
    res.json({ text: bannerText });
});

// Manejador de rutas API no encontradas (garantiza devolver JSON 404 en lugar de HTML)
app.use('/api/*', (req, res) => {
    res.status(404).json({ error: "Ruta de API no encontrada." });
});

// Manejador global de errores (captura excepciones no controladas y responde en JSON)
app.use((err, req, res, next) => {
    console.error("❌ Error en servidor:", err);
    res.status(err.status || 500).json({ error: err.message || "Error interno del servidor." });
});

// Guardado local inmediato al apagar el proceso.
function saveLocalDataSync() {
    try {
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
        fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(dataObj, null, 2), 'utf8');
        console.log("💾 Datos guardados localmente antes del apagado.");
    } catch (err) {
        console.error("❌ No se pudo guardar database.json al apagar:", err.message);
    }
}

process.on('SIGINT', () => {
    saveLocalDataSync();
    process.exit(0);
});

process.on('SIGTERM', () => {
    saveLocalDataSync();
    process.exit(0);
});

// INICIAR SERVIDOR
app.listen(PORT, async () => {
    await loadDataFromGit();
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
