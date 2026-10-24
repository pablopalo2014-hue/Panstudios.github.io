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
const os = require("os");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// COPIA DE SEGURIDAD EN GITHUB (persistencia real en Render Free, sin disco)
// ---------------------------------------------------------------------------
// El disco de un servicio "Free" de Render se borra en cada deploy y, a
// veces, en cada reinicio del contenedor. Para que las cuentas, grupos y
// catálogo SIEMPRE sobrevivan (aunque Render borre el disco), este servidor
// puede guardar automáticamente una copia de la base de datos en un
// repositorio de GitHub (gratis) y recuperarla al arrancar si el disco local
// está vacío. Para activarlo, configura estas 2 variables de entorno en
// Render (pestaña "Environment"):
//   GITHUB_TOKEN  -> un Personal Access Token de GitHub con permiso "repo"
//   GITHUB_REPO   -> "tu-usuario/tu-repositorio" (puede ser un repo privado
//                     vacío creado solo para esto)
// Si no configuras estas variables, el servidor sigue funcionando igual que
// antes (solo con el fichero local), simplemente sin esta protección extra.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || null;
const GITHUB_REPO = process.env.GITHUB_REPO || null; // formato "usuario/repo"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GITHUB_BACKUP_PATH = process.env.GITHUB_BACKUP_PATH || "gameblocks-backup/db.json";
const GITHUB_BACKUP_ENABLED = !!(GITHUB_TOKEN && GITHUB_REPO);

let githubBackupSha = null;

async function githubApiFetch(url, options = {}) {
    return fetch(url, {
        ...options,
        headers: {
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            ...(options.headers || {})
        }
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ghPath = p => p.split("/").map(encodeURIComponent).join("/");
const GITHUB_UPLOADS_PATH = process.env.GITHUB_UPLOADS_PATH || "gameblocks-backup/uploads";
const DB_BACKUP_FILE = path.join(DATA_DIR, "db.backup.json");

let dbSafeToBackup = true;        // false = no se sube nada a GitHub (para no pisar un backup bueno)
let remoteKnownUsers = 0;         // nº de usuarios que tiene el backup remoto
let githubPushPromise = null;
let githubPushPending = false;
let lastGithubPushAt = 0;
let lastGithubError = null;
let lastLocalSaveAt = 0;
let dirty = false;

function ghContentsUrl(p, withRef = true) {
    return `${process.env.GITHUB_API_URL || "https://api.github.com"}/repos/${GITHUB_REPO}/contents/${ghPath(p)}${withRef ? `?ref=${GITHUB_BRANCH}` : ""}`;
}

// Devuelve { status: "ok", data } | { status: "missing" } | { status: "error", error } | { status: "disabled" }
async function pullDbFromGithub() {
    if (!GITHUB_BACKUP_ENABLED) return { status: "disabled" };
    try {
        const url = ghContentsUrl(GITHUB_BACKUP_PATH);
        const res = await githubApiFetch(url);
        if (res.status === 404) return { status: "missing" };
        if (res.status !== 200) return { status: "error", error: `HTTP ${res.status}` };
        const meta = await res.json();
        githubBackupSha = meta.sha;
        let text;
        if (meta.content && meta.encoding === "base64") {
            text = Buffer.from(meta.content, "base64").toString("utf-8");
        } else {
            // Ficheros de más de 1 MB: la API no devuelve el contenido, se pide en bruto.
            const raw = await githubApiFetch(url, { headers: { Accept: "application/vnd.github.raw+json" } });
            if (!raw.ok) return { status: "error", error: `HTTP ${raw.status} (raw)` };
            text = await raw.text();
        }
        return { status: "ok", data: JSON.parse(text) };
    } catch (e) {
        return { status: "error", error: e.message };
    }
}

async function pushDbToGithubOnce() {
    // Nunca se pisa un backup con datos por una base de datos vacía.
    if ((db.users || []).length === 0 && remoteKnownUsers > 0) return;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            if (!githubBackupSha) {
                const check = await githubApiFetch(ghContentsUrl(GITHUB_BACKUP_PATH));
                if (check.status === 200) githubBackupSha = (await check.json()).sha;
            }
            const content = Buffer.from(JSON.stringify(db)).toString("base64");
            const res = await githubApiFetch(ghContentsUrl(GITHUB_BACKUP_PATH, false), {
                method: "PUT",
                body: JSON.stringify({
                    message: `Backup automático de Game Blocks (${new Date().toISOString()})`,
                    content,
                    branch: GITHUB_BRANCH,
                    ...(githubBackupSha ? { sha: githubBackupSha } : {})
                })
            });
            if (res.ok) {
                const data = await res.json();
                githubBackupSha = data.content && data.content.sha;
                remoteKnownUsers = (db.users || []).length;
                lastGithubPushAt = Date.now();
                lastGithubError = null;
                return;
            }
            githubBackupSha = null; // 409/422: sha desfasado, se reconsulta y se reintenta
            lastGithubError = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
            console.error("[GitHub backup] Fallo al subir backup:", lastGithubError);
            if (res.status !== 409 && res.status !== 422) return;
        } catch (e) {
            lastGithubError = e.message;
            console.error("[GitHub backup] Error al subir backup:", e.message);
            return;
        }
    }
}

// Las subidas se encadenan (nunca dos a la vez) y devuelven una promesa
// que se puede esperar, p. ej. al apagarse el servidor.
function pushDbToGithub() {
    if (!GITHUB_BACKUP_ENABLED || !dbSafeToBackup) return Promise.resolve();
    if (githubPushPromise) { githubPushPending = true; return githubPushPromise; }
    githubPushPromise = (async () => {
        try {
            do { githubPushPending = false; await pushDbToGithubOnce(); } while (githubPushPending);
        } finally { githubPushPromise = null; }
    })();
    return githubPushPromise;
}

// ---- Imágenes/modelos subidos (avatares, miniaturas, .glb...) también a GitHub ----
const remoteUploads = new Set();
let remoteUploadsListed = false;
let uploadSyncRunning = false;

async function listRemoteUploads() {
    try {
        const res = await githubApiFetch(ghContentsUrl(GITHUB_UPLOADS_PATH));
        if (res.status === 404) { remoteUploadsListed = true; return []; }
        if (res.status !== 200) return null;
        const list = await res.json();
        remoteUploadsListed = true;
        return Array.isArray(list) ? list.filter(f => f.type === "file") : [];
    } catch (e) { return null; }
}

async function downloadUploadFromGithub(name) {
    const res = await githubApiFetch(ghContentsUrl(`${GITHUB_UPLOADS_PATH}/${name}`), { headers: { Accept: "application/vnd.github.raw+json" } });
    if (!res.ok) return false;
    fs.writeFileSync(path.join(UPLOADS_DIR, name), Buffer.from(await res.arrayBuffer()));
    return true;
}

async function restoreMissingUploads() {
    if (!GITHUB_BACKUP_ENABLED) return;
    const list = await listRemoteUploads();
    if (!list) return;
    let restored = 0;
    for (const f of list) {
        remoteUploads.add(f.name);
        if (!fs.existsSync(path.join(UPLOADS_DIR, f.name))) {
            try { if (await downloadUploadFromGithub(f.name)) restored++; } catch (e) {}
        }
    }
    if (restored) console.log(`[GitHub backup] ${restored} archivo(s) subido(s) restaurado(s).`);
}

async function syncUploadsToGithub() {
    if (!GITHUB_BACKUP_ENABLED || uploadSyncRunning) return;
    uploadSyncRunning = true;
    try {
        if (!remoteUploadsListed) {
            const list = await listRemoteUploads();
            if (!list) return;
            list.forEach(f => remoteUploads.add(f.name));
        }
        for (const name of fs.readdirSync(UPLOADS_DIR)) {
            if (remoteUploads.has(name)) continue;
            const full = path.join(UPLOADS_DIR, name);
            if (!fs.statSync(full).isFile()) continue;
            const res = await githubApiFetch(ghContentsUrl(`${GITHUB_UPLOADS_PATH}/${name}`, false), {
                method: "PUT",
                body: JSON.stringify({
                    message: `Backup de archivo subido: ${name}`,
                    content: fs.readFileSync(full).toString("base64"),
                    branch: GITHUB_BRANCH
                })
            });
            if (res.ok || res.status === 422) remoteUploads.add(name); // 422 = ya existía
            else { console.error("[GitHub backup] No se pudo subir", name, res.status); break; }
        }
    } catch (e) {
        console.error("[GitHub backup] Error sincronizando archivos subidos:", e.message);
    } finally { uploadSyncRunning = false; }
}

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use("/uploads", express.static(UPLOADS_DIR));
// Si un archivo subido no está en el disco (p. ej. tras un redeploy), se
// recupera al vuelo desde la copia de seguridad de GitHub.
app.get("/uploads/:name", async (req, res) => {
    const name = path.basename(req.params.name);
    const local = path.join(UPLOADS_DIR, name);
    try {
        if (!fs.existsSync(local) && GITHUB_BACKUP_ENABLED) { try { await downloadUploadFromGithub(name); } catch (e) {} }
        if (!fs.existsSync(local) && S3_BACKUP_ENABLED) { try { await downloadUploadFromS3(name); } catch (e) {} }
        if (fs.existsSync(local)) return res.sendFile(local);
    } catch (e) {}
    res.status(404).end();
});

// ---------------------------------------------------------------------------
// BASE DE DATOS (fichero JSON persistente)
// ---------------------------------------------------------------------------

function defaultDb() {
    return {
        users: [],           // { id, username, passwordHash, coins, dollars, admin, owner, badges:[], inventory:[], equippedHats:[], equippedTeapot, equippedPfp, friends:[], friendRequests:[], banned, bannedUntil, blockSub:{active,expiresAt}, turboBlockSub:{active,expiresAt}, profileBgColor, profileSoundUrl, bio, reportsCount, avatarUrl, inventoryPublic, itemAcquiredTimes }
        accessories: [],      // { id, name, type, price, limited, offsale, onlyBlock, isGhost, maxPerUser, maxGlobal, expiresAt, totalSold, glbUrl, imageUrl, bgColor, soundUrl, creatorId, creatorUsername, createdByAdmin }
        groups: [],           // { id, name, description, ownerId, members:[], admins:[], pinned, forumEnabled, chatEnabled, membersEnabled, forumPosts:[], groupChatMessages:[], chatSections:[], newsMessages:[] }
        friendChats: {},      // key `${minId}_${maxId}` -> [ {senderId, senderUsername, text, imageUrl, createdAt} ]
        trades: [],           // pending trade offers
        codes: [],            // promo codes
        starCodes: [],        // { code, ownerUsername, ownerId, uses }
        settings: { blockRewardItemId: null, turboBlockRewardItemId: null, bannerText: "", exePath: "" },
        events: [],           // { id, name, description, themeColor, items:[], customHtml, active, createdAt }
        resaleListings: [],   // { id, itemId, sellerId, sellerUsername, price }
        adminMessages: {},    // userId -> [ {fromUsername, text, createdAt} ]
        itemReports: {},      // itemId -> [userId, ...]
        transactions: [],     // ventas de artículos y compras de monedas
        sessions: {},         // token -> { userId, createdAt } (persisten tras reiniciar)
        savedAt: 0,
        profileComments: {},  // userId -> [ {id, senderId, senderUsername, text, createdAt} ]
        blogComments: {},     // postId -> [ ... ]
        blogPosts: [],         // { id, title, content, imageUrl, authorUsername, createdAt }
        nextId: 1,
        nextUserId: 1,
        nextGroupId: 1
    };
}

let db = defaultDb();

// ---------------------------------------------------------------------------
// SEGUNDO MÉTODO DE COPIA DE SEGURIDAD: almacenamiento compatible con S3
// ---------------------------------------------------------------------------
// Totalmente independiente de GitHub. Funciona con Cloudflare R2, Backblaze B2,
// Supabase Storage, AWS S3, MinIO... Se activa con estas variables de entorno:
//   S3_ENDPOINT    p. ej. https://<cuenta>.r2.cloudflarestorage.com
//   S3_BUCKET      nombre del bucket
//   S3_ACCESS_KEY  y  S3_SECRET_KEY
//   S3_REGION      (opcional, por defecto "auto"; en B2 p. ej. "us-west-004")
//   S3_PREFIX      (opcional, carpeta dentro del bucket; por defecto "gameblocks-backup")
// Además hay una carpeta de seguridad FUERA del proyecto (BACKUP_DIR, por defecto
// ~/.gameblocks-backup) y una copia (snapshot) automática cada vez que se
// actualiza server.js, así que actualizar el código nunca deja los datos sin copia.
const S3_ENDPOINT = process.env.S3_ENDPOINT || null;
const S3_BUCKET = process.env.S3_BUCKET || null;
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || null;
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || null;
const S3_REGION = process.env.S3_REGION || "auto";
const S3_PREFIX = (process.env.S3_PREFIX || "gameblocks-backup").replace(/^\/|\/$/g, "");
const S3_BACKUP_ENABLED = !!(S3_ENDPOINT && S3_BUCKET && S3_ACCESS_KEY && S3_SECRET_KEY);
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(os.homedir(), ".gameblocks-backup");
const SERVER_VERSION = (() => { try { return crypto.createHash("sha256").update(fs.readFileSync(__filename)).digest("hex").slice(0, 12); } catch (e) { return "desconocida"; } })();

const sha256hex = d => crypto.createHash("sha256").update(d).digest("hex");
const hmacSha = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
const rfc3986 = s => encodeURIComponent(s).replace(/[!'()*]/g, ch => "%" + ch.charCodeAt(0).toString(16).toUpperCase());

// Firma AWS Signature V4 (se comprueba contra el vector oficial "get-vanilla").
function sigV4({ method, urlStr, headers = {}, payloadHash, region, service, accessKey, secretKey, amzDate }) {
    const url = new URL(urlStr);
    const dateStamp = amzDate.slice(0, 8);
    const all = { host: url.host, "x-amz-date": amzDate };
    for (const [k, v] of Object.entries(headers)) all[k.toLowerCase()] = v;
    const names = Object.keys(all).sort();
    const canonicalHeaders = names.map(k => `${k}:${String(all[k]).trim()}\n`).join("");
    const signedHeaders = names.join(";");
    const canonicalQuery = [...url.searchParams.entries()]
        .map(([k, v]) => [rfc3986(k), rfc3986(v)])
        .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : 1))
        .map(([k, v]) => `${k}=${v}`).join("&");
    const canonicalRequest = [method, url.pathname, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
    const kSigning = hmacSha(hmacSha(hmacSha(hmacSha("AWS4" + secretKey, dateStamp), region), service), "aws4_request");
    const signature = hmacSha(kSigning, stringToSign).toString("hex");
    return {
        signature,
        headers: all,
        authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    };
}

async function s3Request(method, key, { body = null, query = "" } = {}) {
    const keyPath = key ? key.split("/").map(rfc3986).join("/") : "";
    const urlStr = `${S3_ENDPOINT.replace(/\/$/, "")}/${S3_BUCKET}${keyPath ? "/" + keyPath : ""}${query ? "?" + query : ""}`;
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const payloadHash = sha256hex(body || "");
    const signed = sigV4({
        method, urlStr, headers: { "x-amz-content-sha256": payloadHash }, payloadHash,
        region: S3_REGION, service: "s3", accessKey: S3_ACCESS_KEY, secretKey: S3_SECRET_KEY, amzDate
    });
    const sendHeaders = { ...signed.headers, Authorization: signed.authorization };
    delete sendHeaders.host; // lo pone fetch
    return fetch(urlStr, { method, headers: sendHeaders, body: body || undefined });
}

let lastS3PushAt = 0, lastS3Error = null, s3SafeToBackup = true, remoteS3Users = 0;
let s3PushPromise = null, s3PushPending = false;
const s3Uploads = new Set();
let s3UploadsListed = false, s3UploadSyncRunning = false;

// { status: "ok", data } | { status: "missing" } | { status: "error", error }
async function pullDbFromS3() {
    if (!S3_BACKUP_ENABLED) return { status: "disabled" };
    try {
        const res = await s3Request("GET", `${S3_PREFIX}/db.json`);
        if (res.status === 404) return { status: "missing" };
        if (!res.ok) return { status: "error", error: `HTTP ${res.status}` };
        return { status: "ok", data: JSON.parse(await res.text()) };
    } catch (e) { return { status: "error", error: e.message }; }
}

async function pushDbToS3Once() {
    if ((db.users || []).length === 0 && remoteS3Users > 0) return;
    try {
        const res = await s3Request("PUT", `${S3_PREFIX}/db.json`, { body: Buffer.from(JSON.stringify(db)) });
        if (res.ok) { lastS3PushAt = Date.now(); lastS3Error = null; remoteS3Users = (db.users || []).length; }
        else { lastS3Error = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`; console.error("[S3 backup] Fallo al subir:", lastS3Error); }
    } catch (e) { lastS3Error = e.message; console.error("[S3 backup] Error al subir:", e.message); }
}

function pushDbToS3() {
    if (!S3_BACKUP_ENABLED || !s3SafeToBackup) return Promise.resolve();
    if (s3PushPromise) { s3PushPending = true; return s3PushPromise; }
    s3PushPromise = (async () => {
        try { do { s3PushPending = false; await pushDbToS3Once(); } while (s3PushPending); }
        finally { s3PushPromise = null; }
    })();
    return s3PushPromise;
}

async function s3ListKeys(prefix) {
    const keys = [];
    let token = null;
    do {
        const q = `list-type=2&prefix=${rfc3986(prefix)}${token ? "&continuation-token=" + rfc3986(token) : ""}`;
        const res = await s3Request("GET", "", { query: q });
        if (!res.ok) return null;
        const xml = await res.text();
        for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1].replace(/&amp;/g, "&"));
        const next = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) && next ? next[1] : null;
    } while (token);
    return keys;
}

async function downloadUploadFromS3(name) {
    const res = await s3Request("GET", `${S3_PREFIX}/uploads/${name}`);
    if (!res.ok) return false;
    fs.writeFileSync(path.join(UPLOADS_DIR, name), Buffer.from(await res.arrayBuffer()));
    return true;
}

async function restoreMissingUploadsFromS3() {
    if (!S3_BACKUP_ENABLED) return;
    const keys = await s3ListKeys(`${S3_PREFIX}/uploads/`);
    if (!keys) return;
    s3UploadsListed = true;
    let restored = 0;
    for (const k of keys) {
        const name = k.slice(`${S3_PREFIX}/uploads/`.length);
        if (!name) continue;
        s3Uploads.add(name);
        if (!fs.existsSync(path.join(UPLOADS_DIR, name))) { try { if (await downloadUploadFromS3(name)) restored++; } catch (e) {} }
    }
    if (restored) console.log(`[S3 backup] ${restored} archivo(s) subido(s) restaurado(s).`);
}

async function syncUploadsToS3() {
    if (!S3_BACKUP_ENABLED || s3UploadSyncRunning) return;
    s3UploadSyncRunning = true;
    try {
        if (!s3UploadsListed) {
            const keys = await s3ListKeys(`${S3_PREFIX}/uploads/`);
            if (!keys) return;
            keys.forEach(k => s3Uploads.add(k.slice(`${S3_PREFIX}/uploads/`.length)));
            s3UploadsListed = true;
        }
        for (const name of fs.readdirSync(UPLOADS_DIR)) {
            if (s3Uploads.has(name)) continue;
            const full = path.join(UPLOADS_DIR, name);
            if (!fs.statSync(full).isFile()) continue;
            const res = await s3Request("PUT", `${S3_PREFIX}/uploads/${name}`, { body: fs.readFileSync(full) });
            if (res.ok) s3Uploads.add(name);
            else { console.error("[S3 backup] No se pudo subir", name, res.status); break; }
        }
    } catch (e) { console.error("[S3 backup] Error sincronizando archivos:", e.message); }
    finally { s3UploadSyncRunning = false; }
}

// ---- Carpeta de seguridad fuera del proyecto + snapshots al actualizar ----
let lastBackupDirWrite = 0;
function writeBackupDir(force) {
    if (!force && Date.now() - lastBackupDirWrite < 15000) return;
    try {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        const tmp = path.join(BACKUP_DIR, "db.json.tmp");
        fs.writeFileSync(tmp, JSON.stringify(db));
        fs.renameSync(tmp, path.join(BACKUP_DIR, "db.json"));
        lastBackupDirWrite = Date.now();
    } catch (e) { /* carpeta no escribible: se ignora */ }
}

function readBackupDirDb() {
    try { return JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, "db.json"), "utf-8")); } catch (e) { return null; }
}

function snapshotDb(rawData, label) {
    const name = `db-${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const json = JSON.stringify(rawData);
    for (const dir of [path.join(DATA_DIR, "snapshots"), path.join(BACKUP_DIR, "snapshots")]) {
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, name), json);
            const old = fs.readdirSync(dir).filter(f => f.startsWith("db-")).sort();
            old.slice(0, Math.max(0, old.length - 20)).forEach(f => { try { fs.unlinkSync(path.join(dir, f)); } catch (e) {} });
        } catch (e) {}
    }
    if (S3_BACKUP_ENABLED) s3Request("PUT", `${S3_PREFIX}/snapshots/${name}`, { body: Buffer.from(json) }).catch(() => {});
    console.log(`[DB] Snapshot guardado: ${name}`);
}

// Pone al día datos guardados por versiones anteriores de server.js: así, al
// actualizar el código, ninguna cuenta ni artículo antiguo se rompe.
const SCHEMA_VERSION = 3;
function migrateDb() {
    db = Object.assign(defaultDb(), db);
    const userDefaults = {
        coins: 0, dollars: 0, blocks: 0, badges: [], inventory: [], equippedHats: [], equippedGears: [],
        equippedTeapot: null, equippedPfp: null, equippedFace: null, equippedHead: null,
        friends: [], friendRequests: [], followers: [], following: [], likedBy: [], dislikedBy: [],
        likesCount: 0, dislikesCount: 0, inventoryPublic: true, allowFriendRequests: true,
        allowTradeWithoutFriends: false, allowProfileComments: true, connectRewardClaimed: false,
        itemAcquiredTimes: {}, active: true, bio: "", reportsCount: 0, gamexConversionsThisMonth: 0, gamexMonthKey: null
    };
    for (const u of db.users) {
        for (const [k, v] of Object.entries(userDefaults)) if (u[k] === undefined || u[k] === null && Array.isArray(v)) u[k] = JSON.parse(JSON.stringify(v));
    }
    for (const a of db.accessories) {
        if (!Array.isArray(a.comments)) a.comments = [];
        if (!Array.isArray(a.reports)) a.reports = [];
        if (a.price === undefined) a.price = 0;
    }
    for (const g of db.groups) {
        for (const k of ["members", "admins", "groupChatMessages", "newsMessages", "forumPosts", "bannedMembers"]) if (!Array.isArray(g[k])) g[k] = [];
        if (!Array.isArray(g.chatSections)) g.chatSections = [{ id: "general", name: "General" }];
    }
    const maxId = arr => arr.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0);
    db.nextUserId = Math.max(db.nextUserId || 1, maxId(db.users) + 1);
    db.nextGroupId = Math.max(db.nextGroupId || 1, maxId(db.groups) + 1);
    db.nextId = Math.max(db.nextId || 1, maxId(db.accessories) + 1);
    db.schemaVersion = SCHEMA_VERSION;
}

function readLocalDb() {
    // Primero db.json; si estuviera corrupto, la copia rotativa db.backup.json.
    for (const file of [DB_FILE, DB_BACKUP_FILE]) {
        try {
            if (!fs.existsSync(file)) continue;
            const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
            if (parsed && typeof parsed === "object") {
                if (file === DB_BACKUP_FILE) console.warn("[DB] db.json no se pudo leer: se usa db.backup.json");
                return parsed;
            }
        } catch (e) {
            console.error(`[DB] No se pudo leer ${path.basename(file)}:`, e.message);
        }
    }
    return null;
}

const hasUsers = d => !!(d && Array.isArray(d.users) && d.users.length > 0);

function pruneSessions() {
    const TTL = 90 * 24 * 60 * 60 * 1000;
    db.sessions = db.sessions || {};
    for (const [t, s] of Object.entries(db.sessions)) {
        if (!s || Date.now() - (s.createdAt || 0) > TTL) delete db.sessions[t];
    }
}

let backupRetryTimer = null;
// Si un destino de copia falló al arrancar, se reintenta cada 30 s; cuando
// responde se compara con lo que hay en memoria y se vuelve a activar.
function scheduleBackupRetry() {
    clearInterval(backupRetryTimer);
    backupRetryTimer = setInterval(async () => {
        if (!dbSafeToBackup && GITHUB_BACKUP_ENABLED) {
            const r = await pullDbFromGithub();
            if (r.status !== "error") {
                if (r.status === "ok") {
                    remoteKnownUsers = (r.data.users || []).length;
                    if ((r.data.savedAt || 0) > (db.savedAt || 0)) { db = r.data; migrateDb(); saveDbNow(); console.log("[GitHub backup] Backup más reciente cargado."); }
                }
                dbSafeToBackup = true; pushDbToGithub();
            }
        }
        if (!s3SafeToBackup && S3_BACKUP_ENABLED) {
            const r = await pullDbFromS3();
            if (r.status !== "error") {
                if (r.status === "ok") {
                    remoteS3Users = (r.data.users || []).length;
                    if ((r.data.savedAt || 0) > (db.savedAt || 0)) { db = r.data; migrateDb(); saveDbNow(); console.log("[S3 backup] Backup más reciente cargado."); }
                }
                s3SafeToBackup = true; pushDbToS3();
            }
        }
        if (dbSafeToBackup && s3SafeToBackup) clearInterval(backupRetryTimer);
    }, 30000);
}

async function loadDb() {
    // Candidatos: disco, carpeta de seguridad, GitHub y S3. Gana el más reciente (savedAt).
    const candidates = [];
    const local = readLocalDb();
    if (hasUsers(local)) candidates.push({ name: "disco", data: local });
    const bdir = readBackupDirDb();
    if (hasUsers(bdir)) candidates.push({ name: "carpeta de seguridad", data: bdir });
    const haveLocal = candidates.length > 0;

    async function tryRemote(label, pullFn) {
        let r = { status: "error", error: "sin intentar" };
        for (let attempt = 1; attempt <= (haveLocal ? 1 : 6); attempt++) {
            r = await pullFn();
            if (r.status !== "error") break;
            console.error(`[${label}] Intento ${attempt} de leer el backup falló: ${r.error}`);
            if (!haveLocal) await sleep(attempt * 3000);
        }
        return r;
    }

    let gh = { status: "disabled" }, s3 = { status: "disabled" };
    if (GITHUB_BACKUP_ENABLED) gh = await tryRemote("GitHub backup", pullDbFromGithub);
    if (S3_BACKUP_ENABLED) s3 = await tryRemote("S3 backup", pullDbFromS3);
    if (!GITHUB_BACKUP_ENABLED && !S3_BACKUP_ENABLED) {
        console.warn("[DB] ⚠️ Sin backup remoto (GitHub/S3): si el disco de Render se borra, se pierden los datos.");
    }

    if (gh.status === "ok") { remoteKnownUsers = (gh.data.users || []).length; if (hasUsers(gh.data)) candidates.push({ name: "GitHub", data: gh.data }); }
    if (s3.status === "ok") { remoteS3Users = (s3.data.users || []).length; if (hasUsers(s3.data)) candidates.push({ name: "S3", data: s3.data }); }

    const anyError = gh.status === "error" || s3.status === "error";
    if (candidates.length === 0 && anyError) {
        // Mejor NO arrancar que arrancar vacío y pisar un backup bueno.
        throw new Error("No se pudo leer ningún backup remoto y no hay datos locales. No arranco con una base de datos vacía.");
    }
    if (gh.status === "error") dbSafeToBackup = false;
    if (s3.status === "error") s3SafeToBackup = false;
    if (!dbSafeToBackup || !s3SafeToBackup) scheduleBackupRetry();

    let chosen = null;
    for (const cand of candidates) {
        if (!chosen || (cand.data.savedAt || 0) > (chosen.data.savedAt || 0)) chosen = cand;
    }
    if (chosen && chosen.name !== "disco") console.log(`[DB] Base de datos restaurada desde: ${chosen.name}`);

    // Snapshot automático cuando server.js ha cambiado desde el último arranque.
    if (chosen && chosen.data.serverVersion && chosen.data.serverVersion !== SERVER_VERSION) {
        snapshotDb(chosen.data, "antes-de-actualizar");
    }

    db = Object.assign(defaultDb(), chosen ? chosen.data : {});
    migrateDb();
    db.serverVersion = SERVER_VERSION;
    pruneSessions();
    saveDbNow();
    writeBackupDir(true);
    if (GITHUB_BACKUP_ENABLED) { pushDbToGithub(); restoreMissingUploads().then(syncUploadsToGithub); }
    if (S3_BACKUP_ENABLED) { pushDbToS3(); restoreMissingUploadsFromS3().then(syncUploadsToS3); }
}

let saveTimer = null;
let githubSaveTimer = null;
let s3SaveTimer = null;
let lastBackupRotation = 0;

function saveDbNow() {
    try {
        db.savedAt = Date.now();
        // Copia rotativa del fichero anterior (como mucho cada 10 min).
        if (fs.existsSync(DB_FILE) && Date.now() - lastBackupRotation > 10 * 60 * 1000) {
            fs.copyFileSync(DB_FILE, DB_BACKUP_FILE);
            lastBackupRotation = Date.now();
        }
        // Escritura atómica: temporal + renombrado.
        const tmp = DB_FILE + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
        fs.renameSync(tmp, DB_FILE);
        lastLocalSaveAt = Date.now();
        dirty = false;
        writeBackupDir(false);
    } catch (e) {
        console.error("Error guardando la base de datos:", e.message);
    }
}

function saveDb() {
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDbNow, 150);

    if (GITHUB_BACKUP_ENABLED) {
        clearTimeout(githubSaveTimer);
        githubSaveTimer = setTimeout(pushDbToGithub, 4000);
    }
    if (S3_BACKUP_ENABLED) {
        clearTimeout(s3SaveTimer);
        s3SaveTimer = setTimeout(pushDbToS3, 4000);
    }
}

