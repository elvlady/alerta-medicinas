const state = {
  user: null,
  setupRequired: false,
  pushPublicKey: "",
  medicines: [],
  formOpen: false,
};

const SWIPE_ACTION_WIDTH = 138;

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

function shortMedicineMeta(medicine) {
  const dose = String(medicine.dose || "").trim();
  const interval = Number(medicine.intervalHours || 8);
  const duration = Number(medicine.durationDays || 7);
  const durationText = `${duration}${duration === 1 ? "dia" : "dias"}`;
  return [dose, "cd", `${interval}hr`, "x", durationText].filter(Boolean).join(" ");
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

function doseKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
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
  const completedDoses = new Set(medicine.completedDoses || []);
  let nextMs = start.getTime();
  if (nextMs < dayStart.getTime()) {
    nextMs += Math.ceil((dayStart.getTime() - nextMs) / intervalMs) * intervalMs;
  }

  const items = [];
  while (nextMs <= dayEnd.getTime() && (!end || nextMs <= end.getTime()) && items.length < 48) {
    const date = new Date(nextMs);
    items.push({ medicine, date, completed: completedDoses.has(doseKey(date)) });
    nextMs += intervalMs;
  }
  return items;
}

function nextFallbackItem(medicine) {
  const nextDate = medicine.nextReminderAt ? new Date(medicine.nextReminderAt) : null;
  if (!nextDate || Number.isNaN(nextDate.getTime())) return null;
  return { medicine, date: nextDate, completed: new Set(medicine.completedDoses || []).has(doseKey(nextDate)), fallback: true };
}

function closeSwipeRow(row) {
  row.classList.remove("actions-open");
  row.dataset.swipeX = "0";
  const card = row.querySelector("[data-swipe-card]");
  if (card) {
    card.style.transform = "";
  }
}

function closeSwipeRows(except = null) {
  document.querySelectorAll(".schedule-item.actions-open").forEach((row) => {
    if (row !== except) closeSwipeRow(row);
  });
}

function setSwipeOffset(row, card, offset) {
  const nextOffset = Math.max(0, Math.min(SWIPE_ACTION_WIDTH, offset));
  row.dataset.swipeX = String(nextOffset);
  card.style.transform = nextOffset ? `translateX(${-nextOffset}px)` : "";
}

