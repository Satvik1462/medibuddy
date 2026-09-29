require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("./db");
const { sendWhatsAppMessage } = require("./whatsapp");
const { GoogleGenAI } = require("@google/genai");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "";
}

// Keeps only the patient's medical complaint out of a raw chat message.
//
// PREVIOUS BUG: the admin-word stripper used
//   /\b(?:doctor|naam|book|...)\b[^.!?]*[.!?]?/gi
// which, for any message with no sentence-ending punctuation (extremely
// common in casual WhatsApp chat), deleted EVERYTHING from that word to
// the end of the string — silently wiping out real symptoms whenever they
// appeared after a word like "doctor" or "naam" in the same run-on
// message. E.g. "Hi doctor mujhe pet mein dard hai kal se" -> "" even
// though the patient clearly described stomach pain.
//
// FIX: split into clauses first (on punctuation, commas, and common
// conjunctions), keep only the clauses that actually contain a medical
// keyword, and only THEN strip standalone admin words from inside those
// kept clauses (word-for-word, never "to end of string").
function sanitizeMedicalSummary(text) {
  const raw = String(text || "")
    .replace(/\s+/g, " ")
    .replace(/[|]+/g, " ")
    .trim();
  if (!raw) return "";

  const cleaned = raw
    .replace(/^(?:hi|hello|hey|namaste|good\s+(?:morning|afternoon|evening)|hii+|helo+)\b[\s,!.:-]*(?:(?:dost|sir|madam|ma'am|ji)\b[\s,!.:-]*)*/i, "")
    .replace(/^(?:dost|sir|madam|ma'am|ji)\b[\s,!.:-]*/i, "")
    .trim();

  const medicalPattern = /(?:\b(?:pain|ache|dard|dardh|bhutdard|headache|sir\s*dard|chakkar|dizziness|bukhar|fever|khansi|cough|sardi|cold|gale|throat|saans|breath|breathing|chest|seene|pet|stomach|gas|acidity|ulti|vomit|nausea|dast|diarr|constipation|kabz|rash|rashes|khujli|itch|allergy|allergic|skin|infection|swelling|sujan|bleeding|blood|injury|chot|wound|burn|jal|weakness|kamzori|thakan|fatigue|sugar|diabetes|pressure|bp|migraine|joint|knee|back|kamar|shoulder|ear|kaan|eye|aankh|vision|tooth|daant|pregnan|period|urine|peshab|kidney|heart|temperature|taklif|takleef|takleef|tabiyat|tabiyat\s*kharab|kharab|dikkat|pareshani|problem|issue|unwell|not\s*feeling\s*well|sick|illness|bimari|beemari|symptom|samasya|checkup|check[\s-]?up|pair|paer|leg|fracture|toot|tuta|tuti|toota|broken|break)\b|दर्द|सिरदर्द|सिर दर्द|चक्कर|बुखार|खांसी|सर्दी|गला|गले|सांस|सीने|छाती|पेट|गैस|एसिडिटी|उल्टी|मतली|दस्त|कब्ज|खुजली|एलर्जी|त्वचा|संक्रमण|सूजन|खून|रक्त|चोट|घाव|जलन|कमजोरी|थकान|शुगर|मधुमेह|बीपी|माइग्रेन|जोड़|घुटना|कमर|कंधा|कान|आंख|दांत|पेशाब|किडनी|दिल|तापमान|दुखत|दुखणे|डोकेदुखी|चक्कर येणे|ताप|खोकला|घसा|पोट|आम्लपित्त|उलटी|मळमळ|जुलाब|बद्धकोष्ठता|खाज|पुरळ|सूज|जखम|अशक्तपणा|थकवा|साखर|दाब|गुडघा|पाठ|खांदा|डोळा|दात|लघवी|मूत्रपिंड|हृदय|तकलीफ|तबीयत|ख़राब|खराब|दिक्कत|परेशानी|समस्या|बीमार|बीमारी|अस्वस्थ)/i;
  const adminWordPattern = /\b(?:appointment|booking|book|confirm|confirmation|slot|doctor|dr\.?|mobile|phone|number|naam|name|time)\b/gi;

  const clauses = cleaned
    .split(/(?<=[.!?])\s+|,\s*|\s+\b(?:aur|and|phir|then|par|but)\b\s+/i)
    .map(part => part.trim())
    .filter(Boolean);

  const medicalClauses = clauses
    .filter(part => medicalPattern.test(part))
    .map(part => part.replace(adminWordPattern, " ").replace(/\s+/g, " ").trim());

  return medicalClauses
    .join(", ")
    .replace(/^[,;:\- ]+|[,;:\- ]+$/g, "")
    .slice(0, 300);
}

// ---------------------------------------------------------
// resolveComplaint(): the single place that decides which "medical
// complaint" text is stored/shown for an appointment.
//
// PROBLEM: sanitizeMedicalSummary() only keeps clauses containing a word
// from a fixed symptom list. Anything not on that list ("hair fall", "acne",
// "anxiety", "loose motion", "neend nahi aati"...) was thrown away, so the
// dashboard showed "No medical complaint recorded." even though the patient
// had clearly told the chatbot what was wrong — it was sitting in the saved
// chat transcript the whole time.
//
// Order of attempts (first non-empty wins):
//   1. strict keyword-based clean of the saved summary (old behaviour)
//   2. the saved summary itself, if it isn't just booking chatter
//   3. strict clean of what the patient typed in the chat transcript
//   4. the patient's own descriptive chat lines (no booking/contact words)
// It only needs chat_summary + chat_transcript, so it also repairs
// appointments that were already saved with an empty summary.
// ---------------------------------------------------------
const BOOKING_CHATTER_PATTERN = /\b(?:appointments?|apointment|booking|book|confirm(?:ed|ation)?|slots?|mobile|phone|number|naam|name|time|schedule|available|availability|chahiye|chahta|chahti|dikhana|dikhani|milna|consult(?:ation)?|wants?\s+to|need\s+to|would\s+like\s+to|looking\s+for)\b|अपॉइंटमेंट|बुक|स्लॉट|मोबाइल|नंबर|नाम|समय|चाहिए/i;
const ACK_ONLY_PATTERN = /^(?:yes|yeah|no|nope|haan|han|ha|hnji|nahi|nhi|ok|okay|k|thanks|thank\s*you|thnx|theek\s*hai|thik\s*hai|ji|hmm+|hi+|hello+|hey|namaste|bye)[\s.!?,]*$/i;
const GREETING_PREFIX_PATTERN = /^(?:hi|hello|hey|namaste|good\s+(?:morning|afternoon|evening)|hii+|helo+)\b[\s,!.:-]*(?:(?:dost|sir|madam|ma'am|ji)\b[\s,!.:-]*)*/i;

function lightCleanComplaint(text, minWords = 1) {
  const s = String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\+?\d[\d\s-]{8,}\d/g, " ") // phone numbers
    .trim()
    .replace(GREETING_PREFIX_PATTERN, "")
    .replace(/^(?:dost|sir|madam|ma'am|ji)\b[\s,!.:-]*/i, "")
    .replace(/\b(?:doctor|dr)\b\.?/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[,;:\- ]+|[,;:\- ]+$/g, "")
    .trim();
  if (!s || ACK_ONLY_PATTERN.test(s) || BOOKING_CHATTER_PATTERN.test(s)) return "";
  if (s.split(" ").length < minWords) return "";
  return s.slice(0, 300);
}

function resolveComplaint(summary, transcript) {
  const strict = sanitizeMedicalSummary(summary);
  if (strict) return strict;

  const saved = lightCleanComplaint(summary);
  if (saved) return saved;

  let messages = transcript;
  if (typeof messages === "string") {
    try { messages = JSON.parse(messages); } catch { messages = []; }
  }
  const patientLines = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && m.role !== "assistant" && typeof m.message === "string")
    .map((m) => m.message);

  const strictLines = [...new Set(patientLines.map(sanitizeMedicalSummary).filter(Boolean))];
  if (strictLines.length) return strictLines.join(", ").slice(0, 300);

  // Loose fallback needs 3+ words so a bare name/"ok"/"6 pm" is never
  // mistaken for a complaint.
  const looseLines = [...new Set(patientLines.map((m) => lightCleanComplaint(m, 3)).filter(Boolean))];
  return looseLines.slice(0, 2).join(", ").slice(0, 300);
}

// =========================================================
// MULTILINGUAL SUPPORT
//
// The AI itself detects the patient's language/script from their first
// message and is instructed to keep replying in that same language (see
// systemPrompt below). This just normalizes whatever label the model
// returns so it stays stable turn-to-turn, and gives us a small set of
// deterministic (non-AI) system messages in the patient's language for
// the few places the code replies directly instead of via the model
// (parse failures, slot races, final booking confirmation, etc).
// =========================================================

const SUPPORTED_LANGUAGES = ["English", "Hindi", "Hinglish"];

function normalizeLanguage(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return null;
  if (v.startsWith("hing")) return "Hinglish";
  if (v.startsWith("hi") || v === "devanagari" || v === "\u0939\u093f\u0902\u0926\u0940") return "Hindi";
  if (v.startsWith("en")) return "English";
  // Any other detected regional language (Tamil, Bengali, Marathi, etc.)
  // is passed through as-is so the AI can keep replying in it; our own
  // hardcoded system strings fall back to Hinglish for these since we
  // don't maintain static translations for every language.
  return value;
}

const SYSTEM_MESSAGES = {
  parseFallback: {
    English: "I can help you book an appointment.",
    Hindi: "मैं आपकी अपॉइंटमेंट बुक करने में मदद कर सकता हूँ।",
    Hinglish: "Main aapki appointment booking mein help kar sakta hoon.",
  },
  incompleteBooking: {
    English: "Before booking, I still need some appointment details.",
    Hindi: "बुक करने से पहले कुछ अपॉइंटमेंट जानकारी अभी बाकी है।",
    Hinglish: "Booking complete karne ke liye kuch details abhi baaki hain.",
  },
  slotTaken: {
    English: "Sorry, this slot is no longer available. Let me find another one.",
    Hindi: "माफ़ कीजिए, यह स्लॉट अब उपलब्ध नहीं है। मैं दूसरा स्लॉट देखता हूँ।",
    Hinglish: "Sorry, ye slot abhi available nahi hai. Main doosra slot dekh sakta hoon.",
  },
  genericHelp: {
    English: "I can help you with appointment booking.",
    Hindi: "मैं आपकी अपॉइंटमेंट बुकिंग में मदद कर सकता हूँ।",
    Hinglish: "Main appointment booking mein help kar sakta hoon.",
  },
  arrivalTimeQuestion: {
    English: "What time can you come to the hospital?",
    Hindi: "आप कितने बजे तक अस्पताल आ सकते हैं?",
    Hinglish: "Aap kitne baje tak hospital aa sakte hain?",
  },
};

function t(key, language) {
  const table = SYSTEM_MESSAGES[key] || {};
  return table[language] || table.Hinglish;
}

// Tell the patient only which booking fields are actually missing.
// Previously this always listed name + phone + doctor + slot, even when
// most of those details were already present in the booking state.
function incompleteBookingMessage(booking, language) {
  const missing = [];
  if (!booking.patient_name) missing.push("name");
  if (!booking.phone) missing.push("phone");
  if (!booking.doctor_id) missing.push("doctor");
  if (!booking.slot_id) missing.push("slot");

  if (missing.length === 0) return t("incompleteBooking", language);

  const labels = {
    English: { name: "name", phone: "phone number", doctor: "doctor", slot: "appointment slot" },
    Hindi: { name: "नाम", phone: "फ़ोन नंबर", doctor: "डॉक्टर", slot: "अपॉइंटमेंट स्लॉट" },
    Hinglish: { name: "naam", phone: "phone number", doctor: "doctor", slot: "appointment slot" },
  };
  const l = labels[language] || labels.Hinglish;
  const items = missing.map((key) => l[key]);

  if (language === "English") {
    if (items.length === 1) return `I just need your ${items[0]} to complete the booking.`;
    if (items.length === 2) return `I just need your ${items[0]} and ${items[1]} to complete the booking.`;
    return `I just need your ${items.slice(0, -1).join(", ")} and ${items.at(-1)} to complete the booking.`;
  }

  if (language === "Hindi") {
    if (items.length === 1) return `Booking complete karne ke liye bas aapka ${items[0]} chahiye।`;
    if (items.length === 2) return `Booking complete karne ke liye bas aapka ${items[0]} aur ${items[1]} chahiye।`;
    return `Booking complete karne ke liye ${items.slice(0, -1).join(", ")} aur ${items.at(-1)} chahiye।`;
  }

  if (items.length === 1) return `Booking complete karne ke liye bas aapka ${items[0]} chahiye.`;
  if (items.length === 2) return `Booking complete karne ke liye bas aapka ${items[0]} aur ${items[1]} chahiye.`;
  return `Booking complete karne ke liye ${items.slice(0, -1).join(", ")} aur ${items.at(-1)} chahiye.`;
}

// For languages we don't keep a static translation for (anything beyond
// English/Hindi/Hinglish — Marathi, Tamil, Bengali, etc.), we can't just
// trust the main booking model to mirror the right language on demand;
// in practice a small/fast model tends to just mirror whatever script the
// latest message happens to be in (e.g. a quick-pick button's canned
// Hinglish text), even when told not to. So instead we build the message
// ourselves with the real, verified data (Hinglish) and run ONE small,
// single-purpose translation call — a much easier task for the model to
// get right than juggling booking logic + tone + JSON schema all at once.
async function translateText(text, targetLanguage) {
  if (!text || !targetLanguage) return text;
  try {
    const resp = await generateWithFallback({
      contents: [{ role: "user", parts: [{ text }] }],
      config: {
        systemInstruction:
          `Translate the following sentence into ${targetLanguage}, using ` +
          `${targetLanguage}'s native script. Keep any proper nouns (names), ` +
          `dates, and times exactly as given — do not translate or reformat ` +
          `them. Return ONLY the translated sentence, nothing else: no ` +
          `quotes, no explanation, no extra text.`,
        temperature: 0,
        maxOutputTokens: 200,
      },
    });
    const out = typeof resp.text === "string" ? resp.text.trim() : "";
    return out || text;
  } catch (e) {
    console.error("Translation error:", e);
    return text; // fail safe: better a Hinglish reply than a crash
  }
}

// Resolves one of our own SYSTEM_MESSAGES for any language: uses the
// static translation when we have one, otherwise machine-translates the
// Hinglish version on the fly.
async function localize(key, language) {
  const table = SYSTEM_MESSAGES[key] || {};
  if (language && table[language]) return table[language];
  const base = table.Hinglish || "";
  if (!language || language === "Hinglish") return base;
  return translateText(base, language);
}

// Same idea, but for one-off template strings built inline (real doctor
// names / dates / times already interpolated in) rather than a fixed
// SYSTEM_MESSAGES key.
async function localizeTemplate(templatesByLang, language) {
  if (language && templatesByLang[language]) return templatesByLang[language];
  const base = templatesByLang.Hinglish;
  if (!language || language === "Hinglish") return base;
  return translateText(base, language);
}

// =========================================================
// AUTH — staff (doctor / admin) login, role-based access
// =========================================================

// Verifies the Bearer token and (optionally) restricts by role.
// Usage: app.get("/route", requireAuth(["admin"]), handler)
// requireAuth() with no args just requires "logged in, any role".
const DEACTIVATED_MESSAGE = "This account has been deactivated. Please contact the admin.";

// Admin can deactivate a reception login at any time. A JWT stays valid for
// 12h, so for reception accounts we also check the live "active" flag —
// otherwise a deactivated account would keep working until its token expires.
async function isStaffAccountActive(payload) {
  if (!payload || !["reception", "doctor"].includes(payload.role)) return true;
  const r = await pool.query(
    `SELECT s.active, d.deleted_at
     FROM staff s
     LEFT JOIN doctors d ON d.id = s.doctor_id
     WHERE s.id = $1`,
    [payload.id]
  );
  const row = r.rows[0];
  // A deleted (archived) doctor's login stops working immediately, without
  // waiting for their 12h token to expire.
  return Boolean(row) && row.active !== false && !row.deleted_at;
}

function requireAuth(allowedRoles) {
  return async (req, res, next) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: "Login required" });
    }

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: "Session expired, please log in again" });
    }

    if (allowedRoles && !allowedRoles.includes(payload.role)) {
      return res.status(403).json({ error: "Not allowed for your role" });
    }

    try {
      if (!(await isStaffAccountActive(payload))) {
        return res.status(403).json({ error: DEACTIVATED_MESSAGE });
      }
    } catch (err) {
      console.error("Account status check failed:", err);
      return res.status(500).json({ error: "Could not verify account status" });
    }

    req.staff = payload;
    next();
  };
}

