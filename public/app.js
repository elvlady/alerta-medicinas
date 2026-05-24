const state = {
  user: null,
  setupRequired: false,
  pushPublicKey: "",
  treatments: [],
  medicines: [],
  formOpen: false,
  treatmentFormOpen: false,
  clientId: "",
  openDays: new Set(),
  selectedTreatmentId: "",
  view: "treatments",
  todayKey: "",
};

const SWIPE_ACTION_WIDTH = 138;
const SWIPE_RELEASE_CLICK_MS = 450;
const CLIENT_ID_KEY = "alerta_medicinas_client_id";
const SPLASH_RELOAD_KEY = "alerta_medicinas_splash_reload";
let serviceWorkerRegistrationPromise = null;

const $ = (selector) => document.querySelector(selector);

function markAppReady() {
  window.__alertaAppReady = true;
  if (typeof window.__alertaSplashDone === "function") {
    window.__alertaSplashDone();
  }
  try {
    sessionStorage.removeItem(SPLASH_RELOAD_KEY);
  } catch {
    // Ignore storage restrictions in private browsing.
  }

  const splash = document.getElementById("splash-screen");
  if (!splash || splash.hidden) return;
  splash.classList.add("is-done");
  window.setTimeout(() => {
    splash.hidden = true;
  }, 260);
}

function registerServiceWorker() {
  if (serviceWorkerRegistrationPromise) return serviceWorkerRegistrationPromise;
  if (!window.isSecureContext || !("serviceWorker" in navigator)) {
    return Promise.resolve(null);
  }

  serviceWorkerRegistrationPromise = navigator.serviceWorker.register("/sw.js").catch((error) => {
    serviceWorkerRegistrationPromise = null;
    throw error;
  });
  return serviceWorkerRegistrationPromise;
}

function randomClientId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  const bytes = new Uint8Array(24);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function getClientId() {
  if (state.clientId) return state.clientId;
  try {
    let clientId = localStorage.getItem(CLIENT_ID_KEY);
    if (!clientId || !/^[a-zA-Z0-9_-]{20,120}$/.test(clientId)) {
      clientId = randomClientId();
      localStorage.setItem(CLIENT_ID_KEY, clientId);
    }
    state.clientId = clientId;
  } catch {
    state.clientId = state.clientId || randomClientId();
  }
  return state.clientId;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "x-client-id": getClientId(),
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
  state.treatmentFormOpen = false;
  document.body.classList.remove("form-open");
  document.body.classList.remove("treatment-form-open");
  document.body.classList.remove("detail-view");
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
  setTreatmentFormOpen(false);
}

function setFormOpen(open) {
  state.formOpen = open;
  document.body.classList.toggle("form-open", open);
  $("#form-title").textContent = $("#medicine-id").value ? "Editar medicina" : "Nueva medicina";
}

function setTreatmentFormOpen(open) {
  state.treatmentFormOpen = open;
  document.body.classList.toggle("treatment-form-open", open);
  $("#treatment-form-title").textContent = $("#treatment-id").value ? "Editar tratamiento" : "Nuevo tratamiento";
}

function medicinePayload() {
  return {
    treatmentId: state.selectedTreatmentId,
    name: $("#medicine-name").value.trim(),
    dose: $("#medicine-dose").value.trim(),
    startTime: $("#medicine-start-time").value,
    startAt: startAtInputIso(),
    intervalHours: Number($("#medicine-interval").value),
    durationDays: Number($("#medicine-duration").value),
    notes: $("#medicine-notes").value.trim(),
    active: true,
  };
}

