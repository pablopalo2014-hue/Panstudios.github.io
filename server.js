// Array para guardar los listados de reventa en memoria
let resaleListings = []; // { id, itemId, sellerId, sellerUsername, price }

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

// 2. RESTRINGIR TRADES A SOLO LIMITEDS (Actualiza la ruta /api/trade/offer)
app.post('/api/trade/offer', authenticateToken, (req, res) => {
    const { targetUserId, offeredItemId, offeredCoins, requestedItemId, requestedCoins } = req.body;
    const target = users.find(u => String(u.id) === String(targetUserId));

    if (!target) return res.status(404).json({ error: "Usuario destino no encontrado." });

    // Validar que los objetos sean Limiteds
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
    if (!item.offsale) return res.status(400).json({ error: "El artículo debe estar Offsale para ponerlo en reventa de usuarios." });

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
    if (listIndex === -1) return res.status(404).json({ error: "Oferta de reventa no encontrada o ya comprada." });

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