app.post("/auth/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }

  try {
    const result = await pool.query(`SELECT * FROM staff WHERE username = $1`, [username]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    if (user.active === false) {
      return res.status(403).json({ error: DEACTIVATED_MESSAGE });
    }

    // For a doctor login, pull specialization/qualification/photo from the
    // doctors table so the profile dropdown in the dashboard can show them.
    let doctorProfile = {};
    if (user.role === "doctor" && user.doctor_id) {
      const docResult = await pool.query(
        `SELECT specialization, qualification, photo_url FROM doctors WHERE id = $1`,
        [user.doctor_id]
      );
      if (docResult.rows[0]) doctorProfile = docResult.rows[0];
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, name: user.name, role: user.role, doctor_id: user.doctor_id },
      JWT_SECRET,
      { expiresIn: "12h" }
    );

    res.json({
      success: true,
      token,
      staff: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        doctor_id: user.doctor_id,
        ...doctorProfile,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});


// =========================================================
// CITIZEN AUTH — five hard-coded demo mobile numbers + OTP
// =========================================================
const CITIZEN_USERS = {
  "9876543210": "123456",
  "9876543211": "123456",
  "9876543212": "123456",
  "9876543213": "123456",
  "9876543214": "123456",
};

function requireCitizen(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Citizen login required" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.type !== "citizen" || !CITIZEN_USERS[payload.phone]) {
      return res.status(403).json({ error: "Citizen access required" });
    }
    req.citizen = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Citizen session expired, please log in again" });
  }
}

app.post("/citizen/request-otp", (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone || !CITIZEN_USERS[phone]) {
    return res.status(401).json({ error: "This mobile number is not registered for citizen access" });
  }
  res.json({ success: true, message: "OTP sent", demo: true });
});

app.post("/citizen/login", async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const otp = String(req.body.otp || "").trim();
  if (!phone || CITIZEN_USERS[phone] !== otp) {
    return res.status(401).json({ error: "Invalid mobile number or OTP" });
  }
  const token = jwt.sign({ type: "citizen", phone }, JWT_SECRET, { expiresIn: "12h" });

  // Pull the patient's name (if they've booked before) so the citizen
  // profile popover in the chat header can show more than just the phone.
  let name = null;
  try {
    const result = await pool.query(`SELECT name FROM patients WHERE phone = $1`, [phone]);
    name = result.rows[0]?.name || null;
  } catch (err) {
    console.error("Citizen login patient lookup error:", err);
  }

  res.json({ success: true, token, citizen: { phone, name } });
});

// =========================================================
// GEMINI AI
// =========================================================

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// Models are tried in this order. If one returns a temporary error
// (503 overloaded, 429 quota/rate limit, 500/502/504), the request is
// retried once on the same model and then falls through to the next model.
// Change the order/models from backend/.env without touching code:
//   GEMINI_MODELS=gemini-3.8-flash,gemini-3.5-flash,gemini-3.1-flash-lite
const GEMINI_MODELS = (
  process.env.GEMINI_MODELS ||
  "gemini-3.8-flash,gemini-3.5-flash,gemini-3.1-flash-lite"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const RETRYABLE_STATUSES = [429, 500, 502, 503, 504];

function getErrorStatus(err) {
  const direct = Number(err?.status || err?.code);
  if (RETRYABLE_STATUSES.includes(direct)) return direct;
  const fromMessage = String(err?.message || "").match(/\b(429|500|502|503|504)\b/);
  return fromMessage ? Number(fromMessage[1]) : direct || null;
}

// Drop-in replacement for ai.models.generateContent() — pass the same
// params but WITHOUT `model` (it is chosen here from GEMINI_MODELS).
async function generateWithFallback(params) {
  let lastErr;
  for (const model of GEMINI_MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await ai.models.generateContent({ ...params, model });
      } catch (err) {
        lastErr = err;
        const status = getErrorStatus(err);
        // 404 = this model name doesn't exist / is retired for this key.
        // Retrying is pointless, so skip straight to the next model.
        if (status === 404) {
          console.warn(`[gemini] ${model} not available (404), skipping to next model`);
          break;
        }
        if (!RETRYABLE_STATUSES.includes(status)) throw err; // not a temporary error
        console.warn(`[gemini] ${model} failed (${status}), attempt ${attempt + 1}/2`);
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

// =========================================================
// HEALTH CHECK
// =========================================================

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Hospital system backend running",
  });
});

// =========================================================
// GET /doctors
// =========================================================

app.get("/doctors", async (req, res, next) => {
  // Public callers (the citizen chatbot) only ever see active doctors.
  // Seeing inactive ones too (all=true) is an admin-only view.
  if (req.query.all === "true") {
    return requireAuth(["admin", "reception"])(req, res, next);
  }
  next();
}, async (req, res) => {
  const { all } = req.query;

  try {
    const result = await pool.query(`
      SELECT d.*, s.username AS login_username, s.password_display AS login_password
      FROM doctors d
      LEFT JOIN staff s ON s.doctor_id = d.id AND s.role = 'doctor'
      WHERE d.deleted_at IS NULL
      ${all === "true" ? "" : "AND d.active = true"}
      ORDER BY d.id
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("Doctors error:", err);

    res.status(500).json({
      error: "Failed to fetch doctors",
    });
  }
});

// =========================================================
// POST /doctors  (admin: add a doctor)
// =========================================================

app.post("/doctors", requireAuth(["admin"]), async (req, res) => {
  const { name, specialization, username, password } = req.body;

  if (!name || !String(username || "").trim() || !String(password || "").trim()) {
    return res.status(400).json({ error: "name, username and password are required" });
  }

  const cleanUsername = String(username).trim();
  const cleanPassword = String(password);
  if (cleanUsername.length < 3) {
    return res.status(400).json({ error: "username must be at least 3 characters" });
  }
  if (cleanPassword.length < 6) {
    return res.status(400).json({ error: "password must be at least 6 characters" });
  }

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `
        INSERT INTO doctors (name, specialization, active)
        VALUES ($1, $2, true)
        RETURNING *
        `,
        [name, specialization || null]
      );

      const doctor = result.rows[0];
      const passwordHash = await bcrypt.hash(cleanPassword, 10);

      await client.query(
        `
        INSERT INTO staff (username, password_hash, password_display, name, role, doctor_id)
        VALUES ($1, $2, $3, $4, 'doctor', $5)
        `,
        [cleanUsername, passwordHash, cleanPassword, doctor.name, doctor.id]
      );

      await client.query("COMMIT");
      res.json({
        success: true,
        doctor: { ...doctor, login_username: cleanUsername },
        login: { username: cleanUsername },
      });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Create doctor error:", err);
    if (err && err.code === "23505") {
      return res.status(409).json({ error: "Username is already in use" });
    }
    res.status(500).json({ error: "Failed to create doctor" });
  }
});

// =========================================================
// PUT /doctors/:id  (admin: edit / activate / deactivate)
// =========================================================

app.put("/doctors/:id", requireAuth(["admin"]), async (req, res) => {
  const { id } = req.params;
  const { name, specialization, active, username, password } = req.body;

  try {
    const existing = await pool.query(`SELECT * FROM doctors WHERE id = $1`, [id]);

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Doctor not found" });
    }

    const current = existing.rows[0];

    // An archived (deleted) doctor is read-only — restore them first.
    if (current.deleted_at) {
      return res.status(409).json({
        error: "This doctor is in Deleted Doctors. Restore them before editing.",
      });
    }

    const result = await pool.query(
      `
      UPDATE doctors
      SET name = $1, specialization = $2, active = $3
      WHERE id = $4
      RETURNING *
      `,
      [
        name ?? current.name,
        specialization ?? current.specialization,
        typeof active === "boolean" ? active : current.active,
        id,
      ]
    );

    const staffResult = await pool.query(
      `SELECT id, username, password_display FROM staff WHERE doctor_id = $1 AND role = 'doctor' LIMIT 1`,
      [id]
    );
    const staff = staffResult.rows[0];

    if (!staff) {
      return res.status(500).json({ error: "Doctor login account not found" });
    }

    const nextUsername = String(username ?? staff.username).trim();
    if (nextUsername.length < 3) {
      return res.status(400).json({ error: "username must be at least 3 characters" });
    }

    if (nextUsername !== staff.username) {
      const duplicate = await pool.query(
        `SELECT id FROM staff WHERE username = $1 AND id <> $2`,
        [nextUsername, staff.id]
      );
      if (duplicate.rows.length) {
        return res.status(409).json({ error: "Username is already in use" });
      }
    }

    await pool.query(
      `UPDATE staff SET username = $1, name = $2${password ? ", password_hash = $3, password_display = $4" : ""} WHERE id = $${password ? 5 : 3}`,
      password
        ? [nextUsername, result.rows[0].name, await bcrypt.hash(String(password), 10), String(password), staff.id]
        : [nextUsername, result.rows[0].name, staff.id]
    );

    res.json({ success: true, doctor: { ...result.rows[0], login_username: nextUsername, login_password: password ? String(password) : staff.password_display } });
  } catch (err) {
    console.error("Update doctor error:", err);
    res.status(500).json({ error: "Failed to update doctor" });
  }
});

// =========================================================
// DELETE /doctors/:id  (admin only) — SOFT delete / "archive"
//
// The doctor row is NOT dropped. We stamp deleted_at so every appointment,
// feedback and chat transcript linked to them survives (those rows are
// ON DELETE CASCADE, a real delete would wipe the whole history). The doctor
// disappears from every patient/reception/chatbot list, their login stops
// working, and their future *unbooked* slots are cleared so nobody can book
// them. Already-booked appointments are left alone so reception can still
// see and settle them. Admin can review or restore from "Deleted Doctors".
// =========================================================
app.delete("/doctors/:id", requireAuth(["admin"]), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid doctor id" });
  }

  const reason = String(req.body?.reason || "").trim().slice(0, 300) || null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const doctor = await client.query(
      `SELECT id, name, deleted_at FROM doctors WHERE id = $1`,
      [id]
    );
    if (!doctor.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Doctor not found" });
    }
    if (doctor.rows[0].deleted_at) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This doctor is already deleted" });
    }

    const counts = await client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM appointments WHERE doctor_id = $1) AS appointments,
         (SELECT COUNT(*)::int FROM slots WHERE doctor_id = $1) AS slots,
         (SELECT COUNT(*)::int FROM appointments
            WHERE doctor_id = $1 AND status = 'booked') AS upcoming`,
      [id]
    );

    // Free up the calendar: drop only slots nobody has booked.
    await client.query(
      `DELETE FROM slots WHERE doctor_id = $1 AND status = 'available'`,
      [id]
    );

    // Keep the login row (so restore brings back the same username/password)
    // but disable it.
    await client.query(
      `UPDATE staff SET active = false WHERE doctor_id = $1 AND role = 'doctor'`,
      [id]
    );

    const updated = await client.query(
      `UPDATE doctors
       SET active = false, deleted_at = NOW(), deleted_by = $2, delete_reason = $3
       WHERE id = $1
       RETURNING *`,
      [id, req.staff?.name || req.staff?.username || "admin", reason]
    );

    await client.query("COMMIT");
    res.json({
      success: true,
      archived: true,
      deleted: { ...updated.rows[0], ...counts.rows[0] },
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Delete doctor error:", err);
    res.status(500).json({ error: "Failed to delete doctor" });
  } finally {
    client.release();
  }
});

// =========================================================
// GET /doctors/deleted  (admin only)
//
// The "Deleted Doctors" list: every archived doctor plus a quick summary of
// the history kept for them (appointment counts, date range, avg rating).
// =========================================================
app.get("/doctors/deleted", requireAuth(["admin"]), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        d.id,
        d.name,
        d.specialization,
        d.qualification,
        d.deleted_at,
        d.deleted_by,
        d.delete_reason,
        s.username AS login_username,
        s.password_display AS login_password,
        (SELECT COUNT(*)::int FROM appointments a WHERE a.doctor_id = d.id) AS appointments,
        (SELECT COUNT(*)::int FROM appointments a
           WHERE a.doctor_id = d.id AND a.status = 'attended') AS attended,
        (SELECT COUNT(*)::int FROM appointments a
           WHERE a.doctor_id = d.id AND a.status = 'booked') AS upcoming,
        (SELECT COUNT(*)::int FROM slots sl WHERE sl.doctor_id = d.id) AS slots,
        (SELECT MIN(sl.date) FROM slots sl
           JOIN appointments a ON a.slot_id = sl.id
          WHERE a.doctor_id = d.id) AS first_appointment,
        (SELECT MAX(sl.date) FROM slots sl
           JOIN appointments a ON a.slot_id = sl.id
          WHERE a.doctor_id = d.id) AS last_appointment,
        (SELECT ROUND(AVG(f.rating)::numeric, 1) FROM feedback f
           JOIN appointments a ON a.id = f.appointment_id
          WHERE a.doctor_id = d.id) AS avg_rating,
        (SELECT COUNT(*)::int FROM feedback f
           JOIN appointments a ON a.id = f.appointment_id
          WHERE a.doctor_id = d.id) AS feedback_count
      FROM doctors d
      LEFT JOIN staff s ON s.doctor_id = d.id AND s.role = 'doctor'
      WHERE d.deleted_at IS NOT NULL
      ORDER BY d.deleted_at DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("Deleted doctors error:", err);
    res.status(500).json({ error: "Failed to fetch deleted doctors" });
  }
});

