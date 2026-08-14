const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;

const DB_FILE = path.join(__dirname, "db.json");


// ============================================================
// CONFIGURACIÓN
// ============================================================

app.use(cors({
    origin: "*"
}));

app.use(express.json());


// ============================================================
// BASE DE DATOS SIMPLE
// ============================================================

function createDatabase() {

    if (!fs.existsSync(DB_FILE)) {

        const database = {
            users: [],
            friendships: [],
            sessions: []
        };

        fs.writeFileSync(
            DB_FILE,
            JSON.stringify(database, null, 2)
        );
    }
}


function loadDatabase() {

    createDatabase();

    try {

        return JSON.parse(
            fs.readFileSync(DB_FILE, "utf8")
        );

    } catch (error) {

        console.error("Error leyendo db.json:", error);

        return {
            users: [],
            friendships: [],
            sessions: []
        };
    }
}


function saveDatabase(database) {

    fs.writeFileSync(
        DB_FILE,
        JSON.stringify(database, null, 2)
    );
}


createDatabase();


// ============================================================
// CONTRASEÑAS
// ============================================================

function hashPassword(password) {

    return new Promise((resolve, reject) => {

        const salt = crypto.randomBytes(16).toString("hex");

        crypto.scrypt(
            password,
            salt,
            64,
            (error, derivedKey) => {

                if (error) {
                    reject(error);
                    return;
                }

                resolve(
                    salt + ":" +
                    derivedKey.toString("hex")
                );
            }
        );
    });
}


function checkPassword(password, storedPassword) {

    return new Promise((resolve, reject) => {

        const parts = storedPassword.split(":");

        if (parts.length !== 2) {

            resolve(false);
            return;
        }

        const salt = parts[0];
        const storedHash = parts[1];

        crypto.scrypt(
            password,
            salt,
            64,
            (error, derivedKey) => {

                if (error) {
                    reject(error);
                    return;
                }

                const derivedHash =
                    derivedKey.toString("hex");

                try {

                    const valid =
                        crypto.timingSafeEqual(
                            Buffer.from(storedHash, "hex"),
                            Buffer.from(derivedHash, "hex")
                        );

                    resolve(valid);

                } catch {

                    resolve(false);

                }
            }
        );
    });
}


// ============================================================
// IDS
// ============================================================

function generateId() {

    return crypto.randomUUID();
}


// ============================================================
// SESIONES
// ============================================================

function createSession(userId) {

    const database = loadDatabase();

    const token =
        crypto.randomBytes(48).toString("hex");

    database.sessions.push({
        token: token,
        userId: userId,
        createdAt: Date.now()
    });

    saveDatabase(database);

    return token;
}


function getUserFromRequest(req) {

    const authorization =
        req.headers.authorization;

    if (!authorization) {
        return null;
    }

    if (!authorization.startsWith("Bearer ")) {
        return null;
    }

    const token =
        authorization.substring(7);

    const database = loadDatabase();

    const session =
        database.sessions.find(
            s => s.token === token
        );

    if (!session) {
        return null;
    }

    const user =
        database.users.find(
            u => u.id === session.userId
        );

    if (!user) {
        return null;
    }

    return user;
}


function requireLogin(req, res, next) {

    const user =
        getUserFromRequest(req);

    if (!user) {

        res.status(401).json({
            error: "No has iniciado sesión."
        });

        return;
    }

    req.user = user;

    next();
}


// ============================================================
// VALIDACIÓN
// ============================================================

function validUsername(username) {

    return /^[a-zA-Z0-9_]{3,20}$/.test(
        username
    );
}


// ============================================================
// RUTA PRINCIPAL
// ============================================================

app.get("/", (req, res) => {

    res.json({
        status: "online",
        message: "Game Blocks API funcionando"
    });
});


// ============================================================
// TEST
// ============================================================

app.get("/api/test", (req, res) => {

    res.json({
        success: true,
        message: "La API funciona correctamente"
    });
});


// ============================================================
// REGISTRO
// ============================================================

