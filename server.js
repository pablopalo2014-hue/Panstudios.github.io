const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json());
app.use(cors());

// Servir la carpeta 'uploads' para que el cliente pueda cargar los .glb y .png subidos
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}
app.use("/uploads", express.static(uploadsDir));

// Configuración de Multer para guardar archivos .glb en el disco
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, "uploads/"),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});
const upload = multer({ storage });

const SECRET_KEY = "gameblocks_secret_key_production";

// Base de datos en memoria
const users = [];
let catalogAccessories = []; // Accesorios creados
let bannerText = ""; // Banner inferior para la barra lateral

// Middlewares
function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Sin token." });
    const token = authHeader.split(" ")[1];
    try {
        const payload = jwt.verify(token, SECRET_KEY);
        const user = users.find(u => u.id === payload.id);
        if (!user) return res.status(401).json({ error: "Usuario no encontrado." });
        req.user = user;
        next();
    } catch {
        res.status(401).json({ error: "Token inválido." });
    }
}

function requireAdmin(req, res, next) {
    if (!req.user.admin) return res.status(403).json({ error: "Requiere admin." });
    next();
}

// --- AUTENTICACIÓN Y USUARIOS ---

app.post("/api/register", async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Faltan datos." });

    if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
        return res.status(400).json({ error: "El usuario ya existe." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
        id: Date.now().toString(),
        username,
        password: hashedPassword,
        coins: 100, // Monedas iniciales
        equippedAccessory: null,
        inventory: [],
        admin: users.length === 0 // Primer usuario registrado es Admin/Owner
    };
    users.push(newUser);

    const token = jwt.sign({ id: newUser.id }, SECRET_KEY);
    res.json({ token });
});

app.post("/api/login", async (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(400).json({ error: "Credenciales incorrectas." });
    }
    const token = jwt.sign({ id: user.id }, SECRET_KEY);
    res.json({ token });
});

app.get("/api/me", authenticate, (req, res) => {
    const { password, ...data } = req.user;
    res.json(data);
});

// --- PANEL DE ACCESORIOS (OWNER/ADMIN) ---

// Subir accesorio GLB desde archivo local + icono PNG desde URL
app.post("/api/admin/accessories", authenticate, requireAdmin, upload.single("glbFile"), (req, res) => {
    const { isLimited, maxCopies, price, iconUrl } = req.body;

    if (!req.file) return res.status(400).json({ error: "Debes adjuntar un archivo .glb local." });

    const newAcc = {
        id: Date.now().toString(),
        glbUrl: `/uploads/${req.file.filename}`,
        iconUrl: iconUrl || "",
        price: parseInt(price) || 0,
        isLimited: isLimited === "true",
        maxCopies: isLimited === "true" ? parseInt(maxCopies) || 1 : null,
        copiesSold: 0
    };

    catalogAccessories.push(newAcc);
    res.json({ message: "Accesorio creado correctamente.", accessory: newAcc });
});

// --- TIENDA Y EQUIPACIÓN ---

app.get("/api/accessories", (req, res) => {
    res.json({ accessories: catalogAccessories });
});

app.post("/api/accessories/buy", authenticate, (req, res) => {
    const { accessoryId } = req.body;
    const acc = catalogAccessories.find(a => a.id === accessoryId);
    if (!acc) return res.status(404).json({ error: "Accesorio no encontrado." });

    if (req.user.inventory.includes(acc.id)) {
        return res.status(400).json({ error: "Ya posees este accesorio." });
    }
    if (req.user.coins < acc.price) {
        return res.status(400).json({ error: "Monedas insuficientes." });
    }
    if (acc.isLimited && acc.copiesSold >= acc.maxCopies) {
        return res.status(400).json({ error: "Accesorio agotado." });
    }

    req.user.coins -= acc.price;
    if (acc.isLimited) acc.copiesSold++;
    req.user.inventory.push(acc.id);

    res.json({ message: "Compra realizada.", coins: req.user.coins });
});

app.post("/api/avatar/equip", authenticate, (req, res) => {
    const { accessoryId } = req.body;
    
    // Desequipar si envía null o id vacío
    if (!accessoryId) {
        req.user.equippedAccessory = null;
        return res.json({ message: "Accesorio desequipado." });
    }

    if (!req.user.inventory.includes(accessoryId)) {
        return res.status(403).json({ error: "No posees este accesorio." });
    }

    const acc = catalogAccessories.find(a => a.id === accessoryId);
    req.user.equippedAccessory = acc ? acc.glbUrl : null;
    res.json({ message: "Accesorio equipado.", equippedAccessory: req.user.equippedAccessory });
});

// --- BANNER DE TEXTO Y MONEDAS ADMIN ---

app.get("/api/banner", (req, res) => {
    res.json({ bannerText });
});

app.post("/api/admin/banner", authenticate, requireAdmin, (req, res) => {
    const { text } = req.body;
    bannerText = text || "";
    res.json({ message: "Banner actualizado.", bannerText });
});

app.post("/api/admin/add-coins", authenticate, requireAdmin, (req, res) => {
    const { username, amount } = req.body;
    const target = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    target.coins = (target.coins || 0) + parseInt(amount || 0);
    res.json({ message: `Se añadieron ${amount} monedas a ${target.username}.`, coins: target.coins });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor iniciado en puerto ${PORT}`));