// =========================================================
// GET /doctors/:id/history  (admin only)
//
// Full appointment history for one doctor — works for active AND deleted
// doctors, which is the whole point of archiving instead of hard-deleting.
// =========================================================
app.get("/doctors/:id/history", requireAuth(["admin"]), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid doctor id" });
  }

  try {
    const doctorResult = await pool.query(
      `SELECT id, name, specialization, qualification, active, deleted_at, deleted_by, delete_reason
       FROM doctors WHERE id = $1`,
      [id]
    );
    if (!doctorResult.rows[0]) {
      return res.status(404).json({ error: "Doctor not found" });
    }

    const appointments = await pool.query(
      `
      SELECT
        a.id,
        a.status,
        a.chat_summary,
        a.booking_source,
        a.created_at,
        s.date,
        s.time,
        p.name AS patient_name,
        p.phone AS patient_phone,
        f.rating,
        f.comment
      FROM appointments a
      LEFT JOIN slots s ON s.id = a.slot_id
      LEFT JOIN patients p ON p.id = a.patient_id
      LEFT JOIN feedback f ON f.appointment_id = a.id
      WHERE a.doctor_id = $1
      ORDER BY s.date DESC NULLS LAST, s.time DESC NULLS LAST, a.id DESC
      `,
      [id]
    );

    res.json({
      doctor: doctorResult.rows[0],
      appointments: appointments.rows,
    });
  } catch (err) {
    console.error("Doctor history error:", err);
    res.status(500).json({ error: "Failed to fetch doctor history" });
  }
});

// =========================================================
// POST /doctors/:id/restore  (admin only)
//
// Undo an archive: the doctor comes back (inactive by default, so admin can
// add fresh slots before patients start booking), and their login works again.
// =========================================================
app.post("/doctors/:id/restore", requireAuth(["admin"]), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid doctor id" });
  }

  const activate = req.body?.activate !== false;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const doctor = await client.query(
      `SELECT id, name, deleted_at FROM doctors WHERE id = $1`,
      [id]
    );
    if (!doctor.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Doctor not found" });
    }
    if (!doctor.rows[0].deleted_at) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This doctor is not deleted" });
    }

    const updated = await client.query(
      `UPDATE doctors
       SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL, active = $2
       WHERE id = $1
       RETURNING *`,
      [id, activate]
    );

    // Their login row was kept on delete — just switch it back on. If it was
    // removed by an older hard-delete, recreate a default one.
    const staffRow = await client.query(
      `UPDATE staff SET active = true WHERE doctor_id = $1 AND role = 'doctor' RETURNING id`,
      [id]
    );
    if (!staffRow.rows.length) {
      await client.query(
        `INSERT INTO staff (username, password_hash, password_display, name, role, doctor_id)
         VALUES ($1, $2, $3, $4, 'doctor', $5)
         ON CONFLICT (username) DO NOTHING`,
        [
          `dr${id}`,
          await bcrypt.hash("doctor123", 10),
          "doctor123",
          updated.rows[0].name,
          id,
        ]
      );
    }

    await client.query("COMMIT");
    res.json({ success: true, doctor: updated.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Restore doctor error:", err);
    res.status(500).json({ error: "Failed to restore doctor" });
  } finally {
    client.release();
  }
});

// =========================================================
// Reception logins (admin only): list, edit username/name/password,
// activate / deactivate.
// =========================================================

app.get("/staff/reception", requireAuth(["admin"]), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, name, active, password_display AS login_password
       FROM staff WHERE role = 'reception' ORDER BY id`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("List reception error:", err);
    res.status(500).json({ error: "Failed to load reception accounts" });
  }
});

app.put("/staff/reception/:id", requireAuth(["admin"]), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid reception account id" });
  }
  const { username, name, password, active } = req.body;

  try {
    const existing = await pool.query(
      `SELECT * FROM staff WHERE id = $1 AND role = 'reception'`,
      [id]
    );
    const current = existing.rows[0];
    if (!current) {
      return res.status(404).json({ error: "Reception account not found" });
    }

    const nextUsername = String(username ?? current.username).trim();
    if (nextUsername.length < 3) {
      return res.status(400).json({ error: "username must be at least 3 characters" });
    }
    if (nextUsername !== current.username) {
      const duplicate = await pool.query(
        `SELECT id FROM staff WHERE username = $1 AND id <> $2`,
        [nextUsername, id]
      );
      if (duplicate.rows.length) {
        return res.status(409).json({ error: "Username is already in use" });
      }
    }

    const nextName = String(name ?? current.name).trim() || current.name;
    const nextActive = typeof active === "boolean" ? active : current.active !== false;

    const newPassword = password === undefined || password === null ? "" : String(password);
    if (newPassword && newPassword.length < 6) {
      return res.status(400).json({ error: "password must be at least 6 characters" });
    }

    const result = newPassword
      ? await pool.query(
          `UPDATE staff SET username = $1, name = $2, active = $3, password_hash = $4, password_display = $5
           WHERE id = $6 RETURNING id, username, name, active, password_display AS login_password`,
          [nextUsername, nextName, nextActive, await bcrypt.hash(newPassword, 10), newPassword, id]
        )
      : await pool.query(
          `UPDATE staff SET username = $1, name = $2, active = $3
           WHERE id = $4 RETURNING id, username, name, active, password_display AS login_password`,
          [nextUsername, nextName, nextActive, id]
        );

    res.json({ success: true, reception: result.rows[0] });
  } catch (err) {
    console.error("Update reception error:", err);
    res.status(500).json({ error: "Failed to update reception account" });
  }
});

// =========================================================
// GET /slots
//
// /slots
// /slots?doctor_id=1
// /slots?doctor_id=1&date=2026-08-29
// =========================================================

app.get("/slots", async (req, res, next) => {
  // Public callers only see open slots. Admin and reception may inspect booked slots.
  if (req.query.all === "true") {
    return requireAuth(["admin", "reception"])(req, res, next);
  }
  next();
}, async (req, res) => {
  const { doctor_id, date, all } = req.query;

  try {
    let query = `
      SELECT
        s.id,
        s.doctor_id,
        d.name AS doctor_name,
        d.specialization,
        s.date,
        s.time,
        s.status
      FROM slots s
      JOIN doctors d
        ON s.doctor_id = d.id
      WHERE d.deleted_at IS NULL
        ${
          all === "true"
            ? ""
            : `AND s.status = 'available' AND d.active = true
               AND (
                 s.date > (NOW() AT TIME ZONE 'Asia/Kolkata')::date
                 OR (
                   s.date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
                   AND s.time > (NOW() AT TIME ZONE 'Asia/Kolkata')::time
                 )
               )`
        }
    `;

    const params = [];

    if (doctor_id) {
      params.push(doctor_id);
      query += ` AND s.doctor_id = $${params.length}`;
    }

    if (date) {
      params.push(date);
      query += ` AND s.date = $${params.length}`;
    }

    query += `
      ORDER BY s.date, s.time
    `;

    const result = await pool.query(query, params);

    res.json(result.rows);
  } catch (err) {
    console.error("Slots error:", err);

    res.status(500).json({
      error: "Failed to fetch slots",
    });
  }
});

// =========================================================
// POST /slots  (admin: add one or more slots)
// body: { doctor_id, date, time } OR { doctor_id, date, times: ["10:00", ...] }
// =========================================================

app.post("/slots", requireAuth(["admin"]), async (req, res) => {
  const { doctor_id, date, time, times } = req.body;
  const timeList = Array.isArray(times) && times.length ? times : time ? [time] : [];

  if (!doctor_id || !date || timeList.length === 0) {
    return res.status(400).json({ error: "doctor_id, date and time(s) are required" });
  }

  try {
    const inserted = [];

    for (const t of timeList) {
      const result = await pool.query(
        `
        INSERT INTO slots (doctor_id, date, time, status)
        VALUES ($1, $2, $3, 'available')
        ON CONFLICT (doctor_id, date, time) DO NOTHING
        RETURNING *
        `,
        [doctor_id, date, t]
      );
      if (result.rows[0]) inserted.push(result.rows[0]);
    }

    res.json({ success: true, slots: inserted });
  } catch (err) {
    console.error("Create slot error:", err);
    res.status(500).json({ error: "Failed to create slot(s)" });
  }
});

// =========================================================
// DELETE /slots/:id  (admin: remove an unbooked slot)
// =========================================================

app.delete("/slots/:id", requireAuth(["admin"]), async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `
      DELETE FROM slots
      WHERE id = $1 AND status = 'available'
      RETURNING *
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(409).json({ error: "Only unbooked slots can be removed" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Delete slot error:", err);
    res.status(500).json({ error: "Failed to delete slot" });
  }
});

// =========================================================
// GET /reception/calendar?date=YYYY-MM-DD&search=...
// Reception can see every active doctor's slots for a date.
// =========================================================

app.get("/reception/calendar", requireAuth(["reception", "admin"]), async (req, res) => {
  const date = String(req.query.date || "").trim();
  const search = String(req.query.search || "").trim();
  if (!date) return res.status(400).json({ error: "date is required" });

  try {
    const result = await pool.query(`
      SELECT s.id, s.doctor_id, d.name AS doctor_name, d.specialization,
             s.date, s.time, s.status,
             a.id AS appointment_id, a.status AS appointment_status,
             p.name AS patient_name, p.phone
      FROM slots s
      JOIN doctors d ON d.id = s.doctor_id
      LEFT JOIN appointments a ON a.slot_id = s.id
      LEFT JOIN patients p ON p.id = a.patient_id
      WHERE s.date = $1
        AND d.active = true
        AND (
          $2 = '' OR LOWER(d.name) LIKE LOWER('%' || $2 || '%')
          OR LOWER(COALESCE(d.specialization, '')) LIKE LOWER('%' || $2 || '%')
        )
      ORDER BY d.name, s.time
    `, [date, search]);
    res.json(result.rows);
  } catch (err) {
    console.error("Reception calendar error:", err);
    res.status(500).json({ error: "Failed to load reception calendar" });
  }
});

// =========================================================
// GET /patients/history?phone=...
// Identify an existing patient by mobile number and return
// their previous appointment history.
//
// Access control (this used to be a public, unauthenticated route — fixed
// so patient data can't leak):
//   - A citizen may only look up their OWN phone number (used by the
//     booking chat to show "welcome back" history).
//   - Reception/admin may look up any patient (front-desk needs the full
//     picture).
//   - A doctor may look up any patient BY NUMBER, but only ever sees the
//     visits that belong to THEM — other doctors' consultations with that
//     same patient are hidden.
// =========================================================