app.post("/api/register", async (req, res) => {

    try {

        const username =
            String(req.body.username || "").trim();

        const password =
            String(req.body.password || "");


        if (!validUsername(username)) {

            res.status(400).json({
                error:
                    "El usuario debe tener entre 3 y 20 caracteres y solo puede usar letras, números y _."
            });

            return;
        }


        if (password.length < 6) {

            res.status(400).json({
                error:
                    "La contraseña debe tener al menos 6 caracteres."
            });

            return;
        }


        const database =
            loadDatabase();


        const existingUser =
            database.users.find(
                user =>
                    user.username.toLowerCase() ===
                    username.toLowerCase()
            );


        if (existingUser) {

            res.status(409).json({
                error:
                    "Ese nombre de usuario ya existe."
            });

            return;
        }


        const passwordHash =
            await hashPassword(password);


        const user = {

            id: generateId(),

            username: username,

            passwordHash: passwordHash,

            createdAt: Date.now()

        };


        database.users.push(user);

        saveDatabase(database);


        const token =
            createSession(user.id);


        res.status(201).json({

            success: true,

            token: token,

            user: {

                id: user.id,

                username: user.username

            }

        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "Error interno del servidor."
        });
    }
});


// ============================================================
// LOGIN
// ============================================================

app.post("/api/login", async (req, res) => {

    try {

        const username =
            String(req.body.username || "").trim();

        const password =
            String(req.body.password || "");


        const database =
            loadDatabase();


        const user =
            database.users.find(
                user =>
                    user.username.toLowerCase() ===
                    username.toLowerCase()
            );


        if (!user) {

            res.status(401).json({
                error:
                    "Usuario o contraseña incorrectos."
            });

            return;
        }


        const valid =
            await checkPassword(
                password,
                user.passwordHash
            );


        if (!valid) {

            res.status(401).json({
                error:
                    "Usuario o contraseña incorrectos."
            });

            return;
        }


        const token =
            createSession(user.id);


        res.json({

            success: true,

            token: token,

            user: {

                id: user.id,

                username: user.username

            }

        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "Error interno del servidor."
        });
    }
});


// ============================================================
// CERRAR SESIÓN
// ============================================================

app.post(
    "/api/logout",
    requireLogin,
    (req, res) => {

        const authorization =
            req.headers.authorization;

        const token =
            authorization.substring(7);

        const database =
            loadDatabase();


        database.sessions =
            database.sessions.filter(
                session =>
                    session.token !== token
            );


        saveDatabase(database);


        res.json({
            success: true
        });
    }
);


// ============================================================
// INFORMACIÓN DEL USUARIO ACTUAL
// ============================================================

app.get(
    "/api/me",
    requireLogin,
    (req, res) => {

        res.json({

            id: req.user.id,

            username: req.user.username,

            createdAt: req.user.createdAt

        });
    }
);


// ============================================================
// BUSCAR USUARIOS
// ============================================================

app.get(
    "/api/users/search",
    requireLogin,
    (req, res) => {

        const query =
            String(req.query.q || "")
                .trim()
                .toLowerCase();


        if (!query) {

            res.json({
                users: []
            });

            return;
        }


        const database =
            loadDatabase();


        const users =
            database.users
                .filter(user => {

                    if (user.id === req.user.id) {
                        return false;
                    }

                    return user.username
                        .toLowerCase()
                        .includes(query);

                })
                .slice(0, 20)
                .map(user => ({

                    id: user.id,

                    username: user.username

                }));


        res.json({
            users: users
        });
    }
);


// ============================================================
// COMPROBAR RELACIÓN DE AMISTAD
// ============================================================

function getFriendship(
    database,
    userA,
    userB
) {

    return database.friendships.find(
        friendship =>

            (
                friendship.from === userA &&
                friendship.to === userB
            )

            ||

            (
                friendship.from === userB &&
                friendship.to === userA
            )
    );
}


// ============================================================
// ENVIAR SOLICITUD
// ============================================================

app.post(
    "/api/friends/request",
    requireLogin,
    (req, res) => {

        const targetId =
            String(req.body.userId || "");


        if (!targetId) {

            res.status(400).json({
                error: "Usuario inválido."
            });

            return;
        }


        if (targetId === req.user.id) {

            res.status(400).json({
                error:
                    "No puedes enviarte una solicitud a ti mismo."
            });

            return;
        }


        const database =
            loadDatabase();


        const targetUser =
            database.users.find(
                user => user.id === targetId
            );


        if (!targetUser) {

            res.status(404).json({
                error:
                    "Ese usuario no existe."
            });

            return;
        }


        const existing =
            getFriendship(
                database,
                req.user.id,
                targetId
            );


        if (existing) {

            if (existing.status === "accepted") {

                res.status(400).json({
                    error:
                        "Ya sois amigos."
                });

            } else {

                res.status(400).json({
                    error:
                        "Ya existe una solicitud."
                });

            }

            return;
        }


        database.friendships.push({

            id: generateId(),

            from: req.user.id,

            to: targetId,

            status: "pending",

            createdAt: Date.now()

        });


        saveDatabase(database);


        res.json({
            success: true
        });
    }
);