// ---- Guardado al apagarse (Render envía SIGTERM antes de parar el servidor) ----
let shuttingDown = false;
async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[${signal}] Guardando todo antes de apagar...`);
    try {
        saveDbNow();
        await Promise.race([
            (async () => { writeBackupDir(true); await Promise.all([pushDbToGithub(), pushDbToS3()]); await Promise.all([syncUploadsToGithub(), syncUploadsToS3()]); })(),
            sleep(20000)
        ]);
    } catch (e) { console.error("Error al guardar en el apagado:", e.message); }
    process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("uncaughtException", (e) => {
    console.error("uncaughtException:", e);
    try { saveDbNow(); } catch (_) {}
    process.exit(1);
});
process.on("unhandledRejection", (e) => { console.error("unhandledRejection:", e); });

function nextId() {
    const id = db.nextId++;
    saveDb();
    return String(id);
}

// Los usuarios y los grupos tienen su propio contador independiente, empezando en 1.
function nextUserId() {
    if (!db.nextUserId) db.nextUserId = 1;
    const id = db.nextUserId++;
    saveDb();
    return String(id);
}

function nextGroupId() {
    if (!db.nextGroupId) db.nextGroupId = 1;
    const id = db.nextGroupId++;
    saveDb();
    return String(id);
}

// La carga real de la base de datos (y, si aplica, del backup de GitHub) se
// lanza al final del fichero, justo antes de app.listen(), para no arrancar
// a aceptar peticiones antes de tener los datos listos.

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

// Las sesiones se guardan dentro de la base de datos (db.sessions), así que
// sobreviven a reinicios del servidor: nadie tiene que volver a iniciar sesión.
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const tokens = {
    set(token, userId) {
        db.sessions = db.sessions || {};
        db.sessions[token] = { userId, createdAt: Date.now() };
        saveDb();
    },
    get(token) {
        const s = db.sessions && db.sessions[token];
        if (!s) return undefined;
        if (Date.now() - (s.createdAt || 0) > SESSION_TTL_MS) { delete db.sessions[token]; return undefined; }
        return s.userId;
    },
    has(token) { return this.get(token) !== undefined; },
    delete(token) { if (db.sessions && db.sessions[token]) { delete db.sessions[token]; saveDb(); } },
    entries() { return Object.entries(db.sessions || {}).map(([t, s]) => [t, s.userId]); }
};

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

// No exige sesión, pero si hay un token válido, lo añade a req.user (para
// endpoints públicos que dan algo extra si estás autenticado, p.ej. ver el ID
// de un amigo en su ficha).
function optionalAuth(req, res, next) {
    const user = getUserFromReq(req);
    if (user) req.user = user;
    next();
}

function requireAdmin(req, res, next) {
    const user = getUserFromReq(req);
    if (!user) return res.status(401).json({ error: "No autenticado." });
    if (!isAdminUser(user)) return res.status(403).json({ error: "No tienes permisos de administrador." });
    req.user = user;
    next();
}

// Insignias automáticas de suscripción: aparecen mientras la suscripción esté
// activa y desaparecen automáticamente en cuanto expira.
function syncSubscriptionBadges(u) {
    u.badges = u.badges || [];
    const hasTurbo = hasActiveTurboBlock(u);
    const hasBlock = hasActiveBlock(u); // true también si tiene turbo
    const stripAuto = name => u.badges.filter(b => (typeof b === "object" ? b.name : b) !== name);

    // Turbo Block
    if (hasTurbo) {
        if (!u.badges.some(b => (typeof b === "object" ? b.name : b) === "Turbo Block")) {
            u.badges.push({ name: "Turbo Block", auto: true, addedAt: Date.now() });
        }
    } else {
        u.badges = stripAuto("Turbo Block");
    }
    // Block (solo si no tiene ya turbo, turbo la incluye pero mantenemos insignia Block aparte
    // únicamente cuando el usuario tiene Block "normal" activo)
    const blockOnlyActive = !!(u.blockSub && u.blockSub.active && u.blockSub.expiresAt > Date.now());
    if (blockOnlyActive) {
        if (!u.badges.some(b => (typeof b === "object" ? b.name : b) === "Block")) {
            u.badges.push({ name: "Block", auto: true, addedAt: Date.now() });
        }
    } else {
        u.badges = stripAuto("Block");
    }
}

// Vista PÚBLICA de un usuario (lo que ve cualquier otra persona). NUNCA incluye
// el id de cuenta: el id solo lo puede ver el propio dueño (o el owner de la web).
// Si el usuario tiene equipado un artículo que cambia el color de fondo o
// reproduce un sonido, esto se calcula siempre a partir del artículo
// equipado (no de un valor guardado aparte), así que se ve igual para
// cualquiera que visite su tarjeta pública, y persiste tras recargar.
// Si el usuario tiene equipados sombreros o un Teapot con color/sonido
// propio, se calcula siempre a partir de lo que tiene equipado ahora mismo
// (no de un valor guardado aparte), para que se vea igual en cualquier
// tarjeta pública y persista tras recargar.
function equippedStyling(u) {
    const candidates = [
        ...(u.equippedHats || []).map(id => findItem(id)),
        u.equippedTeapot ? findItem(u.equippedTeapot) : null
    ].filter(Boolean);
    const withBg = candidates.find(it => it.bgColor);
    const withSound = candidates.find(it => it.soundUrl);
    return {
        bgColor: (withBg && withBg.bgColor) || null,
        soundUrl: (withSound && withSound.soundUrl) || null
    };
}

// Foto de perfil efectiva de cualquier usuario (si tiene equipado un artículo
// "foto de perfil", esa imagen; si no, la que tuviera). Se usa en chats,
// grupos, búsquedas, amigos, comentarios...
function avatarOf(u) {
    if (!u) return null;
    const pfp = u.equippedPfp ? findItem(u.equippedPfp) : null;
    return (pfp && pfp.imageUrl) || u.avatarUrl || null;
}
function avatarByUsername(name) {
    return avatarOf(findUserByUsername(name));
}
// Añade la foto de perfil actual del autor a un mensaje/post/comentario.
function withAvatar(m) {
    if (!m) return m;
    return { ...m, senderAvatar: m.senderId ? avatarById(m.senderId) : avatarByUsername(m.senderUsername || m.authorUsername) };
}

function avatarById(id) {
    return avatarOf(db.users.find(x => String(x.id) === String(id)));
}

function publicUser(u, viewer) {
    syncSubscriptionBadges(u);
    const inactive = u.active === false;
    if (inactive) {
        // Cuenta inactiva: solo se muestran foto, nombre y el estado "Inactivo".
        return {
            id: u.id,
            username: u.username,
            avatarUrl: u.avatarUrl || null,
            avatar: u.avatarUrl || null,
            inactive: true,
            badges: [],
            inventory: [],
            friends: [],
            bio: "",
            blockSub: false,
            turboBlockSub: false,
            banned: false,
            likesCount: 0,
            dislikesCount: 0,
            followersCount: 0,
            followingCount: 0
        };
    }

    // Foto de perfil: si tiene equipado un artículo tipo "pfp", esa imagen
    // sustituye a la que tenía subida a mano.
    const pfpItem = u.equippedPfp ? findItem(u.equippedPfp) : null;
    const effectiveAvatar = (pfpItem && pfpItem.imageUrl) || u.avatarUrl || null;

    // El inventario solo se muestra si el usuario lo tiene en público, salvo
    // que quien mira sea el Owner (que siempre puede verlo).
    const isOwnerViewer = !!(viewer && viewer.owner);
    const showInventory = u.inventoryPublic !== false || isOwnerViewer;

    return {
        id: u.id, // los IDs de cuenta son públicos
        username: u.username,
        admin: !!u.admin,
        owner: !!u.owner,
        badges: u.badges || [],
        inventory: showInventory ? (u.inventory || []).map(id => findItem(id)).filter(Boolean) : [],
        inventoryPublic: u.inventoryPublic !== false,
        commentsEnabled: u.allowProfileComments !== false,
        equippedHats: u.equippedHats || [],
        equippedTeapot: u.equippedTeapot || null,
        equippedPfp: u.equippedPfp || null,
        equippedFace: u.equippedFace || null,
        equippedHead: u.equippedHead || null,
        equippedGears: u.equippedGears || [],
        friends: u.friends || [],
        profileBgColor: equippedStyling(u).bgColor,
        profileSoundUrl: equippedStyling(u).soundUrl,
        bio: u.bio || "",
        avatarUrl: effectiveAvatar,
        avatar: effectiveAvatar,
        blockSub: hasActiveBlock(u),
        turboBlockSub: hasActiveTurboBlock(u),
        banned: !!u.banned,
        inactive: false,
        likesCount: u.likesCount || 0,
        dislikesCount: u.dislikesCount || 0,
        followersCount: (u.followers || []).length,
        followingCount: (u.following || []).length,
        isAlert: !!u.banned,
        teapotHtml: (() => {
            const eq = u.equippedTeapot ? findItem(u.equippedTeapot) : null;
            return eq ? (eq.customHtml || "") : null;
        })()
    };
}

// Vista PRIVADA (solo para el propio usuario vía /api/me): incluye su id de cuenta.
function privateUser(u) {
    syncSubscriptionBadges(u);
    const pfpItem = u.equippedPfp ? findItem(u.equippedPfp) : null;
    const effectiveAvatar = (pfpItem && pfpItem.imageUrl) || u.avatarUrl || null;
    return {
        id: u.id,
        username: u.username,
        coins: u.coins,
        blocks: u.blocks || 0,
        allowFriendRequests: u.allowFriendRequests !== false,
        allowTradeWithoutFriends: !!u.allowTradeWithoutFriends,
        allowProfileComments: u.allowProfileComments !== false,
        connectRewardClaimed: !!u.connectRewardClaimed,
        dollars: u.dollars,
        admin: !!u.admin,
        owner: !!u.owner,
        badges: u.badges || [],
        inventory: u.inventory || [],
        inventoryPublic: u.inventoryPublic !== false,
        equippedHats: u.equippedHats || [],
        equippedTeapot: u.equippedTeapot || null,
        equippedPfp: u.equippedPfp || null,
        equippedFace: u.equippedFace || null,
        equippedHead: u.equippedHead || null,
        equippedGears: u.equippedGears || [],
        friends: u.friends || [],
        friendRequests: u.friendRequests || [],
        profileBgColor: equippedStyling(u).bgColor,
        profileSoundUrl: equippedStyling(u).soundUrl,
        bio: u.bio || "",
        avatarUrl: effectiveAvatar,
        avatar: effectiveAvatar,
        rawAvatarUrl: u.avatarUrl || null,
        blockSub: hasActiveBlock(u),
        turboBlockSub: hasActiveTurboBlock(u),
        banned: !!u.banned,
        active: u.active !== false,
        followers: (u.followers || []).length,
        following: (u.following || []).length,
        followingIds: u.following || []
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
// WEBHOOK DE DISCORD: avisa cuando se crea un artículo nuevo
// ---------------------------------------------------------------------------

const DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/1556278291021828107/imSv8j3cbfiTE2yEM5ybCQcI1xqR9rbTMGjt47PSnupduHuc-hEOOVHa_Bsm9aPr-gMI";
const DISCORD_LIMITED_ROLE_MENTION = "<@&1556278688817877152>";
const SITE_URL = process.env.SITE_URL || "https://www.gameblocks.panstudios.es";

// URL pública de ESTE servidor (para que Discord pueda descargar la miniatura).
function publicBaseUrl(req) {
    if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
    if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, "");
    if (req) {
        const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0];
        return `${proto}://${req.get("host")}`;
    }
    return "";
}