app.get("/patients/history", async (req, res) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Login required" });

  let requester;
  try {
    requester = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: "Session expired, please log in again" });
  }

  const isCitizen = requester.type === "citizen";
  const isStaff = !isCitizen && ["doctor", "reception", "admin"].includes(requester.role);
  if (!isCitizen && !isStaff) {
    return res.status(403).json({ error: "Not allowed" });
  }

  try {
    if (isStaff && !(await isStaffAccountActive(requester))) {
      return res.status(403).json({ error: DEACTIVATED_MESSAGE });
    }
  } catch (err) {
    console.error("Account status check failed:", err);
    return res.status(500).json({ error: "Could not verify account status" });
  }

  const phone = normalizePhone(req.query.phone);

  // No phone number given: staff (not citizens) get the full bookings list
  // to date instead of a single patient's history — this is what the
  // Patients page shows before anyone searches. A doctor only ever sees
  // their own bookings here; reception/admin see everyone's.
  if (!phone) {
    if (!isStaff) {
      return res.status(400).json({ error: "Valid mobile number is required" });
    }

    try {
      const isDoctorScoped = requester.role === "doctor";
      if (isDoctorScoped && !requester.doctor_id) {
        return res.status(403).json({ error: "Doctor account is not linked to a doctor profile" });
      }

      const listResult = await pool.query(
        `
        SELECT
          a.id AS appointment_id,
          a.status,
          a.chat_summary,
          a.chat_transcript,
          a.created_at,
          a.booking_source,
          p.id AS patient_id,
          p.name AS patient_name,
          p.phone,
          d.id AS doctor_id,
          d.name AS doctor_name,
          d.specialization,
          s.date,
          s.time,
          f.rating AS feedback_rating
        FROM appointments a
        JOIN patients p ON p.id = a.patient_id
        JOIN doctors d ON d.id = a.doctor_id
        LEFT JOIN slots s ON s.id = a.slot_id
        LEFT JOIN feedback f ON f.appointment_id = a.id
        ${isDoctorScoped ? "WHERE a.doctor_id = $1" : ""}
        ORDER BY COALESCE(s.date, a.created_at::date) DESC, COALESCE(s.time, '00:00') DESC
        LIMIT 500
      `,
        isDoctorScoped ? [requester.doctor_id] : []
      );

      const bookings = listResult.rows.map((r) => ({
        appointment_id: r.appointment_id,
        patient_id: r.patient_id,
        patient_name: r.patient_name,
        phone: r.phone,
        doctor_id: r.doctor_id,
        doctor_name: r.doctor_name,
        specialization: r.specialization,
        date: r.date,
        time: r.time,
        status: r.status,
        chat_summary: resolveComplaint(r.chat_summary, r.chat_transcript),
        // Not citizen-only: staff (doctor/admin/reception) get the full
        // raw conversation so they can review exactly what the patient
        // told the chatbot. Citizens looking up their own history see
        // their own chat back too, which is fine — it's their data.
        chat_transcript: r.chat_transcript || null,
        feedback_rating: r.feedback_rating,
        booking_source: r.booking_source,
      }));

      return res.json({ found: bookings.length > 0, mode: "list", bookings });
    } catch (err) {
      console.error("Patient bookings list error:", err);
      return res.status(500).json({ error: "Failed to fetch bookings" });
    }
  }

  // Citizens can only ever pull up their own history, never anyone else's.
  if (isCitizen && normalizePhone(requester.phone) !== phone) {
    return res.status(403).json({ error: "You can only view your own history" });
  }

  try {
    const result = await pool.query(`
      SELECT
        p.id AS patient_id,
        p.name AS patient_name,
        p.phone,
        a.id AS appointment_id,
        a.status,
        a.chat_summary,
        a.chat_transcript,
        a.created_at,
        a.booking_source,
        d.id AS doctor_id,
        d.name AS doctor_name,
        d.specialization,
        s.date,
        s.time,
        f.rating AS feedback_rating
      FROM patients p
      LEFT JOIN appointments a ON a.patient_id = p.id
      LEFT JOIN doctors d ON d.id = a.doctor_id
      LEFT JOIN slots s ON s.id = a.slot_id
      LEFT JOIN feedback f ON f.appointment_id = a.id
      WHERE RIGHT(regexp_replace(p.phone, '\\D', '', 'g'), 10) = $1
      ORDER BY COALESCE(s.date, a.created_at::date) DESC, COALESCE(s.time, '00:00') DESC
    `, [phone]);

    if (result.rows.length === 0) {
      return res.json({ found: false, patient: null, history: [] });
    }

    const first = result.rows[0];
    let history = result.rows
      .filter((r) => r.appointment_id)
      .map((r) => ({
        appointment_id: r.appointment_id,
        doctor_id: r.doctor_id,
        doctor_name: r.doctor_name,
        specialization: r.specialization,
        date: r.date,
        time: r.time,
        status: r.status,
        chat_summary: resolveComplaint(r.chat_summary, r.chat_transcript),
        chat_transcript: r.chat_transcript || null,
        feedback_rating: r.feedback_rating,
        booking_source: r.booking_source,
      }));

    // A doctor only gets to see their own consultations with this patient —
    // never what the patient discussed with a different doctor.
    if (requester.role === "doctor") {
      history = history.filter((h) => Number(h.doctor_id) === Number(requester.doctor_id));
    }

    res.json({
      found: true,
      patient: { id: first.patient_id, name: first.patient_name, phone: first.phone },
      history,
    });
  } catch (err) {
    console.error("Patient history error:", err);
    res.status(500).json({ error: "Failed to fetch patient history" });
  }
});

// =========================================================
// POST /book
// =========================================================

app.post("/book", requireCitizen, async (req, res) => {
  const {
    patient_name,
    doctor_id,
    slot_id,
    chat_summary,
  } = req.body;
  const phone = req.citizen.phone;

  // Keep the legacy/direct booking endpoint consistent with AI booking:
  // if the caller supplies the patient's complaint, store only the medical
  // portion so doctor/reception history never shows booking chatter.
  const cleanedChatSummary = resolveComplaint(chat_summary, null);

  if (
    !patient_name ||
    !phone ||
    !doctor_id ||
    !slot_id
  ) {
    return res.status(400).json({
      error: "Missing required fields",
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Check slot
    const slotCheck = await client.query(
      `
      SELECT
        s.*,
        d.name AS doctor_name,
        d.specialization
      FROM slots s
      JOIN doctors d
        ON s.doctor_id = d.id
      WHERE s.id = $1
        AND s.doctor_id = $2
        AND s.status = 'available'
        AND d.active = true
        AND (
          s.date > (NOW() AT TIME ZONE 'Asia/Kolkata')::date
          OR (
            s.date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
            AND s.time > (NOW() AT TIME ZONE 'Asia/Kolkata')::time
          )
        )
      FOR UPDATE
      `,
      [slot_id, doctor_id]
    );

    if (slotCheck.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        error: "Slot no longer available",
      });
    }

    // Find patient
    let patientResult = await client.query(
      `
      SELECT *
      FROM patients
      WHERE RIGHT(regexp_replace(phone, '\\D', '', 'g'), 10) = $1
      `,
      [phone]
    );

    let patient;

    if (patientResult.rows.length === 0) {
      const insertPatient = await client.query(
        `
        INSERT INTO patients
          (name, phone)
        VALUES
          ($1, $2)
        RETURNING *
        `,
        [patient_name, phone]
      );

      patient = insertPatient.rows[0];
    } else {
      patient = patientResult.rows[0];

      // Update name if changed
      if (patient.name !== patient_name) {
        const updatePatient = await client.query(
          `
          UPDATE patients
          SET name = $1
          WHERE id = $2
          RETURNING *
          `,
          [patient_name, patient.id]
        );

        patient = updatePatient.rows[0];
      }
    }

    // Create appointment
    const appointmentResult = await client.query(
      `
      INSERT INTO appointments
        (patient_id, doctor_id, slot_id, status, chat_summary, booking_source)
      VALUES
        ($1, $2, $3, 'booked', $4, 'chatbot')
      RETURNING *
      `,
      [
        patient.id,
        doctor_id,
        slot_id,
        cleanedChatSummary,
      ]
    );

    // Mark slot booked
    await client.query(
      `
      UPDATE slots
      SET status = 'booked'
      WHERE id = $1
      `,
      [slot_id]
    );

    await client.query("COMMIT");

    const slot = slotCheck.rows[0];

    // WhatsApp confirmation — Dr name, date, patient name, time (in that
    // order, matching the confirmation template's variable slots).
    sendWhatsAppMessage(
      phone,
      "appointment_confirmation",
      [
        slot.doctor_name,
        String(slot.date),
        patient_name,
        String(slot.time),
      ]
    ).catch((e) => {
      console.error(
        "WhatsApp confirmation failed:",
        e
      );
    });

    res.json({
      success: true,

      appointment: appointmentResult.rows[0],

      doctor: {
        id: doctor_id,
        name: slot.doctor_name,
        specialization: slot.specialization,
      },

      slot: {
        id: slot.id,
        date: slot.date,
        time: slot.time,
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");

    console.error("Booking error:", err);

    res.status(500).json({
      error: "Booking failed",
    });
  } finally {
    client.release();
  }
});

// =========================================================
// GET /appointments
// =========================================================

app.get("/appointments", requireAuth(["doctor", "reception", "admin"]), async (req, res) => {
  const { date, range } = req.query;

  try {
    let query = `
      SELECT
        a.id,
        a.status,
        a.chat_summary,
        a.chat_transcript,
        a.booking_source,

        p.id AS patient_id,
        p.name AS patient_name,
        p.phone,

        d.id AS doctor_id,
        d.name AS doctor_name,
        d.specialization,

        s.id AS slot_id,
        s.date,
        s.time

      FROM appointments a
      JOIN patients p ON a.patient_id = p.id
      JOIN doctors d ON a.doctor_id = d.id
      JOIN slots s ON a.slot_id = s.id
    `;

    const params = [];
    const where = [];

    if (date) {
      params.push(date);
      where.push(`s.date = $${params.length}`);
    } else if (range === "today") {
      where.push(`s.date = CURRENT_DATE`);
    } else if (range === "upcoming") {
      where.push(`s.date > CURRENT_DATE`);
    } else if (range === "past") {
      where.push(`s.date < CURRENT_DATE`);
    }

    // A doctor can ONLY see their own appointments.
    if (req.staff.role === "doctor") {
      if (!req.staff.doctor_id) {
        return res.status(403).json({ error: "Doctor account is not linked to a doctor profile" });
      }
      params.push(req.staff.doctor_id);
      where.push(`a.doctor_id = $${params.length}`);
    }

    if (where.length) query += ` WHERE ${where.join(" AND ")}`;

    // Upcoming appointments read soonest-first; today/past read most-recent
    // first so the latest activity is at the top.
    query += range === "upcoming" ? ` ORDER BY s.date ASC, s.time ASC` : ` ORDER BY s.date DESC, s.time DESC`;

    const result = await pool.query(query, params);
    res.json(result.rows.map(row => ({
      ...row,
      chat_summary: resolveComplaint(row.chat_summary, row.chat_transcript),
      chat_transcript: row.chat_transcript || null,
    })));
  } catch (err) {
    console.error("Appointments error:", err);
    res.status(500).json({ error: "Failed to fetch appointments" });
  }
});

// =========================================================
// POST /appointments/:id/status
// =========================================================

app.post(
  "/appointments/:id/status",
  requireAuth(["doctor", "reception", "admin"]),
  async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!["arrived", "attended", "no_show"].includes(status)) {
      return res.status(400).json({
        error: "status must be arrived, attended or no_show",
      });
    }

    try {
      if (req.staff.role === "doctor") {
        const ownership = await pool.query(
          `SELECT 1 FROM appointments WHERE id = $1 AND doctor_id = $2`,
          [id, req.staff.doctor_id]
        );
        if (ownership.rows.length === 0) {
          return res.status(403).json({ error: "This appointment does not belong to your patients" });
        }
      }

      const result = await pool.query(
        `
        UPDATE appointments
        SET status = $1
        WHERE id = $2
        RETURNING *
        `,
        [status, id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "Appointment not found",
        });
      }

      // Get patient details
      const infoResult = await pool.query(
        `
        SELECT
          p.name,
          p.phone
        FROM appointments a
        JOIN patients p
          ON a.patient_id = p.id
        WHERE a.id = $1
        `,
        [id]
      );

      if (infoResult.rows.length > 0) {
        const {
          name,
          phone,
        } = infoResult.rows[0];

        // No-show
        if (status === "no_show") {
          sendWhatsAppMessage(
            phone,
            "no_show_rebook",
            [name]
          ).catch((e) => {
            console.error(
              "No-show WhatsApp failed:",
              e
            );
          });
        }

        // Attended
        if (status === "attended") {
          sendWhatsAppMessage(
            phone,
            "feedback_request",
            [name]
          ).catch((e) => {
            console.error(
              "Feedback WhatsApp failed:",
              e
            );
          });
        }
      }

      res.json({
        success: true,
        appointment: result.rows[0],
      });
    } catch (err) {
      console.error(
        "Status update error:",
        err
      );

      res.status(500).json({
        error:
          "Failed to update status",
      });
    }
  }
);

