// Simple WhatsApp sender wrapper.
// Swap the fetch body/headers to match whichever provider you choose
// (Interakt, Gupshup, etc.) — the shapes differ slightly, but the idea
// is the same: POST the phone number + template name + variables.

require("dotenv").config();

const isConfigured =
  process.env.WHATSAPP_API_KEY &&
  process.env.WHATSAPP_API_KEY !== "your_whatsapp_api_key_here" &&
  process.env.WHATSAPP_API_URL;

// WhatsApp isn't set up yet (no real API key) — stay quiet about it.
// Once WHATSAPP_API_KEY / WHATSAPP_API_URL are filled in with real
// values in backend/.env, sends (and any real failures) will start
// showing up in the logs again.

async function sendWhatsAppMessage(phone, templateName, variables = []) {
  if (!isConfigured) {
    return false;
  }

  try {
    const response = await fetch(process.env.WHATSAPP_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.WHATSAPP_API_KEY}`,
      },
      body: JSON.stringify({
        countryCode: "+91",
        phoneNumber: phone,
        type: "Template",
        template: {
          name: templateName,
          languageCode: "en",
          bodyValues: variables,
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[whatsapp] Send failed (${response.status}) for template "${templateName}" to ${phone}:`, text);
      return false;
    }

    console.log(`[whatsapp] Sent "${templateName}" to ${phone}`);
    return true;
  } catch (err) {
    console.error("[whatsapp] Send error:", err.message);
    return false;
  }
}

module.exports = { sendWhatsAppMessage };