async function sendDiscordWebhook(payload) {
    try {
        await fetch(DISCORD_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(typeof payload === "string" ? { content: payload } : payload)
        });
    } catch (e) {
        console.error("[Discord webhook] Error al enviar mensaje:", e.message);
    }
}

function describeItemPrice(item) {
    if ((item.price || 0) === 0 && (item.priceBlocks || 0) === 0) return "Gratis";
    const parts = [];
    if (item.price > 0) parts.push(`${item.price} monedas`);
    if (item.priceBlocks > 0) parts.push(`${item.priceBlocks} Bloques 🟥`);
    return parts.join(" + ");
}

function itemLink(item) { return `${SITE_URL}?itemid=${item.id}`; }

// El webhook SOLO avisa de artículos creados por administradores.
function createdByAdminUser(item) {
    const creator = db.users.find(u => String(u.id) === String(item.creatorId));
    return !!(creator && isAdminUser(creator)) || (!item.creatorId && !!item.createdByAdmin);
}

function sendItemWebhook(item, req, limited) {
    if (item.isVariant || !createdByAdminUser(item)) return;
    const link = itemLink(item);
    let image = item.imageUrl || "";
    if (image && !/^https?:\/\//i.test(image)) image = publicBaseUrl(req) + image;
    const content = limited
        ? `Nuevo item limited ${item.name} ${DISCORD_LIMITED_ROLE_MENTION}\n${link}`
        : `Nuevo item: ${item.name} por ${describeItemPrice(item)}\n${link}`;
    const embed = {
        title: item.name,
        url: link,
        description: `${limited ? "LIMITED · " : ""}Precio: ${describeItemPrice(item)}`
    };
    if (image) embed.image = { url: image };
    sendDiscordWebhook({ content, embeds: [embed] });
}

function notifyDiscordNewLimited(item, req) { sendItemWebhook(item, req, true); }
function notifyDiscordNewItem(item, req) { sendItemWebhook(item, req, !!item.limited); }

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
        id: nextUserId(), // id de cuenta independiente, empezando en 1
        username,
        passwordHash: hashPassword(password),
        coins: 100,
        dollars: 10,
        blocks: 10, // Bloques 🟥: moneda premium del juego
        gamexMonthKey: null,
        gamexConversionsThisMonth: 0,
        allowFriendRequests: true,
        allowTradeWithoutFriends: false,
        admin: db.users.length === 0, // el primer usuario registrado es admin/owner por defecto
        owner: db.users.length === 0,
        badges: [],
        inventory: [],
        equippedHats: [],
        equippedTeapot: null,
        equippedPfp: null,
        equippedFace: null,
        equippedHead: null,
        equippedGears: [],
        allowProfileComments: true,
        connectRewardClaimed: false,
        inventoryPublic: true,
        itemAcquiredTimes: {},
        friends: [],
        friendRequests: [],
        followers: [],
        following: [],
        likesCount: 0,
        dislikesCount: 0,
        likedBy: [],
        dislikedBy: [],
        banned: false,
        bannedUntil: null,
        active: true,
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
    res.json({ token, user: privateUser(user) });
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
    // Al iniciar sesión, la cuenta deja de estar inactiva automáticamente.
    if (user.active === false) user.active = true;
    const token = issueToken(user.id);
    saveDb();
    res.json({ token, user: privateUser(user) });
});

app.get("/api/me", requireAuth, (req, res) => {
    grantDailyCoinsIfNeeded(req.user);
    res.json(privateUser(req.user));
});

