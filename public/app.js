const state = {
  user: null,
  setupRequired: false,
  pushPublicKey: "",
  medicines: [],
  formOpen: false,
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
  state.formOpen = false;
  document.body.classList.remove("form-open");
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
  setFormOpen(false);
}

function setFormOpen(open) {
  state.formOpen = open;
  document.body.classList.toggle("form-open", open);
  $("#form-title").textContent = $("#medicine-id").value ? "Editar medicina" : "Nueva medicina";
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
  $("#form-title").textContent = "Nueva medicina";
  $("#cancel-edit").hidden = true;
}

function editMedicine(medicine) {
  setFormOpen(true);
  $("#medicine-id").value = medicine.id;
  $("#medicine-name").value = medicine.name;
  $("#medicine-dose").value = medicine.dose || "";
  $("#medicine-interval").value = medicine.intervalHours || 8;
  $("#medicine-duration").value = medicine.durationDays || 7;
  $("#medicine-notes").value = medicine.notes || "";
  $("#medicine-active").checked = medicine.active;
  $("#save-button").textContent = "Actualizar";
  $("#form-title").textContent = "Editar medicina";
  $("#cancel-edit").hidden = false;
  $("#medicine-name").focus();
}

function formatDuration(days) {
  if (days === 7) return "7 dias (1 semana)";
  if (days > 7 && days % 7 === 0) return `${days} dias (${days / 7} semanas)`;
  return `${days} ${days === 1 ? "dia" : "dias"}`;
}

function startOfToday(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function endOfToday(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
}

function timeParts(value) {
  const date = new Date(value);
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const period = date.getHours() >= 12 ? "PM" : "AM";
  const hour = date.getHours() % 12 || 12;
  return { time: `${hour}:${minutes}`, period };
}

function scheduleForMedicine(medicine, now = new Date()) {
  if (!medicine.active || medicine.treatmentStatus === "completed") return [];

  const start = new Date(medicine.startAt || medicine.createdAt || Date.now());
  const end = medicine.endsAt ? new Date(medicine.endsAt) : null;
  if (Number.isNaN(start.getTime())) return [];

  const dayStart = startOfToday(now);
  const dayEnd = endOfToday(now);
  if (end && end < dayStart) return [];

  const intervalMs = Math.max(1, medicine.intervalHours || 8) * 60 * 60 * 1000;
  let nextMs = start.getTime();
  if (nextMs < dayStart.getTime()) {
    nextMs += Math.ceil((dayStart.getTime() - nextMs) / intervalMs) * intervalMs;
  }

  const items = [];
  while (nextMs <= dayEnd.getTime() && (!end || nextMs <= end.getTime()) && items.length < 48) {
    items.push({ medicine, date: new Date(nextMs), completed: nextMs <= now.getTime() });
    nextMs += intervalMs;
  }
  return items;
}

function nextFallbackItem(medicine) {
  const nextDate = medicine.nextReminderAt ? new Date(medicine.nextReminderAt) : null;
  if (!nextDate || Number.isNaN(nextDate.getTime())) return null;
  return { medicine, date: nextDate, completed: false, fallback: true };
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

  const now = new Date();
  let items = state.medicines.flatMap((medicine) => scheduleForMedicine(medicine, now));
  const isFallback = !items.length;
  if (isFallback) {
    items = state.medicines.map(nextFallbackItem).filter(Boolean);
  }
  items.sort((a, b) => a.date - b.date);

  const completed = items.filter((item) => item.completed).length;
  const header = document.createElement("div");
  header.className = "schedule-header";
  header.innerHTML = `
    <span>${isFallback ? "PROXIMAS TOMAS" : "CRONOGRAMA DE HOY"}</span>
    <strong>${completed}/${items.length} completadas</strong>
  `;
  list.append(header);

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No hay tomas programadas.";
    list.append(empty);
    return;
  }

  for (const item of items) {
    const medicine = item.medicine;
    const { time, period } = timeParts(item.date);
    const row = document.createElement("article");
    row.className = `schedule-item${item.completed ? " completed" : ""}`;
    const dose = medicine.dose ? `<span>${escapeHtml(medicine.dose)}</span>` : "";
    const notes = medicine.notes ? `<span>${escapeHtml(medicine.notes)}</span>` : "";
    const meta = [dose, `<span>Cada ${escapeHtml(medicine.intervalHours || 8)} h</span>`, `<span>${escapeHtml(formatDuration(medicine.durationDays || 7))}</span>`, notes]
      .filter(Boolean)
      .join(" - ");
    row.innerHTML = `
      <div class="schedule-time">
        <strong>${escapeHtml(time)}</strong>
        <span>${escapeHtml(period)}</span>
      </div>
      <div class="schedule-line"><span></span></div>
      <div class="schedule-card">
        <div class="medicine-symbol" aria-hidden="true">=</div>
        <div class="schedule-details">
          <strong>${escapeHtml(medicine.name)}</strong>
          <span>${meta}</span>
        </div>
        <div class="schedule-actions">
          <span class="dose-state" aria-label="${item.completed ? "Completada" : "Pendiente"}"></span>
          <button type="button" data-action="edit">Editar</button>
          <button type="button" class="danger" data-action="delete">Eliminar</button>
        </div>
      </div>
    `;
    row.querySelector(".schedule-card").addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      editMedicine(medicine);
    });
    row.querySelector('[data-action="edit"]').addEventListener("click", () => editMedicine(medicine));
    row.querySelector('[data-action="delete"]').addEventListener("click", () => deleteMedicine(medicine.id));
    list.append(row);
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
  setFormOpen(false);
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
    $("#push-button").textContent = "No disponible";
    return;
  }
  $("#push-button").disabled = true;
  try {
    status.textContent = "Solicitando permiso";
    $("#push-button").textContent = "Permitiendo...";
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      status.textContent = "Permiso denegado";
      $("#push-button").textContent = "Activar notificaciones";
      return;
    }

    status.textContent = "Registrando dispositivo";
    $("#push-button").textContent = "Activando...";
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
    $("#push-button").textContent = "Notificaciones activas";
  } catch (error) {
    status.textContent = error.message;
    $("#push-button").textContent = "Activar notificaciones";
  } finally {
    $("#push-button").disabled = false;
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
$("#fab-button").addEventListener("click", () => {
  resetMedicineForm();
  setFormOpen(true);
});
$("#close-form-button").addEventListener("click", () => setFormOpen(false));
$("#push-button").addEventListener("click", activatePush);
$("#logout-button").addEventListener("click", logout);

resetMedicineForm();

boot().catch((error) => {
  setAuthMode(false);
  showAuth();
  $("#auth-message").textContent = error.message;
});
