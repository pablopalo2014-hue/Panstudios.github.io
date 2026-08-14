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
// ADMIN / OWNER
// ============================================================

const OWNER_NAMES = [
    "game_blocks_oficial",
    "game blocks oficial"
];

function normalizeUsername(username) {
    return String(username || "")
        .toLowerCase()
        .replace(/_/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function isOwner(user) {
    if (!user) return false;

    return OWNER_NAMES.some(
        name =>
            normalizeUsername(name) ===
            normalizeUsername(user.username)
    );
}

function isAdmin(user) {
    return isOwner(user) || user.admin === true;
}

// ============================================================
// INSIGNIAS DISPONIBLES
// ============================================================

const BADGES = {
    server_booster: {
        name: "Server Booster",
        description: "Ha mejorado el servidor de Discord."
    },

    blocker: {
        name: "Blocker",
        description: "Tiene la membresía Blocker."
    },

    admin: {
        name: "Admin",
        description: "Forma parte del equipo de administración."
    },

    content_creator: {
        name: "Content Creator",
        description: "Creador de contenido de Game Blocks."
    },

    game_blocks: {
        name: "Game Blocks",
        description: "Cuenta oficial de Game Blocks."
    }
};


// ============================================================
// BASE DE DATOS
// ============================================================

function createEmptyDatabase() {

    return {
        users: [],
        friendships: [],
        sessions: []
    };
}


function createDatabase() {

    if (!fs.existsSync(DB_FILE)) {

        console.log("Creando nueva base de datos...");

        fs.writeFileSync(
            DB_FILE,
            JSON.stringify(
                createEmptyDatabase(),
                null,
                2
            ),
            "utf8"
        );
    }
}


function loadDatabase() {

    createDatabase();

    try {

        const content =
            fs.readFileSync(
                DB_FILE,
                "utf8"
            );

        const database =
            JSON.parse(content);


        // Compatibilidad con bases antiguas

        if (!Array.isArray(database.users)) {
            database.users = [];
        }

        if (!Array.isArray(database.friendships)) {
            database.friendships = [];
        }

        if (!Array.isArray(database.sessions)) {
            database.sessions = [];
        }


        // Añadir badges a cuentas antiguas

        database.users.forEach(user => {

            if (!Array.isArray(user.badges)) {
                user.badges = [];
            }

        });


        return database;

    } catch (error) {

        console.error(
            "ERROR leyendo db.json:",
            error
        );

        // IMPORTANTE:
        // No sobrescribimos inmediatamente el archivo.
        // Si hubo un error de lectura, mantenemos una DB vacía
        // en memoria pero mostramos el error.

        return createEmptyDatabase();
    }
}


function saveDatabase(database) {

    try {

        const temporaryFile =
            DB_FILE + ".tmp";


        fs.writeFileSync(
            temporaryFile,
            JSON.stringify(
                database,
                null,
                2
            ),
            "utf8"
        );


        // Reemplazo atómico del archivo

        fs.renameSync(
            temporaryFile,
            DB_FILE
        );


        console.log(
            `[DB] Guardada correctamente: ${new Date().toISOString()}`
        );


        return true;

    } catch (error) {

        console.error(
            "[DB] ERROR guardando:",
            error
        );

        return false;
    }
}


// Cargar la base al iniciar

let database = loadDatabase();


// ============================================================
// GUARDADO AUTOMÁTICO
// ============================================================

// Guardar cada minuto

setInterval(() => {

    saveDatabase(database);

}, 60 * 1000);


// ============================================================
// GUARDAR ANTES DE APAGAR
// ============================================================

function shutdown(signal) {

    console.log(
        `\n[SERVER] Recibida señal ${signal}.`
    );

    console.log(
        "[SERVER] Guardando base de datos..."
    );

    saveDatabase(database);

    console.log(
        "[SERVER] Base de datos guardada."
    );

    process.exit(0);
}


process.on(
    "SIGTERM",
    () => shutdown("SIGTERM")
);


process.on(
    "SIGINT",
    () => shutdown("SIGINT")
);


// ============================================================
// CONTRASEÑAS
// ============================================================

function hashPassword(password) {

    return new Promise((resolve, reject) => {

        const salt =
            crypto.randomBytes(16).toString("hex");


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
                    salt +
                    ":" +
                    derivedKey.toString("hex")
                );
            }
        );
    });
}


