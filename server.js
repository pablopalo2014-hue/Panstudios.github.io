const RENDER_API = "https://panstudios-github-io-1.onrender.com";

async function request(endpoint, method = "GET", body = null) {
    const headers = { "Content-Type": "application/json" };
    const token = localStorage.getItem("gameblocks_token");
    if (token) headers.Authorization = "Bearer " + token;

    const options = { method, headers };
    if (body !== null) options.body = JSON.stringify(body);

    const response = await fetch(RENDER_API + endpoint, options);
    let data;
    try {
        data = await response.json();
    } catch {
        throw new Error("El servidor devolvió una respuesta inválida.");
    }

    if (!response.ok) throw new Error(data.error || "Error del servidor.");
    return data;
}

function openAccount() {
    document.getElementById("accountModal").style.display = "flex";
    updateAccount();
}

function closeAccount() {
    document.getElementById("accountModal").style.display = "none";
}

function outsideClose(event) {
    if (event.target.id === "accountModal") closeAccount();
}

function showLogin() {
    document.getElementById("loginView").classList.remove("hidden");
    document.getElementById("registerView").classList.add("hidden");
    document.getElementById("accountView").classList.add("hidden");
    document.getElementById("publicProfileView").classList.add("hidden");
}

function showRegister() {
    document.getElementById("loginView").classList.add("hidden");
    document.getElementById("registerView").classList.remove("hidden");
    document.getElementById("accountView").classList.add("hidden");
    document.getElementById("publicProfileView").classList.add("hidden");
}

function showAccount() {
    document.getElementById("loginView").classList.add("hidden");
    document.getElementById("registerView").classList.add("hidden");
    document.getElementById("accountView").classList.remove("hidden");
    document.getElementById("publicProfileView").classList.add("hidden");
}

function showPublicProfile(user) {
    document.getElementById("loginView").classList.add("hidden");
    document.getElementById("registerView").classList.add("hidden");
    document.getElementById("accountView").classList.add("hidden");
    document.getElementById("publicProfileView").classList.remove("hidden");

    // Actualización del avatar en el perfil público
    const avatarImg = document.getElementById("publicAvatar");
    if (avatarImg) {
        avatarImg.src = user.avatar || "https://via.placeholder.com/110";
    }

    document.getElementById("publicUsername").textContent = "👤 " + user.username;
    document.getElementById("publicBio").textContent = user.bio || "Sin biografía.";

    const badgesContainer = document.getElementById("publicBadges");
    badgesContainer.innerHTML = "";
    if (user.badges && user.badges.length > 0) {
        user.badges.forEach(badge => {
            const el = document.createElement("div");
            el.className = "badge";
            el.textContent = badge.name || badge;
            badgesContainer.appendChild(el);
        });
    } else {
        badgesContainer.textContent = "Sin insignias.";
    }
}

function saveExePath() {
    const path = document.getElementById("exePath").value.trim();
    const msg = document.getElementById("exeMessage");
    if (!path) {
        msg.className = "error";
        msg.textContent = "Ingresa una ruta válida.";
        return;
    }
    localStorage.setItem("gameblocks_exe_path", path);
    msg.className = "success";
    msg.textContent = "Ruta guardada en este navegador.";
}

function launchGame() {
    const path = localStorage.getItem("gameblocks_exe_path");
    if (!path) {
        alert("Configura primero la ruta del ejecutable en tu cuenta.");
        openAccount();
        return;
    }
    window.location.href = path.includes("://") ? path : "file:///" + path.replace(/\\/g, "/");
}

async function viewUserProfile(userId) {
    try {
        const user = await request("/api/users/profile/" + userId);
        showPublicProfile(user);
    } catch (error) {
        alert(error.message);
    }
}

async function register() {
    const username = document.getElementById("registerUsername").value.trim();
    const password = document.getElementById("registerPassword").value;
    const password2 = document.getElementById("registerPassword2").value;
    const message = document.getElementById("registerMessage");

    if (!username || !password || !password2) {
        message.className = "error";
        message.textContent = "Completa todos los campos.";
        return;
    }
    if (password !== password2) {
        message.className = "error";
        message.textContent = "Las contraseñas no coinciden.";
        return;
    }

    try {
        message.textContent = "Creando cuenta...";
        const data = await request("/api/register", "POST", { username, password });
        localStorage.setItem("gameblocks_token", data.token);
        await updateAccount();
    } catch (error) {
        message.className = "error";
        message.textContent = error.message;
    }
}

