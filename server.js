const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');

const app = express();

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Configuración de multer para guardar archivos GLB enviados desde PC
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage });

// Almacenamiento local temporal (se puede sustituir por DB)
let accessories = [];
let bannerText = "";
let userCoins = {}; 

// Endpoint para obtener accesorios de la tienda
app.get('/api/accessories', (req, res) => {
    res.json({ items: accessories });
});

// Endpoint para subir un accesorio GLB desde PC
app.post('/api/admin/accessories/upload', upload.single('glb'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "Archivo GLB requerido." });
        }

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
    } catch (err) {
        res.status(500).json({ error: "Error interno en el servidor." });
    }
});

// Endpoint para dar monedas
app.post('/api/admin/coins/add', (req, res) => {
    const { username, amount } = req.body;
    if (!username || !amount) {
        return res.status(400).json({ error: "Nombre y cantidad requeridos." });
    }
    userCoins[username] = (userCoins[username] || 0) + parseInt(amount);
    res.json({ success: true, newBalance: userCoins[username] });
});

// Endpoints de banner
app.post('/api/admin/banner', (req, res) => {
    bannerText = req.body.text || "";
    res.json({ success: true, text: bannerText });
});

app.get('/api/banner', (req, res) => {
    res.json({ text: bannerText });
});

// Servidor escuchando en puerto 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor activo en el puerto ${PORT}`);
});
