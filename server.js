const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();

app.use(express.json());

const JWT_SECRET = 'super-secret-key';

// Base de datos en memoria (Simulación)
let users = [
    { id: '1', username: 'AdminUser', isAdmin: true, coins: 5000, inventory: ['101', '102'], equippedAccessory: null, bio: 'Administrador del sistema', avatar: '' },
    { id: '2', username: 'PlayerTwo', isAdmin: false, coins: 1500, inventory: ['103'], equippedAccessory: null, bio: 'Jugador casual', avatar: '' }
];

let accessories = [
    { id: '101', name: 'Dominus Red', price: 1000, limited: true, offsale: true, imageUrl: 'https://via.placeholder.com/80' },
    { id: '102', name: 'Golden Crown', price: 500, limited: true, offsale: false, imageUrl: 'https://via.placeholder.com/80' },
    { id: '103', name: 'Classic Cap', price: 50, limited: false, offsale: false, imageUrl: 'https://via.placeholder.com/80' }
];

let tradeOffers = [];
let resaleListings = [];

// Función simulada de persistemcia
async function saveDataToGit() {
    console.log("Guardando estado del servidor...");
    return Promise.resolve();
}

// Middlewares
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        // Usuario demo para desarrollo si no hay token
        req.user = users[0];
        return next();
    }
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = users.find(u => u.id === user.id) || users[0];
        next();
    });
}

function requireAdmin(req, res, next) {
    if (!req.user || !req.user.isAdmin) {
        return res.status(403).json({ error: "Acceso denegado. Se requieren permisos de administrador." });
    }
    next();
}

// RUTAS API

// Búsqueda de usuarios
app.get('/api/users/search', (req, res) => {
    const query = (req.query.q || '').toLowerCase();
    const filtered = users.filter(u => u.username.toLowerCase().includes(query));
    res.json({ users: filtered });
});

// Mi Perfil
app.get('/api/me', authenticateToken, (req, res) => {
    res.json(req.user);
});

// Tienda de Accesorios
app.get('/api/accessories', (req, res) => {
    res.json({ items: accessories });
});

// Amigos
app.post('/api/friends/request', authenticateToken, (req, res) => {
    const { userId } = req.body;
    const target = users.find(u => u.id === String(userId));
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });
    res.json({ success: true, message: `Solicitud enviada a ${target.username}` });
});

// 1. MODIFICAR ÍTEM DESDE PANEL ADMIN
app.post('/api/admin/accessories/edit', authenticateToken, requireAdmin, async (req, res) => {
    const { id, price, limited, offsale } = req.body;
    const item = accessories.find(a => String(a.id) === String(id));
    if (!item) return res.status(404).json({ error: "Artículo no encontrado." });

    if (price !== undefined && price !== "") item.price = parseInt(price);
    if (limited !== undefined) item.limited = (limited === true || limited === 'true');
    if (offsale !== undefined) item.offsale = (offsale === true || offsale === 'true');

    await saveDataToGit();
    res.json({ success: true, item });
});

// 2. TRADES RESTRINGIDOS A LIMITEDS
app.post('/api/trade/offer', authenticateToken, (req, res) => {
    const { targetUserId, offeredItemId, offeredCoins, requestedItemId, requestedCoins } = req.body;
    const target = users.find(u => String(u.id) === String(targetUserId));

    if (!target) return res.status(404).json({ error: "Usuario destino no encontrado." });

    if (offeredItemId) {
        const offItem = accessories.find(a => String(a.id) === String(offeredItemId));
        if (!offItem || !offItem.limited) return res.status(400).json({ error: "Solo se pueden intercambiar artículos Limiteds." });
        if (!req.user.inventory.includes(offeredItemId)) return res.status(400).json({ error: "No tienes el ítem ofrecido." });
    }
    if (requestedItemId) {
        const reqItem = accessories.find(a => String(a.id) === String(requestedItemId));
        if (!reqItem || !reqItem.limited) return res.status(400).json({ error: "Solo puedes solicitar artículos Limiteds." });
    }

    if (offeredCoins && (req.user.coins || 0) < offeredCoins) {
        return res.status(400).json({ error: "Monedas insuficientes para ofrecer." });
    }

    const trade = {
        id: Date.now().toString(),
        senderId: req.user.id,
        senderUsername: req.user.username,
        targetUserId,
        offeredItemId,
        offeredCoins: parseInt(offeredCoins) || 0,
        requestedItemId,
        requestedCoins: parseInt(requestedCoins) || 0
    };

    tradeOffers.push(trade);
    res.json({ success: true, trade });
});

// 3. MERCADO DE REVENTA PARA LIMITEDS OFFSALE
app.post('/api/accessories/resell-list', authenticateToken, async (req, res) => {
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
    if (String(req.user.equippedAccessory) === String(itemId)) req.user.equippedAccessory = null;

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
    const { listingId } = req.body;
    const listIndex = resaleListings.findIndex(l => String(l.id) === String(listingId));
    if (listIndex === -1) return res.status(404).json({ error: "Oferta de reventa no encontrada." });

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

const PORT = 3000;
app.listen(PORT, () => console.log(`Servidor iniciado en puerto ${PORT}`));