async function login() {
    const username = document.getElementById("loginUsername").value.trim();
    const password = document.getElementById("loginPassword").value;
    const message = document.getElementById("loginMessage");

    if (!username || !password) {
        message.className = "error";
        message.textContent = "Introduce usuario y contraseña.";
        return;
    }

    try {
        message.textContent = "Iniciando sesión...";
        const data = await request("/api/login", "POST", { username, password });
        localStorage.setItem("gameblocks_token", data.token);
        await updateAccount();
    } catch (error) {
        message.className = "error";
        message.textContent = error.message;
    }
}

async function updateAccount() {
    const token = localStorage.getItem("gameblocks_token");

    const savedPath = localStorage.getItem("gameblocks_exe_path");
    if (savedPath) document.getElementById("exePath").value = savedPath;

    if (!token) {
        document.getElementById("heroSlogan").classList.add("hidden");
        document.getElementById("loginBtn").classList.remove("hidden");
        document.getElementById("accountButton").classList.add("hidden");
        showLogin();
        return;
    }

    try {
        const user = await request("/api/me");
        document.getElementById("heroSlogan").classList.remove("hidden");
        document.getElementById("loginBtn").classList.add("hidden");
        document.getElementById("accountButton").classList.remove("hidden");

        showAccount();

        document.getElementById("welcome").textContent = "👤 " + user.username;
        
        // Carga del avatar de tu propia cuenta
        const myAvatarImg = document.getElementById("myAvatar");
        if (myAvatarImg) {
            myAvatarImg.src = user.avatar || "https://via.placeholder.com/110";
        }
        
        if (user.bio) document.getElementById("myBio").value = user.bio;

        loadFriends();
        loadRequests();
        loadBadges();

        if (user.admin === true) {
            document.getElementById("adminPanel").classList.remove("hidden");
        } else {
            document.getElementById("adminPanel").classList.add("hidden");
        }
    } catch {
        localStorage.removeItem("gameblocks_token");
        document.getElementById("heroSlogan").classList.add("hidden");
        document.getElementById("loginBtn").classList.remove("hidden");
        document.getElementById("accountButton").classList.add("hidden");
        showLogin();
    }
}

// Edición e inserción del nuevo avatar
async function editAvatar() {
    const url = prompt("Introduce la URL de tu nueva imagen de perfil:");
    if (!url) return;

    try {
        await request("/api/profile/avatar", "POST", { avatar: url });
        const myAvatarImg = document.getElementById("myAvatar");
        if (myAvatarImg) {
            myAvatarImg.src = url;
        }
    } catch (error) {
        alert(error.message);
    }
}

async function saveBio() {
    const bio = document.getElementById("myBio").value.trim();
    const msg = document.getElementById("bioMessage");

    try {
        await request("/api/profile/bio", "POST", { bio });
        msg.className = "success";
        msg.textContent = "Biografía guardada correctamente.";
    } catch (error) {
        msg.className = "error";
        msg.textContent = error.message;
    }
}

async function loadBadges() {
    const container = document.getElementById("myBadges");
    try {
        const data = await request("/api/badges/me");
        container.innerHTML = "";
        if (!data.badges || data.badges.length === 0) {
            container.textContent = "No tienes insignias.";
            return;
        }
        data.badges.forEach(badge => {
            const element = document.createElement("div");
            element.className = "badge";
            element.textContent = badge.name || badge;
            container.appendChild(element);
        });
    } catch (error) {
        container.textContent = "No se pudieron cargar las insignias.";
    }
}

async function logout() {
    try {
        await request("/api/logout", "POST");
    } catch {}
    localStorage.removeItem("gameblocks_token");
    closeAccount();
    updateAccount();
}

async function createGameCode() {
    const container = document.getElementById("gameCodeContainer");
    const codeElement = document.getElementById("gameCode");
    const message = document.getElementById("gameCodeMessage");

    container.classList.add("hidden");
    message.textContent = "Generando código...";

    try {
        const data = await request("/api/game/create-code", "POST");
        codeElement.textContent = data.code;
        container.classList.remove("hidden");
        message.className = "success";
        message.textContent = "Código generado correctamente.";
    } catch (error) {
        message.className = "error";
        message.textContent = error.message;
    }
}

