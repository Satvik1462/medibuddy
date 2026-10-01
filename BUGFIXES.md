# MediBuddy / MedAssist — Bug Fix Report

Har fix ke saath code me `BUG FIX:` comment bhi likha hai, taaki search karke dekh sako kya badla.
Sab fixes local Postgres (UTC timezone, Neon jaisa) par test kiye gaye hain. Chatbot flow ko mock Gemini
ke saath end-to-end test kiya gaya hai, aur WhatsApp ko ek fake server ke saath.

## 🔴 Critical (patient safety / data / security)

| # | Bug | Kya hota tha | Fix |
|---|-----|--------------|-----|
| 1 | **WhatsApp reminder galat time pe** (`sendDueReminders`) | Slot ka time IST me hai, lekin query `NOW()` (UTC) se compare karti thi. 10:00 AM ki appointment ka "1 ghanta pehle" reminder ~2:30 PM ko jaata tha, yaani **visit ke baad**. | Ab IST wall-clock se compare hota hai. Reminder ko pehle atomically claim kiya jaata hai, isliye duplicate nahi jaata. |
| 2 | **Koi bhi patient kisi aur ke number pe booking kar sakta tha** (`/ai/chat` confirm card) | Confirm card me type kiya hua mobile number bina check ke use hota tha, aur us number wale asli patient ka naam DB me overwrite ho jaata tha. | Number OTP-login wale number se match hona zaroori hai. UI me field read-only hai, aur server par bhi check hota hai. |
| 3 | **Reception ko sab doctors ke passwords dikhte the** (`GET /doctors?all=true`) | Plain-text password aur username reception ko bhi milte the, aur public list me usernames bhi. | Login details ab sirf admin ko milte hain. |
| 4 | **Hardcoded JWT secret fallback** (`"dev-secret-change-me"`) | `.env` me `JWT_SECRET` na ho to koi bhi fake admin token bana ke saara patient data padh sakta tha. | Secret missing ho to har start pe random secret banta hai, aur warning log hoti hai. |
| 5 | **Patient token staff routes pe** (`requireAuth`) | Citizen token ko staff check se explicitly reject nahi kiya jaata tha. | Citizen token ab kabhi bhi staff check pass nahi kar sakta. |
| 6 | **Slot propose karte waqt date nahi batayi jaati thi** | Aaj ke slots khatam hone par kal ka slot sirf "10:00 AM par available" bol ke propose hota tha. Patient aaj hi aa jaata. | Reply me ab "aaj / kal / 3 Oct" bhi bataya jaata hai. |

## 🟠 Chatbot booking flow