// =========================================================
// POST /manual-appointments
// Reception/admin can enter an appointment for a patient who walked in
// or called the front desk instead of using the chatbot.
// =========================================================
app.post("/manual-appointments", requireAuth(["reception", "admin"]), async (req, res) => {
  const { patient_name, phone, doctor_id, slot_id, chat_summary } = req.body;
  const cleanName = String(patient_name || "").trim();
  const cleanPhone = normalizePhone(phone);
  const doctorId = Number(doctor_id);
  const slotId = Number(slot_id);
  const complaint = resolveComplaint(chat_summary, null);

  if (!cleanName || cleanPhone.length !== 10 || !doctorId || !slotId) {
    return res.status(400).json({ error: "Patient name, valid 10-digit mobile, doctor and appointment time are required." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const slotCheck = await client.query(
      `SELECT s.*, d.name AS doctor_name, d.specialization
       FROM slots s
       JOIN doctors d ON d.id = s.doctor_id
       WHERE s.id = $1
         AND s.doctor_id = $2
         AND s.status = 'available'
         AND d.active = true
         AND (
           s.date > (NOW() AT TIME ZONE 'Asia/Kolkata')::date
           OR (s.date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
               AND s.time > (NOW() AT TIME ZONE 'Asia/Kolkata')::time)
         )
       FOR UPDATE`,
      [slotId, doctorId]
    );

    if (!slotCheck.rows.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This appointment time is no longer available." });
    }

    let patientResult = await client.query(
      `SELECT * FROM patients WHERE RIGHT(regexp_replace(phone, '\\D', '', 'g'), 10) = $1`,
      [cleanPhone]
    );
    let patient;

    if (!patientResult.rows.length) {
      const inserted = await client.query(
        `INSERT INTO patients (name, phone) VALUES ($1, $2) RETURNING *`,
        [cleanName, cleanPhone]
      );
      patient = inserted.rows[0];
    } else {
      patient = patientResult.rows[0];
      if (patient.name !== cleanName) {
        const updated = await client.query(
          `UPDATE patients SET name = $1 WHERE id = $2 RETURNING *`,
          [cleanName, patient.id]
        );
        patient = updated.rows[0];
      }
    }

    const appointmentResult = await client.query(
      `INSERT INTO appointments
        (patient_id, doctor_id, slot_id, status, chat_summary, booking_source)
       VALUES ($1, $2, $3, 'booked', $4, 'manual')
       RETURNING *`,
      [patient.id, doctorId, slotId, complaint || null]
    );

    await client.query(`UPDATE slots SET status = 'booked' WHERE id = $1`, [slotId]);
    await client.query("COMMIT");

    const slot = slotCheck.rows[0];
    sendWhatsAppMessage(
      cleanPhone,
      "appointment_confirmation",
      [slot.doctor_name, String(slot.date), cleanName, String(slot.time)]
    ).catch((e) => console.error("Manual booking WhatsApp failed:", e));

    res.json({
      success: true,
      appointment: appointmentResult.rows[0],
      patient,
      doctor: { id: doctorId, name: slot.doctor_name, specialization: slot.specialization },
      slot: { id: slot.id, date: slot.date, time: slot.time },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Manual appointment error:", err);
    res.status(500).json({ error: "Failed to create manual appointment" });
  } finally {
    client.release();
  }
});

// =========================================================
// POST /feedback
// =========================================================

app.post("/feedback", requireCitizen, async (req, res) => {
  const {
    appointment_id,
    rating,
    comment,
  } = req.body;

  if (!appointment_id || !rating) {
    return res.status(400).json({
      error:
        "appointment_id and rating are required",
    });
  }

  if (
    Number(rating) < 1 ||
    Number(rating) > 5
  ) {
    return res.status(400).json({
      error:
        "rating must be between 1 and 5",
    });
  }

  try {
    const owner = await pool.query(`
      SELECT 1
      FROM appointments a
      JOIN patients p ON p.id = a.patient_id
      WHERE a.id = $1
        AND RIGHT(regexp_replace(p.phone, '\\D', '', 'g'), 10) = $2
    `, [appointment_id, req.citizen.phone]);
    if (owner.rows.length === 0) {
      return res.status(403).json({ error: "You can only review your own appointment" });
    }

    const result = await pool.query(
      `
      INSERT INTO feedback
        (appointment_id, rating, comment)
      VALUES
        ($1, $2, $3)
      ON CONFLICT (appointment_id)
      DO UPDATE SET
        rating = EXCLUDED.rating,
        comment = EXCLUDED.comment,
        created_at = NOW()
      RETURNING *
      `,
      [
        appointment_id,
        rating,
        comment || null,
      ]
    );

    res.json({
      success: true,
      feedback: result.rows[0],
    });
  } catch (err) {
    console.error(
      "Feedback error:",
      err
    );

    res.status(500).json({
      error: "Failed to save feedback",
    });
  }
});

// =========================================================
// GET /feedback  (admin: list all feedback)
// =========================================================

app.get("/feedback", requireAuth(["admin"]), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        f.id,
        f.rating,
        f.comment,
        f.created_at,
        a.id AS appointment_id,
        p.name AS patient_name,
        d.name AS doctor_name,
        d.specialization
      FROM feedback f
      JOIN appointments a ON f.appointment_id = a.id
      JOIN patients p ON a.patient_id = p.id
      JOIN doctors d ON a.doctor_id = d.id
      ORDER BY f.created_at DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("Feedback list error:", err);
    res.status(500).json({ error: "Failed to fetch feedback" });
  }
});

// =========================================================
// GET /stats/summary  (dashboard overview numbers)
// =========================================================

app.get("/stats/summary", requireAuth(["doctor", "reception", "admin"]), async (req, res) => {
  try {
    // A doctor only ever sees numbers scoped to their own consultations;
    // reception/admin keep seeing the hospital-wide totals.
    const isDoctorScoped = req.staff.role === "doctor";
    if (isDoctorScoped && !req.staff.doctor_id) {
      return res.status(403).json({ error: "Doctor account is not linked to a doctor profile" });
    }
    const doctorId = req.staff.doctor_id;

    const [today, doctors, rating, statuses] = await Promise.all([
      pool.query(
        `
        SELECT COUNT(*)::int AS count
        FROM appointments a
        JOIN slots s ON a.slot_id = s.id
        WHERE s.date = CURRENT_DATE
          AND a.status IN ('booked', 'arrived')
        ${isDoctorScoped ? "AND a.doctor_id = $1" : ""}
      `,
        isDoctorScoped ? [doctorId] : []
      ),
      // "Active doctors" stays hospital-wide even for a doctor's own view —
      // it's a hospital stat, not a per-doctor one.
      pool.query(`SELECT COUNT(*)::int AS count FROM doctors WHERE active = true`),
      pool.query(
        `
        SELECT COALESCE(AVG(f.rating), 0)::float AS avg
        FROM feedback f
        ${isDoctorScoped ? "JOIN appointments a ON a.id = f.appointment_id WHERE a.doctor_id = $1" : ""}
      `,
        isDoctorScoped ? [doctorId] : []
      ),
      pool.query(
        `
        SELECT status, COUNT(*)::int AS count
        FROM appointments
        ${isDoctorScoped ? "WHERE doctor_id = $1" : ""}
        GROUP BY status
      `,
        isDoctorScoped ? [doctorId] : []
      ),
    ]);

    const statusCounts = { booked: 0, attended: 0, no_show: 0 };
    statuses.rows.forEach((row) => {
      statusCounts[row.status] = row.count;
    });

    res.json({
      today_appointments: today.rows[0].count,
      active_doctors: doctors.rows[0].count,
      avg_rating: Math.round(rating.rows[0].avg * 10) / 10,
      ...statusCounts,
      total_appointments: statusCounts.booked + statusCounts.attended + statusCounts.no_show,
    });
  } catch (err) {
    console.error("Stats error:", err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// =========================================================
// Natural-language time helper for conversational slot selection.
// Examples: "2:30", "2.30 pm", "14:30", "2 30 baje".
// =========================================================
function parseRequestedTime(text) {
  const value = String(text || "").toLowerCase();
  const match = value.match(/\b(\d{1,2})(?:\s*[:.]\s*(\d{2})|\s+(\d{2}))?\s*(am|pm)?\b/);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2] ?? match[3] ?? 0);
  const meridiem = match[4];

  if (minute > 59) return null;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  // No am/pm given (e.g. "3 baje", "3:30 ho jaye") — patients almost never
  // mean the middle of the night when booking a hospital visit, so treat an
  // ambiguous 1-7 as afternoon/evening (PM). Without this, "3:30" parsed as
  // literal 03:30 was always earlier than every real (afternoon) slot, so
  // the "nearest slot at/after requested time" logic kept matching the
  // doctor's very FIRST slot no matter what time the patient actually asked
  // for — e.g. asking for 3:30 PM kept proposing 2:30 PM instead.
  if (!meridiem && hour >= 1 && hour <= 7) hour += 12;
  if (hour > 23) return null;

  // Avoid treating ordinary numbers (patient age, appointment IDs, etc.) as time.
  const looksLikeTime = /\d\s*(?::|\.|\s+\d{2}\b)|\b\d{1,2}\s*(am|pm)\b|\b\d{1,2}\s*baje\b|\b\d{1,2}\s*o'?clock\b/.test(value);
  return looksLikeTime ? (hour * 60 + minute) : null;
}

function slotMinutes(timeValue) {
  const text = String(timeValue || "");
  const m = text.match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function formatChatTime(timeValue) {
  const text = String(timeValue || "").slice(0, 8);
  const m = text.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return text;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const suffix = hour >= 12 ? "PM" : "AM";
  hour = hour % 12 || 12;
  return `${hour}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function pickNearestSlotAfterTime(slots, doctorId, requestedMinutes) {
  if (!doctorId || requestedMinutes == null) return null;
  const doctorSlots = slots
    .filter((slot) => Number(slot.doctor_id) === Number(doctorId))
    .map((slot) => ({ slot, minutes: slotMinutes(slot.time) }))
    .filter((x) => x.minutes != null)
    .sort((a, b) => String(a.slot.date).localeCompare(String(b.slot.date)) || a.minutes - b.minutes);

  // Prefer the earliest slot at/after the patient's arrival time.
  const sameOrLater = doctorSlots.find((x) => x.minutes >= requestedMinutes);
  if (sameOrLater) return sameOrLater.slot;

  // If today's window has passed, use the first available future slot for that doctor.
  return doctorSlots[0]?.slot || null;
}

function pickNearestSlotAfterDoctorIds(slots, doctorIds, requestedMinutes) {
  if (!Array.isArray(doctorIds) || doctorIds.length === 0 || requestedMinutes == null) return null;
  const ids = new Set(doctorIds.map(Number));
  const candidates = slots
    .filter((slot) => ids.has(Number(slot.doctor_id)))
    .map((slot) => ({ slot, minutes: slotMinutes(slot.time) }))
    .filter((x) => x.minutes != null)
    .sort((a, b) => String(a.slot.date).localeCompare(String(b.slot.date)) || a.minutes - b.minutes);
  return candidates.find((x) => x.minutes >= requestedMinutes)?.slot || candidates[0]?.slot || null;
}

// =========================================================
// POST /ai/chat
//
// AI appointment assistant
// =========================================================

app.post("/ai/chat", requireCitizen, async (req, res) => {
  const {
    message,
    history = [],
    booking: incomingBooking = {},
    // True when this "message" was generated by a UI button (e.g. the
    // doctor quick-pick card sends a canned "Mujhe Dr. X ke saath
    // appointment chahiye" string) rather than actually typed by the
    // patient. Used below to stop these canned strings from being
    // mistaken for the patient switching language mid-conversation.
    quick_action: quickAction = false,
    // Sent only by the final "confirm your details" card in the chat UI
    // (re-typed full name + mobile number), right before an appointment
    // is actually created. Booking is NEVER finalized from a plain typed
    // "yes"/"haan" — see the CONFIRM-DETAILS GATE below.
    confirm_details: confirmDetails = null,
  } = req.body;

  const booking = { ...incomingBooking, phone: req.citizen.phone };

  // The confirm-details submission doesn't carry a free-text "message" —
  // give it a stand-in so the rest of the handler (which reasons about
  // `message`) still has something sane to work with.
  const effectiveMessage = confirmDetails ? "Booking confirm kar rahe hain." : message;

  let confirmedName = "";
  let confirmedPhone = "";
  if (confirmDetails) {
    confirmedName = String(confirmDetails.name || "").trim();
    confirmedPhone = String(confirmDetails.phone || "").replace(/\D/g, "").slice(-10);
    if (!confirmedName || confirmedPhone.length !== 10) {
      return res.status(400).json({
        error: "Please enter your full name and a valid 10-digit mobile number to confirm.",
      });
    }
  }

  if (
    !confirmDetails &&
    (!message ||
    typeof message !== "string" ||
    !message.trim())
  ) {
    return res.status(400).json({
      error: "Message is required",
    });
  }

  try {
    // =====================================================
    // GET DOCTORS
    // =====================================================

    const doctorsResult = await pool.query(`
      SELECT
        id,
        name,
        specialization
      FROM doctors
      WHERE active = true
      ORDER BY id
    `);

    const doctors = doctorsResult.rows;

    // =====================================================
    // GET AVAILABLE SLOTS
    // =====================================================

    const slotsResult = await pool.query(`
      SELECT
        s.id,
        s.doctor_id,
        d.name AS doctor_name,
        d.specialization,
        s.date,
        s.time
      FROM slots s
      JOIN doctors d
        ON s.doctor_id = d.id
      WHERE s.status = 'available'
        AND d.active = true
        AND (
          s.date > (NOW() AT TIME ZONE 'Asia/Kolkata')::date
          OR (
            s.date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
            AND s.time > (NOW() AT TIME ZONE 'Asia/Kolkata')::time
          )
        )
      ORDER BY s.date, s.time
    `);

    const slots = slotsResult.rows;

    // A slot the assistant proposed in an EARLIER turn (booking.pending_slot_id)
    // can go stale between turns — its time can simply pass, or someone else
    // can book it — and REAL AVAILABLE SLOTS above will then no longer contain
    // it. Catch that BEFORE building the system prompt below: otherwise the
    // model still sees the old pending_slot_id/doctor context from CURRENT
    // BOOKING and, for a plain follow-up like "which date?", tends to just
    // repeat the now-expired time straight from the chat history instead of
    // re-checking it against REAL AVAILABLE SLOTS — which is exactly how an
    // already-passed slot kept getting re-confirmed to the patient.
    let expiredPendingSlot = false;
    if (booking.pending_slot_id) {
      const stillAvailable = slots.some(
        (s) => Number(s.id) === Number(booking.pending_slot_id)
      );
      if (!stillAvailable) {
        expiredPendingSlot = true;
        booking.pending_slot_id = null;
      }
    }

    // =====================================================
    // CURRENT BOOKING
    // =====================================================

    let returningPatient = null;
    let patientHistory = [];

    if (booking.phone) {
      const normalizedPhone = normalizePhone(booking.phone);
      if (normalizedPhone) {
        const historyResult = await pool.query(`
          SELECT
            p.id AS patient_id, p.name AS patient_name, p.phone,
            a.id AS appointment_id, a.status, a.chat_summary,
            d.id AS doctor_id, d.name AS doctor_name, d.specialization,
            s.date, s.time,
            f.rating AS feedback_rating
          FROM patients p
          LEFT JOIN appointments a ON a.patient_id = p.id
          LEFT JOIN doctors d ON d.id = a.doctor_id
          LEFT JOIN slots s ON s.id = a.slot_id
          LEFT JOIN feedback f ON f.appointment_id = a.id
          WHERE RIGHT(regexp_replace(p.phone, '\\D', '', 'g'), 10) = $1
          ORDER BY COALESCE(s.date, a.created_at::date) DESC, COALESCE(s.time, '00:00') DESC
        `, [normalizedPhone]);
        if (historyResult.rows.length) {
          const first = historyResult.rows[0];
          returningPatient = { id: first.patient_id, name: first.patient_name, phone: first.phone };
          patientHistory = historyResult.rows.filter(r => r.appointment_id).map(r => ({
            appointment_id: r.appointment_id, doctor_name: r.doctor_name,
            specialization: r.specialization, date: r.date, time: r.time,
            status: r.status, chat_summary: r.chat_summary, feedback_rating: r.feedback_rating
          }));
        }
      }
    }

    const currentBooking = {
      patient_name:
        booking.patient_name || returningPatient?.name || null,

      phone:
        normalizePhone(booking.phone) || normalizePhone(returningPatient?.phone) || null,

      doctor_id:
        booking.doctor_id
          ? Number(booking.doctor_id)
          : null,

      slot_id:
        booking.slot_id
          ? Number(booking.slot_id)
          : null,

      // A slot the assistant proposed (based on a time the patient gave)
      // that the patient has not yet said "yes" to — kept separate from
      // slot_id so the confirm-details card never appears before the
      // patient actually agrees to come at that time.
      pending_slot_id:
        booking.pending_slot_id
          ? Number(booking.pending_slot_id)
          : null,

      confirmed:
        booking.confirmed === true,

      chat_summary:
        booking.chat_summary || null,

      // Detected once from the patient's first message, then kept stable
      // for the rest of the conversation (see systemPrompt LANGUAGE rules
      // below) so replies don't flip-flop between languages mid-chat.
      language:
        normalizeLanguage(booking.language) || null,
    };

    // Keep reception/doctor summaries strictly about the patient's medical
    // complaint. Greetings, booking chatter, names, phone numbers and
    // confirmations must never appear in the stored summary.
    //
    // This used to duplicate sanitizeMedicalSummary() above with the same
    // "eat to end of string" bug — now just delegates to the single fixed
    // implementation so there's one place to maintain, not two that can
    // drift apart.
    const medicalOnlySummary = sanitizeMedicalSummary;

    // =====================================================
    // AI SYSTEM PROMPT
    // =====================================================

    const systemPrompt = `
You are an AI hospital appointment assistant.

Your ONLY job is to help patients book appointments.

TODAY:
${new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })}

CURRENT TIME (IST):
${new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false })}
${expiredPendingSlot ? `
NOTE: A slot you proposed to this patient earlier in the conversation is
no longer available — its time has already passed (or someone else has
booked it since). It has been removed from CURRENT BOOKING and it is NOT
in REAL AVAILABLE SLOTS anymore. Do NOT repeat, confirm, or reference that
old time again, even if it appears in the chat HISTORY below. Politely let
the patient know that specific time is no longer available, and propose
the earliest slot for the same doctor (or same matched doctors) from REAL
AVAILABLE SLOTS instead.
` : ""}
REAL DOCTORS:
${JSON.stringify(doctors)}

REAL AVAILABLE SLOTS:
${JSON.stringify(slots)}

CURRENT BOOKING:
${JSON.stringify(currentBooking)}

RETURNING PATIENT HISTORY (if any):
${JSON.stringify(patientHistory)}

LANGUAGE:

- If CURRENT BOOKING.language is already set, reply in that exact
  language/script for the rest of the conversation. Do not switch
  languages on your own.
- If CURRENT BOOKING.language is null, detect the patient's language
  from their latest message (supports English, Hindi (Devanagari
  script), Hinglish (Hindi written in Roman letters), and other Indian
  regional languages such as Tamil, Bengali, Marathi, Gujarati, etc.)
  and reply in that same language and script. Set booking.language to
  a short label for what you detected (e.g. "English", "Hindi",
  "Hinglish", "Tamil").
- If the patient explicitly switches language mid-conversation, follow
  them and update booking.language to match.
- THIS MESSAGE IS A QUICK-ACTION: ${quickAction ? "true" : "false"}.
  If true, this message text was generated by a UI button (e.g. the
  patient tapped a doctor card), NOT typed by the patient themselves —
  it is usually plain Hinglish regardless of what language they were
  actually speaking. In this case, do NOT treat its language/script as
  the patient switching language: keep booking.language exactly as it
  is in CURRENT BOOKING (do not change it), and keep "reply" in that
  same existing language.
- Keep the "reply" field in the detected language at all times. Warm,
  reassuring, professional tone — the patient may be in pain or
  stressed.

RULES:

1. Only use doctors from REAL DOCTORS.

2. Only use slots from REAL AVAILABLE SLOTS.

3. Never invent a doctor, date or time.

4. Match doctor names and specializations intelligently.

5. Collect:
   - patient_name
   - phone
   - doctor_id
   - slot_id
   - language (see LANGUAGE section above)
   - chat_summary (ONLY the patient's medical complaint/symptoms; 1 short neutral sentence; NEVER include greetings, casual talk, names, phone numbers, doctor/appointment/slot details, confirmations, or your own diagnosis)

6. If information is missing, ask for it.

7. Before booking, show the complete appointment details
   (doctor, specialization, date, time).

8. Once doctor_id AND slot_id are both set, do NOT ask the
   patient to type "yes"/"confirm" in chat, and do NOT ask
   them to type their name or phone number in chat either.
   Instead, in your reply, tell them their details are shown
   below and they just need to confirm their name and mobile
   number there to finish booking (e.g. "Bas neeche apna naam
   aur mobile number confirm kar dijiye, booking ho jaayegi.").
   A separate on-screen form handles the actual name/phone
   confirmation — never invent your own name/phone prompt.

9. NEVER say the appointment is booked, confirmed, or
   "confirm ho gaya hai" in your reply UNLESS this exact
   request came from the confirmation form (you will know
   this because CURRENT BOOKING.confirmed will already be
   true when that happens). Saying it is booked when it is
   not is a serious error — the patient will show up to a
   visit that was never actually created.

10. Regardless of anything the patient types in chat
    ("yes", "haan", "confirm", a typed name/phone, etc.),
    booking.confirmed in your JSON output is ONLY ever
    honored by the backend when it came from that same
    confirmation form — so always set it to whatever is
    already in CURRENT BOOKING.confirmed. You cannot and
    should not try to finalize the booking from chat text.

11. If the patient has not confirmed,
    confirmed MUST be false.

13. Keep reply under 30 words.

14. Do not provide medical diagnosis or treatment advice.

15. Return ONLY valid JSON.

16. DOCTOR DISCOVERY (symptom vs named doctor vs explicit list
    request) — a doctor list/picker must NEVER be shown to the
    patient unless they asked for it or described a symptom.
    Control this with the "show_doctor_list" boolean in your
    output (see EXACT FORMAT below):

    a. If the patient names a specific doctor (exact name or
       close/fuzzy match, e.g. "Dr Shukla", "Shukla wale
       doctor"), immediately set doctor_id to that doctor.
       Set matched_doctor_ids to just that one doctor's id and
       show_doctor_list to false. Do not ask which doctor — go
       straight to offering their available slots.

    b. If the patient instead describes a symptom or problem
       (e.g. "chest me pain hai", "bukhar hai", "skin par
       rashes hain") and has NOT named a doctor, use ordinary
       medical common sense to decide which specialization(s)
       in REAL DOCTORS are relevant (e.g. chest pain ->
       Cardiologist; fever with no other clue -> General
       Physician; skin issue -> Dermatologist). Set
       matched_doctor_ids to the ids of ONLY the doctors in
       REAL DOCTORS whose specialization fits, but set
       show_doctor_list to false. Do NOT ask the patient to
       choose a doctor yet. First ask when they can come to the
       hospital, e.g. "Aap kitne baje tak hospital aa sakte hain?"
       This is not a medical diagnosis, just routing to the
       right department.

    c. If no specialization in REAL DOCTORS clearly matches
       the symptom, fall back to General Physician if one
       exists (matched_doctor_ids = [that id], show_doctor_list
       = true), else include all doctors in matched_doctor_ids
       (show_doctor_list = true) and ask the patient to choose.

    d. If the patient EXPLICITLY asks to see the doctor list /
       all doctors / all departments (e.g. "doctors ki list do",
       "sabhi doctor dikhao", "kaun kaun se doctor hain",
       "show me all doctors", "specialists ki list"), set
       matched_doctor_ids to the ids of ALL doctors in REAL
       DOCTORS and show_doctor_list to true.

    e. If the patient has given NEITHER a symptom, NOR a doctor
       name, NOR explicitly asked for the list (e.g. they only
       said "hi", "hello", "namaste", or something unrelated),
       do NOT show any doctor list. Set matched_doctor_ids to
       an empty array and show_doctor_list to false. In the
       reply, ask them to briefly describe their symptom/problem
       or tell you which doctor/department they want — mention
       they can also just ask to see the full list of doctors.

    f. Once doctor_id is set (from a, or after the patient picks
       from the list shown in b/c/d), matched_doctor_ids should
       just contain that one doctor_id and show_doctor_list
       should be false (the picker is no longer needed).

17. SLOT CONVERSATION — DO NOT SHOW SLOT BUTTONS OR A SLOT LIST:

    a. For a symptom-first conversation, ask when the patient can
       come to the hospital BEFORE asking them to choose a doctor.
       Do not show doctor cards for a symptom-only message.

    b. The patient may answer in natural language such as
       "2:30 baje tak aa paunga".

    c. When the patient gives an arrival time, choose the nearest
       REAL AVAILABLE SLOT at or after that time. If multiple
       matching doctors were identified from the symptom, choose
       the earliest real slot across those matching doctors and
       set BOTH booking.doctor_id and booking.slot_id. Do not
       invent a slot. Do not present a slot list.

    d. If the nearest available slot is later than the requested
       time, clearly tell the patient the nearest available time
       and doctor, then ask for confirmation.

    e. If the patient explicitly names an exact real slot, you may
       use that slot directly.

18. Return ONLY valid JSON.

EXACT FORMAT:

{
  "reply": "short reply, in the patient's detected language",
  "matched_doctor_ids": [1, 2],
  "show_doctor_list": false,
  "booking": {
    "patient_name": null,
    "phone": null,
    "doctor_id": null,
    "slot_id": null,
    "confirmed": false,
    "language": "English | Hindi | Hinglish | <detected regional language>"
  }
}
`;

    // =====================================================
    // CONVERSATION HISTORY
    // =====================================================

    const conversation = [];

    if (Array.isArray(history)) {
      for (const item of history) {
        if (
          item &&
          typeof item.message === "string"
        ) {
          conversation.push({
            role:
              item.role === "assistant"
                ? "model"
                : "user",

            parts: [
              {
                text: item.message,
              },
            ],
          });
        }
      }
    }

    conversation.push({
      role: "user",
      parts: [
        {
          text: effectiveMessage.trim(),
        },
      ],
    });

    // =====================================================
    // CONFIRM-DETAILS GATE
    //
    // When the patient submits the "confirm your details" card (re-typed
    // full name + mobile number), we already know exactly what to do —
    // finalize the booking with those details. Skip the AI call entirely
    // and build the same shaped result deterministically, so a booking
    // can never happen on the strength of a free-text "yes"/"haan" alone.
    // =====================================================

    let aiResult;

    if (confirmDetails) {
      aiResult = {
        reply: "",
        matched_doctor_ids: currentBooking.doctor_id ? [currentBooking.doctor_id] : [],
        show_doctor_list: false,
        booking: {
          patient_name: confirmedName,
          phone: confirmedPhone,
          doctor_id: currentBooking.doctor_id,
          slot_id: currentBooking.slot_id,
          confirmed: true,
          language: currentBooking.language,
        },
      };
    } else {
      // =====================================================
      // GEMINI  (auto retry + fallback across GEMINI_MODELS)
      // =====================================================

      const response =
        await generateWithFallback({
          contents: conversation,

          config: {
            systemInstruction:
              systemPrompt,

            temperature: 0.1,

            // Newer Gemini models can spend part of this budget on
            // internal "thinking", so keep it generous to avoid cut-off JSON.
            maxOutputTokens: 2000,

            responseMimeType:
              "application/json",
          },
        });

      const rawText =
        typeof response.text === "string"
          ? response.text.trim()
          : "";

      console.log(
        "AI raw response:",
        rawText
      );

      // =====================================================
      // PARSE AI RESPONSE
      // =====================================================

      try {
        aiResult =
          JSON.parse(rawText);
      } catch (parseError) {
        console.error(
          "AI JSON parse error:",
          parseError
        );

        console.error(
          "Raw AI response:",
          rawText
        );

        // Safe fallback
        return res.json({
          success: true,
          booked: false,

          reply:
            rawText ||
            await localize("parseFallback", currentBooking.language || "Hinglish"),

          booking: currentBooking,

          // Parsing failed, so we don't know the AI's intent — default to
          // not showing the doctor picker rather than dumping the full list.
          doctors: [],
          show_doctor_list: false,

          available_slots: slots,
          patient: returningPatient,
          patient_history: patientHistory,
        });
      }
    }

    // =====================================================
    // FILTER DOCTORS BY SYMPTOM/NAME MATCH
    //
    // The doctor picker is only ever shown when the AI explicitly says
    // show_doctor_list=true (patient asked for the list, described a
    // symptom, or is choosing between a matched specialization). It is
    // never shown by default just because the AI didn't give a match —
    // that was the old bug where the full doctor list appeared right
    // after the greeting, before the patient asked for anything.
    // =====================================================

    const matchedIds = Array.isArray(aiResult.matched_doctor_ids)
      ? aiResult.matched_doctor_ids.map(Number)
      : [];

    let showDoctorList = aiResult.show_doctor_list === true;

    // Pulled up from NORMALIZE BOOKING below so doctorsToSend can fall back
    // to whichever doctor is already selected (see comment below) — the
    // small model doesn't always re-send matched_doctor_ids once a doctor
    // has already been chosen, e.g. on a turn where the patient is just
    // typing their name.
    const aiBooking =
      aiResult.booking || {};
    const effectiveDoctorId = aiBooking.doctor_id
      ? Number(aiBooking.doctor_id)
      : currentBooking.doctor_id;

    // doctorsToSend always carries the doctor(s) actually relevant right
    // now — a single doctor once one is chosen (so the UI can still show
    // that doctor's name/specialization), the matched subset while the
    // patient is choosing, or nothing at all before the patient has given
    // any symptom/doctor/list request. Whether the picker GRID renders is
    // controlled separately by showDoctorList, sent to the frontend below.
    //
    // Once a doctor is already selected (effectiveDoctorId), it is ALWAYS
    // included even if this turn's matched_doctor_ids/show_doctor_list came
    // back empty — otherwise the frontend's `doctors` list would go blank
    // mid-conversation and lose track of who was picked, which used to
    // silently break the "confirm your details" card further down the flow.
    const doctorsToSend =
      matchedIds.length > 0
        ? doctors.filter((d) => matchedIds.includes(Number(d.id)))
        : showDoctorList
          ? doctors // safety net: AI wants the list shown but gave no ids
          : effectiveDoctorId
            ? doctors.filter((d) => Number(d.id) === effectiveDoctorId)
            : [];

    // =====================================================
    // NORMALIZE BOOKING
    // =====================================================

    // Make explicit confirmations deterministic. Gemini can occasionally
    // miss a simple "yes/haan/book it" even when all booking details are
    // already present in the current booking state.
    const confirmationText = effectiveMessage.trim().toLowerCase();
    const explicitConfirmation =
      /^(yes|yeah|yep|haan|ha|ji|theek hai|thik hai|book it|confirm|confirmed|please book|kar do|book kar do|haan book kar do|haan kar do|bilkul|sure|proceed)$/i.test(confirmationText);

    // The AI model itself may output a slot_id directly (per the SLOT
    // CONVERSATION rules in the system prompt) any time it thinks it has
    // matched an arrival time to a real slot — including bare numbers like
    // "7" that our own parseRequestedTime() below doesn't recognize. That
    // must NOT be trusted as a confirmed slot_id, or the "confirm your
    // details" popup (which fires the instant doctor_id + slot_id are both
    // set) pops up before the patient has agreed to come at that time.
    const aiProposedSlotId = aiBooking.slot_id ? Number(aiBooking.slot_id) : null;

    const finalBooking = {
      patient_name:
        aiBooking.patient_name ||
        currentBooking.patient_name ||
        null,

      phone:
        aiBooking.phone ||
        currentBooking.phone ||
        null,

      doctor_id:
        aiBooking.doctor_id
          ? Number(aiBooking.doctor_id)
          : currentBooking.doctor_id,

      // Only ever carries forward a slot that was already confirmed on a
      // previous turn (see PENDING SLOT CONFIRMATION below) — never taken
      // directly from the AI's output or a fresh deterministic time-match.
      slot_id: currentBooking.slot_id || null,

      // A slot the assistant proposed (from the AI's own output, or from
      // the deterministic time-matching below) that the patient hasn't
      // said yes to yet.
      pending_slot_id:
        aiProposedSlotId && aiProposedSlotId !== currentBooking.slot_id
          ? aiProposedSlotId
          : currentBooking.pending_slot_id || null,

      // Booking is ONLY ever finalized through the confirm-details card
      // (re-typed full name + mobile number) — never from the AI's own
      // "confirmed" guess or a plain typed "yes"/"haan". This guarantees
      // the patient re-confirms their contact details before anything is
      // written to the database. See the explicitConfirmation block below,
      // which is now purely informational and can no longer flip this.
      confirmed:
        confirmDetails === null ? false : aiBooking.confirmed === true,

      chat_summary:
        aiBooking.chat_summary ||
        currentBooking.chat_summary ||
        null,

      language:
        // Deterministic guarantee: a quick-action click (doctor card,
        // etc.) never overrides an already-detected language, even if
        // the AI's output tries to. Real free-typed messages still flow
        // through normally.
        quickAction && currentBooking.language
          ? currentBooking.language
          : (normalizeLanguage(aiBooking.language) ||
             currentBooking.language ||
             null),
    };

    // Hardcoded (non-AI-generated) system messages below use this so they
    // match whatever language the conversation has settled into.
    const lang = finalBooking.language || "Hinglish";

    // SYMPTOM-FIRST CONVERSATION: collect arrival time before doctor choice.
    // If exactly one doctor matches, remember that doctor. If multiple doctors
    // match, the arrival-time step below will choose the earliest real slot.
    const medicalComplaint = medicalOnlySummary(effectiveMessage);
    if (!finalBooking.doctor_id && medicalComplaint && matchedIds.length === 1) {
      finalBooking.doctor_id = Number(matchedIds[0]);
    }

    const requestedMinutes = parseRequestedTime(effectiveMessage.trim());
    if (medicalComplaint && requestedMinutes == null && !finalBooking.slot_id && !finalBooking.confirmed) {
      // Keep the symptom-first question in the patient's detected language.
      // English/Hindi/Hinglish use our deterministic translations; any other
      // language (Marathi, Tamil, Bengali, Telugu, Kannada, Gujarati, etc.)
      // is translated on the fly by localize() instead of falling back to Hinglish.
      aiResult.reply = await localize("arrivalTimeQuestion", lang);
      aiResult.show_doctor_list = false;
      showDoctorList = false;
    }

    // Quick-pick buttons (e.g. the doctor card) send a canned Hinglish
    // string like "Mujhe Dr. X ke saath appointment chahiye" so the AI
    // has something to parse. That's fine for the model, but showing that
    // literal Hinglish text in the patient's own chat bubble looks broken
    // when the rest of the conversation is in Marathi/Hindi/Tamil/etc.
    // Translate it into the conversation's language so the frontend can
    // swap in a matching display string for that bubble.
    const displayText =
      quickAction && lang && lang !== "Hinglish" && lang !== "English"
        ? await translateText(message, lang)
        : null;

    // The patient typed an explicit "yes/haan/confirm" and every booking
    // field is already in place — but we deliberately do NOT finalize the
    // booking here. Instead, point them at the "confirm your details" card
    // (re-typed name + mobile number) that the frontend shows whenever a
    // doctor + slot are both selected. This is what actually creates the
    // appointment (see confirm_details / CONFIRM-DETAILS GATE above).
    if (
      !confirmDetails &&
      explicitConfirmation &&
      currentBooking.patient_name &&
      currentBooking.phone &&
      currentBooking.doctor_id &&
      currentBooking.slot_id
    ) {
      const confirmNudgeTemplates = {
        English: "Almost there — please confirm your name and mobile number below to finalize the booking.",
        Hindi: "बस थोड़ा और — बुकिंग फाइनल करने के लिए नीचे अपना नाम और मोबाइल नंबर कन्फर्म कर दीजिए।",
        Hinglish: "Bas thoda aur — booking finalize karne ke liye niche apna naam aur mobile number confirm kar dijiye.",
      };
      aiResult.reply = await localizeTemplate(confirmNudgeTemplates, lang);
    }

    // Normalize Indian mobile numbers to the last 10 digits so the
    // same patient is recognized even when they enter +91XXXXXXXXXX.
    if (finalBooking.phone) {
      const digits = String(finalBooking.phone).replace(/\D/g, "");
      if (digits.length >= 10) finalBooking.phone = digits.slice(-10);
    }

    finalBooking.phone = normalizePhone(finalBooking.phone);

    // Deterministic conversational time matching. For a selected doctor,
    // use that doctor's nearest real slot. For symptom-first conversations
    // with multiple matching doctors, use the earliest real slot across the
    // matched doctors.
    //
    // IMPORTANT: this only PROPOSES the slot (pending_slot_id) and asks the
    // patient whether they can actually come at that time — it must NOT set
    // slot_id yet. doctor_id + slot_id both being set is exactly what makes
    // the frontend pop up the "confirm your details" card, so setting
    // slot_id here would pop that card up before the patient has ever said
    // they're willing to come at this proposed time.
    if (requestedMinutes != null) {
      let nearest = null;
      if (finalBooking.doctor_id) {
        nearest = pickNearestSlotAfterTime(slots, finalBooking.doctor_id, requestedMinutes);
      } else if (matchedIds.length > 0) {
        nearest = pickNearestSlotAfterDoctorIds(slots, matchedIds, requestedMinutes);
        if (nearest) finalBooking.doctor_id = Number(nearest.doctor_id);
      }
      if (nearest) {
        finalBooking.slot_id = null;
        finalBooking.pending_slot_id = Number(nearest.id);
        finalBooking.confirmed = false;
      }
    } else if (currentBooking.pending_slot_id && !finalBooking.slot_id) {
      // No new time was mentioned this turn — check whether the patient is
      // replying to the pending slot proposal from the previous turn.
      const pendingSlot = slots.find((slot) => Number(slot.id) === Number(currentBooking.pending_slot_id));
      const pendingSlotStillValid =
        pendingSlot &&
        (!finalBooking.doctor_id || Number(pendingSlot.doctor_id) === Number(finalBooking.doctor_id));
      if (!pendingSlotStillValid) {
        // Slot got taken/removed, or the patient switched doctors, while we
        // were waiting on their answer.
        finalBooking.pending_slot_id = null;
      } else if (explicitConfirmation) {
        finalBooking.slot_id = Number(pendingSlot.id);
        finalBooking.doctor_id = finalBooking.doctor_id || Number(pendingSlot.doctor_id);
        finalBooking.pending_slot_id = null;
        const confirmedSlotTemplates = {
          English: "Great — please confirm your name and mobile number below to finish booking.",
          Hindi: "बढ़िया — बुकिंग पूरी करने के लिए नीचे अपना नाम और मोबाइल नंबर कन्फर्म कर दीजिए।",
          Hinglish: "Great — booking finish karne ke liye niche apna naam aur mobile number confirm kar dijiye.",
        };
        aiResult.reply = await localizeTemplate(confirmedSlotTemplates, lang);
      } else if (/^(no|nahi|nahin|na|nope)$/i.test(confirmationText)) {
        finalBooking.pending_slot_id = null;
        aiResult.reply = await localize("arrivalTimeQuestion", lang);
      }
      // Anything else (a fresh symptom, a doctor name, small talk) is left
      // to the AI's own reply; the pending slot is simply carried forward
      // so a later plain "yes" can still confirm it.
    }

    // PENDING SLOT QUESTION — whenever the patient hasn't explicitly said
    // yes/no yet for a proposed (not-yet-confirmed) slot, always ask the
    // plain yes/no question ourselves instead of trusting the model's own
    // reply text. The model doesn't know slot_id is being deliberately
    // withheld until the patient agrees, so left alone it can say things
    // like "confirm your details below" (per system prompt rule 8) even
    // though no popup has actually appeared yet — this used to only apply
    // on the turn the slot was first proposed, so if the same slot was
    // still pending on a LATER turn (e.g. patient re-typed a time that
    // resolved to the same slot again) the AI's own text went out
    // unchecked and could tell the patient to confirm below when the
    // booking form/slot_id was never actually set, so the popup never
    // appeared. Now it fires on every turn a slot is still only pending.
    if (finalBooking.pending_slot_id) {
      const proposedSlot = slots.find((slot) => Number(slot.id) === Number(finalBooking.pending_slot_id));
      if (proposedSlot) {
        const proposedDoctor = doctors.find((doctor) => Number(doctor.id) === Number(proposedSlot.doctor_id));
        const timeText = formatChatTime(proposedSlot.time);
        const slotQuestionTemplates = {
          English: `${proposedDoctor?.name ? `${proposedDoctor.name} is` : "The nearest doctor is"} available at ${timeText}. Will you come at this slot?`,
          Hindi: `${proposedDoctor?.name || "डॉक्टर"} ${timeText} पर उपलब्ध हैं। क्या आप इस समय आ सकते हैं?`,
          Hinglish: `${proposedDoctor?.name || "Doctor"} ${timeText} par available hain. Kya aap is slot par aa sakte hain?`,
        };
        aiResult.reply = await localizeTemplate(slotQuestionTemplates, lang);
      }
    }

    // =====================================================
    // VALIDATE DOCTOR
    // =====================================================

    if (finalBooking.doctor_id) {
      const doctorExists =
        doctors.some(
          (doctor) =>
            Number(doctor.id) ===
            Number(finalBooking.doctor_id)
        );

      if (!doctorExists) {
        finalBooking.doctor_id = null;
        finalBooking.slot_id = null;
        finalBooking.confirmed = false;
      }
    }

    // =====================================================
    // VALIDATE SLOT
    // =====================================================

    let selectedSlot = null;

    if (finalBooking.slot_id) {
      selectedSlot =
        slots.find(
          (slot) =>
            Number(slot.id) ===
            Number(finalBooking.slot_id)
        );

      if (!selectedSlot) {
        finalBooking.slot_id = null;
        finalBooking.confirmed = false;
      }
    }

    // =====================================================
    // SLOT / DOCTOR MATCH
    // =====================================================

    if (
      selectedSlot &&
      finalBooking.doctor_id &&
      Number(selectedSlot.doctor_id) !==
        Number(finalBooking.doctor_id)
    ) {
      finalBooking.slot_id = null;
      finalBooking.confirmed = false;
      selectedSlot = null;
    }

    // =====================================================
    // CONFIRMATION CHECK
    // =====================================================

    if (finalBooking.confirmed) {
      if (
        !finalBooking.patient_name ||
        !finalBooking.phone ||
        !finalBooking.doctor_id ||
        !finalBooking.slot_id
      ) {
        finalBooking.confirmed = false;

        return res.json({
          success: true,
          booked: false,

          reply: incompleteBookingMessage(finalBooking, lang),
          display_text: displayText,

          booking: finalBooking,

          doctors: doctorsToSend,
          show_doctor_list: showDoctorList,

          available_slots: slots,
        });
      }
    }

    // Full conversation transcript (every turn, in order) so admin/doctor
    // can open a booked appointment and see exactly what the patient
    // typed to the chatbot — not just the one-line chat_summary.
    const chatTranscript = [
      ...(Array.isArray(history)
        ? history
            .filter((x) => x && typeof x.message === "string")
            .map((x) => ({
              role: x.role === "assistant" ? "assistant" : "user",
              message: x.message,
            }))
        : []),
      { role: "user", message: effectiveMessage },
    ];

    // Store the patient's complaint. resolveComplaint() tries the AI summary
    // first, then falls back to what the patient actually typed, so a valid
    // complaint isn't lost just because it uses a word outside our keyword list.
    finalBooking.chat_summary = resolveComplaint(finalBooking.chat_summary, chatTranscript) || null;

    // =====================================================
    // ACTUAL BOOKING
    // =====================================================

    if (finalBooking.confirmed) {
      const client =
        await pool.connect();

      try {
        await client.query("BEGIN");

        // -------------------------------------------------
        // LOCK SLOT AGAIN
        // -------------------------------------------------

        const slotCheck =
          await client.query(
            `
            SELECT
              s.*,
              d.name AS doctor_name,
              d.specialization
            FROM slots s
            JOIN doctors d
              ON s.doctor_id = d.id
            WHERE s.id = $1
              AND s.doctor_id = $2
              AND s.status = 'available'
              AND d.active = true
              AND (
                s.date > (NOW() AT TIME ZONE 'Asia/Kolkata')::date
                OR (
                  s.date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
                  AND s.time > (NOW() AT TIME ZONE 'Asia/Kolkata')::time
                )
              )
            FOR UPDATE
            `,
            [
              finalBooking.slot_id,
              finalBooking.doctor_id,
            ]
          );

        if (
          slotCheck.rows.length === 0
        ) {
          await client.query(
            "ROLLBACK"
          );

          return res.json({
            success: true,
            booked: false,

            reply: await localize("slotTaken", lang),
            display_text: displayText,

            booking: {
              ...finalBooking,
              slot_id: null,
              confirmed: false,
            },

            doctors: doctorsToSend,
            show_doctor_list: showDoctorList,

            available_slots:
              slots,
          });
        }

        const slot =
          slotCheck.rows[0];

        // -------------------------------------------------
        // FIND / CREATE PATIENT
        // -------------------------------------------------

        let patientResult =
          await client.query(
            `
            SELECT *
            FROM patients
            WHERE RIGHT(regexp_replace(phone, '\\D', '', 'g'), 10) = $1
            `,
            [finalBooking.phone]
          );

        let patient;

        if (
          patientResult.rows.length === 0
        ) {
          const insertPatient =
            await client.query(
              `
              INSERT INTO patients
                (name, phone)
              VALUES
                ($1, $2)
              RETURNING *
              `,
              [
                finalBooking.patient_name,
                finalBooking.phone,
              ]
            );

          patient =
            insertPatient.rows[0];
        } else {
          patient =
            patientResult.rows[0];

          if (
            patient.name !==
            finalBooking.patient_name
          ) {
            const updatePatient =
              await client.query(
                `
                UPDATE patients
                SET name = $1
                WHERE id = $2
                RETURNING *
                `,
                [
                  finalBooking.patient_name,
                  patient.id,
                ]
              );

            patient =
              updatePatient.rows[0];
          }
        }

        // -------------------------------------------------
        // CREATE APPOINTMENT
        // -------------------------------------------------

        const appointmentResult =
          await client.query(
            `
            INSERT INTO appointments
              (
                patient_id,
                doctor_id,
                slot_id,
                status,
                chat_summary,
                chat_transcript
              )
            VALUES
              ($1, $2, $3, 'booked', $4, $5)
            RETURNING *
            `,
            [
              patient.id,
              finalBooking.doctor_id,
              finalBooking.slot_id,
              finalBooking.chat_summary || null,
              JSON.stringify(chatTranscript),
            ]
          );

        // -------------------------------------------------
        // MARK SLOT BOOKED
        // -------------------------------------------------

        await client.query(
          `
          UPDATE slots
          SET status = 'booked'
          WHERE id = $1
          `,
          [
            finalBooking.slot_id,
          ]
        );

        await client.query(
          "COMMIT"
        );

        // -------------------------------------------------
        // WHATSAPP
        // -------------------------------------------------

        // Dr name, date, patient name, time — in that order, matching the
        // confirmation template's variable slots.
        sendWhatsAppMessage(
          finalBooking.phone,
          "appointment_confirmation",
          [
            slot.doctor_name,
            String(slot.date),
            finalBooking.patient_name,
            String(slot.time),
          ]
        ).catch((e) => {
          console.error(
            "WhatsApp confirmation failed:",
            e
          );
        });

        // -------------------------------------------------
        // SUCCESS
        // -------------------------------------------------

        const successTemplates = {
          English:
            `Your appointment is confirmed ✅\n` +
            `Doctor: ${slot.doctor_name}\n` +
            `Date: ${String(slot.date)}\n` +
            `Patient: ${finalBooking.patient_name}\n` +
            `Time: ${String(slot.time)}`,
          Hindi:
            `आपकी अपॉइंटमेंट कन्फर्म हो गई है ✅\n` +
            `डॉक्टर: ${slot.doctor_name}\n` +
            `तारीख: ${String(slot.date)}\n` +
            `मरीज़: ${finalBooking.patient_name}\n` +
            `समय: ${String(slot.time)}`,
          Hinglish:
            `Aapki appointment confirm ho gayi hai ✅\n` +
            `Doctor: ${slot.doctor_name}\n` +
            `Date: ${String(slot.date)}\n` +
            `Patient: ${finalBooking.patient_name}\n` +
            `Time: ${String(slot.time)}`,
        };
        const successReply = await localizeTemplate(successTemplates, lang);

        // Structured payload for downstream system integration (e.g. a
        // webhook, WhatsApp template, or the boss's external system).
        // Built entirely from the REAL booked row — never from anything
        // the AI invented — so it can't drift from what's actually in
        // the database.
        const integrationPayload = {
          status: "CONFIRMED",
          patient_name: finalBooking.patient_name,
          contact_number: finalBooking.phone,
          department: slot.specialization,
          doctor_name: slot.doctor_name,
          appointment_date: String(slot.date),
          appointment_time: String(slot.time),
          language: lang,
        };
        console.log("Booking integration payload:", integrationPayload);

        return res.json({
          success: true,
          booked: true,

          reply: successReply,
          display_text: displayText,

          booking: {
            ...finalBooking,
            confirmed: true,
          },

          appointment:
            appointmentResult.rows[0],

          doctor: {
            id: slot.doctor_id,
            name: slot.doctor_name,
            specialization:
              slot.specialization,
          },

          slot: {
            id: slot.id,
            date: slot.date,
            time: slot.time,
          },
          patient: patient,
          patient_history: patientHistory,
          integration_payload: integrationPayload,
        });
      } catch (bookingError) {
        await client.query(
          "ROLLBACK"
        );

        console.error(
          "AI booking error:",
          bookingError
        );

        return res.status(500).json({
          error:
            "AI booking failed",
          details:
            bookingError.message,
        });
      } finally {
        client.release();
      }
    }

    // =====================================================
    // NORMAL AI RESPONSE
    // =====================================================

    let conversationalReply = aiResult.reply || (await localize("genericHelp", lang));

    const doctorWasJustSelected = !currentBooking.doctor_id && finalBooking.doctor_id;
    if (doctorWasJustSelected && !finalBooking.slot_id) {
      const doctorSlots = slots
        .filter((slot) => Number(slot.doctor_id) === Number(finalBooking.doctor_id))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.time).localeCompare(String(b.time)));
      if (doctorSlots.length) {
        const firstDate = String(doctorSlots[0].date);
        const sameDay = doctorSlots.filter((slot) => String(slot.date) === firstDate);
        const firstTime = formatChatTime(sameDay[0].time);
        const lastTime = formatChatTime(sameDay[sameDay.length - 1].time);
        const timingText = firstTime === lastTime ? firstTime : `${firstTime} to ${lastTime}`;
        const doctor = doctors.find((d) => Number(d.id) === Number(finalBooking.doctor_id));
        const doctorName = doctor?.name || "Doctor";
        const doctorSpecialization = doctor?.specialization || "General Physician";
        const doctorLabel = `${doctorName} (${doctorSpecialization})`;
        const timingTemplates = {
          English: `${doctorLabel}'s available at ${timingText}. What time can you come?`,
          Hindi: `${doctorLabel} की उपलब्ध टाइमिंग ${timingText} है। आप किस समय आ सकते हैं?`,
          Hinglish: `${doctorLabel} ke available timings ${timingText} hain. Aap kis time aa sakte hain?`,
        };
        // Always use our own copy (accurate real data), translated into
        // whatever language this conversation is locked to — never trust
        // the free-text AI reply here, since a fast/small model tends to
        // just mirror the latest message's script (e.g. a quick-pick
        // button's canned Hinglish text) regardless of instructions.
        conversationalReply = await localizeTemplate(timingTemplates, lang);
      }
    }

    if (requestedMinutes != null && finalBooking.doctor_id && finalBooking.slot_id && !finalBooking.confirmed) {
      const conversationalSlot = slots.find((slot) => Number(slot.id) === Number(finalBooking.slot_id));
      if (conversationalSlot) {
        const displayTime = formatChatTime(conversationalSlot.time);
        const conversationalDoctor = doctors.find(
          (doctor) => Number(doctor.id) === Number(conversationalSlot.doctor_id)
        );
        const doctorName = conversationalDoctor?.name || "Doctor";
        const doctorSpecialization = conversationalDoctor?.specialization || "General Physician";
        const doctorLabel = `${doctorName} (${doctorSpecialization})`;
        const nearestSlotTemplates = {
          English: `The nearest available slot with ${doctorLabel} is ${displayTime}. Shall I confirm it?`,
          Hindi: `${doctorLabel} के साथ सबसे नज़दीकी उपलब्ध स्लॉट ${displayTime} का है। क्या मैं इसे कन्फर्म कर दूँ?`,
          Hinglish: `${doctorLabel} ke saath nearest available slot ${displayTime} ka hai. Kya main ise confirm kar doon?`,
        };
        conversationalReply = await localizeTemplate(nearestSlotTemplates, lang);
      }
    }

    return res.json({
      success: true,
      booked: false,

      reply: conversationalReply,
      display_text: displayText,

      booking: finalBooking,

      doctors: doctorsToSend,
      show_doctor_list: showDoctorList,

      available_slots: slots,
      patient: returningPatient,
      patient_history: patientHistory,
    });

  } catch (err) {
    console.error(
      "AI chat error:",
      err
    );

    return res.status(500).json({
      error:
        "AI assistant failed",

      details:
        err.message,
    });
  }
});

