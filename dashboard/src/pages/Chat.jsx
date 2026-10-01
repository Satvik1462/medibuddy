import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { citizenLogout, getCitizen } from "../lib/auth";
import { API_URL, formatDate, formatTime, initials } from "../lib/api";

// ---------------------------------------------------------
// Clean AI reply — fix technical date/time formats if the
// model accidentally echoes them back raw.
// ---------------------------------------------------------
function cleanAIReply(reply) {
  if (!reply) return "";
  let text = String(reply);

  text = text.replace(
    /(\w{3}) (\w{3}) (\d{1,2}) (\d{4}) 00:00:00 GMT\+0530 \(India Standard Time\)/g,
    (_, day, month, date, year) => {
      const parsed = new Date(`${day} ${month} ${date} ${year} 00:00:00 GMT+0530`);
      if (Number.isNaN(parsed.getTime())) return `${date} ${month} ${year}`;
      return parsed.toLocaleDateString("en-IN", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "Asia/Kolkata",
      });
    }
  );

  text = text.replace(/\b(\d{1,2}):(\d{2}):(\d{2})\b/g, (_, hour, minute) =>
    formatTime(`${hour}:${minute}:00`)
  );

  return text;
}

function findSelectedSlot(booking, availableSlots) {
  if (!booking?.slot_id || !Array.isArray(availableSlots)) return null;
  return availableSlots.find((slot) => Number(slot.id) === Number(booking.slot_id)) || null;
}

// All patient-side API calls go through here so an expired/invalid citizen
// session sends the patient back to the OTP login instead of showing a
// misleading "server se connection nahi ho pa raha" error.
class CitizenSessionError extends Error {}

async function citizenFetch(path, { method = "GET", body } = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${localStorage.getItem("citizen_token") || ""}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 || (response.status === 403 && /citizen/i.test(data.error || ""))) {
    citizenLogout();
    throw new CitizenSessionError(data.error || "Session expired, please log in again");
  }
  if (!response.ok) {
    const err = new Error(data.error || `Request failed (${response.status})`);
    err.status = response.status;
    throw err;
  }
  return data;
}

const WELCOME = {
  role: "assistant",
  message:
    "Namaste! Main aapka AI appointment assistant hoon. Aapko kya taklif hai (jaise 'chest me pain hai'), ya kis doctor se milna chahenge, bata dijiye.",
};