| # | Bug | Fix |
|---|-----|-----|
| 7 | "Yes!", "haan ji", "ok", "okay 👍", "हाँ" ko "yes" nahi samjha jaata tha, aur bot same slot question loop me poochta rehta tha. | Punctuation/emoji hata ke common yes/no forms (Hindi bhi) pehchane jaate hain. Chat me **Haan / Nahi** buttons bhi add kiye. |
| 8 | Symptom se match hue doctors agle turn tak yaad nahi rehte the. "10 baje aaunga" pe koi slot propose nahi hota tha, agar AI ne list repeat nahi ki. | `matched_doctor_ids` ab booking state me save hota hai. |
| 9 | Jis turn pe slot propose hua, ussi turn pe reply overwrite hoke dobara "kis time aa sakte hain?" poochta tha. Agla "yes" ek aise slot ko confirm karta tha jo patient ne dekha hi nahi. | Pending slot hone par wala override band kiya. |
| 10 | Time parsing: "meri age 45 hai, 3 baje" → null, "2 log hain, 11:30" → 2 PM, "subah 7 baje" → 7 PM, "5 बजे" → null. | Parser ab har time-token dekhta hai, aur subah/shaam/raat samajhta hai. |
| 11 | "kal subah 10 baje" me "kal" ignore hota tha, aur aaj ka slot mil sakta tha. | aaj / kal / parso samjha jaata hai ("kal se bukhar hai" ko ignore karta hai). |
| 12 | AI ka tuta ya ```json fenced response raw JSON ke roop me patient ko dikh jaata tha. | Fences hata ke parse hota hai. Fail hone par ek friendly message jaata hai. |
| 13 | Chat history unlimited thi, aur pehla turn assistant ka hota tha (kuch Gemini models 400 dete hain). | Last 40 messages bheje jaate hain, leading model turns hataye jaate hain, aur same-role turns merge hote hain. |
| 14 | Confirmation message me raw `2026-09-04` / `14:30:00` dikhta tha. | "4 Sep 2026", "2:30 PM" format. |
| 15 | Internal error text (SQL message) patient ko `details` me bheja jaata tha. | Hataya gaya. Error sirf server log me jaata hai. |

## 🟡 Staff console / backend

| # | Bug | Fix |
|---|-----|-----|
| 16 | "Today" ke appointments aur stats `CURRENT_DATE` (UTC) use karte the, isliye raat 12 se 5:30 AM IST tak kal ka data dikhta tha. | IST date use hoti hai. |
| 17 | Stats me "arrived" count missing tha, aur total galat aata tha. | Fix kiya. Deleted doctors bhi "active doctors" count se bahar hain. |
| 18 | Status kuch bhi se kuch bhi ho sakta tha (attended → no_show), aur galat "no-show" WhatsApp chala jaata tha. | Sirf valid transitions allowed hain (booked→arrived/no_show/attended, arrived→attended/no_show). Baaki pe 409. |
| 19 | Doctor edit: password length check nahi tha, aur doctor + login do alag steps me update hote the (half-update ho sakta tha). | Pehle validation, phir ek transaction me update. |
| 20 | Slot add: "25:00" ya galat date pe 500 error aata tha, aur deleted doctor ko bhi slots mil jaate the. | Validation lagaya, aur deleted doctor ke liye 404. |
| 21 | WhatsApp confirmation ke variables galat order me the (doctor, date, patient, raw time), README se mismatch. Template approve hone par bhi send fail hota. | Ek common helper: patient, doctor, date, time (reminder jaisa order). README update kiya. |
| 22 | Interakt ko `Bearer` header bheja jaata tha, jabki Interakt `Basic <key>` leta hai. | Interakt ke liye auto `Basic`. `WHATSAPP_AUTH_SCHEME` se override kar sakte ho. Timeout aur phone validation bhi add kiye. |
| 23 | README kehta tha "WhatsApp configure na ho to startup pe warning aati hai", par code chup rehta tha. Reminder job bhi bina config ke sab reminders "sent" mark kar deta tha. | Warning add ki. Bina config ke reminder job skip hota hai. |

## 🟡 Database (`schema.sql`, jo har backend start pe chalta hai)

| # | Bug | Fix |
|---|-----|-----|
| 24 | Admin ne demo doctor ka naam badla, to restart pe wahi purane naam ka **naya duplicate doctor** ban jaata tha (test: 12 → 14 doctors). | Demo doctors sirf khaali DB me seed hote hain. |
| 25 | Admin ka delete kiya hua slot restart pe wapas aa jaata tha. Inactive aur naye doctors ko bhi demo slots mil jaate the. | Sirf un active doctors ke liye seed hota hai jinke paas koi upcoming slot nahi. Date IST me. |
| 26 | Purane DB me `feedback.appointment_id` UNIQUE nahi tha, isliye `/feedback` crash hota tha (migration sirf comment me thi). | Migration automatic chalti hai (duplicates hata ke constraint add karti hai). |
| 27 | Username `dr<id>` pehle se kisi aur ka ho to seed insert fail hota tha, aur **backend start hi nahi hota tha**. | `ON CONFLICT (username) DO NOTHING`. |

## 🟡 Frontend (dashboard)

| # | Bug | Fix |
|---|-----|-----|
| 28 | **Patient feedback kabhi save nahi hota tha.** Request me login token nahi tha (hamesha 401), aur feedback kholne ka koi button bhi nahi tha. | Token add kiya. History panel me "★ Feedback dein" (attended visits ke liye). |
| 29 | Confirm-details popup ek full-screen overlay tha jisme cancel nahi tha. Patient time/doctor badal nahi sakta tha. | "Change time / doctor" button add kiya. |
| 30 | Patient ka session expire hone par "server se connection nahi ho pa raha" dikhta tha. | OTP login page pe bhej diya jaata hai. Server ka asli error (jaise number mismatch) dikhaya jaata hai. |
| 31 | Staff API calls citizen token pe fallback karti thi. Same browser me patient login ho to staff logout ho jaata tha. | Staff pages sirf staff token use karte hain. |
| 32 | **Koi bhi 403 pe staff logout** ho jaata tha (jaise "not your patient"). | Sirf 401 ya "deactivated" pe logout. |
| 33 | Login ke baad `/appointments`, `/patients`, `/manual-entry` pe wapas redirect nahi hota tha. | Role-wise allowed list. |
| 34 | Doctor schedule har 15 sec "Loading calendar…" pe blink karta tha. | Loader sirf pehli baar dikhta hai. |
| 35 | Booking ke baad history panel aur profile ka naam update nahi hota tha. | Refresh ho jaate hain. |
| 36 | Citizen login page ka logo SVG path toota hua tha. | Fix kiya. |

## Naye files
- `backend/.env.example`: sab environment variables ke saath.
- `BUGFIXES.md`: yeh file.

## Jo abhi bhi dhyan dene layak hai (fix nahi kiya, design decision hai)
- **Plain-text passwords (`password_display`)**: admin UI ke liye DB me plain-text password save hote hain. Medical system ke liye yeh risky hai. Behtar hai ki admin sirf "reset password" kare, dekh na sake.
- **Demo OTP**: 5 hardcoded numbers aur OTP `123456` hain. Production se pehle asli SMS OTP lagana zaroori hai.
- **CORS open hai** (`app.use(cors())`). Production me sirf apna dashboard domain allow karo.
- **Login pe rate-limit nahi hai.** `express-rate-limit` add karna chahiye.
- Har chat message ke saath 14 din ke **sab slots** Gemini ko jaate hain (~800 slots). Isse cost/latency badhti hai. Future me sirf matched doctors ke slots bhejna behtar hoga.
