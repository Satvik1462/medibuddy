export const API_URL =
  import.meta.env.VITE_API_URL || "http://localhost:3000";

// These helpers are only used by the STAFF console. (The patient chat has
// its own fetch calls with the citizen token.)
//
// BUG FIX: this used to fall back to the citizen token, so a staff page opened
// in a browser where a patient was also logged in sent the WRONG token, got a
// 403, and the staff member was silently logged out.
function authHeaders() {
  const token = localStorage.getItem("staff_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const DEACTIVATED_TEXT = "deactivated";

async function handle(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // BUG FIX: ANY 403 used to log the user out — including ordinary
    // "not allowed" answers like "This appointment does not belong to your
    // patients". Only a dead session (401) or a deactivated account ends
    // the session now.
    const sessionDead =
      response.status === 401 ||
      (response.status === 403 && String(data.error || "").toLowerCase().includes(DEACTIVATED_TEXT));
    if (sessionDead) {
      localStorage.removeItem("staff_token");
      localStorage.removeItem("staff_info");
      if (!window.location.pathname.startsWith("/login")) {
        window.location.href = "/login";
      }
    }
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

export function getJSON(path) {
  return fetch(`${API_URL}${path}`, { headers: { ...authHeaders() } }).then(handle);
}

export function postJSON(path, body) {
  return fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  }).then(handle);
}

export function putJSON(path, body) {
  return fetch(`${API_URL}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  }).then(handle);
}

export function deleteJSON(path, body) {
  return fetch(`${API_URL}${path}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(handle);
}

// ---------------------------------------------------------
// Shared formatters
// ---------------------------------------------------------
export function formatDate(dateValue) {
  if (!dateValue) return "—";
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return String(dateValue);
  return date.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

export function formatTime(timeValue) {
  if (!timeValue) return "—";
  const value = String(timeValue);
  const match = value.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return value;
  let hour = Number(match[1]);
  const minute = match[2];
  const period = hour >= 12 ? "PM" : "AM";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${minute} ${period}`;
}

export function initials(name) {
  if (!name) return "?";
  return name
    .replace(/^Dr\.?\s*/i, "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

export function todayISO() {
  const d = new Date();
  const tz = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const y = tz.getFullYear();
  const m = String(tz.getMonth() + 1).padStart(2, "0");
  const day = String(tz.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function tomorrowISO() {
  const d = new Date();
  const tz = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  tz.setDate(tz.getDate() + 1);
  const y = tz.getFullYear();
  const m = String(tz.getMonth() + 1).padStart(2, "0");
  const day = String(tz.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// The backend already sanitizes chat_summary down to just the patient's
// medical complaint (see sanitizeMedicalSummary in backend/server.js) —
// this only tidies whitespace for display.
export function cleanMedicalSummary(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

// Appointments carry booking_source = 'chatbot' | 'manual' (older rows may
// have it unset, which means it came through the chatbot). Used to show
// an "Online" / "Manual" tag next to a patient's name.
export function bookingSourceLabel(source) {
  return source === "manual" ? "Manual" : "Online";
}
