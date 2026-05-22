const state = {
  user: null,
  setupRequired: false,
  pushPublicKey: "",
  medicines: [],
};

const $ = (selector) => document.querySelector(selector);

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || "No se pudo completar la accion.");
  }
  return data;
}

function setAuthMode(setupRequired) {
  state.setupRequired = setupRequired;
  $("#auth-eyebrow").textContent = setupRequired ? "Inicio" : "Cuenta";
  $("#auth-title").textContent = setupRequired ? "Crear admin" : "Entrar";
  $("#auth-submit").textContent = setupRequired ? "Crear admin" : "Entrar";
  $("#name-field").hidden = !setupRequired;
  $("#auth-password").autocomplete = setupRequired ? "new-password" : "current-password";
}

function showAuth() {
  $("#auth-view").hidden = false;
  $("#app-view").hidden = true;
}

function clearAuthFields() {
  $("#auth-username").value = "";
  $("#auth-name").value = "";
  $("#auth-password").value = "";
}

function showApp() {
  clearAuthFields();
  $("#auth-view").hidden = true;
  $("#app-view").hidden = false;
  $("#user-label").textContent = state.user ? state.user.username : "";
}

function medicinePayload() {
  return {
    name: $("#medicine-name").value.trim(),
    dose: $("#medicine-dose").value.trim(),
    intervalHours: Number($("#medicine-interval").value),
    durationDays: Number($("#medicine-duration").value),
    notes: $("#medicine-notes").value.trim(),
    active: $("#medicine-active").checked,
  };
}

function resetMedicineForm() {
  $("#medicine-id").value = "";
  $("#medicine-form").reset();
  $("#medicine-interval").value = "8";
  $("#medicine-duration").value = "7";
  $("#medicine-active").checked = true;
  $("#save-button").textContent = "Guardar";
  $("#cancel-edit").hidden = true;
}

function editMedicine(medicine) {
  $("#medicine-id").value = medicine.id;
  $("#medicine-name").value = medicine.name;
  $("#medicine-dose").value = medicine.dose || "";
  $("#medicine-interval").value = medicine.intervalHours || 8;
  $("#medicine-duration").value = medicine.durationDays || 7;
  $("#medicine-notes").value = medicine.notes || "";
  $("#medicine-active").checked = medicine.active;
  $("#save-button").textContent = "Actualizar";
  $("#cancel-edit").hidden = false;
  $("#medicine-name").focus();
}

function formatDuration(days) {
  if (days === 7) return "7 dias (1 semana)";
  if (days > 7 && days % 7 === 0) return `${days} dias (${days / 7} semanas)`;
  return `${days} ${days === 1 ? "dia" : "dias"}`;
}

function formatDateTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function statusText(medicine) {
  if (!medicine.active) return "Pausada";
  if (medicine.treatmentStatus === "completed") return "Completada";
  if (medicine.treatmentStatus === "pending") return "Pendiente";
  return "Activa";
}

function renderMedicines() {
  const list = $("#medicine-list");
  list.innerHTML = "";
  if (!state.medicines.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Aun no hay medicinas guardadas.";
    list.append(empty);
    return;
  }

  for (const medicine of state.medicines) {
    const card = document.createElement("article");
    const isLive = medicine.active && medicine.treatmentStatus !== "completed";
    card.className = `medicine-card${isLive ? "" : " inactive"}`;
    const dose = medicine.dose ? `<span>${escapeHtml(medicine.dose)}</span>` : "";
    const interval = `<span>Cada ${escapeHtml(medicine.intervalHours || 8)} h</span>`;
    const duration = `<span>${escapeHtml(formatDuration(medicine.durationDays || 7))}</span>`;
    const next = medicine.nextReminderAt && isLive ? `<span>Siguiente: ${escapeHtml(formatDateTime(medicine.nextReminderAt))}</span>` : "";
    const notes = medicine.notes ? `<span>${escapeHtml(medicine.notes)}</span>` : "";
    card.innerHTML = `
      <div>
        <div class="medicine-title">
          <strong>${escapeHtml(medicine.name)}</strong>
          <span class="time-pill">${escapeHtml(statusText(medicine))}</span>
        </div>
        <div class="medicine-meta">${[dose, interval, duration, next, notes].filter(Boolean).join(" - ")}</div>
      </div>
      <div class="button-row">
        <button type="button" data-action="edit">Editar</button>
        <button type="button" class="danger" data-action="delete">Eliminar</button>
      </div>
    `;
    card.querySelector('[data-action="edit"]').addEventListener("click", () => editMedicine(medicine));
    card.querySelector('[data-action="delete"]').addEventListener("click", () => deleteMedicine(medicine.id));
    list.append(card);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]);
}

