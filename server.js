/** 
 * GAME BLOCKS - server.js
 * ---------------------------------------------------------------------------
 * Backend completo para el frontend de Game Blocks (index.html).
 * Pensado para desplegarse en Render y ser consumido desde:
 *   https://panstudios-github-io-1.onrender.com   (RENDER_API en el frontend)
 *
 * Persistencia: fichero JSON en disco (./data/db.json). Esto es justo lo que
 * garantiza el punto pedido de "al actualizarse todos mantendrán sus cuentas,
 * grupos y el catálogo seguirá igual" -> los datos NO viven en memoria, se
 * guardan en disco en cada escritura y se vuelven a cargar al arrancar, así
 * un redeploy / reinicio del servicio no borra nada.
 *
 * NOTA IMPORTANTE PARA RENDER: los discos de Render "Free" son efímeros en
 * cada deploy si no usas un "Persistent Disk". Si quieres que los datos
 * sobrevivan a los deploys (no solo a los reinicios), añade un Persistent
 * Disk en Render y monta DATA_DIR en él (variable de entorno DATA_DIR).
 * ---------------------------------------------------------------------------
 */

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use("/uploads", express.static(UPLOADS_DIR));

// ---------------------------------------------------------------------------
// BASE DE DATOS (fichero JSON persistente)
// ---------------------------------------------------------------------------

function defaultDb() {
    return {
        users: [],           // { id, username, passwordHash, coins, dollars, admin, owner, badges:[], inventory:[], equippedAccessory, friends:[], friendRequests:[], banned, bannedUntil, blockSub:{active,expiresAt}, turboBlockSub:{active,expiresAt}, profileBgColor, profileSoundUrl, bio, reportsCount, avatarUrl }
        accessories: [],      // { id, name, type, price, limited, offsale, onlyBlock, isGhost, maxPerUser, maxGlobal, expiresAt, totalSold, glbUrl, imageUrl, bgColor, soundUrl, creatorId, creatorUsername, createdByAdmin }
        groups: [],           // { id, name, description, ownerId, members:[], admins:[], pinned, forumEnabled, chatEnabled, membersEnabled, forumPosts:[], groupChatMessages:[], chatSections:[], newsMessages:[] }
        friendChats: {},      // key `${minId}_${maxId}` -> [ {senderId, senderUsername, text, imageUrl, createdAt} ]
        trades: [],           // pending trade offers
        codes: [],            // promo codes
        starCodes: [],        // { code, ownerUsername, ownerId, uses }
        settings: { blockRewardItemId: null, turboBlockRewardItemId: null, bannerText: "", exePath: "" },
        events: [],           // { id, name, description, themeColor, items:[], customHtml, active, createdAt }
        resaleListings: [],   // { id, itemId, sellerId, sellerUsername, price }
        nextId: 1
    };
}

let db = defaultDb();

function loadDb() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const raw = fs.readFileSync(DB_FILE, "utf-8");
            const parsed = JSON.parse(raw);
            db = Object.assign(defaultDb(), parsed);
        } else {
            saveDb();
        }
    } catch (e) {
        console.error("Error cargando la base de datos, se usa una nueva:", e.message);
    }
}

let saveTimer = null;
function saveDb() {
    // Debounce ligero para no escribir a disco en cada micro-cambio
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
        } catch (e) {
            console.error("Error guardando la base de datos:", e.message);
        }
    }, 150);
}

function nextId() {
    const id = db.nextId++;
    saveDb();
    return String(id);
}

loadDb();

// ---------------------------------------------------------------------------
// UTILIDADES
// ---------------------------------------------------------------------------

function hashPassword(password, salt) {
    salt = salt || crypto.randomBytes(16).toString("hex");
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
    return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
    if (!stored || !stored.includes(":")) return false;
    const [salt, hash] = stored.split(":");
    const check = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
    return check === hash;
}

const tokens = new Map(); // token -> userId (en memoria; se recrea al reiniciar y el usuario tendrá que volver a loguearse)

function issueToken(userId) {
    const token = crypto.randomBytes(32).toString("hex");
    tokens.set(token, userId);
    return token;
}

function getUserFromReq(req) {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token || !tokens.has(token)) return null;
    const userId = tokens.get(token);
    return db.users.find(u => u.id === userId) || null;
}

function requireAuth(req, res, next) {
    const user = getUserFromReq(req);
    if (!user) return res.status(401).json({ error: "No autenticado." });
    if (user.banned && !isBanStillActive(user)) {
        // suspensión temporal expirada -> se levanta automáticamente
        user.banned = false;
        user.bannedUntil = null;
        saveDb();
    } else if (user.banned) {
        return res.status(403).json({ error: bannedMessage(user) });
    }
    req.user = user;
    next();
}

function isBanStillActive(user) {
    if (!user.banned) return false;
    if (!user.bannedUntil) return true; // ban permanente
    return Date.now() < user.bannedUntil;
}

function bannedMessage(user) {
    if (user.bannedUntil) {
        const date = new Date(user.bannedUntil).toLocaleString("es-ES");
        return `Tu cuenta está suspendida hasta ${date}.`;
    }
    return "Tu cuenta ha sido baneada permanentemente.";
}

function isAdminUser(user) {
    if (!user) return false;
    if (user.admin || user.owner) return true;
    return (user.badges || []).some(b => {
        const name = (typeof b === "object" ? b.name : b) || "";
        return name.toLowerCase().includes("admin") || name.toLowerCase() === "co-owner";
    });
}

function requireAdmin(req, res, next) {
    const user = getUserFromReq(req);
    if (!user) return res.status(401).json({ error: "No autenticado." });
    if (!isAdminUser(user)) return res.status(403).json({ error: "No tienes permisos de administrador." });
    req.user = user;
    next();
}

