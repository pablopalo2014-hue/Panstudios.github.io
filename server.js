const express = require("express");

const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get("/", (req, res) => {
    res.json({
        status: "online",
        message: "Game Blocks API funcionando"
    });
});

app.get("/api/test", (req, res) => {
    res.json({
        success: true,
        message: "La API funciona correctamente"
    });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Game Blocks API iniciada en el puerto ${PORT}`);
});