async function searchUsers() {
    const query = document.getElementById("searchInput").value.trim();
    const results = document.getElementById("searchResults");

    if (!query) {
        results.textContent = "Escribe algo en el buscador superior.";
        return;
    }

    openAccount();
    results.textContent = "Buscando...";

    try {
        const data = await request("/api/users/search?q=" + encodeURIComponent(query));
        results.innerHTML = "";

        if (data.users.length === 0) {
            results.textContent = "No se encontraron usuarios.";
            return;
        }

        data.users.forEach(user => {
            const div = document.createElement("div");
            div.className = "result";

            const header = document.createElement("div");
            header.className = "user-card-header";

            const userClickable = document.createElement("div");
            userClickable.className = "user-info-click";
            userClickable.onclick = () => viewUserProfile(user.id);

            // Renderizado de avatar en los resultados
            const img = document.createElement("img");
            img.className = "result-avatar";
            img.src = user.avatar || "https://via.placeholder.com/110";

            const details = document.createElement("div");
            details.className = "user-details";

            const name = document.createElement("strong");
            name.textContent = user.username;

            const bioPreview = document.createElement("span");
            bioPreview.className = "user-bio-preview";
            bioPreview.textContent = user.bio ? (user.bio.substring(0, 35) + "...") : "Sin biografía";

            details.appendChild(name);
            details.appendChild(bioPreview);
            userClickable.appendChild(img);
            userClickable.appendChild(details);

            const button = document.createElement("button");
            button.className = "friend-button";
            button.textContent = "Añadir";
            button.onclick = (e) => {
                e.stopPropagation();
                sendFriendRequest(user.id);
            };

            header.appendChild(userClickable);
            header.appendChild(button);
            div.appendChild(header);

            const badgesDiv = document.createElement("div");
            badgesDiv.className = "badges";
            if (user.badges && user.badges.length > 0) {
                user.badges.forEach(b => {
                    const badgeSpan = document.createElement("span");
                    badgeSpan.className = "badge";
                    badgeSpan.textContent = b;
                    badgesDiv.appendChild(badgeSpan);
                });
            }
            div.appendChild(badgesDiv);

            results.appendChild(div);
        });

    } catch (error) {
        results.textContent = error.message;
    }
}

async function sendFriendRequest(userId) {
    try {
        await request("/api/friends/request", "POST", { userId });
        alert("Solicitud enviada.");
    } catch (error) {
        alert(error.message);
    }
}

async function loadRequests() {
    const container = document.getElementById("requests");
    try {
        const data = await request("/api/friends/requests");
        container.innerHTML = "";
        if (data.requests.length === 0) {
            container.textContent = "No tienes solicitudes.";
            return;
        }

        data.requests.forEach(requestData => {
            const div = document.createElement("div");
            div.className = "result";

            const header = document.createElement("div");
            header.className = "user-card-header";

            const name = document.createElement("span");
            name.textContent = "👤 " + requestData.username;

            const buttons = document.createElement("div");
            const accept = document.createElement("button");
            accept.className = "friend-button";
            accept.textContent = "Aceptar";
            accept.onclick = async () => {
                await request("/api/friends/accept", "POST", { requestId: requestData.id });
                loadRequests();
                loadFriends();
            };

            const reject = document.createElement("button");
            reject.className = "danger-button";
            reject.textContent = "Rechazar";
            reject.onclick = async () => {
                await request("/api/friends/reject", "POST", { requestId: requestData.id });
                loadRequests();
            };

            buttons.appendChild(accept);
            buttons.appendChild(reject);
            header.appendChild(name);
            header.appendChild(buttons);
            div.appendChild(header);

            container.appendChild(div);
        });
    } catch (error) {
        container.textContent = error.message;
    }
}

async function loadFriends() {
    const container = document.getElementById("friends");
    try {
        const data = await request("/api/friends");
        container.innerHTML = "";
        if (data.friends.length === 0) {
            container.textContent = "Todavía no tienes amigos.";
            return;
        }

        data.friends.forEach(friend => {
            const div = document.createElement("div");
            div.className = "result";

            const header = document.createElement("div");
            header.className = "user-card-header";

            const userClickable = document.createElement("div");
            userClickable.className = "user-info-click";
            userClickable.onclick = () => viewUserProfile(friend.id);

            // Renderizado de avatar en la lista de amigos
            const img = document.createElement("img");
            img.className = "result-avatar";
            img.src = friend.avatar || "https://via.placeholder.com/110";

            const details = document.createElement("div");
            details.className = "user-details";

            const name = document.createElement("strong");
            name.textContent = "⭐ " + friend.username;

            details.appendChild(name);
            userClickable.appendChild(img);
            userClickable.appendChild(details);

            const remove = document.createElement("button");
            remove.className = "danger-button";
            remove.textContent = "Eliminar";
            remove.onclick = (e) => {
                e.stopPropagation();
                removeFriend(friend.id);
            };

            header.appendChild(userClickable);
            header.appendChild(remove);
            div.appendChild(header);

            container.appendChild(div);
        });
    } catch (error) {
        container.textContent = error.message;
    }
}