function publicUser(u) {
    return {
        id: u.id,
        username: u.username,
        coins: u.coins,
        dollars: u.dollars,
        admin: !!u.admin,
        owner: !!u.owner,
        badges: u.badges || [],
        inventory: u.inventory || [],
        equippedAccessory: u.equippedAccessory || null,
        friends: u.friends || [],
        profileBgColor: u.profileBgColor || null,
        profileSoundUrl: u.profileSoundUrl || null,
        bio: u.bio || "",
        avatarUrl: u.avatarUrl || null,
        blockSub: hasActiveBlock(u),
        turboBlockSub: hasActiveTurboBlock(u),
        banned: !!u.banned
    };
}

function hasActiveBlock(u) {
    const b = u.blockSub;
    const t = u.turboBlockSub;
    const blockActive = !!(b && b.active && b.expiresAt > Date.now());
    const turboActive = !!(t && t.active && t.expiresAt > Date.now());
    return blockActive || turboActive; // turbo incluye todos los beneficios de block
}

function hasActiveTurboBlock(u) {
    const t = u.turboBlockSub;
    return !!(t && t.active && t.expiresAt > Date.now());
}

function findUserByUsername(username) {
    if (!username) return null;
    return db.users.find(u => u.username.toLowerCase() === username.toLowerCase()) || null;
}

function findItem(itemId) {
    return db.accessories.find(a => String(a.id) === String(itemId)) || null;
}

function itemSoldCount(itemId) {
    return db.accessories.find(a => String(a.id) === String(itemId))?.totalSold || 0;
}

// ---------------------------------------------------------------------------
// SUBIDA DE ARCHIVOS (GLB, imágenes de tienda, imágenes de chat)
// ---------------------------------------------------------------------------

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || "";
        cb(null, `${Date.now()}_${crypto.randomBytes(6).toString("hex")}${ext}`);
    }
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

function fileUrl(req, filename) {
    return `/uploads/${filename}`;
}

// ---------------------------------------------------------------------------
// AUTENTICACIÓN
// ---------------------------------------------------------------------------

app.post("/api/register", (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password || username.length < 3 || password.length < 4) {
        return res.status(400).json({ error: "Usuario o contraseña inválidos (mín. 3/4 caracteres)." });
    }
    if (findUserByUsername(username)) {
        return res.status(400).json({ error: "Ese nombre de usuario ya existe." });
    }
    const user = {
        id: nextId(),
        username,
        passwordHash: hashPassword(password),
        coins: 100,
        dollars: 0,
        admin: db.users.length === 0, // el primer usuario registrado es admin/owner por defecto
        owner: db.users.length === 0,
        badges: [],
        inventory: [],
        equippedAccessory: null,
        friends: [],
        friendRequests: [],
        banned: false,
        bannedUntil: null,
        blockSub: { active: false, expiresAt: 0 },
        turboBlockSub: { active: false, expiresAt: 0 },
        profileBgColor: null,
        profileSoundUrl: null,
        bio: "",
        avatarUrl: null,
        reportsCount: 0,
        lastDailyClaim: 0,
        createdAt: Date.now()
    };
    db.users.push(user);
    saveDb();
    const token = issueToken(user.id);
    res.json({ token, user: publicUser(user) });
});

app.post("/api/login", (req, res) => {
    const { username, password } = req.body || {};
    const user = findUserByUsername(username);
    if (!user || !verifyPassword(password, user.passwordHash)) {
        return res.status(400).json({ error: "Usuario o contraseña incorrectos." });
    }
    if (isBanStillActive(user)) {
        return res.status(403).json({ error: bannedMessage(user) });
    }
    const token = issueToken(user.id);
    res.json({ token, user: publicUser(user) });
});

app.get("/api/me", requireAuth, (req, res) => {
    grantDailyCoinsIfNeeded(req.user);
    res.json(publicUser(req.user));
});

