const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Configuración de Multer para recibir archivos GLB locales
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// Base de Datos Temporal
let accessories = [];
let userCoins = {}; // { username: 100 }
let bannerText = "";

// ENDPOINTS

// 1. Obtener Lista de Accesorios
app.get('/api/accessories', (req, res) => {
    res.json(accessories);
});

// 2. Subir Accesorio GLB desde archivo (Solo Owner/Admin)
app.post('/api/admin/accessories', upload.single('glb'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Archivo GLB no subido." });

    const newAccessory = {
        id: Date.now(),
        glbUrl: `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`,
        imageUrl: req.body.imageUrl,
        limited: req.body.limited === 'true',
        maxCopies: parseInt(req.body.maxCopies) || 0,
        price: parseInt(req.body.price) || 0
    };

    accessories.push(newAccessory);
    res.json({ success: true, accessory: newAccessory });
});

// 3. Añadir Monedas a un Usuario
app.post('/api/admin/add-coins', (req, res) => {
    const { username, amount } = req.body;
    if (!username || !amount) return res.status(400).json({ error: "Datos incompletos." });

    userCoins[username] = (userCoins[username] || 0) + parseInt(amount);
    res.json({ success: true, coins: userCoins[username] });
});

// 4. Banner del Owner
app.post('/api/admin/banner', (req, res) => {
    bannerText = req.body.text || "";
    res.json({ success: true, text: bannerText });
});

app.get('/api/banner', (req, res) => {
    res.json({ text: bannerText });
});

app.listen(3000, () => console.log('Servidor corriendo en puerto 3000'));