// =========================================================
// WHATSAPP APPOINTMENT REMINDERS
// =========================================================
// Sends a one-time "your appointment is coming up" WhatsApp message to each
// patient shortly before their booked slot. Runs on a poll loop (no extra
// cron dependency needed) and uses the `reminder_sent` flag so a patient is
// never reminded twice, no matter how often the loop runs.
//
// Lead time is configurable via REMINDER_LEAD_MINUTES in backend/.env
// (defaults to 60 = "remind about an hour before"). The loop itself runs
// every REMINDER_POLL_MINUTES (default 5) and picks up any booked
// appointment that has now entered the lead window.
const REMINDER_LEAD_MINUTES = Number(process.env.REMINDER_LEAD_MINUTES) || 60;
const REMINDER_POLL_MINUTES = Number(process.env.REMINDER_POLL_MINUTES) || 5;

async function sendDueReminders() {
  try {
    const due = await pool.query(
      `
      SELECT a.id, p.name AS patient_name, p.phone, d.name AS doctor_name, s.date, s.time
      FROM appointments a
      JOIN patients p ON a.patient_id = p.id
      JOIN doctors d ON a.doctor_id = d.id
      JOIN slots s ON a.slot_id = s.id
      WHERE a.status = 'booked'
        AND d.deleted_at IS NULL
        AND a.reminder_sent IS NOT TRUE
        AND (s.date + s.time) > NOW()
        AND (s.date + s.time) <= NOW() + ($1 || ' minutes')::interval
      `,
      [REMINDER_LEAD_MINUTES]
    );

    for (const row of due.rows) {
      try {
        await sendWhatsAppMessage(row.phone, "appointment_reminder", [
          row.patient_name,
          row.doctor_name,
          String(row.date),
          String(row.time),
        ]);
      } catch (e) {
        console.error("Reminder WhatsApp failed:", e);
      }
      // Mark sent regardless of delivery success so a hard failure (bad
      // number, template not approved yet) can't retry-loop forever; real
      // send failures are still visible in the whatsapp.js logs above.
      await pool.query("UPDATE appointments SET reminder_sent = true WHERE id = $1", [row.id]);
    }

    if (due.rows.length) {
      console.log(`[reminders] Sent ${due.rows.length} appointment reminder(s)`);
    }
  } catch (err) {
    console.error("Reminder job failed:", err);
  }
}

