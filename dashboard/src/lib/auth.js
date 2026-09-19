import { API_URL } from "./api";

export function getStaff() {
  try {
    return JSON.parse(localStorage.getItem("staff_info") || "null");
  } catch {
    return null;
  }
}

export function isLoggedIn() {
  return Boolean(localStorage.getItem("staff_token"));
}

export function hasRole(role) {
  const staff = getStaff();
  return Boolean(staff && staff.role === role);
}

export async function login(username, password) {
  const response = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Login failed");
  }

  localStorage.setItem("staff_token", data.token);
  localStorage.setItem("staff_info", JSON.stringify(data.staff));
  return data.staff;
}

export function logout() {
  localStorage.removeItem("staff_token");
  localStorage.removeItem("staff_info");
}


export function getCitizen() {
  try { return JSON.parse(localStorage.getItem("citizen_info") || "null"); } catch { return null; }
}
export function isCitizenLoggedIn() { return Boolean(localStorage.getItem("citizen_token")); }
export function citizenLogout() {
  localStorage.removeItem("citizen_token");
  localStorage.removeItem("citizen_info");
}
export async function citizenLogin(phone, otp) {
  const response = await fetch(`${API_URL}/citizen/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, otp }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Citizen login failed");
  localStorage.setItem("citizen_token", data.token);
  localStorage.setItem("citizen_info", JSON.stringify(data.citizen));
  return data.citizen;
}
export async function requestCitizenOtp(phone) {
  const response = await fetch(`${API_URL}/citizen/request-otp`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Could not send OTP");
  return data;
}