// Las monedas diarias se han quitado: ahora la recompensa diaria es de
// 10 Bloques 🟥 (la nueva moneda premium del juego).
function grantDailyCoinsIfNeeded(user) {
    const now = new Date();
    const todayKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}`;
    if (user._lastDailyKey === todayKey) return;
    user.blocks = (user.blocks || 0) + 10;
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

    // Artículo regalo configurado por los admins: se entrega a partir del
    // 3er paquete de monedas, aunque esté offsale (una copia, si no lo tienes).
    let giftItemName = null;
    const giftId = db.settings && db.settings.coinRewardItemId;
    const pkgIndex = COIN_PACKAGES.indexOf(pkg);
    if (giftId && pkgIndex >= 2) {
        const gift = findItem(giftId);
        if (gift && !user.inventory.some(id => String(id) === String(gift.id))) {
            user.inventory.push(gift.id);
            gift.totalSold = (gift.totalSold || 0) + 1;
            user.itemAcquiredTimes = user.itemAcquiredTimes || {};
            user.itemAcquiredTimes[gift.id] = user.itemAcquiredTimes[gift.id] || [];
            user.itemAcquiredTimes[gift.id].push(Date.now());
            giftItemName = gift.name;
        }
    }

    db.transactions = db.transactions || [];
    db.transactions.push({
        id: nextId(),
        type: "coin_purchase",
        userId: user.id,
        username: user.username,
        coinsBought: totalCoins,
        dollarsSpent: pkg.dollars,
        starCodeApplied,
        createdAt: Date.now()
    });

    saveDb();
    res.json({ coins: user.coins, dollars: user.dollars, starCodeApplied, giftItemName });
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

// --- Regalar Block / Turbo Block a un amigo ---
const GIFT_BLOCK_PRICE_DOLLARS = 6;
const GIFT_TURBO_BLOCK_PRICE_DOLLARS = 11;

app.post("/api/subscription/gift", requireAuth, (req, res) => {
    const { toUserId, type } = req.body || {}; // type: "block" | "turbo"
    const giver = req.user;
    const receiver = db.users.find(u => String(u.id) === String(toUserId));
    if (!receiver) return res.status(404).json({ error: "Usuario no encontrado." });
    if (String(receiver.id) === String(giver.id)) return res.status(400).json({ error: "No puedes regalarte una suscripción a ti mismo." });
    if (!(giver.friends || []).includes(receiver.id)) return res.status(400).json({ error: "Solo puedes regalar suscripciones a tus amigos." });

    if (type === "turbo") {
        if (giver.dollars < GIFT_TURBO_BLOCK_PRICE_DOLLARS) return res.status(400).json({ error: "No tienes 💲 suficientes." });
        giver.dollars -= GIFT_TURBO_BLOCK_PRICE_DOLLARS;
        const base = receiver.turboBlockSub && receiver.turboBlockSub.expiresAt > Date.now() ? receiver.turboBlockSub.expiresAt : Date.now();
        receiver.turboBlockSub = { active: true, expiresAt: base + THIRTY_DAYS_MS };
        // El regalador recibe además 1000 monedas por regalar Turbo Block.
        giver.coins += 1000;
    } else if (type === "block") {
        if (giver.dollars < GIFT_BLOCK_PRICE_DOLLARS) return res.status(400).json({ error: "No tienes 💲 suficientes." });
        giver.dollars -= GIFT_BLOCK_PRICE_DOLLARS;
        const base = receiver.blockSub && receiver.blockSub.expiresAt > Date.now() ? receiver.blockSub.expiresAt : Date.now();
        receiver.blockSub = { active: true, expiresAt: base + THIRTY_DAYS_MS };
    } else {
        return res.status(400).json({ error: "Tipo de regalo no válido." });
    }

    // Insignia de regalador para quien regala una suscripción.
    giver.badges = giver.badges || [];
    const giftBadgeName = type === "turbo" ? "🎁 Regaló Turbo Block" : "🎁 Regaló Block";
    if (!giver.badges.some(b => (typeof b === "object" ? b.name : b) === giftBadgeName)) {
        giver.badges.push({ name: giftBadgeName, addedAt: Date.now() });
    }

    saveDb();
    res.json({ ok: true, message: `¡Has regalado ${type === "turbo" ? "Turbo Block" : "Block"} a ${receiver.username}!`, dollars: giver.dollars, coins: giver.coins });
});

// ---------------------------------------------------------------------------
// CATÁLOGO / ACCESORIOS
// ---------------------------------------------------------------------------

function maskAnonymous(item) {
    if (!item.anonymous) return item;
    return { ...item, creatorUsername: "Anónimo" };
}

app.get("/api/accessories", (req, res) => {
    const items = db.accessories.filter(a => !a.isGhost && !a.isVariant && (a.reports || []).length < 10).map(maskAnonymous);
    res.json({ items });
});

app.get("/api/accessories/all", (req, res) => {
    res.json({ items: db.accessories.map(maskAnonymous) });
});

// Lógica común de comprar un artículo para uno mismo o regalarlo a otra persona.
// payer = quien paga; receiver = quien lo recibe (puede ser el mismo).
function performPurchase(payer, receiver, item, isGift) {
    if (item.offsale) return { status: 400, error: "Este artículo no está a la venta." };
    if (item.expiresAt && Date.now() > item.expiresAt) return { status: 400, error: "Este artículo ya no está disponible." };

    if (item.onlyBlock === "turbo" && !hasActiveTurboBlock(payer)) {
        return { status: 403, error: "Este artículo requiere Suscripción Turbo Block." };
    }
    if (item.onlyBlock === true && !hasActiveBlock(payer)) {
        return { status: 403, error: "Este artículo requiere Suscripción Block." };
    }

    const ownedCount = receiver.inventory.filter(id => String(id) === String(item.id)).length;
    if (!item.limited) {
        // Los artículos que no son limited solo se pueden tener (comprar) 1 vez.
        if (ownedCount >= 1) {
            return { status: 400, error: isGift
                ? `${receiver.username} ya tiene este artículo (los no limited solo se pueden tener 1 vez).`
                : "Ya tienes este artículo. Los artículos que no son limited solo se pueden comprar 1 vez." };
        }
    } else {
        if (item.maxPerUser && ownedCount >= item.maxPerUser) {
            return { status: 400, error: isGift ? `${receiver.username} ya tiene el máximo de copias permitidas.` : "Ya tienes el máximo de copias permitidas de este artículo." };
        }
        if (item.maxGlobal != null && (item.totalSold || 0) >= item.maxGlobal) {
            return { status: 400, error: "Este artículo limitado se ha agotado." };
        }
    }

    // Al regalar se paga el precio completo (sin descuento de variantes).
    const eff = isGift
        ? { coins: item.price || 0, blocks: Number(item.priceBlocks) || 0 }
        : effectivePrice(payer, item);
    const priceBlocks = eff.blocks;
    if (payer.coins < eff.coins) return { status: 400, error: "No tienes monedas suficientes." };
    if (priceBlocks > 0 && (payer.blocks || 0) < priceBlocks) return { status: 400, error: "No tienes suficientes Bloques 🟥." };

    payer.coins -= eff.coins;
    if (priceBlocks > 0) payer.blocks = (payer.blocks || 0) - priceBlocks;
    receiver.inventory.push(item.id);
    item.totalSold = (item.totalSold || 0) + 1;

    // Periodo de retención de 3 días para quien recibe la copia.
    receiver.itemAcquiredTimes = receiver.itemAcquiredTimes || {};
    receiver.itemAcquiredTimes[item.id] = receiver.itemAcquiredTimes[item.id] || [];
    receiver.itemAcquiredTimes[item.id].push(Date.now());

    // Ganancias del creador (usuarios normales y 🎩UGC+; los admins no cobran):
    // el precio en monedas + el precio en bloques + 5 bloques por venta.
    if (item.creatorId && !item.createdByAdmin && String(item.creatorId) !== String(payer.id) && (item.price > 0 || priceBlocks > 0 || true)) {
        const creator = db.users.find(u => String(u.id) === String(item.creatorId));
        if (creator) {
            creator.coins += eff.coins;
            const blocksEarned = priceBlocks + SALE_BLOCKS_REWARD;
            creator.blocks = (creator.blocks || 0) + blocksEarned;
            db.transactions = db.transactions || [];
            db.transactions.push({
                id: nextId(),
                type: "sale",
                itemId: item.id,
                itemName: item.name,
                buyerId: payer.id,
                buyerUsername: payer.username,
                receiverUsername: receiver.username,
                gift: !!isGift,
                sellerId: creator.id,
                sellerUsername: creator.username,
                amount: eff.coins,
                blocksEarned,
                createdAt: Date.now()
            });
        }
    }

    // Star Code enlazado (p. ej. Teapots): su dueño recibe un 10% en monedas.
    if (item.linkedStarCode) {
        const sc = db.starCodes.find(c => c.code.toLowerCase() === String(item.linkedStarCode).toLowerCase());
        if (sc) {
            const owner = db.users.find(u => String(u.id) === String(sc.ownerId));
            if (owner) owner.coins += Math.floor(item.price * 0.1);
            sc.uses = (sc.uses || 0) + 1;
        }
    }
    return { ok: true, eff };
}

app.post("/api/accessories/buy", requireAuth, (req, res) => {
    const { itemId } = req.body || {};
    const item = findItem(itemId);
    if (!item) return res.status(404).json({ error: "Artículo no encontrado." });
    const r = performPurchase(req.user, req.user, item, false);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    saveDb();
    res.json({ newBalance: req.user.coins });
});

// Regalar un artículo: pagas lo que vale y lo recibe otra persona (por nombre o ID).
app.post("/api/accessories/gift", requireAuth, (req, res) => {
    const { itemId, to } = req.body || {};
    const item = findItem(itemId);
    if (!item) return res.status(404).json({ error: "Artículo no encontrado." });
    const key = String(to || "").trim();
    if (!key) return res.status(400).json({ error: "Escribe el nombre o el ID del usuario al que regalar." });
    const receiver = db.users.find(u => String(u.id) === key) || findUserByUsername(key);
    if (!receiver) return res.status(404).json({ error: "No existe ningún usuario con ese nombre o ID." });
    if (String(receiver.id) === String(req.user.id)) return res.status(400).json({ error: "No puedes regalarte un artículo a ti mismo (cómpralo normal)." });
    const r = performPurchase(req.user, receiver, item, true);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    saveDb();
    res.json({ ok: true, message: `¡Has regalado "${item.name}" a ${receiver.username}!`, newBalance: req.user.coins, newBlocks: req.user.blocks || 0 });
});

// Comprueba si el usuario puede revender/tradear una copia de este artículo.
// Los limiteds recién comprados tienen 3 días de retención antes de poder
// revenderse o tradearse; los admins no tienen esta restricción.
function canResellOrTrade(user, itemId) {
    if (isAdminUser(user)) return true;
    const times = (user.itemAcquiredTimes && user.itemAcquiredTimes[itemId]) || [];
    if (times.length === 0) return true;
    const oldest = Math.min(...times);
    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
    return (Date.now() - oldest) >= THREE_DAYS_MS;
}

function retentionRemaining(user, itemId) {
    const times = (user.itemAcquiredTimes && user.itemAcquiredTimes[itemId]) || [];
    if (times.length === 0) return 0;
    const oldest = Math.min(...times);
    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
    return Math.max(0, THREE_DAYS_MS - (Date.now() - oldest));
}

// ---------------------------------------------------------------------------
// BLOQUES 🟥 (segunda moneda premium) y gamEX
// ---------------------------------------------------------------------------

const BLOCKS_PRICE_PER_COIN = 1; // comprar 1 bloque cuesta 1 moneda (gamEX no cambia)
const GAMEX_RATE_BLOCKS_PER_COIN = 20; // convertir 20 bloques = 1 moneda
const GAMEX_MAX_CONVERSIONS_PER_MONTH = 20;
const SALE_BLOCKS_REWARD = 5;

app.post("/api/blocks/buy", requireAuth, (req, res) => {
    const { amount } = req.body || {};
    const user = req.user;
    const blocksToBuy = Math.floor(Number(amount));
    if (!blocksToBuy || blocksToBuy <= 0) return res.status(400).json({ error: "Cantidad no válida." });
    const cost = blocksToBuy * BLOCKS_PRICE_PER_COIN;
    if (user.coins < cost) return res.status(400).json({ error: "No tienes monedas suficientes." });
    user.coins -= cost;
    user.blocks = (user.blocks || 0) + blocksToBuy;
    saveDb();
    res.json({ coins: user.coins, blocks: user.blocks });
});

app.post("/api/blocks/gamex-convert", requireAuth, (req, res) => {
    const { blocks } = req.body || {};
    const user = req.user;
    const blocksToConvert = Math.floor(Number(blocks));
    if (!blocksToConvert || blocksToConvert <= 0 || blocksToConvert % GAMEX_RATE_BLOCKS_PER_COIN !== 0) {
        return res.status(400).json({ error: `Debes convertir en múltiplos de ${GAMEX_RATE_BLOCKS_PER_COIN} bloques.` });
    }
    const now = new Date();
    const monthKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}`;
    if (user.gamexMonthKey !== monthKey) {
        user.gamexMonthKey = monthKey;
        user.gamexConversionsThisMonth = 0;
    }
    if ((user.gamexConversionsThisMonth || 0) >= GAMEX_MAX_CONVERSIONS_PER_MONTH) {
        return res.status(400).json({ error: `Ya has hecho el máximo de ${GAMEX_MAX_CONVERSIONS_PER_MONTH} conversiones este mes.` });
    }
    if ((user.blocks || 0) < blocksToConvert) return res.status(400).json({ error: "No tienes suficientes bloques." });

    const coinsGained = blocksToConvert / GAMEX_RATE_BLOCKS_PER_COIN;
    user.blocks -= blocksToConvert;
    user.coins += coinsGained;
    user.gamexConversionsThisMonth = (user.gamexConversionsThisMonth || 0) + 1;
    saveDb();
    res.json({
        coins: user.coins,
        blocks: user.blocks,
        conversionsLeft: GAMEX_MAX_CONVERSIONS_PER_MONTH - user.gamexConversionsThisMonth
    });
});

app.get("/api/transactions/mine", requireAuth, (req, res) => {
    db.transactions = db.transactions || [];
    const myId = String(req.user.id);
    // Ventas: de tu ropa/accesorios (sale) y de tus reventas (resale).
    const sales = db.transactions.filter(t => (t.type === "sale" || t.type === "resale") && String(t.sellerId) === myId);
    const resalePurchases = db.transactions.filter(t => t.type === "resale" && String(t.buyerId) === myId);
    const purchases = db.transactions.filter(t => t.type === "coin_purchase" && String(t.userId) === myId);
    const totalEarned = sales.reduce((sum, t) => sum + (t.amount || 0), 0);
    const totalBlocksEarned = sales.reduce((sum, t) => sum + (t.blocksEarned || 0), 0);
    res.json({
        sales: sales.sort((a, b) => b.createdAt - a.createdAt),
        resalePurchases: resalePurchases.sort((a, b) => b.createdAt - a.createdAt),
        purchases: purchases.sort((a, b) => b.createdAt - a.createdAt),
        totalEarned,
        totalBlocksEarned
    });
});

app.post("/api/accessories/equip", requireAuth, (req, res) => {
    const { itemId } = req.body || {};
    const user = req.user;
    if (!user.inventory.some(id => String(id) === String(itemId))) {
        return res.status(400).json({ error: "No posees este artículo." });
    }
    const item = findItem(itemId);
    if (!item) return res.status(404).json({ error: "Artículo no encontrado." });

    user.equippedHats = user.equippedHats || [];
    if (item.type === "hat") {
        if (!user.equippedHats.some(id => String(id) === String(itemId))) {
            if (user.equippedHats.length >= 3) {
                return res.status(400).json({ error: "Ya tienes 3 sombreros equipados (el máximo). Desequipa uno primero." });
            }
            user.equippedHats.push(itemId);
        }
    } else if (item.type === "teapot") {
        user.equippedTeapot = itemId;
    } else if (item.type === "pfp") {
        user.equippedPfp = itemId;
    } else if (item.type === "face") {
        user.equippedFace = itemId;
    } else if (item.type === "head") {
        user.equippedHead = itemId; // solo 1 cabeza
    } else if (item.type === "gear") {
        user.equippedGears = user.equippedGears || [];
        if (!user.equippedGears.some(id => String(id) === String(itemId))) {
            if (user.equippedGears.length >= 3) {
                return res.status(400).json({ error: "Ya tienes 3 gears equipados (el máximo). Desequipa uno primero." });
            }
            user.equippedGears.push(itemId);
        }
    } else {
        return res.status(400).json({ error: "Este tipo de artículo no se puede equipar." });
    }

    saveDb();
    res.json({
        equippedHats: user.equippedHats,
        equippedTeapot: user.equippedTeapot || null,
        equippedPfp: user.equippedPfp || null,
        equippedFace: user.equippedFace || null,
        equippedHead: user.equippedHead || null,
        equippedGears: user.equippedGears || [],
        profileBgColor: equippedStyling(user).bgColor,
        profileSoundUrl: equippedStyling(user).soundUrl
    });
});

app.post("/api/accessories/unequip", requireAuth, (req, res) => {
    const { itemId } = req.body || {};
    const user = req.user;
    user.equippedHats = user.equippedHats || [];

    if (itemId) {
        user.equippedHats = user.equippedHats.filter(id => String(id) !== String(itemId));
        if (String(user.equippedTeapot) === String(itemId)) user.equippedTeapot = null;
        if (String(user.equippedPfp) === String(itemId)) user.equippedPfp = null;
        if (String(user.equippedFace) === String(itemId)) user.equippedFace = null;
        if (String(user.equippedHead) === String(itemId)) user.equippedHead = null;
        user.equippedGears = (user.equippedGears || []).filter(id => String(id) !== String(itemId));
    } else {
        user.equippedGears = [];
        user.equippedHead = null;
        user.equippedHats = [];
        user.equippedTeapot = null;
        user.equippedPfp = null;
        user.equippedFace = null;
    }
    saveDb();
    res.json({ ok: true, equippedHats: user.equippedHats, equippedTeapot: user.equippedTeapot || null, equippedPfp: user.equippedPfp || null });
});

// NOTA: se ha eliminado la venta directa de artículos por el 50% de su valor.
// Ahora solo se pueden revender los Limiteds Offsale, a través del mercado de
// reventa (/api/accessories/resell-list).

app.get("/api/accessories/resale-market", (req, res) => {
    res.json({ listings: db.resaleListings });
});

// Página de detalle de un artículo: toda su info + (si aplica) sus reventas,
// para que la tienda ya no necesite una página de reventa aparte.
app.get("/api/accessories/:id/detail", (req, res) => {
    const item = findItem(req.params.id);
    if (!item) return res.status(404).json({ error: "Artículo no encontrado." });
    const listings = db.resaleListings
        .filter(l => String(l.itemId) === String(item.id))
        .sort((a, b) => a.price - b.price);
    const g = variantGroupOf(item);
    const variants = g.ids.length > 1
        ? g.ids.map(id => findItem(id)).filter(Boolean).map(v => ({
            id: v.id, label: v.variantLabel || "Original", imageUrl: v.imageUrl, glbUrl: v.glbUrl || null,
            price: v.price, priceBlocks: v.priceBlocks || 0
        }))
        : [];
    const masked = maskAnonymous(item);
    masked.comments = (item.comments || []).map(withAvatar);
    res.json({
        item: masked,
        resaleListings: listings,
        bestResalePrice: listings.length > 0 ? listings[0].price : null,
        variants,
        variantDiscountPercent: g.percent
    });
});

// Precio máximo de reventa: 9 billones de monedas (9 x 10^12).
const RESALE_MAX_PRICE = 9000000000000;

app.post("/api/accessories/resell-list", requireAuth, (req, res) => {
    const { itemId, price } = req.body || {};
    const user = req.user;
    const item = findItem(itemId);
    if (!item || !item.limited || !item.offsale) return res.status(400).json({ error: "Solo se pueden revender Limiteds Offsale." });
    if (!user.inventory.some(id => String(id) === String(itemId))) return res.status(400).json({ error: "No posees este artículo." });
    if (!canResellOrTrade(user, itemId)) {
        const hours = Math.ceil(retentionRemaining(user, itemId) / (60 * 60 * 1000));
        return res.status(400).json({ error: `Este Limited está en periodo de retención. Podrás revenderlo en ~${hours}h.` });
    }
    const p = Math.floor(Number(price));
    if (!p || p < 1) return res.status(400).json({ error: "Pon un precio de reventa válido (mínimo 1 moneda)." });
    if (p > RESALE_MAX_PRICE) return res.status(400).json({ error: "El precio máximo de reventa es 9.000.000.000.000 monedas (9 billones)." });

    // Solo una reventa publicada por artículo; para cambiarla hay que eliminarla antes.
    if (db.resaleListings.some(l => String(l.itemId) === String(itemId) && String(l.sellerId) === String(user.id))) {
        return res.status(400).json({ error: "Ya tienes una reventa publicada de este artículo. Elimínala para publicar otra." });
    }

    // La copia NO sale de tu inventario hasta que alguien la compre.
    const listing = { id: nextId(), itemId, sellerId: user.id, sellerUsername: user.username, price: p, createdAt: Date.now() };
    db.resaleListings.push(listing);
    saveDb();
    res.json({ listing });
});