export default function App() {
  const [messages, setMessages] = useState([WELCOME]);
  const [input, setInput] = useState("");
  const [booking, setBooking] = useState({});
  const [availableSlots, setAvailableSlots] = useState([]);
  const [doctors, setDoctors] = useState([]);
  // Whether the backend/AI actually wants the doctor picker shown right
  // now (patient asked for the list, or described a symptom that matched
  // one or more specializations). Prevents the picker from appearing
  // automatically right after the greeting.
  const [showDoctorList, setShowDoctorList] = useState(false);
  const [loading, setLoading] = useState(false);
  const [appointment, setAppointment] = useState(null);
  const [patientHistory, setPatientHistory] = useState([]);
  const [returningPatient, setReturningPatient] = useState(null);
  const [feedbackOpenFor, setFeedbackOpenFor] = useState(null);
  const [feedbackRating, setFeedbackRating] = useState(5);
  const [feedbackComment, setFeedbackComment] = useState("");
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const [feedbackDoneIds, setFeedbackDoneIds] = useState(() => new Set());
  const [feedbackError, setFeedbackError] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [chatCompleted, setChatCompleted] = useState(false);

  // Re-confirm name + mobile number right before booking (see confirm-card
  // below). Prefilled from whatever the chat/patient history already has,
  // but the patient can edit either field.
  const [confirmName, setConfirmName] = useState("");
  const [confirmPhone, setConfirmPhone] = useState("");
  const [confirmError, setConfirmError] = useState("");
  const [confirmSubmitting, setConfirmSubmitting] = useState(false);
  const [confirmPrefilled, setConfirmPrefilled] = useState(false);

  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const navigate = useNavigate();
  const citizen = getCitizen();

  function handleSessionError(error) {
    if (error instanceof CitizenSessionError) {
      navigate("/citizen-login", { replace: true });
      return true;
    }
    return false;
  }

  async function loadHistory() {
    if (!citizen?.phone) return;
    try {
      const data = await citizenFetch(`/patients/history?phone=${encodeURIComponent(citizen.phone)}`);
      setReturningPatient(data.patient || null);
      setPatientHistory(Array.isArray(data.history) ? data.history : []);
    } catch (error) {
      if (!handleSessionError(error)) console.error("History load error:", error);
    }
  }

  useEffect(() => {
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [citizen?.phone]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    // Run again on the next frame too — the confirm-details card / doctor
    // picker mount with their own height a tick after this effect fires,
    // so a single synchronous scroll can land short and leave the newly
    // shown card just off-screen (looked like it "never showed up").
    const raf = requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(raf);
    // booking.doctor_id/slot_id and chatCompleted are the same values that
    // decide whether the confirm-details card / doctor picker are showing
    // (see showConfirmCard/showDoctorPicker below); using them here keeps
    // this effect above those declarations without a temporal-dead-zone
    // reference error.
  }, [messages, loading, availableSlots, doctors, appointment, booking?.doctor_id, booking?.slot_id, chatCompleted, showDoctorList]);

  // Keep the message box focused after every send/reply so the patient can
  // just keep typing without clicking back into it each time.
  useEffect(() => {
    if (!loading && !chatCompleted && inputRef.current) {
      inputRef.current.focus();
    }
  }, [loading, chatCompleted, messages]);

  async function dispatchMessage(text, { quickAction = false, confirmDetails = null } = {}) {
    if (!text || loading || chatCompleted) return;

    const userMessage = { role: "user", message: text };
    const updatedMessages = [...messages, userMessage];
    // Phone is verified during citizen login; it is never collected in chat.
    const requestBooking = { ...booking, phone: citizen?.phone || "" };

    setMessages(updatedMessages);
    setInput("");
    setLoading(true);

    try {
      const data = await citizenFetch("/ai/chat", {
        method: "POST",
        body: {
          message: text,
          history: messages,
          booking: requestBooking,
          // Tells the backend this text was generated by a UI button
          // (e.g. the doctor quick-pick card), not typed by the patient,
          // so it doesn't get mistaken for a language switch.
          quick_action: quickAction,
          // Sent only from the "confirm your details" card, right before
          // booking — the backend re-checks name + mobile number here and
          // will only ever create the appointment via this field.
          confirm_details: confirmDetails,
        },
      });

      if (Array.isArray(data.doctors) && data.doctors.length > 0) {
        // Merge, never overwrite-to-empty. Once a doctor has been selected,
        // a later turn's doctors list (e.g. from a name/phone message the
        // AI wasn't paying doctor-attention to) should never make the
        // already-chosen doctor disappear from state.
        setDoctors((prev) => {
          const byId = new Map(prev.map((d) => [d.id, d]));
          data.doctors.forEach((d) => byId.set(d.id, d));
          return Array.from(byId.values());
        });
      }
      setShowDoctorList(data.show_doctor_list === true);
      if (Array.isArray(data.available_slots)) setAvailableSlots(data.available_slots);
      if (data.booking) setBooking(data.booking);
      if (data.patient !== undefined) setReturningPatient(data.patient);
      if (Array.isArray(data.patient_history)) setPatientHistory(data.patient_history);

      const reply = cleanAIReply(data.reply || "Sorry, mujhe response nahi mila.");

      // Quick-pick buttons (e.g. "Choose a doctor") send a canned Hinglish
      // string under the hood so the AI has something to parse. Once we
      // know the conversation's language, swap the patient's own chat
      // bubble for the translated version so it doesn't sit there in
      // Hinglish while everything else is in Marathi/Hindi/etc.
      if (data.display_text) {
        updatedMessages[updatedMessages.length - 1] = {
          ...updatedMessages[updatedMessages.length - 1],
          message: data.display_text,
        };
      }

      if (data.booked && data.appointment) {
        setAppointment({
          appointment: data.appointment,
          doctor: data.doctor || null,
          slot: data.slot || null,
          booking: data.booking || {},
        });
      }

      // Keep the booking confirmation inside the conversation, then end the
      // booking chat with a clear completion message.
      const nextMessages = [...updatedMessages, {
        role: "assistant",
        message: reply || (data.booked ? "Appointment confirmed successfully." : "Sorry, mujhe response nahi mila."),
      }];
      if (data.booked && data.appointment) {
        // Keep the header profile + history panel in sync with what was
        // just booked (they used to show the old name / old visit list).
        try {
          const info = JSON.parse(localStorage.getItem("citizen_info") || "{}");
          if (data.booking?.patient_name) {
            localStorage.setItem("citizen_info", JSON.stringify({ ...info, name: data.booking.patient_name }));
          }
        } catch { /* cosmetic only */ }
        loadHistory();
        nextMessages.push({
          role: "assistant",
          message: "Appointment booking completed. Dhanyavaad!",
        });
        setChatCompleted(true);
      }
      setMessages(nextMessages);
    } catch (error) {
      if (handleSessionError(error)) return;
      console.error("AI chat error:", error);
      // A 4xx from the server carries a real, readable reason (e.g. the
      // confirm card's mobile number check) — show it instead of pretending
      // the server is unreachable.
      const message = error?.status && error.status < 500
        ? error.message
        : "Sorry, abhi server se connection nahi ho pa raha. Please thodi der baad try karein.";
      if (confirmDetails) setConfirmError(message);
      setMessages([
        ...updatedMessages,
        { role: "assistant", message },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function submitFeedback(appointmentId) {
    setFeedbackSubmitting(true);
    setFeedbackError("");
    try {
      // BUG FIX: this request had NO Authorization header, and /feedback
      // requires a citizen login — so every feedback submission failed with
      // 401. (There was also no button anywhere to open this form.)
      await citizenFetch("/feedback", {
        method: "POST",
        body: {
          appointment_id: appointmentId,
          rating: feedbackRating,
          comment: feedbackComment.trim() || null,
        },
      });
      const savedRating = feedbackRating;
      setPatientHistory((prev) => prev.map((h) => (
        h.appointment_id === appointmentId ? { ...h, feedback_rating: savedRating } : h
      )));
      setFeedbackDoneIds((prev) => new Set(prev).add(appointmentId));
      setFeedbackOpenFor(null);
      setFeedbackComment("");
      setFeedbackRating(5);
    } catch (err) {
      if (handleSessionError(err)) return;
      setFeedbackError(err.message || "Feedback save nahi hua");
    } finally {
      setFeedbackSubmitting(false);
    }
  }

  function sendMessage() {
    dispatchMessage(input.trim());
  }

  function handleKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  }

  function resetChat() {
    setMessages([WELCOME]);
    setInput("");
    setBooking({});
    setAvailableSlots([]);
    setDoctors([]);
    setShowDoctorList(false);
    setAppointment(null);
    // Keep the history panel available after starting a new chat.
    setHistoryOpen(false);
    setDetailsOpen(false);
    setChatCompleted(false);
    setConfirmName("");
    setConfirmPhone("");
    setConfirmError("");
    setConfirmPrefilled(false);
  }

  const selectedSlot = appointment?.slot || findSelectedSlot(booking, availableSlots);
  const selectedDoctor =
    appointment?.doctor ||
    doctors.find((doctor) => Number(doctor.id) === Number(booking?.doctor_id));

  const patientName = appointment?.booking?.patient_name || booking?.patient_name || "";
  const patientPhone = appointment?.booking?.phone || booking?.phone || "";
  const appointmentId = appointment?.appointment?.id;

  // Show doctor picker only when the AI actually wants it shown right now
  // (patient asked for the list or described symptoms that matched one or
  // more doctors) — never just because a doctors array happens to exist.
  const showDoctorPicker =
    !appointment && !booking?.doctor_id && showDoctorList && doctors.length > 0;

  // Once a doctor + slot are both chosen and the appointment isn't booked
  // yet, always show the "confirm your details" card — the ONLY way the
  // booking is actually finalized (see backend confirm_details gate). This
  // re-asks name + mobile number even if the AI already collected them
  // earlier in the conversation.
  const showConfirmCard =
    !appointment && !chatCompleted && !!selectedDoctor && !!selectedSlot;

  useEffect(() => {
    if (showConfirmCard && !confirmPrefilled) {
      setConfirmName(patientName || "");
      setConfirmPhone((citizen?.phone || patientPhone || "").replace(/\D/g, "").slice(-10));
      setConfirmPrefilled(true);
    }
    if (!showConfirmCard && confirmPrefilled) {
      setConfirmPrefilled(false);
      setConfirmError("");
    }
  }, [showConfirmCard, confirmPrefilled, patientName, patientPhone, citizen?.phone]);

  // BUG FIX: the confirm-details popup is a full-screen overlay with no way
  // out — once a slot was picked the patient could not change the time or
  // doctor, or even type in the chat, except by starting a brand-new chat.
  function cancelConfirmDetails() {
    setBooking((prev) => ({ ...prev, slot_id: null, pending_slot_id: null, confirmed: false }));
    setConfirmError("");
    setMessages((prev) => [
      ...prev,
      { role: "assistant", message: "Theek hai. Aap kis time aa sakte hain? Ya kisi aur doctor se milna ho to bata dijiye." },
    ]);
  }

  async function submitConfirmDetails() {
    const name = confirmName.trim();
    const phoneDigits = confirmPhone.replace(/\D/g, "").slice(-10);
    if (!name) {
      setConfirmError("Please enter your full name.");
      return;
    }
    if (phoneDigits.length !== 10) {
      setConfirmError("Please enter a valid 10-digit mobile number.");
      return;
    }
    if (citizen?.phone && phoneDigits !== String(citizen.phone).slice(-10)) {
      setConfirmError("Mobile number wahi hona chahiye jisse aapne OTP se login kiya hai.");
      return;
    }
    setConfirmError("");
    setConfirmSubmitting(true);
    try {
      await dispatchMessage(`✅ Confirmed — ${name}, +91 ${phoneDigits}`, {
        confirmDetails: { name, phone: phoneDigits },
      });
    } finally {
      setConfirmSubmitting(false);
    }
  }

  return (
    <div className="app">
      <div className="chat-container">
        {/* HEADER */}
        <div className="chat-header">
          <div className="brand-orb">
            <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 21s-7.5-4.6-10-9.3C.3 7.4 2.4 3.5 6.3 3.1c2-.2 3.9.8 5.7 2.6 1.8-1.8 3.7-2.8 5.7-2.6 3.9.4 6 4.3 4.3 8.6C19.5 16.4 12 21 12 21Z" />
            </svg>
          </div>
          <div className="header-text">
            <h1>MedAssist</h1>
            <div className="status-line">
              <span className="status-dot" />
              AI online · booking appointments
            </div>
          </div>
          <button
            className={`header-action profile-toggle-button${profileOpen ? " active" : ""}`}
            onClick={() => { setProfileOpen((open) => !open); setHistoryOpen(false); setDetailsOpen(false); }}
            title="Open profile"
          >
            Profile
          </button>
          <button
            className={`header-action phone-history-button${historyOpen ? " active" : ""}`}
            onClick={() => { setHistoryOpen((open) => !open); setDetailsOpen(false); setProfileOpen(false); }}
            title="Open appointment history"
          >
            {citizen?.phone ? `+91 ${citizen.phone}` : "History"}
          </button>
          <button
            className={`header-action${detailsOpen ? " active" : ""}`}
            onClick={() => { setDetailsOpen((open) => !open); setHistoryOpen(false); setProfileOpen(false); }}
          >
            Details
          </button>
          <button className="reset-button" onClick={resetChat}>New Chat</button>
          <button className="reset-button" onClick={() => { citizenLogout(); navigate("/citizen-login", { replace: true }); }}>Logout</button>

          {profileOpen && (
            <div className="header-popover profile-popover">
              <div className="popover-head">
                <div className="profile-popover-identity">
                  <div className="topbar-avatar profile-avatar-lg">{initials(citizen?.name || citizen?.phone || "P")}</div>
                  <div>
                    <strong>{citizen?.name || "Patient"}</strong>
                    <span>Citizen</span>
                  </div>
                </div>
                <button onClick={() => setProfileOpen(false)}>×</button>
              </div>
              <div className="details-popover-grid">
                <div><span>Name</span><b>{citizen?.name || "Not on file yet"}</b></div>
                <div><span>Phone</span><b>{citizen?.phone ? `+91 ${citizen.phone}` : "—"}</b></div>
              </div>
              <button
                type="button"
                className="profile-logout-btn"
                onClick={() => { citizenLogout(); navigate("/citizen-login", { replace: true }); }}
              >
                Log out
              </button>
            </div>
          )}

          {historyOpen && (
            <div className="header-popover history-popover">
              <div className="popover-head">
                <div>
                  <strong>Appointment History</strong>
                  <span>{patientHistory.length ? `${patientHistory.length} previous visit${patientHistory.length > 1 ? "s" : ""}` : "No previous visits"}</span>
                </div>
                <button onClick={() => setHistoryOpen(false)}>×</button>
              </div>
              {patientHistory.length > 0 ? (
                <div className="popover-list">
                  {patientHistory.slice(0, 8).map((item) => (
                    <div className="history-popover-item" key={item.appointment_id}>
                      <div className="history-popover-main">
                        <strong>{item.doctor_name || "Doctor"}</strong>
                        <span>{item.specialization || ""}</span>
                      </div>
                      <div className="history-popover-meta">
                        {item.date ? formatDate(item.date) : "—"}{item.time ? ` · ${formatTime(item.time)}` : ""} · {item.status || ""}
                      </div>
                      {item.status === "attended" && (
                        item.feedback_rating || feedbackDoneIds.has(item.appointment_id) ? (
                          <div className="history-popover-meta">
                            {"★".repeat(Number(item.feedback_rating) || 0)} Feedback diya — dhanyavaad!
                          </div>
                        ) : feedbackOpenFor === item.appointment_id ? (
                          <div className="feedback-inline" style={{ marginTop: 6 }}>
                            <div style={{ display: "flex", gap: 4 }}>
                              {[1, 2, 3, 4, 5].map((n) => (
                                <button
                                  key={n}
                                  type="button"
                                  aria-label={`${n} star`}
                                  onClick={() => setFeedbackRating(n)}
                                  style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: n <= feedbackRating ? "#f5a623" : "#c8c8c8", padding: 0 }}
                                >
                                  ★
                                </button>
                              ))}
                            </div>
                            <textarea
                              rows={2}
                              value={feedbackComment}
                              onChange={(e) => setFeedbackComment(e.target.value)}
                              placeholder="Apna anubhav likhiye (optional)"
                              style={{ width: "100%", marginTop: 4, boxSizing: "border-box" }}
                              maxLength={500}
                            />
                            {feedbackError && <div className="confirm-card-error">{feedbackError}</div>}
                            <div className="row-actions" style={{ marginTop: 4 }}>
                              <button type="button" className="btn-mini btn-good" disabled={feedbackSubmitting} onClick={() => submitFeedback(item.appointment_id)}>
                                {feedbackSubmitting ? "Saving…" : "Submit"}
                              </button>
                              <button type="button" className="btn-mini" onClick={() => { setFeedbackOpenFor(null); setFeedbackError(""); }}>Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="btn-mini"
                            style={{ marginTop: 6 }}
                            onClick={() => { setFeedbackOpenFor(item.appointment_id); setFeedbackRating(5); setFeedbackComment(""); setFeedbackError(""); }}
                          >
                            ★ Feedback dein
                          </button>
                        )
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="popover-empty">Aapki appointment history yahan dikhegi.</div>
              )}
            </div>
          )}

          {detailsOpen && (
            <div className="header-popover details-popover">
              <div className="popover-head">
                <div>
                  <strong>Appointment Details</strong>
                  <span>{appointment ? "Booking completed" : "Current booking"}</span>
                </div>
                <button onClick={() => setDetailsOpen(false)}>×</button>
              </div>
              <div className="details-popover-grid">
                <div><span>Patient</span><b>{patientName || "Not added yet"}</b></div>
                <div><span>Doctor</span><b>{selectedDoctor?.name || "Not selected yet"}</b></div>
                <div><span>Specialization</span><b>{selectedDoctor?.specialization || "—"}</b></div>
                <div><span>Date</span><b>{selectedSlot ? formatDate(selectedSlot.date) : "Not selected yet"}</b></div>
                <div><span>Time</span><b>{selectedSlot ? formatTime(selectedSlot.time) : "Nearest available slot will be suggested"}</b></div>
                <div><span>Status</span><b>{appointment ? "Confirmed" : chatCompleted ? "Completed" : "In progress"}</b></div>
              </div>
            </div>
          )}
        </div>

        {/* MESSAGES */}
        <div className="messages" ref={scrollRef}>
          {messages.map((item, index) => (
            <div
              key={index}
              className={`message-row ${item.role === "user" ? "user-row" : "assistant-row"}`}
            >
              {item.role !== "user" && <div className="avatar avatar-assistant">M</div>}
              <div className={`message ${item.role === "user" ? "user-message" : "assistant-message"}`}>
                {item.message}
              </div>
              {item.role === "user" && (
                <div className="avatar avatar-user">{initials(patientName) === "?" ? "P" : initials(patientName)}</div>
              )}
            </div>
          ))}

          {loading && (
            <div className="message-row assistant-row">
              <div className="avatar avatar-assistant">M</div>
              <div className="message assistant-message">
                <span className="typing-dots">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            </div>
          )}

          {/* DOCTOR QUICK-PICK */}
          {showDoctorPicker && !loading && (
            <div className="quick-actions">
              <p className="quick-label">Choose a doctor</p>
              <div className="doctor-scroll">
                {doctors.map((doc) => (
                  <button
                    key={doc.id}
                    className="doctor-card"
                    onClick={() => dispatchMessage(`Mujhe ${doc.name} (${doc.specialization}) ke saath appointment chahiye`, { quickAction: true })}
                  >
                    <div className="doctor-avatar">{initials(doc.name)}</div>
                    <div>
                      <strong>{doc.name}</strong>
                      <span>{doc.specialization}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}


          {/* PROPOSED SLOT — one-tap Yes / No */}
          {booking?.pending_slot_id && !booking?.slot_id && !appointment && !loading && !chatCompleted && (
            <div className="quick-actions">
              <div className="row-actions">
                <button type="button" className="btn-mini btn-good" onClick={() => dispatchMessage("Haan", { quickAction: true })}>Haan, aa jaunga</button>
                <button type="button" className="btn-mini btn-bad" onClick={() => dispatchMessage("Nahi", { quickAction: true })}>Nahi, doosra time</button>
              </div>
            </div>
          )}

          {/* APPOINTMENT CONFIRMED TICKET */}
          {appointment?.appointment && (
            <div className="ticket">
              <div className="ticket-head">
                <div className="ticket-check">✓</div>
                <div>
                  <strong>Appointment Confirmed</strong>
                  <span>Your visit is booked — see you soon</span>
                </div>
              </div>
              <div className="ticket-divider" />
              <div className="ticket-grid">
                <div className="ticket-item">
                  <label>Patient</label>
                  <strong>{patientName || "—"}</strong>
                </div>
                <div className="ticket-item">
                  <label>Phone</label>
                  <strong>{patientPhone || "—"}</strong>
                </div>
                <div className="ticket-item">
                  <label>Doctor</label>
                  <strong>{selectedDoctor?.name || "—"}</strong>
                </div>
                <div className="ticket-item">
                  <label>Specialization</label>
                  <strong>{selectedDoctor?.specialization || "—"}</strong>
                </div>
                <div className="ticket-item">
                  <label>Date</label>
                  <strong>{selectedSlot ? formatDate(selectedSlot.date) : "—"}</strong>
                </div>
                <div className="ticket-item">
                  <label>Time</label>
                  <strong>{selectedSlot ? formatTime(selectedSlot.time) : "—"}</strong>
                </div>
              </div>
              {appointmentId && (
                <div className="ticket-id">
                  Appointment ID: <strong>#{appointmentId}</strong>
                </div>
              )}
            </div>
          )}

        </div>

        {/* INPUT */}
        <div className="input-area">
          <div className="input-pill">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type your message..."
              disabled={loading || chatCompleted}
              rows={1}
              autoFocus
            />
          </div>
          <button className="send-button" onClick={sendMessage} disabled={loading || chatCompleted || !input.trim()}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 2 11 13" />
              <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
            </svg>
          </button>
        </div>
        <div className={`hint${chatCompleted ? " completed-hint" : ""}`}>{chatCompleted ? "Appointment booking completed · Start New Chat for another appointment" : "Press Enter to send"}</div>
      </div>

      {/* CONFIRM YOUR DETAILS — re-ask name + mobile before booking.
          Rendered as a fixed, viewport-centered overlay (not inside the
          scrolling message list) so it is always fully visible, on any
          screen size, regardless of how tall the chat panel is or how far
          the user has scrolled. */}
      {showConfirmCard && !loading && (
        <div className="confirm-modal-backdrop">
          <div className="confirm-card">
            <div className="confirm-card-head">
              <strong>Confirm your details</strong>
              <span>Booking finalize karne se pehle apna naam aur mobile number confirm kar dijiye.</span>
            </div>
            <div className="confirm-card-body">
              <label>
                Full name
                <input
                  type="text"
                  value={confirmName}
                  onChange={(event) => setConfirmName(event.target.value)}
                  placeholder="Patient's full name"
                  disabled={loading || confirmSubmitting}
                  autoFocus
                />
              </label>
              <label>
                Mobile number
                <input
                  type="tel"
                  inputMode="numeric"
                  value={confirmPhone}
                  onChange={(event) => setConfirmPhone(event.target.value.replace(/\D/g, "").slice(-10))}
                  placeholder="10-digit mobile number"
                  maxLength={10}
                  // Verified by OTP at login — the booking is always made on this number.
                  readOnly={Boolean(citizen?.phone)}
                  title={citizen?.phone ? "Verified at login" : undefined}
                  disabled={loading || confirmSubmitting}
                />
              </label>
              {confirmError && <p className="confirm-card-error">{confirmError}</p>}
            </div>
            <div className="confirm-card-actions" style={{ display: "flex", gap: 10 }}>
              <button
                type="button"
                className="btn-mini"
                style={{ flex: 1 }}
                onClick={cancelConfirmDetails}
                disabled={loading || confirmSubmitting}
              >
                Change time / doctor
              </button>
              <button
                type="button"
                className="btn-primary"
                style={{ flex: 2 }}
                onClick={submitConfirmDetails}
                disabled={loading || confirmSubmitting}
              >
                {confirmSubmitting ? "Confirming…" : "Confirm & Book Appointment"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