function checkPassword(
    password,
    storedPassword
) {

    return new Promise((resolve, reject) => {

        const parts =
            storedPassword.split(":");


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
                            Buffer.from(
                                storedHash,
                                "hex"
                            ),
                            Buffer.from(
                                derivedHash,
                                "hex"
                            )
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


    if (
        !authorization.startsWith(
            "Bearer "
        )
    ) {

        return null;
    }


    const token =
        authorization.substring(7);


    const session =
        database.sessions.find(
            session =>
                session.token === token
        );


    if (!session) {

        return null;
    }


    const user =
        database.users.find(
            user =>
                user.id === session.userId
        );


    if (!user) {

        return null;
    }


    return user;
}


function requireLogin(
    req,
    res,
    next
) {

    const user =
        getUserFromRequest(req);


    if (!user) {

        res.status(401).json({

            error:
                "No has iniciado sesión."

        });

        return;
    }


    req.user = user;

    next();
}


// ============================================================
// ADMIN
// ============================================================

function requireAdmin(
    req,
    res,
    next
) {

    const user =
        getUserFromRequest(req);


    if (!user) {

        res.status(401).json({

            error:
                "No has iniciado sesión."

        });

        return;
    }


    if (
        !Array.isArray(user.badges) ||
        !user.badges.includes("admin")
    ) {

        res.status(403).json({

            error:
                "No tienes permisos de administrador."

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

        message:
            "Game Blocks API funcionando"

    });
});


// ============================================================
// TEST
// ============================================================

app.get(
    "/api/test",
    (req, res) => {

        res.json({

            success: true,

            message:
                "La API funciona correctamente"

        });

    }
);


// ============================================================
// REGISTRO
// ============================================================

app.post(
    "/api/register",
    async (req, res) => {

        try {

            const username =
                String(
                    req.body.username || ""
                ).trim();


            const password =
                String(
                    req.body.password || ""
                );


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


            const existingUser =
                database.users.find(
                    user =>
                        user.username
                            .toLowerCase() ===
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
                await hashPassword(
                    password
                );


            const user = {

                id: generateId(),

                username: username,

                passwordHash:
                    passwordHash,

                badges: [],

                createdAt:
                    Date.now()

            };


            database.users.push(user);


            saveDatabase(database);


            const token =
                createSession(
                    user.id
                );


            res.status(201).json({

                success: true,

                token: token,

                user: {

                    id: user.id,

                    username:
                        user.username,

                    badges:
                        user.badges

                }

            });

        } catch (error) {

            console.error(error);


            res.status(500).json({

                error:
                    "Error interno del servidor."

            });
        }
    }
);


// ============================================================
// LOGIN
// ============================================================

app.post(
    "/api/login",
    async (req, res) => {

        try {

            const username =
                String(
                    req.body.username || ""
                ).trim();


            const password =
                String(
                    req.body.password || ""
                );


            const user =
                database.users.find(
                    user =>
                        user.username
                            .toLowerCase() ===
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
                createSession(
                    user.id
                );


            res.json({

                success: true,

                token: token,

                user: {

                    id: user.id,

                    username:
                        user.username,

                    badges:
                        user.badges || []

                }

            });

        } catch (error) {

            console.error(error);


            res.status(500).json({

                error:
                    "Error interno del servidor."

            });
        }
    }
);


// ============================================================
// LOGOUT
// ============================================================

app.post(
    "/api/logout",
    requireLogin,
    (req, res) => {

        const authorization =
            req.headers.authorization;


        const token =
            authorization.substring(7);


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
// INFORMACIÓN DE LA CUENTA
// ============================================================

app.get(
    "/api/me",
    requireLogin,
    (req, res) => {

        res.json({

            id:
                req.user.id,

            username:
                req.user.username,

            badges:
                req.user.badges || [],

            createdAt:
                req.user.createdAt

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
            String(
                req.query.q || ""
            )
            .trim()
            .toLowerCase();


        if (!query) {

            res.json({

                users: []

            });

            return;
        }


        const users =
            database.users
                .filter(user => {

                    if (
                        user.id ===
                        req.user.id
                    ) {

                        return false;
                    }


                    return user.username
                        .toLowerCase()
                        .includes(query);

                })
                .slice(0, 20)
                .map(user => ({

                    id:
                        user.id,

                    username:
                        user.username,

                    badges:
                        user.badges || []

                }));


        res.json({

            users:
                users

        });
    }
);


// ============================================================
// AMISTADES
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
            String(
                req.body.userId || ""
            );


        if (!targetId) {

            res.status(400).json({

                error:
                    "Usuario inválido."

            });

            return;
        }


        if (
            targetId ===
            req.user.id
        ) {

            res.status(400).json({

                error:
                    "No puedes enviarte una solicitud a ti mismo."

            });

            return;
        }


        const targetUser =
            database.users.find(
                user =>
                    user.id === targetId
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

            res.status(400).json({

                error:
                    existing.status ===
                    "accepted"

                        ? "Ya sois amigos."

                        : "Ya existe una solicitud."

            });

            return;
        }


        database.friendships.push({

            id:
                generateId(),

            from:
                req.user.id,

            to:
                targetId,

            status:
                "pending",

            createdAt:
                Date.now()

        });


        saveDatabase(database);


        res.json({

            success:
                true

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

        const requests =
            database.friendships

                .filter(friendship =>

                    friendship.to ===
                    req.user.id &&

                    friendship.status ===
                    "pending"

                )

                .map(friendship => {

                    const user =
                        database.users.find(
                            u =>
                                u.id ===
                                friendship.from
                        );


                    return {

                        id:
                            friendship.id,

                        userId:
                            user?.id,

                        username:
                            user?.username,

                        badges:
                            user?.badges || []

                    };

                });


        res.json({

            requests:
                requests

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
            String(
                req.body.requestId || ""
            );


        const friendship =
            database.friendships.find(
                f =>

                    f.id ===
                    requestId &&

                    f.to ===
                    req.user.id &&

                    f.status ===
                    "pending"

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

            success:
                true

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
            String(
                req.body.requestId || ""
            );


        const index =
            database.friendships.findIndex(
                f =>

                    f.id ===
                    requestId &&

                    f.to ===
                    req.user.id &&

                    f.status ===
                    "pending"

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

            success:
                true

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

        const friendships =
            database.friendships.filter(
                friendship =>

                    friendship.status ===
                    "accepted" &&

                    (
                        friendship.from ===
                        req.user.id ||

                        friendship.to ===
                        req.user.id
                    )
            );


        const friends =
            friendships

                .map(friendship => {

                    const friendId =
                        friendship.from ===
                        req.user.id

                            ? friendship.to

                            : friendship.from;


                    const user =
                        database.users.find(
                            u =>
                                u.id ===
                                friendId
                        );


                    if (!user) {
                        return null;
                    }


                    return {

                        id:
                            user.id,

                        username:
                            user.username,

                        badges:
                            user.badges || []

                    };

                })

                .filter(Boolean);


        res.json({

            friends:
                friends

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
            String(
                req.body.userId || ""
            );


        const index =
            database.friendships.findIndex(
                friendship =>

                    friendship.status ===
                    "accepted" &&

                    (

                        (
                            friendship.from ===
                            req.user.id &&

                            friendship.to ===
                            targetId
                        )

                        ||

                        (
                            friendship.from ===
                            targetId &&

                            friendship.to ===
                            req.user.id
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

            success:
                true

        });
    }
);


// ============================================================
// INSIGNIAS - LISTA
// ============================================================

app.get(
    "/api/badges",
    (req, res) => {

        res.json({

            badges:
                BADGES

        });
    }
);


// ============================================================
// INSIGNIAS - VER LAS DE UNA CUENTA
// ============================================================

app.get(
    "/api/users/:id/badges",
    (req, res) => {

        const user =
            database.users.find(
                user =>
                    user.id ===
                    req.params.id
            );


        if (!user) {

            res.status(404).json({

                error:
                    "Usuario no encontrado."

            });

            return;
        }


        res.json({

            username:
                user.username,

            badges:
                user.badges || []

        });
    }
);


// ============================================================
// ADMIN - AÑADIR INSIGNIA
// ============================================================

app.post(
    "/api/admin/badges/add",
    requireAdmin,
    (req, res) => {

        const userId =
            String(
                req.body.userId || ""
            );


        const badgeId =
            String(
                req.body.badge || ""
            );


        if (!BADGES[badgeId]) {

            res.status(400).json({

                error:
                    "Esa insignia no existe."

            });

            return;
        }


        const user =
            database.users.find(
                user =>
                    user.id ===
                    userId
            );


        if (!user) {

            res.status(404).json({

                error:
                    "Usuario no encontrado."

            });

            return;
        }


        if (!Array.isArray(user.badges)) {

            user.badges = [];

        }


        if (
            user.badges.includes(
                badgeId
            )
        ) {

            res.status(400).json({

                error:
                    "El usuario ya tiene esa insignia."

            });

            return;
        }


        user.badges.push(
            badgeId
        );


        saveDatabase(database);


        res.json({

            success:
                true,

            username:
                user.username,

            badges:
                user.badges

        });
    }
);


// ============================================================
// ADMIN - QUITAR INSIGNIA
// ============================================================

app.post(
    "/api/admin/badges/remove",
    requireAdmin,
    (req, res) => {

        const userId =
            String(
                req.body.userId || ""
            );


        const badgeId =
            String(
                req.body.badge || ""
            );


        const user =
            database.users.find(
                user =>
                    user.id ===
                    userId
            );


        if (!user) {

            res.status(404).json({

                error:
                    "Usuario no encontrado."

            });

            return;
        }


        if (!Array.isArray(user.badges)) {

            user.badges = [];

        }


        user.badges =
            user.badges.filter(
                badge =>
                    badge !==
                    badgeId
            );


        saveDatabase(database);


        res.json({

            success:
                true,

            username:
                user.username,

            badges:
                user.badges

        });
    }
);


// ============================================================
// GODOT - COMPROBAR CUENTA
// ============================================================

app.get(
    "/api/game/account",
    (req, res) => {

        const token =
            String(
                req.query.token || ""
            );


        if (!token) {

            return res.json({

                logged:
                    false

            });

        }


        const session =
            database.sessions.find(
                session =>
                    session.token ===
                    token
            );


        if (!session) {

            return res.json({

                logged:
                    false

            });

        }


        const user =
            database.users.find(
                user =>
                    user.id ===
                    session.userId
            );


        if (!user) {

            return res.json({

                logged:
                    false

            });

        }


        res.json({

            logged:
                true,

            username:
                user.username,

            badges:
                user.badges || []

        });
    }
);


// ============================================================
// GODOT - COMPROBAR SOLO SI ESTÁ LOGUEADO
// ============================================================

app.get(
    "/api/game/account/check",
    (req, res) => {

        const token =
            String(
                req.query.token || ""
            );


        if (!token) {

            return res.json({

                logged:
                    false

            });

        }


        const session =
            database.sessions.find(
                session =>
                    session.token ===
                    token
            );


        if (!session) {

            return res.json({

                logged:
                    false

            });

        }


        const user =
            database.users.find(
                user =>
                    user.id ===
                    session.userId
            );


        if (!user) {

            return res.json({

                logged:
                    false

            });

        }


        res.json({

            logged:
                true

        });
    }
);


// ============================================================
// ELIMINAR CUENTA
// ============================================================

app.delete(
    "/api/account",
    requireLogin,
    (req, res) => {

        const userId =
            req.user.id;


        // Eliminar usuario

        database.users =
            database.users.filter(
                user =>
                    user.id !==
                    userId
            );


        // Eliminar sesiones

        database.sessions =
            database.sessions.filter(
                session =>
                    session.userId !==
                    userId
            );


        // Eliminar amistades

        database.friendships =
            database.friendships.filter(
                friendship =>
                    friendship.from !==
                    userId &&

                    friendship.to !==
                    userId
            );


        saveDatabase(database);


        res.json({

            success:
                true

        });
    }
);


// ============================================================
// ERROR 404
// ============================================================

app.use(
    (req, res) => {

        res.status(404).json({

            error:
                "Ruta no encontrada."

        });

    }
);


// ============================================================
// ERRORES INTERNOS
// ============================================================

app.use(
    (error, req, res, next) => {

        console.error(
            "ERROR:",
            error
        );


        res.status(500).json({

            error:
                "Error interno del servidor."

        });

    }
);


// ============================================================
// INICIAR SERVIDOR
// ============================================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            "======================================"
        );

        console.log(
            "     GAME BLOCKS API"
        );

        console.log(
            "======================================"
        );

        console.log(
            `Servidor iniciado en puerto ${PORT}`
        );

        console.log(
            `Base de datos: ${DB_FILE}`
        );

        console.log(
            `Usuarios cargados: ${database.users.length}`
        );

        console.log(
            `Amistades cargadas: ${database.friendships.length}`
        );

        console.log(
            "Guardado automático: cada 60 segundos"
        );

        console.log(
            "======================================"
        );

    }
);