app.post("/api/accessories/resell-cancel", requireAuth, (req, res) => {
    const { listingId, itemId } = req.body || {};
    const listing = db.resaleListings.find(l =>
        (listingId && String(l.id) === String(listingId)) ||
        (!listingId && itemId && String(l.itemId) === String(itemId) && String(l.sellerId) === String(req.user.id)));
    if (!listing) return res.status(404).json({ error: "No tienes ninguna reventa publicada de este artículo." });
    if (String(listing.sellerId) !== String(req.user.id) && !isAdminUser(req.user)) {
        return res.status(403).json({ error: "Esa reventa no es tuya." });
    }
    db.resaleListings = db.resaleListings.filter(l => l.id !== listing.id);
    saveDb();
    res.json({ ok: true, message: "Reventa eliminada. Sigues teniendo tu copia." });
});

app.post("/api/accessories/resell-buy", requireAuth, (req, res) => {
    const { listingId } = req.body || {};
    const listing = db.resaleListings.find(l => String(l.id) === String(listingId));
    if (!listing) return res.status(404).json({ error: "Anuncio no encontrado." });
    const buyer = req.user;
    const seller = db.users.find(u => String(u.id) === String(listing.sellerId));
    const item = findItem(listing.itemId);
    if (!item) { db.resaleListings = db.resaleListings.filter(l => l.id !== listing.id); saveDb(); return res.status(404).json({ error: "Artículo no encontrado." }); }
    if (!seller || String(seller.id) === String(buyer.id)) return res.status(400).json({ error: "No puedes comprar tu propia reventa." });

    // El vendedor tiene que seguir teniendo la copia (si no, el anuncio ya no es válido).
    const idx = seller.inventory.findIndex(id => String(id) === String(listing.itemId));
    if (idx === -1) {
        db.resaleListings = db.resaleListings.filter(l => l.id !== listing.id);
        saveDb();
        return res.status(400).json({ error: "El vendedor ya no tiene esta copia. El anuncio se ha retirado." });
    }
    if (buyer.coins < listing.price) return res.status(400).json({ error: "No tienes monedas suficientes." });
    const buyerOwned = buyer.inventory.filter(id => String(id) === String(item.id)).length;
    if (item.maxPerUser && buyerOwned >= item.maxPerUser) {
        return res.status(400).json({ error: "Ya tienes el máximo de copias permitidas de este artículo." });
    }

    // Ahora sí: la copia pasa al comprador y el vendedor cobra.
    seller.inventory.splice(idx, 1);
    if (seller.itemAcquiredTimes && seller.itemAcquiredTimes[listing.itemId]) seller.itemAcquiredTimes[listing.itemId].shift();
    if (!seller.inventory.some(id => String(id) === String(item.id))) {
        seller.equippedHats = (seller.equippedHats || []).filter(id => String(id) !== String(item.id));
        if (String(seller.equippedHead) === String(item.id)) seller.equippedHead = null;
        if (String(seller.equippedTeapot) === String(item.id)) seller.equippedTeapot = null;
        if (String(seller.equippedPfp) === String(item.id)) seller.equippedPfp = null;
        if (String(seller.equippedFace) === String(item.id)) seller.equippedFace = null;
        seller.equippedGears = (seller.equippedGears || []).filter(id => String(id) !== String(item.id));
    }
    buyer.coins -= listing.price;
    seller.coins += listing.price;
    buyer.inventory.push(listing.itemId);
    buyer.itemAcquiredTimes = buyer.itemAcquiredTimes || {};
    buyer.itemAcquiredTimes[listing.itemId] = buyer.itemAcquiredTimes[listing.itemId] || [];
    buyer.itemAcquiredTimes[listing.itemId].push(Date.now());

    // Queda registrado en "Mis transacciones" (del vendedor y del comprador).
    db.transactions = db.transactions || [];
    db.transactions.push({
        id: nextId(),
        type: "resale",
        itemId: item.id,
        itemName: item.name,
        buyerId: buyer.id,
        buyerUsername: buyer.username,
        sellerId: seller.id,
        sellerUsername: seller.username,
        amount: listing.price,
        createdAt: Date.now()
    });

    db.resaleListings = db.resaleListings.filter(l => l.id !== listing.id);
    saveDb();
    res.json({ ok: true, newBalance: buyer.coins });
});

// ---------------------------------------------------------------------------
// UGC: helpers de permisos
// ---------------------------------------------------------------------------

function hasBadge(u, name) {
    return (u.badges || []).some(b => (typeof b === "object" ? b.name : b) === name);
}
function isUgcPlus(u) {
    return hasBadge(u, "🎩UGC+");
}
function canUploadUGC(u) {
    // Subir artículos al catálogo es un beneficio exclusivo de Turbo Block,
    // de la insignia 🎩UGC+, o de administradores.
    return hasActiveTurboBlock(u) || isUgcPlus(u) || isAdminUser(u);
}

// ---------------------------------------------------------------------------
// CAMISETAS / ACCESORIOS SUBIDOS POR USUARIOS (UGC)
// ---------------------------------------------------------------------------

// Fecha de fin de un limited: ahora se elige una fecha concreta (expiresAt);
// se mantiene expiresInDays por compatibilidad.
function parseExpires(b) {
    if (b.expiresAt) {
        const t = Date.parse(b.expiresAt);
        if (!isNaN(t)) return t;
    }
    if (b.expiresInDays) return Date.now() + Number(b.expiresInDays) * 86400000;
    return null;
}

// Variantes: cada variante es un artículo hijo con su propia imagen/modelo,
// enlazado al padre. El catálogo solo muestra el padre; en su página se
// puede elegir entre todas. Si el padre tiene descuento, comprar una variante
// teniendo ya otra del mismo grupo cuesta menos.
function createVariants(parent, variants, maxVariants, discountPercent) {
    let list = variants;
    if (typeof list === "string") { try { list = JSON.parse(list); } catch (e) { list = []; } }
    list = (Array.isArray(list) ? list : [])
        .filter(v => v && String(v.name || "").trim() && (v.imageUrl || v.glbUrl))
        .slice(0, maxVariants);
    parent.variantIds = [];
    parent.variantDiscountPercent = Math.min(90, Math.max(0, Number(discountPercent) || 0));
    list.forEach(v => {
        const label = String(v.name).trim().slice(0, 40);
        const child = JSON.parse(JSON.stringify(parent));
        Object.assign(child, {
            id: nextId(),
            name: `${parent.name} (${label})`,
            variantLabel: label,
            variantOf: parent.id,
            isVariant: true,
            imageUrl: v.imageUrl || parent.imageUrl,
            totalSold: 0,
            comments: [],
            reports: []
        });
        if (parent.type === "hat" || parent.type === "head") child.glbUrl = v.glbUrl || parent.glbUrl;
        delete child.variantIds;
        delete child.variantDiscountPercent;
        db.accessories.push(child);
        parent.variantIds.push(child.id);
    });
}

// Precio efectivo para un usuario: descuento si ya posee otro artículo del grupo.
function variantGroupOf(item) {
    const root = item.variantOf ? findItem(item.variantOf) : item;
    if (!root) return { root: item, ids: [item.id], percent: 0 };
    return { root, ids: [root.id, ...(root.variantIds || [])], percent: root.variantDiscountPercent || 0 };
}
function effectivePrice(user, item) {
    const g = variantGroupOf(item);
    let coins = item.price || 0, blocks = Number(item.priceBlocks) || 0, discounted = false;
    if (g.percent > 0 && g.ids.length > 1) {
        const ownsOther = g.ids.some(id => String(id) !== String(item.id) && user.inventory.some(x => String(x) === String(id)));
        if (ownsOther) {
            coins = Math.round(coins * (100 - g.percent) / 100);
            blocks = Math.round(blocks * (100 - g.percent) / 100);
            discounted = true;
        }
    }
    return { coins, blocks, discounted, percent: g.percent };
}

app.post("/api/tshirts/upload", requireAuth, (req, res) => {
    const user = req.user;
    if (!canUploadUGC(user)) {
        return res.status(403).json({ error: "Subir artículos al catálogo requiere Suscripción Turbo Block (o la insignia 🎩UGC+)." });
    }
    const { name, imageUrl, price, priceBlocks, offsale, anonymous, type, description, obtainText, variants, onlyTurbo } = req.body || {};
    if (!name || !imageUrl) return res.status(400).json({ error: "Faltan datos." });

    const ugcPlus = isUgcPlus(user);
    const canMakePfp = ugcPlus || isAdminUser(user);
    let finalPrice = Number(price) || 0;
    let finalOffsale = !!offsale;

    // Vender por Bloques (solos o junto a monedas) es exclusivo de admins y 🎩UGC+.
    let finalPriceBlocks = 0;
    if (priceBlocks && Number(priceBlocks) > 0) {
        if (!ugcPlus && !isAdminUser(user)) {
            return res.status(403).json({ error: "Solo los administradores o la insignia 🎩UGC+ pueden vender artículos por Bloques 🟥." });
        }
        finalPriceBlocks = Number(priceBlocks);
    }

    // Las fotos de perfil (tipo "pfp") solo las pueden subir admins o 🎩UGC+.
    // Los 🎩UGC+ pueden ponerlas gratis (0 monedas) sin problema.
    const wantsPfp = type === "pfp" || type === "face";
    if (wantsPfp && !canMakePfp) {
        return res.status(403).json({ error: "Solo los administradores o la insignia 🎩UGC+ pueden subir fotos de perfil y caras al catálogo." });
    }

    if (ugcPlus && !isAdminUser(user) && !wantsPfp) {
        // Restricciones especiales de la insignia 🎩UGC+ (no aplican a fotos de perfil):
        // no puede hacer limiteds, no puede vender a 0 monedas, precio mínimo 55.
        if (!finalOffsale) {
            if (finalPrice < 55) {
                return res.status(400).json({ error: "Con 🎩UGC+ el precio mínimo de venta es 55 monedas (o márcalo como Offsale)." });
            }
        }
    }

    const itemType = wantsPfp ? type : ((ugcPlus && type === "hat") ? "hat" : "tshirt");

    const item = {
        id: nextId(),
        name,
        type: itemType,
        imageUrl,
        description: (description || "").slice(0, 300),
        obtainText: (obtainText || "").slice(0, 200),
        price: finalPrice,
        priceBlocks: finalPriceBlocks,
        limited: false,
        offsale: finalOffsale,
        onlyBlock: (onlyTurbo === true || onlyTurbo === "true") ? "turbo" : false,
        isGhost: false,
        totalSold: 0,
        creatorId: user.id,
        creatorUsername: user.username,
        anonymous: !!anonymous,
        createdByAdmin: isAdminUser(user),
        createdByUgcPlus: ugcPlus,
        comments: [],
        reports: []
    };
    db.accessories.push(item);
    createVariants(item, variants, isAdminUser(user) ? 10 : 3, 0);
    saveDb();
    notifyDiscordNewItem(item, req);
    res.json({ item });
});

app.post("/api/admin/tshirts/upload", requireAdmin, (req, res) => {
    const { name, limited, maxPerUser, maxGlobal, expiresInDays, expiresAt, offsale, onlyBlock, imageUrl, price, priceBlocks, description, obtainText, type, variants, variantDiscountPercent, gearId, value } = req.body || {};
    // Los gears llevan un ID único (el que usa el juego en Godot para identificarlos).
    let cleanGearId = null;
    if (type === "gear") {
        cleanGearId = String(gearId || "").trim().slice(0, 40);
        if (!cleanGearId) return res.status(400).json({ error: "Los gears necesitan un ID único (p. ej. espada_fuego)." });
        if (db.accessories.some(a => a.type === "gear" && String(a.gearId).toLowerCase() === cleanGearId.toLowerCase())) {
            return res.status(400).json({ error: `Ya existe un gear con el ID "${cleanGearId}".` });
        }
    }
    const item = {
        id: nextId(),
        name,
        type: (type === "pfp" || type === "face" || type === "gear") ? type : "tshirt",
        imageUrl,
        description: (description || "").slice(0, 300),
        obtainText: (obtainText || "").slice(0, 200),
        ...(cleanGearId ? { gearId: cleanGearId } : {}),
        price: Number(price) || 0,
        priceBlocks: Number(priceBlocks) || 0,
        value: (limited && value) ? Math.max(0, Math.floor(Number(value)) || 0) : null,
        limited: !!limited,
        offsale: !!offsale,
        onlyBlock: onlyBlock === "turbo" ? "turbo" : (onlyBlock === true || onlyBlock === "true"),
        // Copias vacías = infinitas (null).
        maxPerUser: limited && maxPerUser ? Number(maxPerUser) : null,
        maxGlobal: limited && maxGlobal ? Number(maxGlobal) : null,
        expiresAt: limited ? parseExpires({ expiresAt, expiresInDays }) : null,
        isGhost: false,
        totalSold: 0,
        creatorId: req.user.id,
        creatorUsername: req.user.username,
        createdByAdmin: true,
        comments: [],
        reports: []
    };
    db.accessories.push(item);
    createVariants(item, variants, 10, variantDiscountPercent);
    saveDb();
    notifyDiscordNewItem(item, req);
    res.json({ item });
});

// ---------------------------------------------------------------------------
// ACCESORIOS 3D (Admin)
// ---------------------------------------------------------------------------

app.post("/api/admin/accessories/upload", requireAdmin, upload.fields([{ name: "glb", maxCount: 1 }, { name: "image", maxCount: 1 }]), (req, res) => {
    const b = req.body || {};
    const limited = b.limited === "true" || b.limited === true;
    const glbFile = req.files && req.files.glb && req.files.glb[0];
    const imageFile = req.files && req.files.image && req.files.image[0];
    if (!glbFile) return res.status(400).json({ error: "Falta el archivo .glb del modelo 3D." });
    const item = {
        id: nextId(),
        name: b.name,
        type: b.type === "head" ? "head" : "hat",
        glbUrl: fileUrl(req, glbFile.filename),
        // La miniatura ahora es siempre un archivo subido al servidor, no un enlace externo.
        imageUrl: imageFile ? fileUrl(req, imageFile.filename) : "",
        description: (b.description || "").slice(0, 300),
        obtainText: (b.obtainText || "").slice(0, 200),
        price: Number(b.price) || 0,
        priceBlocks: Number(b.priceBlocks) || 0,
        limited,
        offsale: b.offsale === "true" || b.offsale === true,
        onlyBlock: b.onlyBlock === "turbo" ? "turbo" : (b.onlyBlock === "true" || b.onlyBlock === true),
        maxPerUser: limited && b.maxPerUser ? Number(b.maxPerUser) : null,
        maxGlobal: limited && b.maxGlobal ? Number(b.maxGlobal) : null,
        expiresAt: limited ? parseExpires(b) : null,
        bgColor: b.bgColor || null,
        soundUrl: b.soundUrl || null,
        isGhost: false,
        totalSold: 0,
        creatorId: req.user.id,
        creatorUsername: req.user.username,
        createdByAdmin: true,
        comments: [],
        reports: []
    };
    db.accessories.push(item);
    createVariants(item, b.variants, 10, b.variantDiscountPercent);
    saveDb();
    notifyDiscordNewItem(item, req);
    res.json({ item });
});