async function loadMedicines() {
  const data = await api("/api/medicines");
  state.medicines = data.medicines;
  renderMedicines();
}

async function saveMedicine(event) {
  event.preventDefault();
  const id = $("#medicine-id").value;
  const payload = medicinePayload();
  if (id) {
    await api(`/api/medicines/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  } else {
    await api("/api/medicines", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }
  resetMedicineForm();
  await loadMedicines();
}

async function deleteMedicine(id) {
  await api(`/api/medicines/${encodeURIComponent(id)}`, { method: "DELETE" });
  await loadMedicines();
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function activatePush() {
  const status = $("#push-status");
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    status.textContent = "Este navegador no soporta push";
    return;
  }
  $("#push-button").disabled = true;
  try {
    status.textContent = "Solicitando permiso";
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      status.textContent = "Permiso denegado";
      return;
    }

    status.textContent = "Registrando dispositivo";
    const registration = await navigator.serviceWorker.register("/sw.js");
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(state.pushPublicKey),
      });
    }
    const payload = subscription.toJSON();
    payload.contentEncoding = "aes128gcm";
    await api("/api/push/subscribe", {
      method: "POST",
      body: JSON.stringify({ subscription: payload }),
    });
    status.textContent = "Activas";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    $("#push-button").disabled = false;
  }
}

async function testPush() {
  $("#test-push-button").disabled = true;
  try {
    const data = await api("/api/push/test", { method: "POST", body: "{}" });
    $("#push-status").textContent = data.sent ? "Prueba enviada" : "Activa push primero";
  } catch (error) {
    $("#push-status").textContent = error.message;
  } finally {
    $("#test-push-button").disabled = false;
  }
}

async function authenticate(event) {
  event.preventDefault();
  $("#auth-message").textContent = "";
  const body = {
    username: $("#auth-username").value.trim(),
    name: $("#auth-name").value.trim(),
    password: $("#auth-password").value,
  };
  try {
    const endpoint = state.setupRequired ? "/api/setup" : "/api/login";
    await api(endpoint, { method: "POST", body: JSON.stringify(body) });
    clearAuthFields();
    await boot();
  } catch (error) {
    $("#auth-password").value = "";
    $("#auth-message").textContent = error.message;
  }
}

async function logout() {
  await api("/api/logout", { method: "POST", body: "{}" });
  state.user = null;
  showAuth();
}

async function boot() {
  const me = await api("/api/me");
  state.user = me.user;
  state.pushPublicKey = me.pushPublicKey;
  setAuthMode(me.setupRequired);
  if (!me.authenticated) {
    showAuth();
    return;
  }
  showApp();
  await loadMedicines();
}

$("#auth-form").addEventListener("submit", authenticate);
$("#medicine-form").addEventListener("submit", saveMedicine);
$("#cancel-edit").addEventListener("click", resetMedicineForm);
$("#push-button").addEventListener("click", activatePush);
$("#test-push-button").addEventListener("click", testPush);
$("#logout-button").addEventListener("click", logout);

resetMedicineForm();

boot().catch((error) => {
  setAuthMode(false);
  showAuth();
  $("#auth-message").textContent = error.message;
});