async function removeFriend(userId) {
    if (!confirm("¿Eliminar este amigo?")) return;
    try {
        await request("/api/friends/remove", "POST", { userId });
        loadFriends();
    } catch (error) {
        alert(error.message);
    }
}

async function adminChangeUsername() {
    const username = document.getElementById("adminUsername").value.trim();
    if (!username) {
        alert("Escribe un nombre.");
        return;
    }
    try {
        await request("/api/admin/change-username", "POST", { username });
        alert("Nombre cambiado.");
        document.getElementById("adminUsername").value = "";
        updateAccount();
    } catch (error) {
        alert(error.message);
    }
}

async function adminSearchUsers() {
    const query = document.getElementById("adminSearch").value.trim();
    const container = document.getElementById("adminUsers");
    if (!query) {
        container.textContent = "Escribe un nombre.";
        return;
    }

    try {
        const data = await request("/api/admin/users?q=" + encodeURIComponent(query));
        container.innerHTML = "";

        if (!data.users || data.users.length === 0) {
            container.textContent = "No se encontraron cuentas.";
            return;
        }

        data.users.forEach(user => {
            const div = document.createElement("div");
            div.className = "admin-user";
            div.innerHTML = "<strong>👤 " + escapeHTML(user.username) + "</strong>";

            const actions = document.createElement("div");
            actions.className = "admin-actions";

            const rename = document.createElement("button");
            rename.className = "admin-button";
            rename.textContent = "Cambiar nombre";
            rename.onclick = () => adminRenameUser(user.id, user.username);

            const deleteButton = document.createElement("button");
            deleteButton.className = "danger-button";
            deleteButton.textContent = "Borrar cuenta";
            deleteButton.onclick = () => adminDeleteUser(user.id, user.username);

            actions.appendChild(rename);
            actions.appendChild(deleteButton);
            div.appendChild(actions);
            container.appendChild(div);
        });
    } catch (error) {
        container.textContent = error.message;
    }
}

async function adminRenameUser(userId, oldName) {
    const newName = prompt("Nuevo nombre para " + oldName + ":");
    if (!newName) return;

    try {
        await request("/api/admin/users/change-username", "POST", { userId, username: newName });
        alert("Nombre cambiado.");
        adminSearchUsers();
    } catch (error) {
        alert(error.message);
    }
}

async function adminDeleteUser(userId, username) {
    if (!confirm("¿Seguro que quieres borrar la cuenta " + username + "?")) return;

    try {
        await request("/api/admin/users/delete", "POST", { userId });
        alert("Cuenta eliminada.");
        adminSearchUsers();
    } catch (error) {
        alert(error.message);
    }
}

async function addBadge() {
    const username = document.getElementById("badgeUser").value.trim();
    const badge = document.getElementById("badgeSelect").value;
    const message = document.getElementById("badgeMessage");

    try {
        await request("/api/admin/badges/add", "POST", { username, badge });
        message.className = "success";
        message.textContent = "Insignia añadida correctamente.";
    } catch (error) {
        message.className = "error";
        message.textContent = error.message;
    }
}

async function removeBadge() {
    const username = document.getElementById("badgeUser").value.trim();
    const badge = document.getElementById("badgeSelect").value;
    const message = document.getElementById("badgeMessage");

    try {
        await request("/api/admin/badges/remove", "POST", { username, badge });
        message.className = "success";
        message.textContent = "Insignia eliminada.";
    } catch (error) {
        message.className = "error";
        message.textContent = error.message;
    }
}

function escapeHTML(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

document.addEventListener("keydown", event => {
    if (event.key === "Enter" && document.activeElement.id === "searchInput") {
        searchUsers();
    }
});

window.addEventListener("load", () => {
    updateAccount();
});