app.post("/api/admin/accessories/edit", requireAdmin, (req, res) => {
    const { itemId, price, priceBlocks, limited, offsale, isGhost, onlyBlock, bgColor, soundUrl, description, obtainText, value } = req.body || {};
    const item = findItem(itemId);
    if (!item) return res.status(404).json({ error: "Artículo no encontrado." });
    if (item.type === "teapot") return res.status(403).json({ error: "Los Teapots solo los puede editar el Owner." });

    if (price !== undefined && price !== "") item.price = Number(price);
    if (priceBlocks !== undefined && priceBlocks !== "") item.priceBlocks = Number(priceBlocks);
    const wasLimited = item.limited;
    if (limited === "true") item.limited = true;
    if (limited === "false") item.limited = false;
    if (offsale === "true") item.offsale = true;
    if (offsale === "false") item.offsale = false;
    if (isGhost === "true") item.isGhost = true;
    if (isGhost === "false") item.isGhost = false;
    if (onlyBlock === "true") item.onlyBlock = true;
    else if (onlyBlock === "turbo") item.onlyBlock = "turbo";
    else if (onlyBlock === "false") item.onlyBlock = false;
    if (bgColor) item.bgColor = bgColor;
    if (soundUrl) item.soundUrl = soundUrl;
    if (description !== undefined) item.description = (description || "").slice(0, 300);
    if (obtainText !== undefined) item.obtainText = (obtainText || "").slice(0, 200);
    // Valor de un limited (sale en la página del artículo). Vacío = quitarlo.
    if (value !== undefined) item.value = (value === "" || value === null) ? null : Math.max(0, Math.floor(Number(value)) || 0);

    if (!wasLimited && item.limited) notifyDiscordNewLimited(item, req);

    saveDb();
    res.json({ item });
});

// ---------------------------------------------------------------------------
// TEAPOTS: artículo especial exclusivo del OWNER (ni siquiera los admins).
// Al equiparlo, reemplaza tu tarjeta pública por un HTML personalizado.
// Se puede vender, poner offsale, hacer limited, o enlazarle un Star Code.
// ---------------------------------------------------------------------------

function requireOwner(req, res, next) {
    if (!req.user || !req.user.owner) return res.status(403).json({ error: "Solo el Owner puede hacer esto." });
    next();
}

app.post("/api/owner/teapots/upload", requireAuth, requireOwner, (req, res) => {
    const b = req.body || {};
    const limited = b.limited === true || b.limited === "true";
    const item = {
        id: nextId(),
        name: b.name || "Teapot",
        type: "teapot",
        imageUrl: b.imageUrl || "",
        description: (b.description || "").slice(0, 300),
        obtainText: (b.obtainText || "").slice(0, 200),
        customHtml: b.customHtml || "",
        price: Number(b.price) || 0,
        limited,
        offsale: b.offsale === true || b.offsale === "true",
        onlyBlock: b.onlyBlock === "turbo" ? "turbo" : false,
        // Copias vacías = infinitas.
        maxPerUser: limited && b.maxPerUser ? Number(b.maxPerUser) : null,
        maxGlobal: limited && b.maxGlobal ? Number(b.maxGlobal) : null,
        expiresAt: limited ? parseExpires(b) : null,
        value: (limited && b.value) ? Math.max(0, Math.floor(Number(b.value)) || 0) : null,
        linkedStarCode: b.linkedStarCode || null,
        isGhost: false,
        totalSold: 0,
        creatorId: req.user.id,
        creatorUsername: req.user.username,
        createdByAdmin: true,
        comments: [],
        reports: []
    };
    db.accessories.push(item);
    saveDb();
    notifyDiscordNewItem(item, req);
    res.json({ item });
});

app.post("/api/owner/teapots/edit", requireAuth, requireOwner, (req, res) => {
    const { itemId, name, imageUrl, customHtml, price, limited, offsale, maxPerUser, maxGlobal, linkedStarCode } = req.body || {};
    const item = findItem(itemId);
    if (!item || item.type !== "teapot") return res.status(404).json({ error: "Teapot no encontrado." });

    const wasLimited = item.limited;
    if (name) item.name = name;
    if (imageUrl) item.imageUrl = imageUrl;
    if (customHtml !== undefined) item.customHtml = customHtml;
    if (price !== undefined && price !== "") item.price = Number(price);
    if (limited === true || limited === "true") item.limited = true;
    if (limited === false || limited === "false") item.limited = false;
    if (offsale === true || offsale === "true") item.offsale = true;
    if (offsale === false || offsale === "false") item.offsale = false;
    if (maxPerUser) item.maxPerUser = Number(maxPerUser);
    if (maxGlobal) item.maxGlobal = Number(maxGlobal);
    if (linkedStarCode !== undefined) item.linkedStarCode = linkedStarCode || null;

    if (!wasLimited && item.limited) notifyDiscordNewLimited(item, req);

    saveDb();
    res.json({ item });
});

// El propio administrador que subió el artículo puede ser consultado por cualquiera.
app.get("/api/accessories/:id/creator", (req, res) => {
    const item = findItem(req.params.id);
    if (!item) return res.status(404).json({ error: "Artículo no encontrado." });
    res.json({
        creatorUsername: item.anonymous ? "Anónimo" : (item.creatorUsername || null),
        createdByAdmin: !!item.createdByAdmin
    });
});

// Un admin puede borrar PARA SIEMPRE cualquier artículo UGC del catálogo.
// Quienes lo tenían en su inventario reciben un reembolso de su precio.
app.post("/api/admin/accessories/delete", requireAdmin, (req, res) => {
    const { itemId } = req.body || {};
    const item = findItem(itemId);
    if (!item) return res.status(404).json({ error: "No existe ningún artículo con ese ID." });

    // Se borra también todo el grupo de variantes del artículo.
    const toDelete = [item, ...((item.variantIds || []).map(id => findItem(id)).filter(Boolean))];
    const ids = new Set(toDelete.map(i => String(i.id)));

    toDelete.forEach(it => {
        db.users.forEach(u => {
            const ownedCount = (u.inventory || []).filter(id => String(id) === String(it.id)).length;
            if (ownedCount > 0) {
                u.inventory = u.inventory.filter(id => String(id) !== String(it.id));
                u.coins += ownedCount * (it.price || 0);
                u.blocks = (u.blocks || 0) + ownedCount * (Number(it.priceBlocks) || 0);
            }
            u.equippedHats = (u.equippedHats || []).filter(id => String(id) !== String(it.id));
            if (String(u.equippedTeapot) === String(it.id)) u.equippedTeapot = null;
            if (String(u.equippedPfp) === String(it.id)) u.equippedPfp = null;
            if (String(u.equippedFace) === String(it.id)) u.equippedFace = null;
            if (String(u.equippedHead) === String(it.id)) u.equippedHead = null;
            u.equippedGears = (u.equippedGears || []).filter(id => String(id) !== String(it.id));
        });
    });
    db.accessories = db.accessories.filter(a => !ids.has(String(a.id)));
    db.resaleListings = db.resaleListings.filter(l => !ids.has(String(l.itemId)));
    if (db.settings && ids.has(String(db.settings.coinRewardItemId))) db.settings.coinRewardItemId = null;
    saveDb();
    res.json({ ok: true, message: `Artículo "${item.name}" borrado (${toDelete.length} en total, con sus variantes).` });
});

// ---------------------------------------------------------------------------
// COMENTARIOS Y DENUNCIAS DE ARTÍCULOS DEL CATÁLOGO
// ---------------------------------------------------------------------------

app.post("/api/accessories/:id/comments", requireAuth, (req, res) => {
    const item = findItem(req.params.id);
    if (!item) return res.status(404).json({ error: "Artículo no encontrado." });
    const { text } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: "El comentario no puede estar vacío." });

    item.comments = item.comments || [];
    const trimmed = text.trim().slice(0, 300);

    // Fácil huevo de pascua: comentar "/e free" simula ganar el artículo gratis
    // (mensaje de broma, sin dar el artículo realmente).
    if (trimmed.toLowerCase() === "/e free") {
        item.comments.push({
            senderId: req.user.id,
            senderUsername: req.user.username,
            text: trimmed,
            createdAt: Date.now()
        });
        saveDb();
        return res.json({ ok: true, easterEgg: true, message: "¡Lo has ganado gratis! 🎉 (mensaje de broma, no se te ha dado el artículo)" });
    }

    item.comments.push({
        senderId: req.user.id,
        senderUsername: req.user.username,
        text: trimmed,
        createdAt: Date.now()
    });
    saveDb();
    res.json({ ok: true, comments: item.comments });
});

app.post("/api/accessories/:id/report", requireAuth, (req, res) => {
    const item = findItem(req.params.id);
    if (!item) return res.status(404).json({ error: "Artículo no encontrado." });
    item.reports = item.reports || [];
    if (!item.reports.includes(req.user.id)) item.reports.push(req.user.id);
    saveDb();
    res.json({ ok: true, reportsCount: item.reports.length });
});

app.get("/api/admin/reported-items", requireAdmin, (req, res) => {
    const items = db.accessories.filter(a => (a.reports || []).length >= 10);
    res.json({ items });
});

// ---------------------------------------------------------------------------
// PERFIL, AVATAR, BIO
// ---------------------------------------------------------------------------

// NOTA: se ha eliminado la subida libre de foto de perfil (algunos usuarios
// subían imágenes inapropiadas). Ahora la foto de perfil se elige equipando
// un artículo del catálogo de tipo "pfp" (solo admins/🎩UGC+ pueden crearlos).

// Subida real de imagen (icono de grupo, imagen de artículo, Teapot, etc.)
app.post("/api/upload/image", requireAuth, upload.single("image"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No se recibió ninguna imagen." });
    const imageUrl = fileUrl(req, req.file.filename);
    res.json({ ok: true, imageUrl, url: imageUrl });
});

app.post("/api/admin/upload/file", requireAdmin, upload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No se recibió ningún archivo." });
    res.json({ ok: true, url: fileUrl(req, req.file.filename) });
});


// ---------------------------------------------------------------------------
// SOMBREROS 3D DE 🎩UGC+ (subida con modelo .glb)
// ---------------------------------------------------------------------------

function discardUploads(req) {
    const files = [];
    if (req.file) files.push(req.file);
    if (req.files) Object.values(req.files).forEach(arr => files.push(...arr));
    files.forEach(f => { try { fs.unlinkSync(f.path); } catch (e) {} });
}

app.post("/api/ugc/accessories/upload", requireAuth, upload.fields([{ name: "glb", maxCount: 1 }, { name: "image", maxCount: 1 }]), (req, res) => {
    const user = req.user;
    if (!isUgcPlus(user) && !isAdminUser(user)) {
        discardUploads(req);
        return res.status(403).json({ error: "Solo la insignia 🎩UGC+ (o un admin) puede subir sombreros/accesorios 3D." });
    }
    const b = req.body || {};
    const glbFile = req.files && req.files.glb && req.files.glb[0];
    const imageFile = req.files && req.files.image && req.files.image[0];
    if (!b.name || !String(b.name).trim()) { discardUploads(req); return res.status(400).json({ error: "Falta el nombre." }); }
    if (!glbFile || !/\.glb$/i.test(glbFile.originalname || "")) { discardUploads(req); return res.status(400).json({ error: "Sube el modelo 3D como archivo .glb." }); }
    if (!imageFile) { discardUploads(req); return res.status(400).json({ error: "Falta la miniatura (imagen PNG/JPG)." }); }

    const offsale = b.offsale === "true" || b.offsale === true;
    const price = Number(b.price) || 0;
    // Restricciones de 🎩UGC+: no limiteds, no gratis, mínimo 55 monedas (o offsale).
    if (!isAdminUser(user) && !offsale && price < 55) {
        discardUploads(req);
        return res.status(400).json({ error: "Con 🎩UGC+ el precio mínimo de venta es 55 monedas (o márcalo como Offsale)." });
    }
    const item = {
        id: nextId(),
        name: String(b.name).trim().slice(0, 60),
        type: "hat",
        glbUrl: fileUrl(req, glbFile.filename),
        imageUrl: fileUrl(req, imageFile.filename),
        description: (b.description || "").slice(0, 300),
        obtainText: (b.obtainText || "").slice(0, 200),
        price,
        priceBlocks: Number(b.priceBlocks) || 0,
        limited: false,
        offsale,
        onlyBlock: (b.onlyTurbo === "true" || b.onlyTurbo === true) ? "turbo" : false,
        isGhost: false,
        totalSold: 0,
        creatorId: user.id,
        creatorUsername: user.username,
        anonymous: b.anonymous === "true" || b.anonymous === true,
        createdByAdmin: isAdminUser(user),
        createdByUgcPlus: true,
        comments: [],
        reports: []
    };
    db.accessories.push(item);
    createVariants(item, b.variants, 3, 0);
    saveDb();
    notifyDiscordNewItem(item, req);
    res.json({ item });
});

// Subida de modelos .glb para las variantes de los sombreros (🎩UGC+ y admins).
app.post("/api/upload/model", requireAuth, upload.single("file"), (req, res) => {
    if (!isUgcPlus(req.user) && !isAdminUser(req.user)) { discardUploads(req); return res.status(403).json({ error: "Solo 🎩UGC+ o admins." }); }
    if (!req.file) return res.status(400).json({ error: "No se recibió ningún archivo." });
    if (!/\.glb$/i.test(req.file.originalname || "")) { discardUploads(req); return res.status(400).json({ error: "Debe ser un archivo .glb." }); }
    res.json({ ok: true, url: fileUrl(req, req.file.filename) });
});

// ---------------------------------------------------------------------------
// CHAT PRIVADO: imágenes de la galería de fotos de perfil (Turbo Block)
// ---------------------------------------------------------------------------

app.post("/api/chat/send-image", requireAuth, (req, res) => {
    const user = req.user;
    if (!hasActiveTurboBlock(user)) return res.status(403).json({ error: "Enviar imágenes al chat requiere Suscripción Turbo Block." });
    const { friendId, pfpItemId } = req.body || {};
    const item = findItem(pfpItemId);
    if (!item || item.type !== "pfp") return res.status(400).json({ error: "Solo se pueden enviar fotos de la galería de fotos de perfil." });
    if (!user.inventory.some(id => String(id) === String(item.id))) return res.status(400).json({ error: "Esa foto no está en tu galería (no la tienes)." });
    const friend = db.users.find(u => String(u.id) === String(friendId));
    if (!friend) return res.status(404).json({ error: "Usuario no encontrado." });
    const key = chatKey(user.id, friendId);
    db.friendChats[key] = db.friendChats[key] || [];
    db.friendChats[key].push({
        senderId: user.id,
        senderUsername: user.username,
        text: "",
        imageUrl: item.imageUrl,
        createdAt: Date.now()
    });
    saveDb();
    res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// COMENTARIOS: tarjeta pública de perfil y publicaciones del blog
// ---------------------------------------------------------------------------

function cleanComment(m) { return { ...withAvatar(m) }; }

app.get("/api/users/:id/comments", (req, res) => {
    const target = db.users.find(u => String(u.id) === String(req.params.id));
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });
    const enabled = target.allowProfileComments !== false;
    if (!enabled || target.active === false) return res.json({ enabled: false, comments: [] });
    const list = ((db.profileComments || {})[target.id] || []).slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
    res.json({ enabled: true, comments: list.map(cleanComment) });
});

app.post("/api/users/:id/comments", requireAuth, (req, res) => {
    const target = db.users.find(u => String(u.id) === String(req.params.id));
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });
    if (target.allowProfileComments === false) return res.status(403).json({ error: "Este usuario tiene los comentarios desactivados." });
    const text = String((req.body || {}).text || "").trim().slice(0, 300);
    if (!text) return res.status(400).json({ error: "El comentario no puede estar vacío." });
    db.profileComments = db.profileComments || {};
    db.profileComments[target.id] = db.profileComments[target.id] || [];
    db.profileComments[target.id].push({ id: nextId(), senderId: req.user.id, senderUsername: req.user.username, text, createdAt: Date.now() });
    saveDb();
    res.json({ ok: true });
});

app.post("/api/users/:id/comments/delete", requireAuth, (req, res) => {
    const target = db.users.find(u => String(u.id) === String(req.params.id));
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });
    const list = (db.profileComments || {})[target.id] || [];
    const cm = list.find(x => String(x.id) === String((req.body || {}).commentId));
    if (!cm) return res.status(404).json({ error: "Comentario no encontrado." });
    const allowed = String(cm.senderId) === String(req.user.id) || String(target.id) === String(req.user.id) || isAdminUser(req.user);
    if (!allowed) return res.status(403).json({ error: "No puedes borrar este comentario." });
    db.profileComments[target.id] = list.filter(x => x !== cm);
    saveDb();
    res.json({ ok: true });
});

app.get("/api/blog/posts/:id/comments", (req, res) => {
    const post = (db.blogPosts || []).find(p => String(p.id) === String(req.params.id));
    if (!post) return res.status(404).json({ error: "Publicación no encontrada." });
    if (post.commentsEnabled === false) return res.json({ enabled: false, comments: [] });
    const list = ((db.blogComments || {})[post.id] || []).slice().sort((a, b) => a.createdAt - b.createdAt);
    res.json({ enabled: true, comments: list.map(cleanComment) });
});

