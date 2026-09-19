import { useEffect, useMemo, useRef, useState } from "react";
import Shell from "../components/Shell";
import { getJSON, postJSON, todayISO, formatDate, formatTime } from "../lib/api";

// A single dropdown that IS the search box — click it to open, type to
// filter, click an option to pick it. Replaces a plain <select> plus a
// separate search input sitting below it.
function DoctorCombobox({ doctors, value, onChange, loading }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  const selected = doctors.find((d) => Number(d.id) === Number(value));

  useEffect(() => {
    function onOutside(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, []);

  function openPanel() {
    if (loading) return;
    setOpen(true);
    setQuery("");
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function pick(doctor) {
    onChange(String(doctor.id));
    setOpen(false);
    setQuery("");
  }

  const filtered = doctors.filter((d) =>
    `${d.name} ${d.specialization || ""}`.toLowerCase().includes(query.trim().toLowerCase())
  );

  return (
    <div className="doctor-combobox" ref={wrapRef}>
      {open ? (
        <input
          ref={inputRef}
          className="doctor-combobox-input"
          placeholder="Search doctors by name or specialization…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      ) : (
        <button type="button" className="doctor-combobox-trigger" onClick={openPanel} disabled={loading}>
          <span className={selected ? "" : "doctor-combobox-placeholder"}>
            {loading ? "Loading doctors…" : selected ? `${selected.name} — ${selected.specialization || "General Physician"}` : "Select doctor"}
          </span>
          <span className="doctor-combobox-caret">▾</span>
        </button>
      )}
      {open && (
        <div className="doctor-combobox-panel">
          {filtered.length === 0 ? (
            <div className="doctor-combobox-empty">No doctor matches "{query}".</div>
          ) : (
            filtered.map((d) => (
              <button
                type="button"
                key={d.id}
                className={`doctor-combobox-option${Number(d.id) === Number(value) ? " active" : ""}`}
                onClick={() => pick(d)}
              >
                {d.name} — {d.specialization || "General Physician"}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default function ManualEntry() {
  const [doctors, setDoctors] = useState([]);
  const [slots, setSlots] = useState([]);
  const [form, setForm] = useState({
    patient_name: "",
    phone: "",
    doctor_id: "",
    date: todayISO(),
    slot_id: "",
    chat_summary: "",
  });
  const [loadingDoctors, setLoadingDoctors] = useState(true);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(null);

  useEffect(() => {
    getJSON("/doctors?all=true")
      .then((data) => setDoctors(data.filter((d) => d.active)))
      .catch((err) => setError(err.message))
      .finally(() => setLoadingDoctors(false));
  }, []);

  useEffect(() => {
    setForm((v) => ({ ...v, slot_id: "" }));
    if (!form.doctor_id || !form.date) {
      setSlots([]);
      return;
    }
    setLoadingSlots(true);
    getJSON(`/slots?doctor_id=${form.doctor_id}&date=${form.date}`)
      .then(setSlots)
      .catch((err) => { setSlots([]); setError(err.message); })
      .finally(() => setLoadingSlots(false));
  }, [form.doctor_id, form.date]);

  const selectedDoctor = useMemo(
    () => doctors.find((d) => Number(d.id) === Number(form.doctor_id)),
    [doctors, form.doctor_id]
  );
  const selectedSlot = useMemo(
    () => slots.find((s) => Number(s.id) === Number(form.slot_id)),
    [slots, form.slot_id]
  );

  function update(field, value) {
    setForm((v) => ({ ...v, [field]: value }));
    setError("");
    setSuccess(null);
  }

  async function submit(event) {
    event.preventDefault();
    setError("");
    setSuccess(null);
    const phone = form.phone.replace(/\D/g, "").slice(-10);
    if (!form.patient_name.trim() || phone.length !== 10 || !form.doctor_id || !form.slot_id) {
      setError("Please fill patient name, valid 10-digit mobile number, doctor and appointment time.");
      return;
    }
    setSaving(true);
    try {
      const data = await postJSON("/manual-appointments", {
        patient_name: form.patient_name.trim(),
        phone,
        doctor_id: Number(form.doctor_id),
        slot_id: Number(form.slot_id),
        chat_summary: form.chat_summary.trim(),
      });
      setSuccess(data);
      setForm({ patient_name: "", phone: "", doctor_id: "", date: todayISO(), slot_id: "", chat_summary: "" });
      setSlots([]);
    } catch (err) {
      setError(err.message || "Could not create appointment");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Shell title="Manual Patient Entry" subtitle="Book an appointment for a walk-in or personally registered patient without the chatbot.">
      <div className="panel manual-entry-panel">
        <div className="manual-entry-intro">
          <div>
            <h2>New manual appointment</h2>
            <p>Use the same core details collected by the chatbot: patient name, mobile, medical complaint, doctor and appointment time.</p>
          </div>
          <span className="manual-badge">MANUAL ENTRY</span>
        </div>

        {error && <div className="banner banner-error">{error}</div>}
        {success && (
          <div className="banner banner-success">
            Appointment created for <strong>{success.patient?.name}</strong> with <strong>{success.doctor?.name}</strong> on <strong>{formatDate(success.slot?.date)}</strong> at <strong>{formatTime(success.slot?.time)}</strong>.
          </div>
        )}

        <form className="manual-entry-form" onSubmit={submit}>
          <div className="form-section-title">Patient details</div>
          <div className="manual-form-grid">
            <label>Full name<input value={form.patient_name} onChange={(e) => update("patient_name", e.target.value)} placeholder="Patient's full name" /></label>
            <label>Mobile number<input value={form.phone} onChange={(e) => update("phone", e.target.value.replace(/\D/g, "").slice(-10))} inputMode="numeric" maxLength={10} placeholder="10-digit mobile number" /></label>
          </div>

          <label className="manual-full-field">Medical complaint / problem
            <textarea value={form.chat_summary} onChange={(e) => update("chat_summary", e.target.value)} rows={4} placeholder="e.g. Pair mein dard hai aur chalne mein dikkat ho rahi hai" />
            <span className="field-help">Only the patient's complaint is stored in the doctor/reception summary.</span>
          </label>

          <div className="form-section-title">Appointment details</div>
          <div className="manual-form-grid">
            <label>Doctor
              <DoctorCombobox doctors={doctors} value={form.doctor_id} onChange={(v) => update("doctor_id", v)} loading={loadingDoctors} />
            </label>
            <label>Date<input type="date" value={form.date} min={todayISO()} onChange={(e) => update("date", e.target.value)} /></label>
          </div>

          <label className="manual-full-field">Available appointment time
            <select value={form.slot_id} onChange={(e) => update("slot_id", e.target.value)} disabled={!form.doctor_id || !form.date || loadingSlots}>
              <option value="">{loadingSlots ? "Loading available times…" : form.doctor_id ? "Select available time" : "Select doctor first"}</option>
              {slots.map((slot) => <option key={slot.id} value={slot.id}>{formatTime(slot.time)}</option>)}
            </select>
            {selectedDoctor && selectedSlot && <span className="field-help">{selectedDoctor.name} · {selectedDoctor.specialization || "General Physician"} · {formatDate(selectedSlot.date)} · {formatTime(selectedSlot.time)}</span>}
            {!loadingSlots && form.doctor_id && form.date && !slots.length && <span className="field-help">No future available slot for this doctor on this date. Add a slot from the Admin Panel first.</span>}
          </label>

          <div className="manual-entry-actions">
            <button className="btn-primary" type="submit" disabled={saving || loadingDoctors || loadingSlots}>{saving ? "Creating appointment…" : "Create Manual Appointment"}</button>
          </div>
        </form>
      </div>
    </Shell>
  );
}
