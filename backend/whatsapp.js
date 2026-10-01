// Simple WhatsApp sender wrapper.
// Swap the fetch body/headers to match whichever provider you choose
// (Interakt, Gupshup, etc.) — the shapes differ slightly, but the idea
// is the same: POST the phone number + template name + variables.

require("dotenv").config();

const isConfigured = Boolean(
  process.env.WHATSAPP_API_KEY &&
  process.env.WHATSAPP_API_KEY !== "your_whatsapp_api_key_here" &&
  process.env.WHATSAPP_API_URL
);

// BUG FIX: the README promises a startup warning when WhatsApp isn't set
// up, but the code stayed completely silent — so a missing key looked
// exactly like "messages are being sent".
if (!isConfigured) {
  console.warn(
    "[whatsapp] WHATSAPP_API_KEY / WHATSAPP_API_URL not set in backend/.env — " +
    "booking confirmations and reminders will NOT be sent."
  );
}

// BUG FIX: Interakt authenticates with "Authorization: Basic <API key>"
// (the key from the Interakt dashboard is already base64-encoded), not
// "Bearer". With Bearer every request came back 401. Other providers can
// override this with WHATSAPP_AUTH_SCHEME=Bearer in .env.
const AUTH_SCHEME =
  process.env.WHATSAPP_AUTH_SCHEME ||
  (/interakt/i.test(process.env.WHATSAPP_API_URL || "") ? "Basic" : "Bearer");

const TIMEOUT_MS = 10000;

async function sendWhatsAppMessage(phone, templateName, variables = []) {
  if (!isConfigured) {
    return false;
  }

  const digits = String(phone || "").replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) {
    console.error(`[whatsapp] Not sending "${templateName}" — invalid phone number "${phone}"`);
    return false;
  }

  // A slow/hung provider should never keep a request (or the reminder loop)
  // waiting forever.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(process.env.WHATSAPP_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `${AUTH_SCHEME} ${process.env.WHATSAPP_API_KEY}`,
      },
      body: JSON.stringify({
        countryCode: "+91",
        phoneNumber: digits,
        type: "Template",
        template: {
          name: templateName,
          languageCode: process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en",
          bodyValues: variables.map((v) => String(v ?? "")),
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[whatsapp] Send failed (${response.status}) for template "${templateName}" to ${digits}:`, text);
      return false;
    }

    console.log(`[whatsapp] Sent "${templateName}" to ${digits}`);
    return true;
  } catch (err) {
    console.error("[whatsapp] Send error:", err.name === "AbortError" ? "request timed out" : err.message);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendWhatsAppMessage, isConfigured };