// ============================================================
// SOLICITUDES RECIBIDAS
// ============================================================

app.get(
    "/api/friends/requests",
    requireLogin,
    (req, res) => {

        const database =
            loadDatabase();


        const requests =
            database.friendships
                .filter(friendship =>

                    friendship.to === req.user.id &&
                    friendship.status === "pending"

                )
                .map(friendship => {

                    const user =
                        database.users.find(
                            u =>
                                u.id ===
                                friendship.from
                        );


                    return {

                        id: friendship.id,

                        userId: user?.id,

                        username: user?.username

                    };

                });


        res.json({
            requests: requests
        });
    }
);


// ============================================================
// ACEPTAR SOLICITUD
// ============================================================

app.post(
    "/api/friends/accept",
    requireLogin,
    (req, res) => {

        const requestId =
            String(req.body.requestId || "");


        const database =
            loadDatabase();


        const friendship =
            database.friendships.find(
                f =>

                    f.id === requestId &&

                    f.to === req.user.id &&

                    f.status === "pending"

            );


        if (!friendship) {

            res.status(404).json({
                error:
                    "Solicitud no encontrada."
            });

            return;
        }


        friendship.status =
            "accepted";


        saveDatabase(database);


        res.json({
            success: true
        });
    }
);


// ============================================================
// RECHAZAR SOLICITUD
// ============================================================

app.post(
    "/api/friends/reject",
    requireLogin,
    (req, res) => {

        const requestId =
            String(req.body.requestId || "");


        const database =
            loadDatabase();


        const index =
            database.friendships.findIndex(
                f =>

                    f.id === requestId &&

                    f.to === req.user.id &&

                    f.status === "pending"

            );


        if (index === -1) {

            res.status(404).json({
                error:
                    "Solicitud no encontrada."
            });

            return;
        }


        database.friendships.splice(
            index,
            1
        );


        saveDatabase(database);


        res.json({
            success: true
        });
    }
);


// ============================================================
// LISTA DE AMIGOS
// ============================================================

app.get(
    "/api/friends",
    requireLogin,
    (req, res) => {

        const database =
            loadDatabase();


        const friendships =
            database.friendships.filter(
                friendship =>

                    friendship.status === "accepted" &&

                    (
                        friendship.from === req.user.id ||
                        friendship.to === req.user.id
                    )
            );


        const friends =
            friendships.map(
                friendship => {

                    const friendId =
                        friendship.from === req.user.id
                            ? friendship.to
                            : friendship.from;


                    const user =
                        database.users.find(
                            u =>
                                u.id === friendId
                        );


                    return {

                        id: user.id,

                        username: user.username

                    };

                }
            );


        res.json({
            friends: friends
        });
    }
);


// ============================================================
// ELIMINAR AMIGO
// ============================================================

app.post(
    "/api/friends/remove",
    requireLogin,
    (req, res) => {

        const targetId =
            String(req.body.userId || "");


        const database =
            loadDatabase();


        const index =
            database.friendships.findIndex(
                friendship =>

                    friendship.status === "accepted" &&

                    (
                        (
                            friendship.from === req.user.id &&
                            friendship.to === targetId
                        )

                        ||

                        (
                            friendship.from === targetId &&
                            friendship.to === req.user.id
                        )
                    )
            );


        if (index === -1) {

            res.status(404).json({
                error:
                    "No sois amigos."
            });

            return;
        }


        database.friendships.splice(
            index,
            1
        );


        saveDatabase(database);


        res.json({
            success: true
        });
    }
);
// ============================================================
// COMPROBAR CUENTA DESDE GODOT
// ============================================================

app.get("/api/game/account", (req, res) => {

    const token = String(req.query.token || "");

    // No se ha enviado token
    if (!token) {

        return res.json({
            logged: false
        });

    }

    const database = loadDatabase();

    // Buscar la sesión
    const session =
        database.sessions.find(
            session => session.token === token
        );

    // No existe la sesión
    if (!session) {

        return res.json({
            logged: false
        });

    }

    // Buscar el usuario de esa sesión
    const user =
        database.users.find(
            user => user.id === session.userId
        );

    // El usuario ya no existe
    if (!user) {

        return res.json({
            logged: false
        });

    }

    // Cuenta válida
    res.json({

        logged: true,

        username: user.username

    });

});

// ============================================================
// ERRORES
// ============================================================

app.use((req, res) => {

    res.status(404).json({
        error: "Ruta no encontrada."
    });
});


app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `Game Blocks API funcionando en puerto ${PORT}`
        );

    }
);
