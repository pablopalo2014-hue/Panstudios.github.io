const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Directorio para almacenar archivos subidos (.glb y .png)
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// Configuración de Multer para subir GLB desde el PC
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// Datos en memoria (Para producción, conectar a tu Base de Datos)
let items = [];
let bannerText = "Bienvenido a Game Blocks";

// Middleware para verificar Owner / Admin (Simplificado)
function isOwner(req, res, next) {
    // Aquí validas si el usuario es Owner
    next();
}

// ENDPOINTS

// 1. Subir accesorio GLB (Solo Owner)
app.post('/api/admin/upload-item', isOwner, upload.single('glbFile'), (req, res) => {
    const { name, isLimited, copies, maxPerUser, price } = req.body;
    
    if (!req.file) {
        return res.status(400).json({ error: "Debes subir un archivo .glb" });
    }

    const newItem = {
        id: Date.now().toString(),
        name: name || "Accesorio GLB",
        glbUrl: `/uploads/${req.file.filename}`,
        isLimited: isLimited === 'true',
        copies: isLimited === 'true' ? parseInt(copies) : null,
        maxPerUser: isLimited === 'true' ? parseInt(maxPerUser) : null,
        price: parseInt(price) || 0,
        type: 'hat'
    };

    items.push(newItem);
    res.json({ message: "Accesorio subido con éxito", item: newItem });
});

// 2. Obtener catálogo de la tienda
app.get('/api/shop/items', (req, res) => {
    res.json({ items });
});

// 3. Añadir monedas a un usuario (Admin)
app.post('/api/admin/add-coins', isOwner, (req, res) => {
    const { username, amount } = req.body;
    // Lógica para sumar monedas al usuario en tu BD
    res.json({ message: `Se han añadido ${amount} monedas a ${username}` });
});

// 4. Actualizar Banner
app.post('/api/admin/banner', isOwner, (req, res) => {
    const { text } = req.body;
    bannerText = text;
    res.json({ message: "Banner actualizado", banner: bannerText });
});

app.get('/api/banner', (req, res) => {
    res.json({ banner: bannerText });
});

app.listen(3000, () => console.log("Servidor corriendo en el puerto 3000"));