function grantDailyCoinsIfNeeded(user) {
    const now = new Date();
    const todayKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}`;
    if (user._lastDailyKey === todayKey) return;
    let amount = 10;
    if (hasActiveTurboBlock(user)) amount = 50;
    else if (hasActiveBlock(user)) amount = 34;
    user.coins += amount;
    user._lastDailyKey = todayKey;
    saveDb();
}

// ---------------------------------------------------------------------------
// MONEDAS: PAQUETES, COMPRA Y STAR CODES
// ---------------------------------------------------------------------------

// Los paquetes bonus pedidos:
// Paquete 1: sin bonus (base)
// Paquete 2: 500 -> +50 (550)
// Paquete 3: 1000 -> +100 (1100)
// Paquete 4: 2500 -> +500 (3000)
// Paquete 5: 6000 -> +1000 (7000)
const COIN_PACKAGES = [
    { coins: 100, dollars: 1, bonus: 0 },
    { coins: 500, dollars: 4, bonus: 50 },
    { coins: 1000, dollars: 8, bonus: 100 },
    { coins: 2500, dollars: 18, bonus: 500 },
    { coins: 6000, dollars: 40, bonus: 1000 }
];

app.get("/api/coins/packages", (req, res) => {
    res.json({ packages: COIN_PACKAGES });
});

app.post("/api/coins/purchase", requireAuth, (req, res) => {
    const { coins, starCode } = req.body || {};
    const pkg = COIN_PACKAGES.find(p => Number(p.coins) === Number(coins));
    if (!pkg) return res.status(400).json({ error: "Paquete no válido." });

    const user = req.user;
    if (user.dollars < pkg.dollars) {
        return res.status(400).json({ error: "No tienes 💲 suficientes para este paquete." });
    }

    let totalCoins = pkg.coins + (pkg.bonus || 0);
    let starCodeApplied = null;

    user.dollars -= pkg.dollars;

    if (starCode && starCode.trim()) {
        const sc = db.starCodes.find(c => c.code.toLowerCase() === starCode.trim().toLowerCase());
        if (!sc) {
            saveDb();
            return res.status(400).json({ error: "Star Code no válido." });
        }
        const bonusCoins = Math.round(pkg.coins * 0.10);
        totalCoins += bonusCoins;
        starCodeApplied = sc.code;

        // El 10% de las monedas (en valor equivalente de 💲) va a la cuenta asociada
        const ownerAccount = db.users.find(u => u.id === sc.ownerId) || findUserByUsername(sc.ownerUsername);
        if (ownerAccount && ownerAccount.id !== user.id) {
            const dollarShare = Math.max(1, Math.round(pkg.dollars * 0.10));
            ownerAccount.dollars += dollarShare;
        }
        sc.uses = (sc.uses || 0) + 1;
    }

    user.coins += totalCoins;
    saveDb();
    res.json({ coins: user.coins, dollars: user.dollars, starCodeApplied });
});

// ---------------------------------------------------------------------------
// SUSCRIPCIONES: BLOCK Y TURBO BLOCK
// ---------------------------------------------------------------------------

const BLOCK_PRICE_DOLLARS = 5;
const TURBO_BLOCK_PRICE_DOLLARS = 10;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

app.post("/api/subscription/buy-block", requireAuth, (req, res) => {
    const user = req.user;
    if (user.dollars < BLOCK_PRICE_DOLLARS) {
        return res.status(400).json({ error: "No tienes 💲 suficientes." });
    }
    user.dollars -= BLOCK_PRICE_DOLLARS;
    const alreadyHad = hasActiveBlock(user);
    const base = user.blockSub && user.blockSub.expiresAt > Date.now() ? user.blockSub.expiresAt : Date.now();
    user.blockSub = { active: true, expiresAt: base + THIRTY_DAYS_MS };

    let freeItemGiven = null;
    if (!alreadyHad && db.settings.blockRewardItemId) {
        const item = findItem(db.settings.blockRewardItemId);
        if (item) {
            user.inventory.push(item.id);
            item.totalSold = (item.totalSold || 0) + 1;
            freeItemGiven = item.name;
        }
    }
    saveDb();
    res.json({ message: "¡Suscripción Block activada!", dollars: user.dollars, freeItemGiven });
});

app.post("/api/subscription/buy-turbo-block", requireAuth, (req, res) => {
    const user = req.user;
    if (user.dollars < TURBO_BLOCK_PRICE_DOLLARS) {
        return res.status(400).json({ error: "No tienes 💲 suficientes." });
    }
    user.dollars -= TURBO_BLOCK_PRICE_DOLLARS;
    const alreadyHad = hasActiveTurboBlock(user);
    const base = user.turboBlockSub && user.turboBlockSub.expiresAt > Date.now() ? user.turboBlockSub.expiresAt : Date.now();
    user.turboBlockSub = { active: true, expiresAt: base + THIRTY_DAYS_MS };

    let freeItemGiven = null;
    if (!alreadyHad && db.settings.turboBlockRewardItemId) {
        const item = findItem(db.settings.turboBlockRewardItemId);
        if (item) {
            user.inventory.push(item.id);
            item.totalSold = (item.totalSold || 0) + 1;
            freeItemGiven = item.name;
        }
    }
    saveDb();
    res.json({ message: "¡Suscripción Turbo Block activada!", dollars: user.dollars, freeItemGiven });
});

// ---------------------------------------------------------------------------
// CATÁLOGO / ACCESORIOS
// ---------------------------------------------------------------------------

app.get("/api/accessories", (req, res) => {
    const items = db.accessories.filter(a => !a.isGhost);
    res.json({ items });
});

app.get("/api/accessories/all", (req, res) => {
    res.json({ items: db.accessories });
});

app.post("/api/accessories/buy", requireAuth, (req, res) => {
    const { itemId } = req.body || {};
    const item = findItem(itemId);
    if (!item) return res.status(404).json({ error: "Artículo no encontrado." });
    if (item.offsale) return res.status(400).json({ error: "Este artículo no está a la venta." });
    if (item.expiresAt && Date.now() > item.expiresAt) return res.status(400).json({ error: "Este artículo ya no está disponible." });

    const user = req.user;
    if (item.onlyBlock === "turbo" && !hasActiveTurboBlock(user)) {
        return res.status(403).json({ error: "Este artículo requiere Suscripción Turbo Block." });
    }
    if (item.onlyBlock === true && !hasActiveBlock(user)) {
        return res.status(403).json({ error: "Este artículo requiere Suscripción Block." });
    }
    if (item.limited) {
        const ownedCount = user.inventory.filter(id => String(id) === String(item.id)).length;
        if (item.maxPerUser && ownedCount >= item.maxPerUser) {
            return res.status(400).json({ error: "Ya tienes el máximo de copias permitidas de este artículo." });
        }
        if (item.maxGlobal != null && (item.totalSold || 0) >= item.maxGlobal) {
            return res.status(400).json({ error: "Este artículo limitado se ha agotado." });
        }
    }
    if (user.coins < item.price) {
        return res.status(400).json({ error: "No tienes monedas suficientes." });
    }

    user.coins -= item.price;
    user.inventory.push(item.id);
    item.totalSold = (item.totalSold || 0) + 1;
    saveDb();
    res.json({ newBalance: user.coins });
});

app.post("/api/accessories/equip", requireAuth, (req, res) => {
    const { itemId } = req.body || {};
    const user = req.user;
    if (!user.inventory.some(id => String(id) === String(itemId))) {
        return res.status(400).json({ error: "No posees este artículo." });
    }
    const item = findItem(itemId);
    user.equippedAccessory = itemId;
    saveDb();
    res.json({ profileBgColor: item?.bgColor || null, profileSoundUrl: item?.soundUrl || null });
});

app.post("/api/accessories/unequip", requireAuth, (req, res) => {
    req.user.equippedAccessory = null;
    saveDb();
    res.json({ ok: true });
});

app.post("/api/accessories/sell", requireAuth, (req, res) => {
    const { itemId } = req.body || {};
    const user = req.user;
    const idx = user.inventory.findIndex(id => String(id) === String(itemId));
    if (idx === -1) return res.status(400).json({ error: "No posees este artículo." });
    const item = findItem(itemId);
    const refundAmount = Math.floor((item?.price || 0) * 0.5);
    user.inventory.splice(idx, 1);
    if (String(user.equippedAccessory) === String(itemId)) user.equippedAccessory = null;
    user.coins += refundAmount;
    saveDb();
    res.json({ refundAmount, newBalance: user.coins });
});

app.get("/api/accessories/resale-market", (req, res) => {
    res.json({ listings: db.resaleListings });
});

app.post("/api/accessories/resell-list", requireAuth, (req, res) => {
    const { itemId, price } = req.body || {};
    const user = req.user;
    const item = findItem(itemId);
    if (!item || !item.limited || !item.offsale) return res.status(400).json({ error: "Solo se pueden revender Limiteds Offsale." });
    if (!user.inventory.some(id => String(id) === String(itemId))) return res.status(400).json({ error: "No posees este artículo." });

    const listing = { id: nextId(), itemId, sellerId: user.id, sellerUsername: user.username, price: Number(price) || 0 };
    db.resaleListings.push(listing);
    saveDb();
    res.json({ listing });
});

app.post("/api/accessories/resell-buy", requireAuth, (req, res) => {
    const { listingId } = req.body || {};
    const listing = db.resaleListings.find(l => String(l.id) === String(listingId));
    if (!listing) return res.status(404).json({ error: "Anuncio no encontrado." });
    const buyer = req.user;
    const seller = db.users.find(u => u.id === listing.sellerId);
    if (buyer.coins < listing.price) return res.status(400).json({ error: "No tienes monedas suficientes." });

    const idx = seller ? seller.inventory.findIndex(id => String(id) === String(listing.itemId)) : -1;
    if (seller && idx !== -1) seller.inventory.splice(idx, 1);
    buyer.coins -= listing.price;
    if (seller) seller.coins += listing.price;
    buyer.inventory.push(listing.itemId);

    db.resaleListings = db.resaleListings.filter(l => l.id !== listing.id);
    saveDb();
    res.json({ ok: true, newBalance: buyer.coins });
});

// ---------------------------------------------------------------------------
// CAMISETAS (T-SHIRTS)
// ---------------------------------------------------------------------------

app.post("/api/tshirts/upload", requireAuth, (req, res) => {
    const { name, imageUrl, price, onlyBlock } = req.body || {};
    if (!name || !imageUrl) return res.status(400).json({ error: "Faltan datos." });
    const item = {
        id: nextId(),
        name,
        type: "tshirt",
        imageUrl,
        price: Number(price) || 0,
        limited: false,
        offsale: false,
        onlyBlock: onlyBlock === true || onlyBlock === "true",
        isGhost: false,
        totalSold: 0,
        creatorId: req.user.id,
        creatorUsername: req.user.username,
        createdByAdmin: false
    };
    db.accessories.push(item);
    saveDb();
    res.json({ item });
});

app.post("/api/admin/tshirts/upload", requireAdmin, (req, res) => {
    const { name, limited, maxPerUser, maxGlobal, expiresInDays, offsale, onlyBlock, imageUrl, price } = req.body || {};
    const item = {
        id: nextId(),
        name,
        type: "tshirt",
        imageUrl,
        price: Number(price) || 0,
        limited: !!limited,
        offsale: !!offsale,
        onlyBlock: onlyBlock === true || onlyBlock === "true",
        maxPerUser: limited ? Number(maxPerUser) || 1 : null,
        maxGlobal: limited && maxGlobal ? Number(maxGlobal) : null,
        expiresAt: limited && expiresInDays ? Date.now() + Number(expiresInDays) * 86400000 : null,
        isGhost: false,
        totalSold: 0,
        creatorUsername: "Admin",
        createdByAdmin: true
    };
    db.accessories.push(item);
    saveDb();
    res.json({ item });
});

// ---------------------------------------------------------------------------
// ACCESORIOS 3D (Admin)
// ---------------------------------------------------------------------------

app.post("/api/admin/accessories/upload", requireAdmin, upload.single("glb"), (req, res) => {
    const b = req.body || {};
    const limited = b.limited === "true" || b.limited === true;
    const item = {
        id: nextId(),
        name: b.name,
        type: "hat",
        glbUrl: fileUrl(req, req.file.filename),
        imageUrl: b.imageUrl || "",
        price: Number(b.price) || 0,
        limited,
        offsale: b.offsale === "true" || b.offsale === true,
        onlyBlock: b.onlyBlock === "true" || b.onlyBlock === true,
        maxPerUser: limited ? Number(b.maxPerUser) || 1 : null,
        maxGlobal: limited && b.maxGlobal ? Number(b.maxGlobal) : null,
        expiresAt: limited && b.expiresInDays ? Date.now() + Number(b.expiresInDays) * 86400000 : null,
        bgColor: b.bgColor || null,
        soundUrl: b.soundUrl || null,
        isGhost: false,
        totalSold: 0,
        creatorUsername: "Admin",
        createdByAdmin: true
    };
    db.accessories.push(item);
    saveDb();
    res.json({ item });
});

app.post("/api/admin/accessories/edit", requireAdmin, (req, res) => {
    const { itemId, price, limited, offsale, isGhost, onlyBlock, bgColor, soundUrl } = req.body || {};
    const item = findItem(itemId);
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

    saveDb();
    res.json({ item });
});

// ---------------------------------------------------------------------------
// PERFIL, AVATAR, BIO
// ---------------------------------------------------------------------------

app.post("/api/profile/avatar", requireAuth, (req, res) => {
    const { avatarUrl } = req.body || {};
    req.user.avatarUrl = avatarUrl;
    saveDb();
    res.json({ ok: true });
});

app.post("/api/profile/bio", requireAuth, (req, res) => {
    const { bio } = req.body || {};
    req.user.bio = (bio || "").slice(0, 500);
    saveDb();
    res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// AMIGOS
// ---------------------------------------------------------------------------

app.get("/api/friends", requireAuth, (req, res) => {
    const friends = (req.user.friends || []).map(id => {
        const u = db.users.find(x => x.id === id);
        return u ? { id: u.id, username: u.username } : null;
    }).filter(Boolean);
    res.json({ friends });
});

app.get("/api/friends/requests", requireAuth, (req, res) => {
    const requests = (req.user.friendRequests || []).map(id => {
        const u = db.users.find(x => x.id === id);
        return u ? { id: u.id, username: u.username } : null;
    }).filter(Boolean);
    res.json({ requests });
});

app.post("/api/friends/request", requireAuth, (req, res) => {
    const { username } = req.body || {};
    const target = findUserByUsername(username);
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });
    if (target.id === req.user.id) return res.status(400).json({ error: "No puedes añadirte a ti mismo." });
    target.friendRequests = target.friendRequests || [];
    if (!target.friendRequests.includes(req.user.id)) target.friendRequests.push(req.user.id);
    saveDb();
    res.json({ ok: true });
});

app.post("/api/friends/accept", requireAuth, (req, res) => {
    const { userId } = req.body || {};
    const user = req.user;
    user.friendRequests = (user.friendRequests || []).filter(id => id !== userId);
    user.friends = user.friends || [];
    if (!user.friends.includes(userId)) user.friends.push(userId);
    const other = db.users.find(u => u.id === userId);
    if (other) {
        other.friends = other.friends || [];
        if (!other.friends.includes(user.id)) other.friends.push(user.id);
    }
    saveDb();
    res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// CHAT PRIVADO (AMIGOS)
// ---------------------------------------------------------------------------

function chatKey(idA, idB) {
    const [a, b] = [String(idA), String(idB)].sort();
    return `${a}_${b}`;
}

app.get("/api/chat/messages/:friendId", requireAuth, (req, res) => {
    const key = chatKey(req.user.id, req.params.friendId);
    res.json({ messages: db.friendChats[key] || [] });
});

app.post("/api/chat/send", requireAuth, (req, res) => {
    const { friendId, text } = req.body || {};
    const key = chatKey(req.user.id, friendId);
    db.friendChats[key] = db.friendChats[key] || [];
    db.friendChats[key].push({
        senderId: req.user.id,
        senderUsername: req.user.username,
        text: String(text).slice(0, 1000),
        createdAt: Date.now()
    });
    saveDb();
    res.json({ ok: true });
});

app.post("/api/chat/upload", requireAuth, upload.single("image"), (req, res) => {
    const user = req.user;
    if (!hasActiveTurboBlock(user)) {
        return res.status(403).json({ error: "Subir imágenes al chat requiere Suscripción Turbo Block." });
    }
    const { friendId, groupId, sectionId } = req.body || {};
    if (!req.file) return res.status(400).json({ error: "No se recibió ninguna imagen." });
    const imageUrl = fileUrl(req, req.file.filename);

    if (groupId) {
        const group = db.groups.find(g => String(g.id) === String(groupId));
        if (!group) return res.status(404).json({ error: "Grupo no encontrado." });
        group.groupChatMessages = group.groupChatMessages || [];
        group.groupChatMessages.push({
            senderUsername: user.username,
            senderId: user.id,
            text: "",
            imageUrl,
            sectionId: sectionId || "general",
            createdAt: Date.now()
        });
    } else if (friendId) {
        const key = chatKey(user.id, friendId);
        db.friendChats[key] = db.friendChats[key] || [];
        db.friendChats[key].push({
            senderId: user.id,
            senderUsername: user.username,
            text: "",
            imageUrl,
            createdAt: Date.now()
        });
    } else {
        return res.status(400).json({ error: "Falta el destinatario (friendId o groupId)." });
    }

    saveDb();
    res.json({ ok: true, imageUrl });
});

// ---------------------------------------------------------------------------
// GRUPOS
// ---------------------------------------------------------------------------

const GROUP_CREATE_COST = 100;

app.get("/api/groups", (req, res) => {
    res.json({ groups: db.groups });
});

app.get("/api/groups/:id", (req, res) => {
    const group = db.groups.find(g => String(g.id) === String(req.params.id));
    if (!group) return res.status(404).json({ error: "Grupo no encontrado." });
    res.json(group);
});

app.post("/api/groups/create", requireAuth, (req, res) => {
    const { name, description } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: "El grupo necesita un nombre." });
    const user = req.user;
    if (user.coins < GROUP_CREATE_COST) return res.status(400).json({ error: "No tienes monedas suficientes para crear un grupo." });

    user.coins -= GROUP_CREATE_COST;
    const group = {
        id: nextId(),
        name: name.trim(),
        description: description || "",
        ownerId: user.id,
        members: [user.id],
        admins: [],
        pinned: false,
        forumEnabled: false,
        chatEnabled: true,
        membersEnabled: true,
        forumPosts: [],
        groupChatMessages: [],
        chatSections: [{ id: "general", name: "General" }],
        newsMessages: [],
        bannedMembers: []
    };
    db.groups.push(group);
    saveDb();
    res.json({ group, newBalance: user.coins });
});

app.post("/api/groups/:id/join", requireAuth, (req, res) => {
    const group = db.groups.find(g => String(g.id) === String(req.params.id));
    if (!group) return res.status(404).json({ error: "Grupo no encontrado." });
    if ((group.bannedMembers || []).includes(req.user.id)) {
        return res.status(403).json({ error: "Has sido baneado de este grupo." });
    }
    if (!group.members.includes(req.user.id)) group.members.push(req.user.id);
    saveDb();
    res.json({ message: "Te has unido al grupo." });
});

app.post("/api/groups/:id/ban-member", requireAuth, (req, res) => {
    const group = db.groups.find(g => String(g.id) === String(req.params.id));
    if (!group) return res.status(404).json({ error: "Grupo no encontrado." });
    const isOwner = String(group.ownerId) === String(req.user.id);
    const isAdmin = (group.admins || []).includes(req.user.id);
    if (!isOwner && !isAdmin) return res.status(403).json({ error: "No tienes permisos en este grupo." });

    const { memberId } = req.body || {};
    group.members = group.members.filter(id => String(id) !== String(memberId));
    group.bannedMembers = group.bannedMembers || [];
    if (!group.bannedMembers.includes(memberId)) group.bannedMembers.push(memberId);
    saveDb();
    res.json({ ok: true });
});

app.post("/api/groups/:id/admins", requireAuth, (req, res) => {
    const group = db.groups.find(g => String(g.id) === String(req.params.id));
    if (!group) return res.status(404).json({ error: "Grupo no encontrado." });
    if (String(group.ownerId) !== String(req.user.id)) return res.status(403).json({ error: "Solo el dueño puede gestionar admins." });

    const { memberId, action } = req.body || {};
    group.admins = group.admins || [];
    if (action === "add" && !group.admins.includes(memberId)) group.admins.push(memberId);
    if (action === "remove") group.admins = group.admins.filter(id => String(id) !== String(memberId));
    saveDb();
    res.json({ ok: true });
});

app.post("/api/groups/:id/settings", requireAuth, (req, res) => {
    const group = db.groups.find(g => String(g.id) === String(req.params.id));
    if (!group) return res.status(404).json({ error: "Grupo no encontrado." });
    const isOwner = String(group.ownerId) === String(req.user.id);
    const isAdmin = (group.admins || []).includes(req.user.id);
    if (!isOwner && !isAdmin) return res.status(403).json({ error: "No tienes permisos en este grupo." });

    ["forumEnabled", "chatEnabled", "membersEnabled"].forEach(key => {
        if (req.body[key] !== undefined) group[key] = !!req.body[key];
    });
    saveDb();
    res.json({ group });
});

// --- Secciones de chat de grupo (tipo canales) ---
app.post("/api/groups/:id/chat/sections", requireAuth, (req, res) => {
    const group = db.groups.find(g => String(g.id) === String(req.params.id));
    if (!group) return res.status(404).json({ error: "Grupo no encontrado." });
    const isOwner = String(group.ownerId) === String(req.user.id);
    const isAdmin = (group.admins || []).includes(req.user.id);
    if (!isOwner && !isAdmin) return res.status(403).json({ error: "Solo el dueño o admins pueden crear secciones." });

    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: "La sección necesita un nombre." });

    group.chatSections = group.chatSections || [{ id: "general", name: "General" }];
    const section = { id: nextId(), name: name.trim() };
    group.chatSections.push(section);
    saveDb();
    res.json({ section });
});

app.post("/api/groups/:id/chat/send", requireAuth, (req, res) => {
    const group = db.groups.find(g => String(g.id) === String(req.params.id));
    if (!group) return res.status(404).json({ error: "Grupo no encontrado." });
    if (!group.members.includes(req.user.id)) return res.status(403).json({ error: "No eres miembro de este grupo." });
    if (!group.chatEnabled) return res.status(403).json({ error: "El chat está desactivado en este grupo." });

    const { text, sectionId } = req.body || {};
    group.groupChatMessages = group.groupChatMessages || [];
    group.groupChatMessages.push({
        senderUsername: req.user.username,
        senderId: req.user.id,
        text: String(text).slice(0, 1000),
        sectionId: sectionId || "general",
        createdAt: Date.now()
    });
    saveDb();
    res.json({ ok: true });
});

app.post("/api/groups/:id/news/send", requireAuth, (req, res) => {
    const group = db.groups.find(g => String(g.id) === String(req.params.id));
    if (!group) return res.status(404).json({ error: "Grupo no encontrado." });
    const isOwner = String(group.ownerId) === String(req.user.id);
    const isAdmin = (group.admins || []).includes(req.user.id);
    if (!isOwner && !isAdmin) return res.status(403).json({ error: "Solo el dueño o admins pueden publicar noticias." });

    const { text } = req.body || {};
    group.newsMessages = group.newsMessages || [];
    group.newsMessages.push({ senderUsername: req.user.username, text: String(text).slice(0, 1000), createdAt: Date.now() });
    saveDb();
    res.json({ ok: true });
});

// --- Foros con chat por tema ---
app.post("/api/groups/:id/forum", requireAuth, (req, res) => {
    const group = db.groups.find(g => String(g.id) === String(req.params.id));
    if (!group) return res.status(404).json({ error: "Grupo no encontrado." });
    if (!group.forumEnabled) return res.status(403).json({ error: "El foro está desactivado en este grupo." });

    const { title, content } = req.body || {};
    if (!title || !content) return res.status(400).json({ error: "Faltan datos del tema." });

    const post = {
        id: nextId(),
        title: title.slice(0, 150),
        content: content.slice(0, 3000),
        authorId: req.user.id,
        authorUsername: req.user.username,
        createdAt: Date.now(),
        messages: []
    };
    group.forumPosts = group.forumPosts || [];
    group.forumPosts.push(post);
    saveDb();
    res.json({ post });
});

app.post("/api/groups/:id/forum/:postId/messages", requireAuth, (req, res) => {
    const group = db.groups.find(g => String(g.id) === String(req.params.id));
    if (!group) return res.status(404).json({ error: "Grupo no encontrado." });
    const post = (group.forumPosts || []).find(p => String(p.id) === String(req.params.postId));
    if (!post) return res.status(404).json({ error: "Tema de foro no encontrado." });

    const { text } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: "El mensaje no puede estar vacío." });

    post.messages = post.messages || [];
    post.messages.push({
        senderId: req.user.id,
        senderUsername: req.user.username,
        text: text.slice(0, 1000),
        createdAt: Date.now()
    });
    saveDb();
    res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// CÓDIGOS PROMOCIONALES
// ---------------------------------------------------------------------------

app.post("/api/codes/redeem", requireAuth, (req, res) => {
    const { code } = req.body || {};
    const promo = db.codes.find(c => c.code.toLowerCase() === String(code).toLowerCase());
    if (!promo) return res.status(404).json({ error: "Código no válido." });
    if (promo.expiresAt && Date.now() > promo.expiresAt) return res.status(400).json({ error: "Este código ha expirado." });
    if (promo.maxUses && (promo.uses || 0) >= promo.maxUses) return res.status(400).json({ error: "Este código ha alcanzado su límite de usos." });
    if ((promo.redeemedBy || []).includes(req.user.id)) return res.status(400).json({ error: "Ya has usado este código." });

    const user = req.user;
    user.coins += Number(promo.coins) || 0;
    user.dollars += Number(promo.dollars) || 0;
    let rewardItemName = null;
    if (promo.rewardItemId) {
        const item = findItem(promo.rewardItemId);
        if (item) {
            user.inventory.push(item.id);
            item.totalSold = (item.totalSold || 0) + 1;
            rewardItemName = item.name;
        }
    }
    promo.uses = (promo.uses || 0) + 1;
    promo.redeemedBy = promo.redeemedBy || [];
    promo.redeemedBy.push(user.id);
    saveDb();
    res.json({ message: "Código canjeado con éxito.", coins: user.coins, dollars: user.dollars, rewardItemName });
});

// ---------------------------------------------------------------------------
// TRADES (INTERCAMBIOS DE LIMITEDS)
// ---------------------------------------------------------------------------

app.get("/api/trade/pending", requireAuth, (req, res) => {
    const pending = db.trades.filter(t => t.toUserId === req.user.id && t.status === "pending");
    res.json({ trades: pending });
});

app.post("/api/trade/offer", requireAuth, (req, res) => {
    const { toUsername, giveItemId, giveCoins, getItemId, getCoins } = req.body || {};
    const toUser = findUserByUsername(toUsername);
    if (!toUser) return res.status(404).json({ error: "Usuario no encontrado." });

    const trade = {
        id: nextId(),
        fromUserId: req.user.id,
        fromUsername: req.user.username,
        toUserId: toUser.id,
        giveItemId, giveCoins: Number(giveCoins) || 0,
        getItemId, getCoins: Number(getCoins) || 0,
        status: "pending",
        createdAt: Date.now()
    };
    db.trades.push(trade);
    saveDb();
    res.json({ trade });
});

app.post("/api/trade/accept", requireAuth, (req, res) => {
    const { tradeId } = req.body || {};
    const trade = db.trades.find(t => String(t.id) === String(tradeId));
    if (!trade || trade.status !== "pending") return res.status(404).json({ error: "Oferta no encontrada o ya resuelta." });

    const fromUser = db.users.find(u => u.id === trade.fromUserId);
    const toUser = req.user;
    if (String(trade.toUserId) !== String(toUser.id)) return res.status(403).json({ error: "Esta oferta no es para ti." });

    if (trade.giveCoins > fromUser.coins || trade.getCoins > toUser.coins) {
        return res.status(400).json({ error: "Alguna de las partes no tiene monedas suficientes." });
    }

    // Intercambiar items
    if (trade.giveItemId) {
        const idx = fromUser.inventory.findIndex(id => String(id) === String(trade.giveItemId));
        if (idx !== -1) { fromUser.inventory.splice(idx, 1); toUser.inventory.push(trade.giveItemId); }
    }
    if (trade.getItemId) {
        const idx = toUser.inventory.findIndex(id => String(id) === String(trade.getItemId));
        if (idx !== -1) { toUser.inventory.splice(idx, 1); fromUser.inventory.push(trade.getItemId); }
    }
    fromUser.coins -= trade.giveCoins;
    toUser.coins += trade.giveCoins;
    toUser.coins -= trade.getCoins;
    fromUser.coins += trade.getCoins;

    trade.status = "accepted";
    saveDb();
    res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// JUEGO: CÓDIGO DE VINCULACIÓN (login desde el ejecutable)
// ---------------------------------------------------------------------------

app.post("/api/game/create-code", requireAuth, (req, res) => {
    const code = crypto.randomBytes(3).toString("hex").toUpperCase();
    db.gameLinkCodes = db.gameLinkCodes || {};
    db.gameLinkCodes[code] = { userId: req.user.id, createdAt: Date.now() };
    saveDb();
    res.json({ code });
});

// ---------------------------------------------------------------------------
// BANNER
// ---------------------------------------------------------------------------

app.get("/api/banner", (req, res) => res.json({ text: db.settings.bannerText || "" }));

app.post("/api/admin/banner", requireAdmin, (req, res) => {
    db.settings.bannerText = (req.body && req.body.text) || "";
    saveDb();
    res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// EVENTOS
// ---------------------------------------------------------------------------

app.get("/api/events/active", (req, res) => {
    const event = db.events.find(e => e.active);
    res.json({ event: event || null });
});

app.post("/api/admin/events/save", requireAdmin, (req, res) => {
    const { name, description, themeColor, items, customHtml, active } = req.body || {};
    // Solo un evento puede estar activo a la vez
    if (active) db.events.forEach(e => (e.active = false));

    const event = {
        id: nextId(),
        name: name || "Evento Especial",
        description: description || "",
        themeColor: themeColor || "#ffd700",
        items: Array.isArray(items) ? items : [],
        customHtml: customHtml || "",
        active: !!active,
        createdAt: Date.now()
    };
    db.events.push(event);
    saveDb();
    res.json({ event });
});

app.post("/api/admin/events/delete", requireAdmin, (req, res) => {
    db.events = db.events.filter(e => !e.active);
    saveDb();
    res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// STAR CODES
// ---------------------------------------------------------------------------

app.post("/api/admin/starcodes/create", requireAdmin, (req, res) => {
    const { code, ownerUsername } = req.body || {};
    if (!code || !ownerUsername) return res.status(400).json({ error: "Faltan datos." });
    const owner = findUserByUsername(ownerUsername);
    if (!owner) return res.status(404).json({ error: "Usuario asociado no encontrado." });
    if (db.starCodes.some(c => c.code.toLowerCase() === code.toLowerCase())) {
        return res.status(400).json({ error: "Ese Star Code ya existe." });
    }
    const starCode = { code, ownerId: owner.id, ownerUsername: owner.username, uses: 0 };
    db.starCodes.push(starCode);
    saveDb();
    res.json({ starCode });
});

// ---------------------------------------------------------------------------
// ADMIN: USUARIOS, INSIGNIAS, BANEOS
// ---------------------------------------------------------------------------

app.post("/api/admin/users/rename", requireAdmin, (req, res) => {
    const { targetUsername, newName } = req.body || {};
    const user = findUserByUsername(targetUsername);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });
    if (findUserByUsername(newName)) return res.status(400).json({ error: "Ese nombre ya está en uso." });
    user.username = newName;
    saveDb();
    res.json({ ok: true });
});

app.post("/api/admin/badges/add", requireAdmin, (req, res) => {
    const { username, badgeName } = req.body || {};
    const user = findUserByUsername(username);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });
    user.badges = user.badges || [];
    if (!user.badges.some(b => (typeof b === "object" ? b.name : b) === badgeName)) {
        user.badges.push({ name: badgeName, addedAt: Date.now() });
    }
    if (badgeName === "co-owner") user.owner = true; // el co-owner obtiene también acceso de administración
    saveDb();
    res.json({ ok: true });
});

app.post("/api/admin/badges/remove", requireAdmin, (req, res) => {
    const { username, badgeName } = req.body || {};
    const user = findUserByUsername(username);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });
    user.badges = (user.badges || []).filter(b => (typeof b === "object" ? b.name : b) !== badgeName);
    saveDb();
    res.json({ ok: true });
});

app.post("/api/admin/users/ban", requireAdmin, (req, res) => {
    const { username, days } = req.body || {};
    const user = findUserByUsername(username);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });
    if (isAdminUser(user) && !req.user.owner) {
        return res.status(403).json({ error: "No puedes banear a otro administrador." });
    }
    user.banned = true;
    user.bannedUntil = days ? Date.now() + Number(days) * 86400000 : null;
    saveDb();
    res.json({
        message: days
            ? `Usuario suspendido durante ${days} día(s).`
            : "Usuario baneado permanentemente."
    });
});

app.post("/api/admin/users/unban", requireAdmin, (req, res) => {
    const { username } = req.body || {};
    const user = findUserByUsername(username);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });
    user.banned = false;
    user.bannedUntil = null;
    saveDb();
    res.json({ message: "Usuario desbaneado correctamente." });
});

app.post("/api/account/delete-banned", requireAuth, (req, res) => {
    // Un usuario baneado puede solicitar el borrado de su propia cuenta
    db.users = db.users.filter(u => u.id !== req.user.id);
    saveDb();
    res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// REPORTES
// ---------------------------------------------------------------------------

app.post("/api/users/:id/report", requireAuth, (req, res) => {
    const user = db.users.find(u => String(u.id) === String(req.params.id));
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });
    user.reportsCount = (user.reportsCount || 0) + 1;
    saveDb();
    res.json({ ok: true });
});

app.get("/api/admin/reports", requireAdmin, (req, res) => {
    const reportedUsers = db.users
        .filter(u => (u.reportsCount || 0) >= 10)
        .map(u => ({ id: u.id, username: u.username, reportsCount: u.reportsCount, banned: !!u.banned }));
    res.json({ reportedUsers });
});

app.post("/api/admin/reports/rename", requireAdmin, (req, res) => {
    const user = db.users.find(u => String(u.id) === String(req.body.userId));
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });
    user.username = `Usuario${user.id}`;
    saveDb();
    res.json({ ok: true });
});

app.post("/api/admin/reports/ban", requireAdmin, (req, res) => {
    const user = db.users.find(u => String(u.id) === String(req.body.userId));
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });
    user.banned = true;
    user.bannedUntil = null;
    saveDb();
    res.json({ ok: true });
});

app.post("/api/admin/reports/clear", requireAdmin, (req, res) => {
    const user = db.users.find(u => String(u.id) === String(req.body.userId));
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });
    user.reportsCount = 0;
    saveDb();
    res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// ADMIN: AJUSTES Y CÓDIGOS
// ---------------------------------------------------------------------------

app.post("/api/admin/settings/block-reward", requireAdmin, (req, res) => {
    db.settings.blockRewardItemId = req.body.itemId || null;
    saveDb();
    res.json({ ok: true });
});

app.post("/api/admin/settings/turbo-block-reward", requireAdmin, (req, res) => {
    db.settings.turboBlockRewardItemId = req.body.itemId || null;
    saveDb();
    res.json({ ok: true });
});

app.post("/api/admin/codes/create", requireAdmin, (req, res) => {
    const { code, coins, dollars, maxUses, expiresInDays, rewardItemId } = req.body || {};
    if (!code) return res.status(400).json({ error: "Falta el nombre del código." });
    const promo = {
        code,
        coins: Number(coins) || 0,
        dollars: Number(dollars) || 0,
        maxUses: maxUses ? Number(maxUses) : null,
        expiresAt: expiresInDays ? Date.now() + Number(expiresInDays) * 86400000 : null,
        rewardItemId: rewardItemId || null,
        uses: 0,
        redeemedBy: []
    };
    db.codes.push(promo);
    saveDb();
    res.json({ promo });
});

app.post("/api/admin/coins/add", requireAdmin, (req, res) => {
    const { username, amount } = req.body || {};
    const user = findUserByUsername(username);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });
    user.coins += Number(amount) || 0;
    saveDb();
    res.json({ ok: true });
});

app.post("/api/admin/dollars/add", requireAdmin, (req, res) => {
    const { username, amount } = req.body || {};
    const user = findUserByUsername(username);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });
    user.dollars += Number(amount) || 0;
    saveDb();
    res.json({ ok: true });
});

app.post("/api/admin/groups/pin", requireAdmin, (req, res) => {
    const { groupId } = req.body || {};
    const group = db.groups.find(g => String(g.id) === String(groupId));
    if (!group) return res.status(404).json({ error: "Grupo no encontrado." });
    group.pinned = !group.pinned;
    saveDb();
    res.json({ message: group.pinned ? "Grupo fijado 📌" : "Grupo desfijado." });
});

// ---------------------------------------------------------------------------
// SALUD / RAÍZ
// ---------------------------------------------------------------------------

app.get("/", (req, res) => res.send("Game Blocks API funcionando correctamente."));
app.get("/api/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ---------------------------------------------------------------------------
app.listen(PORT, () => {
    console.log(`Game Blocks server escuchando en el puerto ${PORT}`);
    console.log(`Base de datos persistente en: ${DB_FILE}`);
});