app.post("/api/blog/posts/:id/comments", requireAuth, (req, res) => {
    const post = (db.blogPosts || []).find(p => String(p.id) === String(req.params.id));
    if (!post) return res.status(404).json({ error: "Publicación no encontrada." });
    if (post.commentsEnabled === false) return res.status(403).json({ error: "Los comentarios de esta publicación están desactivados." });
    const text = String((req.body || {}).text || "").trim().slice(0, 500);
    if (!text) return res.status(400).json({ error: "El comentario no puede estar vacío." });
    db.blogComments = db.blogComments || {};
    db.blogComments[post.id] = db.blogComments[post.id] || [];
    db.blogComments[post.id].push({ id: nextId(), senderId: req.user.id, senderUsername: req.user.username, text, createdAt: Date.now() });
    saveDb();
    res.json({ ok: true });
});

app.post("/api/blog/posts/:id/comments/delete", requireAuth, (req, res) => {
    const list = (db.blogComments || {})[req.params.id] || [];
    const cm = list.find(x => String(x.id) === String((req.body || {}).commentId));
    if (!cm) return res.status(404).json({ error: "Comentario no encontrado." });
    if (String(cm.senderId) !== String(req.user.id) && !isAdminUser(req.user)) return res.status(403).json({ error: "No puedes borrar este comentario." });
    db.blogComments[req.params.id] = list.filter(x => x !== cm);
    saveDb();
    res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// CONEXIÓN CON EL JUEGO (Godot): /connect
// ---------------------------------------------------------------------------

const CONNECT_REWARD_BLOCKS = 100;

function validAppId(appId) {
    return String(appId || "").toLowerCase().replace(/[^a-z0-9]/g, "") === "gameblocks";
}

function roleOf(u) {
    // El badge co-owner también activa el flag owner (acceso de administración),
    // así que se comprueba primero para distinguirlo del owner real.
    if ((u.badges || []).some(b => /co-?owner/i.test((typeof b === "object" ? b.name : b) || ""))) return "coowner";
    if (u.owner) return "owner";
    if (isAdminUser(u)) return "admin";
    return "user";
}

function connectPayload(u, req) {
    const base = publicBaseUrl(req);
    const abs = url => (url && !/^https?:\/\//i.test(url)) ? base + url : url;
    const modelOf = id => {
        const it = findItem(id);
        return it ? { id: it.id, name: it.name, glb: abs(it.glbUrl || null) } : null;
    };
    return {
        ok: true,
        app_id: "gameblocks",
        user: { id: u.id, username: u.username },
        // IDs únicos de los gears equipados (hasta 3), tal como se configuran en el panel de admin.
        gears: (u.equippedGears || []).map(id => findItem(id)).filter(Boolean).map(it => it.gearId).filter(Boolean),
        // Solo sombreros (modelos .glb).
        hats: (u.equippedHats || []).map(modelOf).filter(h => h && h.glb),
        head: (() => { const h = u.equippedHead ? modelOf(u.equippedHead) : null; return h && h.glb ? h : null; })(),
        block: hasActiveBlock(u),
        turbo_block: hasActiveTurboBlock(u),
        role: roleOf(u),
        is_admin: isAdminUser(u),
        is_owner: roleOf(u) === "owner",
        is_coowner: roleOf(u) === "coowner"
    };
}

function finishConnect(u, req, res) {
    const payload = connectPayload(u, req);
    let reward = null;
    if (!u.connectRewardClaimed) {
        u.connectRewardClaimed = true;
        u.blocks = (u.blocks || 0) + CONNECT_REWARD_BLOCKS;
        reward = { blocks: CONNECT_REWARD_BLOCKS, message: `¡El premio por conectar tu cuenta son ${CONNECT_REWARD_BLOCKS} bloques!` };
        saveDb();
    }
    res.json({ ...payload, reward });
}

// Desde la página /connect (el usuario tiene sesión en la web).
app.post("/api/connect", requireAuth, (req, res) => {
    if (!validAppId((req.body || {}).app_id)) return res.status(400).json({ ok: false, error: "app_id no válido." });
    finishConnect(req.user, req, res);
});

// Desde el propio juego con el código de vinculación que se genera en la web.
app.post("/api/connect/by-code", (req, res) => {
    const { code, app_id } = req.body || {};
    if (!validAppId(app_id)) return res.status(400).json({ ok: false, error: "app_id no válido." });
    const entry = (db.gameLinkCodes || {})[String(code || "").toUpperCase()];
    if (!entry || Date.now() - entry.createdAt > 15 * 60 * 1000) return res.status(400).json({ ok: false, error: "Código no válido o caducado." });
    const u = db.users.find(x => String(x.id) === String(entry.userId));
    if (!u) return res.status(404).json({ ok: false, error: "Usuario no encontrado." });
    finishConnect(u, req, res);
});

app.post("/api/profile/inventory-visibility", requireAuth, (req, res) => {
    const { public: isPublic } = req.body || {};
    req.user.inventoryPublic = !!isPublic;
    saveDb();
    res.json({ ok: true, inventoryPublic: req.user.inventoryPublic });
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
        return u ? { id: u.id, username: u.username, avatar: avatarOf(u) } : null;
    }).filter(Boolean);
    res.json({ friends });
});

app.get("/api/friends/requests", requireAuth, (req, res) => {
    const requests = (req.user.friendRequests || []).map(id => {
        const u = db.users.find(x => x.id === id);
        return u ? { id: u.id, username: u.username, avatar: avatarOf(u) } : null;
    }).filter(Boolean);
    res.json({ requests });
});

app.post("/api/friends/request", requireAuth, (req, res) => {
    const { username, userId } = req.body || {};
    const target = userId
        ? db.users.find(u => String(u.id) === String(userId))
        : findUserByUsername(username);
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });
    if (target.id === req.user.id) return res.status(400).json({ error: "No puedes añadirte a ti mismo." });
    if (target.allowFriendRequests === false) {
        return res.status(403).json({ error: `${target.username} no acepta solicitudes de amistad.` });
    }
    target.friendRequests = target.friendRequests || [];
    if (!target.friendRequests.includes(req.user.id)) target.friendRequests.push(req.user.id);
    saveDb();
    res.json({ ok: true, message: `¡Solicitud de amistad enviada a ${target.username}!` });
});

app.post("/api/profile/settings", requireAuth, (req, res) => {
    const { allowFriendRequests, allowTradeWithoutFriends, allowProfileComments } = req.body || {};
    if (allowFriendRequests !== undefined) req.user.allowFriendRequests = !!allowFriendRequests;
    if (allowTradeWithoutFriends !== undefined) req.user.allowTradeWithoutFriends = !!allowTradeWithoutFriends;
    if (allowProfileComments !== undefined) req.user.allowProfileComments = !!allowProfileComments;
    saveDb();
    res.json({ ok: true });
});

app.post("/api/friends/accept", requireAuth, (req, res) => {
    const { userId, requestId } = req.body || {};
    const targetId = userId || requestId;
    const user = req.user;
    user.friendRequests = (user.friendRequests || []).filter(id => String(id) !== String(targetId));
    user.friends = user.friends || [];
    if (!user.friends.includes(targetId)) user.friends.push(targetId);
    const other = db.users.find(u => String(u.id) === String(targetId));
    if (other) {
        other.friends = other.friends || [];
        if (!other.friends.includes(user.id)) other.friends.push(user.id);
    }
    saveDb();
    res.json({ ok: true, message: other ? `Ahora eres amigo de ${other.username}.` : "Solicitud aceptada." });
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
    res.json({ messages: (db.friendChats[key] || []).map(withAvatar) });
});

// Alias: el frontend pide /api/chat/:friendId (antes daba 404).
app.get("/api/chat/:friendId", requireAuth, (req, res) => {
    const key = chatKey(req.user.id, req.params.friendId);
    res.json({ messages: (db.friendChats[key] || []).map(withAvatar) });
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
        // En el chat privado ya no se suben archivos: solo se pueden enviar
        // imágenes de la galería de fotos de perfil (ver /api/chat/send-image).
        try { fs.unlinkSync(req.file.path); } catch (e) {}
        return res.status(403).json({ error: "En el chat privado solo puedes enviar imágenes de tu galería de fotos de perfil." });
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
    // enrichedMembers: la lista de miembros con su nombre y avatar, para que el
    // frontend pueda pintarla sin tener que hacer una petición por cada uno.
    const enrichedMembers = (group.members || []).map(id => {
        const u = db.users.find(x => String(x.id) === String(id));
        return u ? { id: u.id, username: u.username, avatar: avatarOf(u) } : null;
    }).filter(Boolean);
    res.json({
        ...group,
        enrichedMembers,
        groupChatMessages: (group.groupChatMessages || []).map(withAvatar),
        newsMessages: (group.newsMessages || []).map(withAvatar),
        forumPosts: (group.forumPosts || []).map(p => ({
            ...withAvatar({ senderId: p.authorId, senderUsername: p.authorUsername || p.senderUsername, ...p }),
            messages: (p.messages || []).map(withAvatar)
        }))
    });
});