// =========================================================
// START SERVER — auto-migrate/seed the database on startup
// =========================================================
// This makes an existing Neon database compatible with the current app
// without requiring the user to remember a separate migration command.
async function initializeDatabase() {
  const schemaPath = path.join(__dirname, "..", "database", "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf8");
  await pool.query(schema);

  // Store the admin-visible password for existing demo accounts without
  // resetting passwords on every server restart. Passwords remain hashed
  // for authentication; password_display is only for the admin UI.
  const adminHash = "$2b$10$obkpp9Lj7jnSOEuL8K7UfeXyh3BU5sMsQ2mIn5oAg5pbLMPlYLYGa"; // admin123
  const demoHash = "$2b$10$u2AFt5PRcadLA.HQL5KixePjZ.EH0T4Q5RcmkWWjvIfsgpa/yIv5e"; // doctor123
  await pool.query("UPDATE staff SET password_display = 'admin123' WHERE username = 'admin' AND password_display IS NULL");
  await pool.query("UPDATE staff SET password_display = 'doctor123' WHERE username = 'reception' AND password_display IS NULL");
  await pool.query("UPDATE staff SET password_display = 'doctor123' WHERE role = 'doctor' AND password_display IS NULL");

  // If doctors existed before the doctor-login migration, ensure every active
  // doctor has exactly one linked login.
  await pool.query(`
    INSERT INTO staff (username, password_hash, password_display, name, role, doctor_id)
    SELECT 'dr' || d.id, $1, 'doctor123', d.name, 'doctor', d.id
    FROM doctors d
    WHERE d.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM staff s WHERE s.doctor_id = d.id AND s.role = 'doctor'
      );
  `, [demoHash]);

  console.log("Database schema/migrations ready");
}

initializeDatabase()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Hospital system backend running on port ${PORT}`);
    });

    // Kick off the reminder loop: an immediate check on boot (catches
    // anything due right away), then every REMINDER_POLL_MINUTES after that.
    sendDueReminders();
    setInterval(sendDueReminders, REMINDER_POLL_MINUTES * 60 * 1000);
    console.log(
      `[reminders] Polling every ${REMINDER_POLL_MINUTES}min, reminding ${REMINDER_LEAD_MINUTES}min before each appointment`
    );
  })
  .catch((err) => {
    console.error("Database initialization failed:", err);
    process.exit(1);
  });