function setupSwipe(row, card) {
  let startX = 0;
  let startY = 0;
  let initialOffset = 0;
  let pointerId = null;
  let dragging = false;
  let suppressClick = false;

  const finishSwipe = (event) => {
    if (pointerId !== event.pointerId) return;
    card.style.transition = "";
    const offset = Number(row.dataset.swipeX || 0);
    if (dragging && offset > SWIPE_ACTION_WIDTH * 0.42) {
      row.classList.add("actions-open");
      row.dataset.swipeX = String(SWIPE_ACTION_WIDTH);
      card.style.transform = "";
    } else {
      closeSwipeRow(row);
    }
    suppressClick = dragging;
    pointerId = null;
    dragging = false;
  };

  card.addEventListener("pointerdown", (event) => {
    if ((event.button && event.button !== 0) || event.target.closest("button")) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    initialOffset = row.classList.contains("actions-open") ? SWIPE_ACTION_WIDTH : Number(row.dataset.swipeX || 0);
    dragging = false;
    card.style.transition = "none";
    if (card.setPointerCapture) card.setPointerCapture(event.pointerId);
  });

  card.addEventListener("pointermove", (event) => {
    if (pointerId !== event.pointerId) return;
    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;
    if (!dragging && Math.abs(deltaX) < 8 && Math.abs(deltaY) < 8) return;
    if (!dragging && Math.abs(deltaY) > Math.abs(deltaX)) return;
    dragging = true;
    event.preventDefault();
    closeSwipeRows(row);
    setSwipeOffset(row, card, initialOffset - deltaX);
  });

  card.addEventListener("pointerup", finishSwipe);
  card.addEventListener("pointercancel", finishSwipe);
  card.addEventListener("click", (event) => {
    if (suppressClick) {
      suppressClick = false;
      event.preventDefault();
      return;
    }
    if (row.classList.contains("actions-open")) closeSwipeRow(row);
  });
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
    const meta = shortMedicineMeta(medicine);
    row.innerHTML = `
      <div class="schedule-time">
        <strong>${escapeHtml(time)}</strong>
        <span>${escapeHtml(period)}</span>
      </div>
      <div class="schedule-line"><span></span></div>
      <div class="swipe-shell">
        <div class="swipe-actions" aria-label="Acciones de ${escapeHtml(medicine.name)}">
          <button type="button" data-action="edit">Editar</button>
          <button type="button" class="danger" data-action="delete">Borrar</button>
        </div>
        <div class="schedule-card" data-swipe-card>
          <div class="medicine-symbol" aria-hidden="true">=</div>
          <div class="schedule-details">
            <strong>${escapeHtml(medicine.name)}</strong>
            <span>${escapeHtml(meta)}</span>
          </div>
          <div class="schedule-actions">
            <button
              type="button"
              class="dose-state"
              data-action="complete"
              aria-label="${item.completed ? "Marcar como pendiente" : "Marcar como completada"}"
            ></button>
          </div>
        </div>
      </div>
    `;
    const card = row.querySelector("[data-swipe-card]");
    row.querySelector('[data-action="complete"]').addEventListener("click", (event) => {
      event.stopPropagation();
      toggleDoseCompletion(medicine, item.date, !item.completed);
    });
    row.querySelector('[data-action="edit"]').addEventListener("click", (event) => {
      event.stopPropagation();
      closeSwipeRow(row);
      editMedicine(medicine);
    });
    row.querySelector('[data-action="delete"]').addEventListener("click", (event) => {
      event.stopPropagation();
      deleteMedicine(medicine.id);
    });
    setupSwipe(row, card);
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

async function toggleDoseCompletion(medicine, date, completed) {
  const key = doseKey(date);
  const completedDoses = new Set(medicine.completedDoses || []);
  if (completed) {
    completedDoses.add(key);
  } else {
    completedDoses.delete(key);
  }
  medicine.completedDoses = [...completedDoses];
  renderMedicines();

  try {
    await api(`/api/medicines/${encodeURIComponent(medicine.id)}/completions`, {
      method: "POST",
      body: JSON.stringify({ scheduledAt: key, completed }),
    });
    await loadMedicines();
  } catch (error) {
    console.error(error);
    await loadMedicines();
  }
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

function uint8ArrayToBase64Url(value) {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function setPushStatus(message) {
  const status = $("#push-status");
  const pushButton = $("#push-button");
  status.textContent = message;
  pushButton.setAttribute("aria-label", `Activar notificaciones. ${message}`);
  pushButton.title = message;
}

function subscriptionMatchesCurrentKey(subscription) {
  const applicationServerKey = subscription?.options?.applicationServerKey;
  if (!applicationServerKey || !state.pushPublicKey) return true;
  return uint8ArrayToBase64Url(new Uint8Array(applicationServerKey)) === state.pushPublicKey;
}

async function pushRegistration() {
  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  return registration;
}

async function currentPushSubscription(registration) {
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !subscriptionMatchesCurrentKey(subscription)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  return subscription;
}

async function savePushSubscription(subscription) {
  const payload = subscription.toJSON();
  payload.contentEncoding = "aes128gcm";
  await api("/api/push/subscribe", {
    method: "POST",
    body: JSON.stringify({ subscription: payload }),
  });
}

async function activatePush() {
  const pushButton = $("#push-button");
  if (!window.isSecureContext || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    setPushStatus("Este navegador no soporta push. Abre la PWA instalada por HTTPS.");
    return;
  }
  pushButton.disabled = true;
  pushButton.classList.add("is-busy");
  try {
    setPushStatus("Solicitando permiso");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setPushStatus("Permiso denegado");
      pushButton.classList.remove("is-on");
      pushButton.setAttribute("aria-pressed", "false");
      return;
    }

    setPushStatus("Registrando dispositivo");
    const registration = await pushRegistration();
    let subscription = await currentPushSubscription(registration);
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(state.pushPublicKey),
      });
    }
    await savePushSubscription(subscription);
    setPushStatus("Activas");
    pushButton.classList.add("is-on");
    pushButton.setAttribute("aria-pressed", "true");
  } catch (error) {
    setPushStatus(error.message || "No se pudieron activar");
    pushButton.classList.remove("is-on");
    pushButton.setAttribute("aria-pressed", "false");
  } finally {
    pushButton.classList.remove("is-busy");
    pushButton.disabled = false;
  }
}

async function refreshPushSwitch() {
  const pushButton = $("#push-button");
  if (!window.isSecureContext || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    setPushStatus("Este navegador no soporta push");
    return;
  }
  if (Notification.permission !== "granted") {
    pushButton.classList.remove("is-on");
    pushButton.setAttribute("aria-pressed", "false");
    setPushStatus("Listo para activar");
    return;
  }
  try {
    const registration = await pushRegistration();
    const subscription = await currentPushSubscription(registration);
    pushButton.classList.toggle("is-on", Boolean(subscription));
    pushButton.setAttribute("aria-pressed", subscription ? "true" : "false");
    setPushStatus(subscription ? "Activas" : "Listo para activar");
  } catch {
    pushButton.classList.remove("is-on");
    pushButton.setAttribute("aria-pressed", "false");
    setPushStatus("Listo para activar");
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
  refreshPushSwitch();
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