app.post("/api/groups/create", requireAuth, (req, res) => {
    const { name, description, iconUrl } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: "El grupo necesita un nombre." });
    const user = req.user;
    if (user.coins < GROUP_CREATE_COST) return res.status(400).json({ error: "No tienes monedas suficientes para crear un grupo." });

    user.coins -= GROUP_CREATE_COST;
    const group = {
        id: nextGroupId(), // id de grupo independiente, empezando en 1
        name: name.trim(),
        description: description || "",
        iconUrl: iconUrl || null,
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

app.post("/api/groups/:id/icon", requireAuth, (req, res) => {
    const group = db.groups.find(g => String(g.id) === String(req.params.id));
    if (!group) return res.status(404).json({ error: "Grupo no encontrado." });
    const isOwner = String(group.ownerId) === String(req.user.id);
    const isAdmin = (group.admins || []).includes(req.user.id);
    if (!isOwner && !isAdmin) return res.status(403).json({ error: "No tienes permisos en este grupo." });
    const { iconUrl } = req.body || {};
    group.iconUrl = iconUrl || null;
    saveDb();
    res.json({ ok: true, iconUrl: group.iconUrl });
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
    promo.claims = promo.claims || {};
    const alreadyClaims = promo.claims[req.user.id] || ((promo.redeemedBy || []).includes(req.user.id) ? 1 : 0);
    const perUserLimit = promo.maxPerUser ? Number(promo.maxPerUser) : 1;
    if (alreadyClaims >= perUserLimit) {
        return res.status(400).json({ error: perUserLimit > 1 ? `Ya has usado este código el máximo de veces (${perUserLimit}).` : "Ya has usado este código." });
    }

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
    if (!promo.redeemedBy.includes(user.id)) promo.redeemedBy.push(user.id);
    promo.claims[user.id] = alreadyClaims + 1;
    saveDb();
    res.json({ message: "Código canjeado con éxito.", coins: user.coins, dollars: user.dollars, rewardItemName });
});

// ---------------------------------------------------------------------------
// TRADES (INTERCAMBIOS DE LIMITEDS)
// ---------------------------------------------------------------------------

// Límite de Limiteds Offsale que se pueden meter en un trade, según suscripción.
function maxTradeLimiteds(u) {
    if (hasActiveTurboBlock(u)) return 6;
    if (hasActiveBlock(u)) return 5;
    return 4;
}

function normalizeIds(single, arr) {
    if (Array.isArray(arr)) return arr.filter(Boolean).map(String);
    if (single) return [String(single)];
    return [];
}

app.get("/api/trade/pending", requireAuth, (req, res) => {
    const pending = db.trades.filter(t => t.toUserId === req.user.id && t.status === "pending");
    res.json({ trades: pending });
});

app.post("/api/trade/offer", requireAuth, (req, res) => {
    const { toUsername, giveItemId, giveItemIds, giveCoins, getItemId, getItemIds, getCoins } = req.body || {};
    const toUser = findUserByUsername(toUsername);
    if (!toUser) return res.status(404).json({ error: "Usuario no encontrado." });

    const fromUser = req.user;
    const areFriends = (fromUser.friends || []).includes(toUser.id);
    if (!areFriends && !toUser.allowTradeWithoutFriends) {
        return res.status(403).json({ error: `${toUser.username} solo permite tradear con amigos.` });
    }
    const giveIds = normalizeIds(giveItemId, giveItemIds);
    const getIds = normalizeIds(getItemId, getItemIds);

    const myMax = maxTradeLimiteds(fromUser);
    const theirMax = maxTradeLimiteds(toUser);
    if (giveIds.length > myMax) {
        return res.status(400).json({ error: `Con tu suscripción actual solo puedes ofrecer hasta ${myMax} Limiteds Offsale.` });
    }
    if (getIds.length > theirMax) {
        return res.status(400).json({ error: `El otro usuario solo puede aceptar hasta ${theirMax} Limiteds Offsale en un trade.` });
    }
    for (const id of [...giveIds, ...getIds]) {
        const it = findItem(id);
        if (!it || !it.limited || !it.offsale) {
            return res.status(400).json({ error: "Solo se pueden intercambiar Limiteds Offsale." });
        }
    }
    for (const id of giveIds) {
        if (!canResellOrTrade(fromUser, id)) {
            return res.status(400).json({ error: "Uno de tus artículos aún está en periodo de retención (3 días desde que lo compraste)." });
        }
    }
    for (const id of getIds) {
        if (!canResellOrTrade(toUser, id)) {
            return res.status(400).json({ error: "Uno de los artículos que pides aún está en periodo de retención para su dueño." });
        }
    }

    const trade = {
        id: nextId(),
        fromUserId: fromUser.id,
        fromUsername: fromUser.username,
        toUserId: toUser.id,
        giveItemIds: giveIds, giveCoins: Number(giveCoins) || 0,
        getItemIds: getIds, getCoins: Number(getCoins) || 0,
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

    const giveIds = trade.giveItemIds || (trade.giveItemId ? [trade.giveItemId] : []);
    const getIds = trade.getItemIds || (trade.getItemId ? [trade.getItemId] : []);

    // Comprobar que ambas partes siguen teniendo todos los artículos.
    for (const id of giveIds) {
        if (!fromUser.inventory.some(x => String(x) === String(id))) {
            return res.status(400).json({ error: "El otro usuario ya no tiene uno de los artículos ofrecidos." });
        }
    }
    for (const id of getIds) {
        if (!toUser.inventory.some(x => String(x) === String(id))) {
            return res.status(400).json({ error: "Ya no tienes uno de los artículos que ibas a entregar." });
        }
    }

    giveIds.forEach(id => {
        const idx = fromUser.inventory.findIndex(x => String(x) === String(id));
        if (idx !== -1) {
            fromUser.inventory.splice(idx, 1);
            toUser.inventory.push(id);
            if (fromUser.itemAcquiredTimes && fromUser.itemAcquiredTimes[id]) fromUser.itemAcquiredTimes[id].shift();
            toUser.itemAcquiredTimes = toUser.itemAcquiredTimes || {};
            toUser.itemAcquiredTimes[id] = toUser.itemAcquiredTimes[id] || [];
            toUser.itemAcquiredTimes[id].push(Date.now());
        }
    });
    getIds.forEach(id => {
        const idx = toUser.inventory.findIndex(x => String(x) === String(id));
        if (idx !== -1) {
            toUser.inventory.splice(idx, 1);
            fromUser.inventory.push(id);
            if (toUser.itemAcquiredTimes && toUser.itemAcquiredTimes[id]) toUser.itemAcquiredTimes[id].shift();
            fromUser.itemAcquiredTimes = fromUser.itemAcquiredTimes || {};
            fromUser.itemAcquiredTimes[id] = fromUser.itemAcquiredTimes[id] || [];
            fromUser.itemAcquiredTimes[id].push(Date.now());
        }
    });
    // Los artículos que cambian de dueño dejan de estar en reventa.
    db.resaleListings = db.resaleListings.filter(l =>
        !(String(l.sellerId) === String(fromUser.id) && giveIds.map(String).includes(String(l.itemId))) &&
        !(String(l.sellerId) === String(toUser.id) && getIds.map(String).includes(String(l.itemId))));
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
    if (!event) return res.json({ event: null });
    // Se incluyen los artículos completos (no solo los IDs) para que el
    // frontend pueda mostrarlos y comprarlos directamente desde la sección del evento.
    const resolvedItems = (event.items || []).map(id => findItem(id)).filter(Boolean).map(maskAnonymous);
    res.json({ event: { ...event, resolvedItems } });
});

app.post("/api/admin/events/save", requireAdmin, (req, res) => {
    const { name, description, themeColor, items, customHtml, active } = req.body || {};
    // Solo un evento puede estar activo a la vez
    if (active) db.events.forEach(e => (e.active = false));

    // Se pueden seleccionar hasta 10 artículos del catálogo para mostrar en el evento.
    const itemIds = (Array.isArray(items) ? items : []).slice(0, 500).map(String);

    const event = {
        id: nextId(),
        name: name || "Evento Especial",
        description: description || "",
        themeColor: themeColor || "#ffd700",
        items: itemIds,
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
    // Se identifica al dueño del Star Code por su ID de cuenta (privado), no por su nombre.
    const { code, ownerId, ownerUsername } = req.body || {};
    if (!code || (!ownerId && !ownerUsername)) return res.status(400).json({ error: "Faltan datos (código e ID de cuenta)." });
    const owner = ownerId
        ? db.users.find(u => String(u.id) === String(ownerId))
        : findUserByUsername(ownerUsername);
    if (!owner) return res.status(404).json({ error: "No existe ninguna cuenta con ese ID." });
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
// BORRAR CUENTA AL 100% / PONERSE INACTIVO
// ---------------------------------------------------------------------------

// Borra la cuenta y TODOS sus datos del servidor (mensajes, membresías de
// grupos, trades, reventas...). El frontend debe pedir 2 confirmaciones antes
// de llamar a este endpoint, ya que es irreversible.
app.post("/api/account/delete-self", requireAuth, (req, res) => {
    const userId = req.user.id;

    db.users = db.users.filter(u => u.id !== userId);

    db.users.forEach(u => {
        u.friends = (u.friends || []).filter(id => id !== userId);
        u.friendRequests = (u.friendRequests || []).filter(id => id !== userId);
        u.followers = (u.followers || []).filter(id => id !== userId);
        u.following = (u.following || []).filter(id => id !== userId);
        u.likedBy = (u.likedBy || []).filter(id => id !== userId);
        u.dislikedBy = (u.dislikedBy || []).filter(id => id !== userId);
    });

    db.groups.forEach(g => {
        g.members = (g.members || []).filter(id => id !== userId);
        g.admins = (g.admins || []).filter(id => id !== userId);
        g.bannedMembers = (g.bannedMembers || []).filter(id => id !== userId);
    });

    db.trades = db.trades.filter(t => t.fromUserId !== userId && t.toUserId !== userId);
    db.resaleListings = db.resaleListings.filter(l => l.sellerId !== userId);

    Object.keys(db.friendChats || {}).forEach(key => {
        if (key.split("_").includes(String(userId))) delete db.friendChats[key];
    });

    if (db.adminMessages) delete db.adminMessages[userId];

    // Revocar cualquier token de sesión activo de esta cuenta.
    for (const [token, uid] of tokens.entries()) {
        if (String(uid) === String(userId)) tokens.delete(token);
    }

    saveDb();
    res.json({ ok: true });
});

// Ponerse inactivo: cierra la sesión y marca la cuenta como inactiva. Al
// volver a iniciar sesión, deja de estar inactiva automáticamente.
app.post("/api/account/set-inactive", requireAuth, (req, res) => {
    req.user.active = false;
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (token) tokens.delete(token);
    saveDb();
    res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// MENSAJES DE ADMINISTRACIÓN (los admins pueden escribir a cualquier usuario)
// ---------------------------------------------------------------------------

// Solo el Owner puede regalar artículos del catálogo directamente a un usuario.
app.post("/api/owner/give-item", requireAuth, requireOwner, (req, res) => {
    const { username, itemId } = req.body || {};
    const target = findUserByUsername(username);
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });
    const item = findItem(itemId);
    if (!item) return res.status(404).json({ error: "Artículo no encontrado." });
    target.inventory.push(item.id);
    item.totalSold = (item.totalSold || 0) + 1;
    saveDb();
    res.json({ ok: true, message: `Se ha entregado "${item.name}" a ${target.username}.` });
});

// ---------------------------------------------------------------------------
// BLOG (los admins publican con imagen, título y contenido; los usuarios solo leen)
// ---------------------------------------------------------------------------

const BLOG_CATEGORIES = ["Anuncio", "Archivo", "Random", "Evento", "Locura de admin"];
app.get("/api/blog/categories", (req, res) => res.json({ categories: BLOG_CATEGORIES }));

app.post("/api/admin/blog/posts/category", requireAdmin, (req, res) => {
    const { postId, category } = req.body || {};
    const post = (db.blogPosts || []).find(p => String(p.id) === String(postId));
    if (!post) return res.status(404).json({ error: "Publicación no encontrada." });
    if (!BLOG_CATEGORIES.includes(category)) return res.status(400).json({ error: "Categoría no válida." });
    post.category = category;
    saveDb();
    res.json({ ok: true, category });
});

app.get("/api/blog/posts", (req, res) => {
    const posts = (db.blogPosts || []).slice().sort((a, b) => b.createdAt - a.createdAt)
        .map(p => ({ ...p, commentsEnabled: p.commentsEnabled !== false, commentsCount: ((db.blogComments || {})[p.id] || []).length }));
    res.json({ posts });
});

app.post("/api/admin/blog/posts", requireAdmin, (req, res) => {
    const { title, content, imageUrl, category, commentsEnabled } = req.body || {};
    if (!title || !title.trim() || !content || !content.trim()) {
        return res.status(400).json({ error: "Faltan el título o el contenido." });
    }
    const post = {
        id: nextId(),
        title: title.trim().slice(0, 150),
        content: content.trim().slice(0, 5000),
        imageUrl: imageUrl || null,
        category: BLOG_CATEGORIES.includes(category) ? category : "Anuncio",
        commentsEnabled: !(commentsEnabled === false || commentsEnabled === "false"),
        authorUsername: req.user.username,
        createdAt: Date.now()
    };
    db.blogPosts = db.blogPosts || [];
    db.blogPosts.push(post);
    saveDb();
    res.json({ post });
});

app.post("/api/admin/blog/posts/delete", requireAdmin, (req, res) => {
    const { postId } = req.body || {};
    db.blogPosts = (db.blogPosts || []).filter(p => String(p.id) !== String(postId));
    saveDb();
    res.json({ ok: true });
});

app.get("/api/messages", requireAuth, (req, res) => {
    db.adminMessages = db.adminMessages || {};
    res.json({ messages: db.adminMessages[req.user.id] || [] });
});

app.post("/api/admin/messages/send", requireAdmin, (req, res) => {
    const { username, text } = req.body || {};
    const target = findUserByUsername(username);
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });
    if (!text || !text.trim()) return res.status(400).json({ error: "El mensaje no puede estar vacío." });

    db.adminMessages = db.adminMessages || {};
    db.adminMessages[target.id] = db.adminMessages[target.id] || [];
    db.adminMessages[target.id].push({
        fromUsername: req.user.username,
        text: text.trim().slice(0, 2000),
        createdAt: Date.now()
    });
    saveDb();
    res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// SOLO OWNER: LISTADO DE IDs DE CUENTA
// ---------------------------------------------------------------------------

app.get("/api/owner/account-ids", requireAuth, (req, res) => {
    if (!req.user.owner) return res.status(403).json({ error: "Solo el Owner puede ver los IDs de cuenta." });
    const list = db.users.map(u => ({ id: u.id, username: u.username }));
    res.json({ users: list });
});

// ---------------------------------------------------------------------------
// PING (mantiene la sesión/servidor "despierto")
// ---------------------------------------------------------------------------

app.post("/api/ping", (req, res) => {
    res.json({ ok: true, t: Date.now() });
});

// ---------------------------------------------------------------------------
// REPORTES
// ---------------------------------------------------------------------------

app.post("/api/users/:id/report", requireAuth, (req, res) => {
    const user = db.users.find(u => String(u.id) === String(req.params.id));
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });
    if (user.owner) return res.status(403).json({ error: "No se puede denunciar a la cuenta del Owner." });
    user.reportsCount = (user.reportsCount || 0) + 1;
    saveDb();
    res.json({ ok: true, message: "Usuario denunciado. Gracias por tu reporte." });
});

// ---------------------------------------------------------------------------
// PERFILES PÚBLICOS: búsqueda, ficha, likes/dislikes, seguir
// ---------------------------------------------------------------------------

app.get("/api/users/search", (req, res) => {
    const q = String(req.query.q || "").trim().toLowerCase();
    if (!q) return res.json({ users: [] });
    const results = db.users
        .filter(u => u.username.toLowerCase().includes(q))
        .slice(0, 25)
        .map(u => ({ id: u.id, username: u.username, avatar: avatarOf(u) }));
    res.json({ users: results });
});

app.get("/api/users/profile/:id", optionalAuth, (req, res) => {
    const user = db.users.find(u => String(u.id) === String(req.params.id) || u.username.toLowerCase() === String(req.params.id).toLowerCase());
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });
    res.json(publicUser(user, req.user));
});

app.post("/api/users/:id/like", requireAuth, (req, res) => {
    const user = db.users.find(u => String(u.id) === String(req.params.id));
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });
    user.likedBy = user.likedBy || [];
    user.dislikedBy = user.dislikedBy || [];
    user.dislikedBy = user.dislikedBy.filter(id => id !== req.user.id);
    if (!user.likedBy.includes(req.user.id)) user.likedBy.push(req.user.id);
    user.likesCount = user.likedBy.length;
    user.dislikesCount = user.dislikedBy.length;
    saveDb();
    res.json({ likes: user.likesCount, dislikes: user.dislikesCount });
});

app.post("/api/users/:id/dislike", requireAuth, (req, res) => {
    const user = db.users.find(u => String(u.id) === String(req.params.id));
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });
    if (user.owner) return res.status(403).json({ error: "No se puede dar dislike a la cuenta del Owner." });
    user.likedBy = user.likedBy || [];
    user.dislikedBy = user.dislikedBy || [];
    user.likedBy = user.likedBy.filter(id => id !== req.user.id);
    if (!user.dislikedBy.includes(req.user.id)) user.dislikedBy.push(req.user.id);
    user.likesCount = user.likedBy.length;
    user.dislikesCount = user.dislikedBy.length;
    saveDb();
    res.json({ likes: user.likesCount, dislikes: user.dislikesCount });
});

app.post("/api/users/:id/follow", requireAuth, (req, res) => {
    const target = db.users.find(u => String(u.id) === String(req.params.id));
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });
    if (String(target.id) === String(req.user.id)) return res.status(400).json({ error: "No puedes seguirte a ti mismo." });
    req.user.following = req.user.following || [];
    target.followers = target.followers || [];
    const already = req.user.following.includes(target.id);
    if (already) {
        req.user.following = req.user.following.filter(id => id !== target.id);
        target.followers = target.followers.filter(id => id !== req.user.id);
    } else {
        req.user.following.push(target.id);
        target.followers.push(req.user.id);
    }
    saveDb();
    res.json({ following: !already, followersCount: target.followers.length });
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
    const { code, coins, dollars, maxUses, maxPerUser, expiresInDays, rewardItemId } = req.body || {};
    if (!code) return res.status(400).json({ error: "Falta el nombre del código." });
    const promo = {
        code,
        coins: Number(coins) || 0,
        dollars: Number(dollars) || 0,
        maxUses: maxUses ? Number(maxUses) : null,
        maxPerUser: maxPerUser ? Number(maxPerUser) : null,
        expiresAt: expiresInDays ? Date.now() + Number(expiresInDays) * 86400000 : null,
        rewardItemId: rewardItemId || null,
        uses: 0,
        redeemedBy: []
    };
    db.codes.push(promo);
    saveDb();
    res.json({ promo });
});

app.post("/api/admin/settings/coin-reward-item", requireAdmin, (req, res) => {
    const { itemId } = req.body || {};
    if (itemId && !findItem(itemId)) return res.status(404).json({ error: "No existe ningún artículo con ese ID." });
    db.settings = db.settings || {};
    db.settings.coinRewardItemId = itemId ? String(itemId) : null;
    saveDb();
    res.json({ ok: true, coinRewardItemId: db.settings.coinRewardItemId });
});

app.get("/api/settings/coin-reward-item", (req, res) => {
    const id = db.settings && db.settings.coinRewardItemId;
    const item = id ? findItem(id) : null;
    res.json({ itemId: id || null, itemName: item ? item.name : null });
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
app.get("/api/admin/backup-status", requireAdmin, (req, res) => {
    res.json({
        githubBackupEnabled: GITHUB_BACKUP_ENABLED,
        repo: GITHUB_BACKUP_ENABLED ? GITHUB_REPO : null,
        path: GITHUB_BACKUP_ENABLED ? GITHUB_BACKUP_PATH : null,
        s3BackupEnabled: S3_BACKUP_ENABLED,
        s3Bucket: S3_BACKUP_ENABLED ? S3_BUCKET : null,
        lastS3Push: lastS3PushAt || null,
        lastS3Error,
        s3Safe: s3SafeToBackup,
        s3UploadsBackedUp: s3Uploads.size,
        backupDir: BACKUP_DIR,
        serverVersion: SERVER_VERSION,
        dataDir: DATA_DIR,
        users: (db.users || []).length,
        lastLocalSave: lastLocalSaveAt || null,
        lastGithubPush: lastGithubPushAt || null,
        lastGithubError,
        safeToBackup: dbSafeToBackup,
        uploadsBackedUp: remoteUploads.size
    });
});

app.post("/api/admin/backup-now", requireAdmin, async (req, res) => {
    saveDbNow();
    writeBackupDir(true);
    if (!GITHUB_BACKUP_ENABLED && !S3_BACKUP_ENABLED) {
        return res.json({ ok: true, message: "Guardado en disco y en la carpeta de seguridad. No hay backup remoto configurado (GitHub o S3)." });
    }
    await Promise.all([pushDbToGithub(), pushDbToS3()]);
    await Promise.all([syncUploadsToGithub(), syncUploadsToS3()]);
    const errs = [GITHUB_BACKUP_ENABLED && lastGithubError ? `GitHub: ${lastGithubError}` : null, S3_BACKUP_ENABLED && lastS3Error ? `S3: ${lastS3Error}` : null].filter(Boolean);
    res.json({ ok: errs.length === 0, message: errs.length ? `Guardado en disco, pero falló: ${errs.join(" | ")}` : "Guardado en disco y subido a todos los destinos configurados." });
});

// Copia manual: el Owner puede descargar toda la base de datos y volver a importarla.
app.get("/api/admin/export-db", requireAuth, requireOwner, (req, res) => {
    saveDbNow();
    res.setHeader("Content-Disposition", `attachment; filename="gameblocks-db-${Date.now()}.json"`);
    res.json(db);
});

app.post("/api/admin/import-db", requireAuth, requireOwner, (req, res) => {
    const incoming = req.body && (req.body.db || req.body);
    if (!hasUsers(incoming)) return res.status(400).json({ error: "El archivo no parece una base de datos válida (sin usuarios)." });
    db = Object.assign(defaultDb(), incoming);
    migrateDb();
    saveDbNow();
    pushDbToGithub();
    pushDbToS3();
    res.json({ ok: true, users: db.users.length, message: "Base de datos importada. Vuelve a iniciar sesión." });
});

(async () => {
    try {
        await loadDb();
    } catch (e) {
        console.error("❌", e.message);
        process.exit(1); // Render reiniciará el servicio y volverá a intentarlo
    }
    app.listen(PORT, () => {
        console.log(`Game Blocks server escuchando en el puerto ${PORT}`);
        console.log(`Base de datos en: ${DB_FILE} (${(db.users || []).length} usuarios)`);
        console.log(GITHUB_BACKUP_ENABLED
            ? `[GitHub backup] Activado -> ${GITHUB_REPO} (${GITHUB_BACKUP_PATH})`
            : `[GitHub backup] Desactivado (configura GITHUB_TOKEN y GITHUB_REPO para activarlo).`);
        console.log(S3_BACKUP_ENABLED
            ? `[S3 backup] Activado -> ${S3_BUCKET}/${S3_PREFIX}`
            : `[S3 backup] Desactivado (configura S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY y S3_SECRET_KEY).`);
        console.log(`[DB] Carpeta de seguridad: ${BACKUP_DIR} · versión del servidor: ${SERVER_VERSION}`);
    });
    // Red de seguridad: guarda en disco cada 30 s si hay cambios pendientes, y
    // revisa cada 20 s si hay archivos subidos sin copia en GitHub.
    setInterval(() => { if (dirty) saveDbNow(); }, 30000);
    setInterval(syncUploadsToGithub, 20000);
    setInterval(syncUploadsToS3, 20000);
})();