function dateInputValue(value = new Date()) {
  if (value === "" || value === null) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return dateInputValue(new Date());
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function treatmentPayload() {
  return {
    name: $("#treatment-name").value.trim(),
    startDate: $("#treatment-start-date").value,
    endDate: $("#treatment-end-date").value,
  };
}

function resetTreatmentForm() {
  const today = new Date();
  $("#treatment-id").value = "";
  $("#treatment-form").reset();
  $("#treatment-start-date").value = dateInputValue(today);
  $("#treatment-end-date").value = "";
  $("#treatment-save-button").textContent = "Guardar";
  $("#treatment-form-title").textContent = "Nuevo tratamiento";
}

function editTreatment(treatment) {
  $("#treatment-id").value = treatment.id;
  $("#treatment-name").value = treatment.name || "";
  $("#treatment-start-date").value = dateInputValue(treatment.startAt);
  $("#treatment-end-date").value = dateInputValue(treatment.endAt);
  $("#treatment-save-button").textContent = "Actualizar";
  $("#treatment-form-title").textContent = "Editar tratamiento";
  setTreatmentFormOpen(true);
  $("#treatment-name").focus();
}

function resetMedicineForm() {
  $("#medicine-id").value = "";
  $("#medicine-form").reset();
  $("#medicine-start-time").value = timeInputValue();
  $("#medicine-interval").value = "8";
  $("#medicine-duration").value = "7";
  $("#save-button").textContent = "Guardar";
  $("#form-title").textContent = "Nueva medicina";
  $("#cancel-edit").hidden = true;
}

function selectedTreatment() {
  return state.treatments.find((treatment) => treatment.id === state.selectedTreatmentId) || null;
}

function editMedicine(medicine) {
  setFormOpen(true);
  $("#medicine-id").value = medicine.id;
  $("#medicine-name").value = medicine.name;
  $("#medicine-dose").value = medicine.dose || "";
  $("#medicine-start-time").value = timeInputValue(medicine.startAt || medicine.createdAt);
  $("#medicine-interval").value = medicine.intervalHours || 8;
  $("#medicine-duration").value = medicine.durationDays || 7;
  $("#medicine-notes").value = medicine.notes || "";
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

function startOfDay(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function endOfDay(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
}

function startOfToday(now = new Date()) {
  return startOfDay(now);
}

function endOfToday(now = new Date()) {
  return endOfDay(now);
}

function addDays(value, days) {
  const date = startOfDay(value);
  date.setDate(date.getDate() + days);
  return date;
}

function treatmentLastDay(medicine) {
  const start = new Date(medicine.startAt || medicine.createdAt || Date.now());
  if (Number.isNaN(start.getTime())) return startOfToday();
  const duration = Math.max(1, Number(medicine.durationDays || 1));
  return addDays(start, duration - 1);
}

function treatmentEndsOn(medicine) {
  return endOfDay(treatmentLastDay(medicine));
}

function sameDay(a, b) {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

function dayKey(date) {
  const value = startOfDay(date);
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${value.getFullYear()}-${month}-${day}`;
}

function dayTitle(date) {
  const today = startOfToday();
  if (sameDay(date, today)) return "HOY";
  if (sameDay(date, addDays(today, 1))) return "MANANA";
  if (sameDay(date, addDays(today, 2))) return "PASADO MANANA";
  return date.toLocaleDateString("es-MX", { day: "numeric", month: "long" }).replace(" de ", " ").toUpperCase();
}

function daySubtitle(date) {
  return date.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
}

function treatmentRange(treatment) {
  const start = formatDate(treatment.startAt);
  const end = formatDate(treatment.endAt);
  return end ? `${start} - ${end}` : `Desde ${start}`;
}

function timeInputValue(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return timeInputValue(new Date());
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function startAtInputIso() {
  const match = /^(\d{1,2}):(\d{2})$/.exec($("#medicine-start-time").value || "");
  if (!match) return new Date().toISOString();

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const id = $("#medicine-id").value;
  const existing = state.medicines.find((medicine) => medicine.id === id);
  const treatment = selectedTreatment();
  const treatmentStart = treatment?.startAt ? new Date(treatment.startAt) : null;
  const today = new Date();
  const date = existing?.startAt
    ? new Date(existing.startAt)
    : (treatmentStart && treatmentStart > today ? treatmentStart : today);
  if (Number.isNaN(date.getTime())) {
    date.setTime(Date.now());
  }
  date.setHours(hours, minutes, 0, 0);
  return date.toISOString();
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

function scheduleForMedicine(medicine, day = new Date()) {
  if (!medicine.active) return [];

  const start = new Date(medicine.startAt || medicine.createdAt || Date.now());
  const end = treatmentEndsOn(medicine);
  if (Number.isNaN(start.getTime())) return [];

  const dayStart = startOfDay(day);
  const dayEnd = endOfDay(day);
  if (dayEnd < start || dayStart > end) return [];

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

function lastScheduleDate() {
  const today = startOfToday();
  let last = today;
  for (const medicine of state.medicines) {
    if (!medicine.active) continue;
    const candidate = treatmentLastDay(medicine);
    if (!Number.isNaN(candidate.getTime()) && candidate > last) {
      last = candidate;
    }
  }
  return startOfDay(last);
}

function closeSwipeRow(row) {
  row.classList.remove("actions-open");
  row.dataset.swipeX = "0";
  delete row.dataset.justSwipedOpenAt;
  delete row.dataset.closeOnlyClick;
  const card = row.querySelector("[data-swipe-card]");
  if (card) {
    card.style.transform = "";
  }
}

function closeSwipeRows(except = null) {
  document.querySelectorAll(".schedule-item.actions-open, .treatment-row.actions-open").forEach((row) => {
    if (row !== except) closeSwipeRow(row);
  });
}

function setSwipeOffset(row, card, offset) {
  const nextOffset = Math.max(0, Math.min(SWIPE_ACTION_WIDTH, offset));
  row.dataset.swipeX = String(nextOffset);
  card.style.transform = nextOffset ? `translateX(${-nextOffset}px)` : "";
}

function consumeSwipeReleaseClick(row) {
  const openedAt = Number(row.dataset.justSwipedOpenAt || 0);
  if (!openedAt) return false;
  delete row.dataset.justSwipedOpenAt;
  return Date.now() - openedAt < SWIPE_RELEASE_CLICK_MS;
}

function setupSwipe(row, card) {
  let startX = 0;
  let startY = 0;
  let initialOffset = 0;
  let pointerId = null;
  let dragging = false;
  let suppressClick = false;
  let suppressClickUntil = 0;

  const finishSwipe = (event) => {
    if (pointerId !== event.pointerId) return;
    card.style.transition = "";
    const offset = Number(row.dataset.swipeX || 0);
    if (dragging && offset > SWIPE_ACTION_WIDTH * 0.42) {
      row.classList.add("actions-open");
      row.dataset.swipeX = String(SWIPE_ACTION_WIDTH);
      row.dataset.justSwipedOpenAt = String(Date.now());
      card.style.transform = "";
    } else {
      closeSwipeRow(row);
    }
    suppressClick = dragging;
    suppressClickUntil = dragging ? Date.now() + SWIPE_RELEASE_CLICK_MS : 0;
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
      const shouldIgnore = Date.now() < suppressClickUntil;
      suppressClick = false;
      suppressClickUntil = 0;
      if (shouldIgnore) {
        event.preventDefault();
        return;
      }
    }
    if (row.classList.contains("actions-open")) closeSwipeRow(row);
  });
}

function createScheduleRow(item) {
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
    return row;
}

function scheduleDays() {
  const today = startOfToday();
  const last = lastScheduleDate();
  const days = [];
  for (let day = today; day <= last && days.length < 3700; day = addDays(day, 1)) {
    const items = state.medicines.flatMap((medicine) => scheduleForMedicine(medicine, day));
    items.sort((a, b) => a.date - b.date);
    days.push({ day, items });
  }
  return days;
}

function createDayAccordion(group, index) {
  const completed = group.items.filter((item) => item.completed).length;
  const key = dayKey(group.day);
  const section = document.createElement("details");
  section.className = "day-accordion";
  section.open = state.openDays.size ? state.openDays.has(key) : index === 0;
  section.innerHTML = `
    <summary>
      <span>
        <strong>${escapeHtml(dayTitle(group.day))}</strong>
        <small>${escapeHtml(daySubtitle(group.day))}</small>
      </span>
      <em>${completed}/${group.items.length} completadas</em>
    </summary>
  `;
  section.addEventListener("toggle", () => {
    if (section.open) {
      state.openDays.add(key);
    } else {
      state.openDays.delete(key);
    }
  });

  const body = document.createElement("div");
  body.className = "day-accordion-body";
  if (!group.items.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No hay tomas programadas este dia.";
    body.append(empty);
  } else {
    group.items.forEach((item) => body.append(createScheduleRow(item)));
  }
  section.append(body);
  return section;
}

function setView(view) {
  state.view = view;
  document.body.classList.toggle("detail-view", view === "detail");
  const fab = $("#fab-button");
  fab.setAttribute("aria-label", view === "detail" ? "Agregar medicina" : "Agregar tratamiento");
  fab.title = view === "detail" ? "Agregar medicina" : "Agregar tratamiento";
  if (view === "treatments") {
    state.selectedTreatmentId = "";
    state.medicines = [];
    state.openDays.clear();
    setFormOpen(false);
  }
}

function renderTreatmentHeader() {
  const count = state.treatments.length;
  $("#treatment-count").textContent = `${count} ${count === 1 ? "tratamiento" : "tratamientos"}`;
}

function createTreatmentCard(treatment) {
  const row = document.createElement("article");
  row.className = "treatment-row";
  row.innerHTML = `
    <div class="swipe-shell">
      <div class="swipe-actions" aria-label="Acciones de ${escapeHtml(treatment.name)}">
        <button type="button" data-action="edit">Editar</button>
        <button type="button" class="danger" data-action="delete">Borrar</button>
      </div>
      <div class="treatment-card" data-swipe-card role="button" tabindex="0">
        <span>
          <strong>${escapeHtml(treatment.name)}</strong>
          <small>${escapeHtml(treatmentRange(treatment))}</small>
        </span>
        <em>${treatment.medicineCount || 0} ${(treatment.medicineCount || 0) === 1 ? "medicina" : "medicinas"}</em>
      </div>
    </div>
  `;
  const card = row.querySelector("[data-swipe-card]");
  card.addEventListener("pointerdown", () => {
    if (row.classList.contains("actions-open")) {
      row.dataset.closeOnlyClick = "1";
    }
  });
  card.addEventListener("click", (event) => {
    if (consumeSwipeReleaseClick(row)) {
      event.preventDefault();
      return;
    }
    if (row.dataset.closeOnlyClick === "1" || row.classList.contains("actions-open")) {
      delete row.dataset.closeOnlyClick;
      event.preventDefault();
      closeSwipeRow(row);
      return;
    }
    enterTreatment(treatment.id);
  });
  card.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (row.classList.contains("actions-open")) {
      closeSwipeRow(row);
      return;
    }
    enterTreatment(treatment.id);
  });
  row.querySelector('[data-action="edit"]').addEventListener("click", (event) => {
    event.stopPropagation();
    closeSwipeRow(row);
    editTreatment(treatment);
  });
  row.querySelector('[data-action="delete"]').addEventListener("click", (event) => {
    event.stopPropagation();
    deleteTreatment(treatment.id);
  });
  setupSwipe(row, card);
  return row;
}

function renderTreatments() {
  renderTreatmentHeader();
  const list = $("#treatment-list");
  list.innerHTML = "";

  if (!state.treatments.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state treatment-empty-state";
    empty.innerHTML = `
      <span>Crea tu primer tratamiento.</span>
      <button type="button" class="primary empty-action">Agregar Tratamiento</button>
    `;
    empty.querySelector("button").addEventListener("click", () => {
      resetTreatmentForm();
      setTreatmentFormOpen(true);
    });
    list.append(empty);
    return;
  }

  state.treatments.forEach((treatment) => list.append(createTreatmentCard(treatment)));
}

function renderSelectedTreatment() {
  const treatment = selectedTreatment();
  $("#selected-treatment-name").textContent = treatment?.name || "Tratamiento";
  $("#selected-treatment-range").textContent = treatment ? treatmentRange(treatment) : "";
}

function renderMedicines() {
  const list = $("#medicine-list");
  list.innerHTML = "";
  renderSelectedTreatment();
  if (!state.selectedTreatmentId) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Selecciona un tratamiento.";
    list.append(empty);
    return;
  }
  if (!state.medicines.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Aun no hay medicinas en este tratamiento.";
    list.append(empty);
    return;
  }

  const header = document.createElement("div");
  header.className = "schedule-header";
  header.innerHTML = `
    <span>CRONOGRAMA</span>
    <strong>Por dias</strong>
  `;
  list.append(header);

  const groups = scheduleDays();
  if (!state.openDays.size && groups[0]) {
    state.openDays.add(dayKey(groups[0].day));
  }
  groups.forEach((group, index) => {
    list.append(createDayAccordion(group, index));
  });
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
  if (!state.selectedTreatmentId) {
    state.medicines = [];
    renderMedicines();
    return;
  }
  const data = await api(`/api/medicines?treatmentId=${encodeURIComponent(state.selectedTreatmentId)}`);
  state.medicines = data.medicines;
  renderMedicines();
}

async function loadTreatments() {
  const data = await api("/api/treatments");
  state.treatments = data.treatments;
  if (state.selectedTreatmentId && !selectedTreatment()) {
    setView("treatments");
  }
  renderTreatments();
  renderSelectedTreatment();
}

async function enterTreatment(id) {
  state.selectedTreatmentId = id;
  state.openDays.clear();
  setView("detail");
  renderSelectedTreatment();
  await loadMedicines();
}

function backToTreatments() {
  setView("treatments");
  renderTreatments();
}

async function saveTreatment(event) {
  event.preventDefault();
  const id = $("#treatment-id").value;
  const payload = treatmentPayload();
  const data = id
    ? await api(`/api/treatments/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    })
    : await api("/api/treatments", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  resetTreatmentForm();
  setTreatmentFormOpen(false);
  await loadTreatments();
  await enterTreatment(data.treatment.id);
}

async function saveMedicine(event) {
  event.preventDefault();
  if (!state.selectedTreatmentId) return;
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
  await loadTreatments();
}

async function deleteMedicine(id) {
  await api(`/api/medicines/${encodeURIComponent(id)}`, { method: "DELETE" });
  await loadMedicines();
  await loadTreatments();
}

async function deleteTreatment(id) {
  if (!window.confirm("Eliminar este tratamiento y sus medicinas?")) return;
  await api(`/api/treatments/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (state.selectedTreatmentId === id) {
    setView("treatments");
  }
  await loadTreatments();
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

function refreshDateLabels(force = false) {
  const currentKey = dayKey(new Date());
  if (!force && state.todayKey === currentKey) return;
  state.todayKey = currentKey;
  state.openDays.clear();
  renderTreatments();
  if (state.view === "detail") renderMedicines();
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
  const registration = await registerServiceWorker();
  if (!registration) {
    throw new Error("Este navegador no soporta service worker por HTTPS.");
  }
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
  showApp();
  markAppReady();
  setView("treatments");
  refreshPushSwitch();
  await loadTreatments();
}

$("#auth-form").addEventListener("submit", authenticate);
$("#treatment-form").addEventListener("submit", saveTreatment);
$("#medicine-form").addEventListener("submit", saveMedicine);
$("#cancel-edit").addEventListener("click", resetMedicineForm);
$("#fab-button").addEventListener("click", () => {
  if (state.view === "detail" && state.selectedTreatmentId) {
    resetMedicineForm();
    setFormOpen(true);
    return;
  }
  resetTreatmentForm();
  setTreatmentFormOpen(true);
});
$("#close-form-button").addEventListener("click", () => setFormOpen(false));
$("#treatment-close-form-button").addEventListener("click", () => setTreatmentFormOpen(false));
$("#back-to-treatments").addEventListener("click", backToTreatments);
$("#push-button").addEventListener("click", activatePush);
$("#logout-button").addEventListener("click", logout);

resetMedicineForm();
resetTreatmentForm();
state.todayKey = dayKey(new Date());
setInterval(() => refreshDateLabels(), 60 * 1000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshDateLabels();
});

registerServiceWorker().catch((error) => console.warn(error));

boot().catch((error) => {
  showApp();
  markAppReady();
  const list = $("#treatment-list");
  list.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = error.message;
  list.append(empty);
});
