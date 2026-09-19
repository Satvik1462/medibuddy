import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import Shell from "../components/Shell";
import { FilterIcon } from "../components/icons";
import { getJSON, postJSON, putJSON, deleteJSON, formatDate, formatTime, todayISO, cleanMedicalSummary } from "../lib/api";

const TABS = [{ id: "doctors", label: "Doctors" }, { id: "slots", label: "Calendar & Slots" }, { id: "reception", label: "Reception Login" }, { id: "feedback", label: "Feedback" }];
function Stars({ rating }) { return <span className="stars" aria-label={`${rating} out of 5`}>{"★★★★★".slice(0, rating)}<span className="stars-empty">{"★★★★★".slice(rating)}</span></span>; }

// Common clinic specializations for the searchable dropdown below. Typing a
// value that isn't in this list is still allowed — it just won't show a
// matching suggestion — so admins aren't blocked from entering something
// specific to their hospital.
const SPECIALIZATIONS = [
  "General Physician", "Cardiologist", "Dermatologist", "Neurologist",
  "Orthopedic", "Pediatrician", "Gynecologist", "ENT Specialist",
  "Ophthalmologist", "Psychiatrist", "Dentist", "Urologist",
  "Gastroenterologist", "Endocrinologist", "Pulmonologist", "Nephrologist",
  "Oncologist", "Radiologist", "Anesthesiologist", "General Surgeon",
  "Rheumatologist", "Diabetologist", "Physiotherapist", "Dietitian / Nutritionist",
];

// Searchable specialization dropdown: typing filters the suggestion list,
// clicking a suggestion fills the field, and a value not in the list can
// still be typed and kept as-is.
function SpecializationCombobox({ value, onChange, placeholder }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    function onOutside(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, []);

  const filtered = SPECIALIZATIONS.filter((s) =>
    s.toLowerCase().includes(value.trim().toLowerCase())
  );

  return (
    <div className="specialization-combobox" ref={wrapRef}>
      <input
        placeholder={placeholder}
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
      />
      {open && (
        <div className="specialization-combobox-panel">
          {value.trim() && <div className="specialization-combobox-hint">Suggestions</div>}
          {filtered.length === 0 ? (
            <div className="specialization-combobox-empty">No match — you can still use "{value.trim() || "…"}" as a custom specialization.</div>
          ) : (
            filtered.map((s) => (
              <button
                type="button"
                key={s}
                className={`specialization-combobox-option${s.toLowerCase() === value.trim().toLowerCase() ? " active" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onChange(s); setOpen(false); }}
              >
                {s}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// Shift windows the bulk slot generator offers, and the min/max time each
// one is bounded to (24h "HH:MM").
const SHIFTS = {
  morning: { label: "Morning", range: "8:00 AM – 12:00 PM", min: "08:00", max: "12:00" },
  afternoon: { label: "Afternoon", range: "12:00 PM – 4:00 PM", min: "12:00", max: "16:00" },
  evening: { label: "Evening", range: "4:00 PM – 8:00 PM", min: "16:00", max: "20:00" },
};

// Every half-hour mark between a shift's min and max (inclusive), used to
// populate the "from"/"to" pickers.
function halfHourMarks(min, max) {
  const marks = [];
  let [h, m] = min.split(":").map(Number);
  const [maxH, maxM] = max.split(":").map(Number);
  while (h < maxH || (h === maxH && m <= maxM)) {
    marks.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    m += 30;
    if (m >= 60) { m -= 60; h += 1; }
  }
  return marks;
}

// Every half-hour slot from "from" to "to" inclusive — this is the actual
// list of appointment start times the generator proposes.
function buildHalfHourSlots(from, to) {
  if (!from || !to || from > to) return [];
  return halfHourMarks(from, to);
}

// Bulk "Add slots" popup for one doctor: pick a shift, narrow the time
// range within that shift's bounds, review/edit the auto-generated
// half-hour slots, then create them all at once.
function AddSlotsModal({ doctor, date, existingTimes, onClose, onCreated, notify }) {
  const [shift, setShift] = useState(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [removed, setRemoved] = useState(() => new Set());
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(null);

  function pickShift(key) {
    setShift(key);
    setFrom(SHIFTS[key].min);
    setTo(SHIFTS[key].max);
    setRemoved(new Set());
  }

  const marks = shift ? halfHourMarks(SHIFTS[shift].min, SHIFTS[shift].max) : [];
  const generated = useMemo(
    () => (shift ? buildHalfHourSlots(from, to) : []),
    [shift, from, to]
  );
  const preview = generated.filter((t) => !removed.has(t));

  function removeTime(t) {
    setRemoved((prev) => new Set(prev).add(t));
  }

  async function handleDone() {
    if (!preview.length) return;
    setSaving(true);
    try {
      await postJSON("/slots", { doctor_id: doctor.id, date, times: preview });
      setDone({ count: preview.length });
      await onCreated();
    } catch (err) {
      notify(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="confirm-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="confirm-card bulk-slots-card" onClick={(e) => e.stopPropagation()}>
        {done ? (
          <div className="confirm-card-body bulk-slots-confirm">
            <div className="tick">✓</div>
            <strong>{done.count} slot{done.count === 1 ? "" : "s"} added</strong>
            <span>{doctor.name} · {formatDate(date)}</span>
            <div className="confirm-card-actions" style={{ padding: "16px 0 0" }}>
              <button className="btn-primary" style={{ width: "100%" }} onClick={onClose}>Close</button>
            </div>
          </div>
        ) : (
          <>
            <div className="confirm-card-head">
              <span className="modal-eyebrow">Add slots</span>
              <strong>{doctor.name}</strong>
              <span>{doctor.specialization || "No specialization set"} · {formatDate(date)}</span>
            </div>
            <div className="confirm-card-body bulk-slots-body">
              <div className="bulk-slots-section">
                <label>Shift</label>
                <div className="shift-picker">
                  {Object.entries(SHIFTS).map(([key, s]) => (
                    <button
                      type="button"
                      key={key}
                      className={`shift-option${shift === key ? " active" : ""}`}
                      onClick={() => pickShift(key)}
                    >
                      <strong>{s.label}</strong>
                      <span>{s.range}</span>
                    </button>
                  ))}
                </div>
              </div>

              {shift && (
                <div className="bulk-slots-section">
                  <label>Time range within {SHIFTS[shift].label.toLowerCase()}</label>
                  <div className="slot-range-row">
                    <select value={from} onChange={(e) => { setFrom(e.target.value); setRemoved(new Set()); }}>
                      {marks.filter((t) => t <= to).map((t) => (
                        <option key={t} value={t}>{formatTime(t)}</option>
                      ))}
                    </select>
                    <span className="slot-range-sep">to</span>
                    <select value={to} onChange={(e) => { setTo(e.target.value); setRemoved(new Set()); }}>
                      {marks.filter((t) => t >= from).map((t) => (
                        <option key={t} value={t}>{formatTime(t)}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {shift && (
                <div className="bulk-slots-section">
                  <div className="slot-preview-head">
                    <label style={{ margin: 0 }}>Generated slots (half-hour apart)</label>
                    <span className="slot-preview-count">{preview.length} slot{preview.length === 1 ? "" : "s"}</span>
                  </div>
                  {generated.length === 0 ? (
                    <div className="slot-preview-empty">Pick a valid range to generate slots.</div>
                  ) : (
                    <div className="slot-preview-grid">
                      {generated.map((t) => {
                        const already = existingTimes.has(t);
                        const isRemoved = removed.has(t);
                        if (isRemoved) return null;
                        return (
                          <span className="slot-preview-chip" key={t} title={already ? "Already exists for this date" : ""}>
                            {formatTime(t)}{already ? " ·" : ""}
                            <button type="button" onClick={() => removeTime(t)} aria-label={`Remove ${formatTime(t)}`}>×</button>
                          </span>
                        );
                      })}
                      {preview.length === 0 && <div className="slot-preview-empty">All slots removed — add at least one to continue.</div>}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="confirm-card-actions add-doctor-actions" style={{ display: "flex", gap: 10 }}>
              <button type="button" className="btn-mini" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
              <button
                type="button"
                className="btn-primary"
                style={{ flex: 1 }}
                disabled={!shift || preview.length === 0 || saving}
                onClick={handleDone}
              >
                {saving ? "Adding…" : "Done"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function DoctorDetailModal({ doctors, index, setIndex, onClose }) {
  const doc = doctors[index];
  if (!doc) return null;
  return (
    <div className="confirm-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="confirm-card patient-detail-card" onClick={e => e.stopPropagation()}>
        <div className="confirm-card-head">
          <span className="modal-eyebrow">Doctor Details</span>
          <strong>{doc.name}</strong>
          <span>{doc.specialization || "No specialization set"}</span>
        </div>
        <div className="confirm-card-body patient-detail-body">
          <div className="detail-row">
            <label>Login username</label>
            <div><code>{doc.login_username || `dr${doc.id}`}</code></div>
          </div>
          <div className="detail-row">
            <label>Password</label>
            <div><code>{doc.login_password || "Not set"}</code></div>
          </div>
          <div className="detail-row">
            <label>Status</label>
            <div><span className={`badge ${doc.active ? "badge-attended" : "badge-no_show"}`}>{doc.active ? "Active" : "Inactive"}</span></div>
          </div>
        </div>
        <div className="confirm-card-actions patient-detail-nav">
          <button className="btn-mini" disabled={index <= 0} onClick={() => setIndex(index - 1)}>← Previous</button>
          <span className="cell-sub">{index + 1} / {doctors.length}</span>
          <button className="btn-mini" disabled={index >= doctors.length - 1} onClick={() => setIndex(index + 1)}>Next →</button>
        </div>
        <div className="confirm-card-actions">
          <button className="btn-mini" style={{ width: "100%" }} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// Read-only appointment history for one doctor. Works for a doctor who is
// still on the roster as well as one sitting in "Deleted Doctors" — deleting
// a doctor now archives them instead of wiping their rows, so this list
// survives the delete.
function DoctorHistoryModal({ doctorId, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setData(null); setError("");
    getJSON(`/doctors/${doctorId}/history`)
      .then(d => { if (alive) setData(d); })
      .catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [doctorId]);

  const doc = data?.doctor;
  const rows = data?.appointments || [];
  const attended = rows.filter(r => r.status === "attended").length;
  const noShow = rows.filter(r => r.status === "no_show").length;
  const upcoming = rows.filter(r => r.status === "booked").length;

  return (
    <div className="confirm-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="confirm-card archive-card" onClick={e => e.stopPropagation()}>
        <div className="confirm-card-head">
          <span className="modal-eyebrow">Doctor history</span>
          <strong>{doc ? doc.name : "Loading…"}</strong>
          <span>
            {doc ? (doc.specialization || "No specialization set") : "\u00a0"}
            {doc?.deleted_at ? ` · Deleted on ${formatDate(doc.deleted_at)}${doc.deleted_by ? ` by ${doc.deleted_by}` : ""}` : ""}
          </span>
        </div>
        <div className="confirm-card-body archive-body">
          {error && <div className="banner banner-error">{error}</div>}
          {!data && !error && <div className="empty-state">Loading history…</div>}
          {data && (
            <>
              <div className="archive-stats">
                <div><strong>{rows.length}</strong><span>Total appointments</span></div>
                <div><strong>{attended}</strong><span>Attended</span></div>
                <div><strong>{upcoming}</strong><span>Still booked</span></div>
                <div><strong>{noShow}</strong><span>No show</span></div>
              </div>
              {doc?.delete_reason && (
                <div className="info-note" style={{ marginTop: 12 }}>
                  <b>Reason for deletion:</b> {doc.delete_reason}
                </div>
              )}
              {rows.length === 0 ? (
                <div className="empty-state">No appointments were ever booked with this doctor.</div>
              ) : (
                <div className="table-wrap" style={{ marginTop: 12 }}>
                  <table className="data-table">
                    <thead><tr><th>Date</th><th>Time</th><th>Patient</th><th>Complaint</th><th>Status</th><th>Feedback</th></tr></thead>
                    <tbody>
                      {rows.map(r => (
                        <tr key={r.id}>
                          <td>{r.date ? formatDate(r.date) : "—"}</td>
                          <td>{r.time ? formatTime(r.time) : "—"}</td>
                          <td>
                            <strong>{r.patient_name || "—"}</strong>
                            {r.patient_phone && <div className="cell-sub">{r.patient_phone}</div>}
                          </td>
                          <td>{cleanMedicalSummary(r.chat_summary) || "—"}</td>
                          <td><span className={`badge badge-${r.status}`}>{r.status.replace("_", " ")}</span></td>
                          <td>{r.rating ? <><Stars rating={r.rating} />{r.comment && <div className="cell-sub">{r.comment}</div>}</> : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
        <div className="confirm-card-actions">
          <button className="btn-mini" style={{ width: "100%" }} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// The "Deleted Doctors" drawer: everyone the admin has removed, with the
// history kept for each of them and a Restore action. There is deliberately
// no "erase for good" here — the whole point is that the appointment history
// and chat summaries survive a delete.
function DeletedDoctorsModal({ onClose, onChanged }) {
  const [list, setList] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [historyId, setHistoryId] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try { setList(await getJSON("/doctors/deleted")); }
    catch (e) { setError(e.message); setList([]); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function restore(doc) {
    setBusyId(doc.id); setError("");
    try {
      await postJSON(`/doctors/${doc.id}/restore`, { activate: true });
      await load();
      await onChanged();
    } catch (e) { setError(e.message); }
    finally { setBusyId(null); }
  }

  return (
    <>
      <div className="confirm-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
        <div className="confirm-card archive-card" onClick={e => e.stopPropagation()}>
          <div className="confirm-card-head">
            <span className="modal-eyebrow">Archive</span>
            <strong>Deleted Doctors</strong>
            <span>Deleted doctors are kept here with their full appointment history. Restore one to put them back on the roster.</span>
          </div>
          <div className="confirm-card-body archive-body">
            {error && <div className="banner banner-error">{error}</div>}
            {list === null && <div className="empty-state">Loading…</div>}
            {list && list.length === 0 && <div className="empty-state">No deleted doctors. Anyone you delete will show up here.</div>}
            {list && list.length > 0 && (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>Doctor</th><th>Deleted</th><th>History kept</th><th>Rating</th><th>Actions</th></tr></thead>
                  <tbody>
                    {list.map(doc => (
                      <tr key={doc.id}>
                        <td>
                          <strong>{doc.name}</strong>
                          <div className="cell-sub">{doc.specialization || "No specialization"} · <code>{doc.login_username || `dr${doc.id}`}</code></div>
                        </td>
                        <td>
                          {formatDate(doc.deleted_at)}
                          <div className="cell-sub">by {doc.deleted_by || "admin"}</div>
                          {doc.delete_reason && <div className="cell-sub">{doc.delete_reason}</div>}
                        </td>
                        <td>
                          {doc.appointments} appointment{doc.appointments === 1 ? "" : "s"}
                          <div className="cell-sub">
                            {doc.attended} attended{doc.upcoming ? ` · ${doc.upcoming} still booked` : ""}
                          </div>
                          {doc.last_appointment && <div className="cell-sub">Last: {formatDate(doc.last_appointment)}</div>}
                        </td>
                        <td>{doc.avg_rating ? <>{doc.avg_rating} ★<div className="cell-sub">{doc.feedback_count} review{doc.feedback_count === 1 ? "" : "s"}</div></> : "—"}</td>
                        <td>
                          <div className="row-actions">
                            <button className="btn-mini" onClick={() => setHistoryId(doc.id)}>View history</button>
                            <button className="btn-mini btn-good" disabled={busyId === doc.id} onClick={() => restore(doc)}>
                              {busyId === doc.id ? "Working…" : "Restore"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="confirm-card-actions">
            <button className="btn-mini" style={{ width: "100%" }} onClick={onClose}>Close</button>
          </div>
        </div>
      </div>

      {historyId !== null && (
        <DoctorHistoryModal doctorId={historyId} onClose={() => setHistoryId(null)} />
      )}
    </>
  );
}

function DoctorsTab({ doctors, reload, notify, openAdd, onOpenAddHandled }) {
  const [name, setName] = useState("Dr. ");
  const [specialization, setSpecialization] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showAddPassword, setShowAddPassword] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editValues, setEditValues] = useState({ name: "", specialization: "", username: "", password: "" });
  const [detailIndex, setDetailIndex] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  // Error from "Add doctor" (e.g. username already in use) — shown inside the
  // popup itself, because the page-level banner sits hidden behind the popup.
  const [addError, setAddError] = useState("");
  // Permanent delete: ticked rows (ids) and the doctors currently waiting on the
  // "are you sure?" popup.
  const [deleteTargets, setDeleteTargets] = useState(null);
  const [deleting, setDeleting] = useState(false);
  // The doctor just created via "Add doctor + login" — while this is set,
  // the bulk "Add slots" popup opens for them right away so the admin can
  // give the new doctor slots without hunting for them in the calendar tab.
  const [slotsForNewDoctor, setSlotsForNewDoctor] = useState(null);
  // "Deleted Doctors" archive: the drawer itself, how many are in there (for
  // the button's badge), and the history popup opened from a live doctor row.
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deletedCount, setDeletedCount] = useState(0);
  const [historyDoctor, setHistoryDoctor] = useState(null);

  const refreshDeletedCount = useCallback(async () => {
    try { setDeletedCount((await getJSON("/doctors/deleted")).length); }
    catch { /* the badge is cosmetic — a failure here shouldn't break the tab */ }
  }, []);

  useEffect(() => { refreshDeletedCount(); }, [refreshDeletedCount]);

  // The sidebar's "Add Doctor" shortcut lands here via /admin?add=doctor —
  // pop the modal open on arrival, then let the parent clear the param.
  useEffect(() => {
    if (openAdd) { setAddOpen(true); onOpenAddHandled(); }
  }, [openAdd, onOpenAddHandled]);

  function closeAddModal() {
    setAddOpen(false);
    setName("Dr. "); setSpecialization(""); setUsername(""); setPassword("");
    setAddError("");
  }
  // Set when the name+specialization the admin just typed matches an
  // existing doctor — holds the matched doctor so the confirm popup can
  // show its name, until the admin picks Yes (add anyway) or No (cancel).
  const [duplicateMatch, setDuplicateMatch] = useState(null);

  async function performAddDoctor() {
    setSaving(true);
    setAddError("");
    try {
      const res = await postJSON("/doctors", {
        name: name.trim(),
        specialization: specialization.trim(),
        username: username.trim(),
        password,
      });
      setName("Dr. "); setSpecialization(""); setUsername(""); setPassword("");
      setAddOpen(false);
      await reload();
      // Doctor's created with no slots yet — open the bulk "Add slots"
      // popup for them straight away instead of leaving the admin to find
      // the new doctor in the Calendar & Slots tab themselves.
      if (res?.doctor) setSlotsForNewDoctor(res.doctor);
    } catch (err) { setAddError(err.message || "Could not add doctor"); } finally { setSaving(false); }
  }

  function addDoctor(e) {
    e.preventDefault();
    if (!name.trim() || !username.trim() || !password.trim()) return;

    // Same name + same specialization as an already-added doctor? Ask
    // the admin to confirm before creating what might be a duplicate
    // entry (or genuinely another doctor with the same name).
    const existing = doctors.find(
      d =>
        d.name.trim().toLowerCase() === name.trim().toLowerCase() &&
        (d.specialization || "").trim().toLowerCase() === specialization.trim().toLowerCase()
    );
    if (existing) {
      setDuplicateMatch(existing);
      return;
    }
    performAddDoctor();
  }

  function confirmAddDuplicate() {
    setDuplicateMatch(null);
    performAddDoctor();
  }

  function cancelAddDuplicate() {
    setDuplicateMatch(null);
  }

  async function toggleActive(d) {
    try { await putJSON(`/doctors/${d.id}`, { active: !d.active }); await reload(); }
    catch (err) { notify(err.message); }
  }

  function startEdit(d) {
    setEditingId(d.id);
    setEditValues({
      name: d.name || "",
      specialization: d.specialization || "",
      username: d.login_username || `dr${d.id}`,
      password: "",
    });
  }

  function cancelEdit() { setEditingId(null); }

  async function saveEdit(id) {
    try {
      const payload = {
        name: editValues.name.trim(),
        specialization: editValues.specialization.trim(),
        username: editValues.username.trim(),
      };
      if (editValues.password.trim()) payload.password = editValues.password;
      await putJSON(`/doctors/${id}`, payload);
      setEditingId(null);
      await reload();
    } catch (err) { notify(err.message); }
  }

  async function performDelete() {
    if (!deleteTargets || !deleteTargets.length) return;
    setDeleting(true);
    const failed = [];
    for (const d of deleteTargets) {
      try { await deleteJSON(`/doctors/${d.id}`); }
      catch (err) { failed.push(`${d.name}: ${err.message}`); }
    }
    setDeleteTargets(null);
    setDeleting(false);
    await reload();
    await refreshDeletedCount();
    if (failed.length) notify(`Could not delete ${failed.length} doctor(s) — ${failed.join("; ")}`);
  }

  const filtered = doctors.filter(d =>
    `${d.name} ${d.specialization || ""} ${d.login_username || `dr${d.id}`}`.toLowerCase().includes(search.toLowerCase())
  );

  return <div className="admin-tab-body">
    <div className="toolbar-row">
      <div className="search-with-filter wide">
        <input className="doctor-search wide" placeholder="Search doctors / specialization / login…" value={search} onChange={e => setSearch(e.target.value)} />
        <FilterIcon className="search-filter-icon" />
      </div>
      <button type="button" className="btn-mini btn-archive" onClick={() => setArchiveOpen(true)}>
        Deleted Doctors{deletedCount ? ` (${deletedCount})` : ""}
      </button>
      <button type="button" className="btn-primary btn-add-doctor" onClick={() => setAddOpen(true)}>+ Add Doctor</button>
    </div>

    <div className="info-note">Deleting a doctor moves them to <b>Deleted Doctors</b> along with their full appointment history, so nothing is lost and they can be restored later. Admin can set each doctor's login while adding them. Username and password can also be changed later from <b>Edit</b>. The admin can view each doctor's current password in the doctor list.</div>

    {addOpen && (
      <div className="confirm-modal-backdrop" role="dialog" aria-modal="true" onClick={closeAddModal}>
        <div className="confirm-card add-doctor-card" onClick={e => e.stopPropagation()}>
          <div className="confirm-card-head">
            <strong>Add doctor + login</strong>
            <span>Create a doctor profile and their staff console login in one go.</span>
          </div>
          <form className="confirm-card-body add-doctor-form" onSubmit={addDoctor}>
            <div>
              <label>Doctor name</label>
              <input placeholder="e.g. Dr. Mehta" value={name} onChange={e => { setName(e.target.value); setAddError(""); }} />
            </div>
            <div>
              <label>Specialization</label>
              <SpecializationCombobox placeholder="e.g. Dermatologist" value={specialization} onChange={setSpecialization} />
            </div>
            <div>
              <label>Username</label>
              <input placeholder="e.g. drmehta" value={username} onChange={e => { setUsername(e.target.value); setAddError(""); }} required />
            </div>
            <div>
              <label>Password</label>
              <div className="password-field"><input type={showAddPassword ? "text" : "password"} placeholder="Min 6 characters" value={password} onChange={e => { setPassword(e.target.value); setAddError(""); }} minLength={6} required /><button type="button" className="password-toggle" onClick={() => setShowAddPassword(v => !v)}>{showAddPassword ? "Hide" : "Show"}</button></div>
            </div>
            {addError && <div className="banner banner-error" role="alert">{addError}</div>}
            <div className="add-doctor-actions">
              <button type="button" className="btn-mini" style={{ flex: 1 }} onClick={closeAddModal}>Cancel</button>
              <button className="btn-primary" style={{ flex: 1 }} type="submit" disabled={saving || !name.trim() || !username.trim() || password.length < 6}>
                {saving ? "Adding…" : "Add doctor + login"}
              </button>
            </div>
          </form>
        </div>
      </div>
    )}

    {duplicateMatch && (
      <div className="confirm-modal-backdrop" role="dialog" aria-modal="true">
        <div className="confirm-card">
          <div className="confirm-card-head">
            <strong>Doctor already exists</strong>
            <span>{duplicateMatch.name} ({duplicateMatch.specialization || "no specialization set"}) is already in the list.</span>
          </div>
          <div className="confirm-card-body">
            <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-soft)" }}>
              Do you want to add another {duplicateMatch.name}?
            </p>
          </div>
          <div className="confirm-card-actions" style={{ display: "flex", gap: 10 }}>
            <button className="btn-mini" style={{ flex: 1 }} onClick={cancelAddDuplicate}>No</button>
            <button className="btn-primary" style={{ flex: 1 }} onClick={confirmAddDuplicate} disabled={saving}>{saving ? "Adding…" : "Yes, add another"}</button>
          </div>
        </div>
      </div>
    )}

    <div className="table-wrap">
      <table className="data-table">
        <thead><tr><th>Doctor</th><th>Specialization</th><th>Login</th><th>Password</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
          {filtered.map((doc, i) => <tr key={doc.id}>
            <td>{editingId === doc.id
              ? <input value={editValues.name} onChange={e => setEditValues(v => ({ ...v, name: e.target.value }))} />
              : <button type="button" className="cell-person-btn" onClick={() => setDetailIndex(i)}><strong>{doc.name}</strong></button>}</td>
            <td>{editingId === doc.id
              ? <input value={editValues.specialization} onChange={e => setEditValues(v => ({ ...v, specialization: e.target.value }))} />
              : doc.specialization || "—"}</td>
            <td>{editingId === doc.id ? <div className="login-edit-fields">
              <input value={editValues.username} placeholder="Username" onChange={e => setEditValues(v => ({ ...v, username: e.target.value }))} />
            </div> : <code>{doc.login_username || `dr${doc.id}`}</code>}</td>
            <td>{editingId === doc.id ? <div className="login-edit-fields">
              <input type="text" value={editValues.password} placeholder="New password (optional)" onChange={e => setEditValues(v => ({ ...v, password: e.target.value }))} minLength={6} />
            </div> : <code>{doc.login_password || "Not set"}</code>}</td>
            <td><span className={`badge ${doc.active ? "badge-attended" : "badge-no_show"}`}>{doc.active ? "Active" : "Inactive"}</span></td>
            <td><div className="row-actions">
              {editingId === doc.id
                ? <><button className="btn-mini btn-good" onClick={() => saveEdit(doc.id)} disabled={!editValues.name.trim() || !editValues.username.trim() || (editValues.password.trim() && editValues.password.trim().length < 6)}>Save</button><button className="btn-mini" onClick={cancelEdit}>Cancel</button></>
                : <button className="btn-mini" onClick={() => startEdit(doc)}>Edit</button>}
              <button className={`btn-mini ${doc.active ? "btn-bad" : "btn-good"}`} onClick={() => toggleActive(doc)}>{doc.active ? "Deactivate" : "Activate"}</button>
              <button className="btn-mini" onClick={() => setHistoryDoctor(doc)}>History</button>
              <button className="btn-mini btn-delete" onClick={() => setDeleteTargets([doc])}>Delete</button>
            </div></td>
          </tr>)}
        </tbody>
      </table>
    </div>
    {deleteTargets && (
      <div className="confirm-modal-backdrop" role="dialog" aria-modal="true" onClick={() => !deleting && setDeleteTargets(null)}>
        <div className="confirm-card" onClick={e => e.stopPropagation()}>
          <div className="confirm-card-head">
            <strong>Delete {deleteTargets.length === 1 ? deleteTargets[0].name : `${deleteTargets.length} doctors`}?</strong>
            <span>{deleteTargets.length === 1 ? "The doctor moves" : "They move"} to Deleted Doctors — nothing is erased.</span>
          </div>
          <div className="confirm-card-body">
            {deleteTargets.length > 1 && (
              <p style={{ margin: "0 0 10px", fontSize: 13.5, color: "var(--ink-soft)" }}>
                {deleteTargets.slice(0, 6).map(d => d.name).join(", ")}{deleteTargets.length > 6 ? ` and ${deleteTargets.length - 6} more` : ""}
              </p>
            )}
            <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-soft)" }}>
              Their login is switched off and their free slots are cleared so no new bookings can come in. <b>Every past appointment, chat summary and patient review is kept</b> and stays readable under <b>Deleted Doctors</b>, where you can also restore them. Already-booked appointments are left for reception to settle.
            </p>
          </div>
          <div className="confirm-card-actions" style={{ display: "flex", gap: 10 }}>
            <button className="btn-mini" style={{ flex: 1 }} onClick={() => setDeleteTargets(null)} disabled={deleting}>Cancel</button>
            <button className="btn-primary btn-danger-solid" style={{ flex: 1 }} onClick={performDelete} disabled={deleting}>{deleting ? "Deleting…" : "Yes, delete"}</button>
          </div>
        </div>
      </div>
    )}
    {detailIndex !== null && (
      <DoctorDetailModal doctors={filtered} index={detailIndex} setIndex={setDetailIndex} onClose={() => setDetailIndex(null)} />
    )}
    {archiveOpen && (
      <DeletedDoctorsModal
        onClose={() => setArchiveOpen(false)}
        onChanged={async () => { await reload(); await refreshDeletedCount(); }}
      />
    )}
    {historyDoctor && (
      <DoctorHistoryModal doctorId={historyDoctor.id} onClose={() => setHistoryDoctor(null)} />
    )}
    {slotsForNewDoctor && (
      <AddSlotsModal
        doctor={slotsForNewDoctor}
        date={todayISO()}
        existingTimes={new Set()}
        onClose={() => setSlotsForNewDoctor(null)}
        onCreated={async () => {}}
        notify={notify}
      />
    )}
  </div>;
}
function ReceptionTab({ notify }) {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState(null);
  const [editValues, setEditValues] = useState({ name: "", username: "", password: "" });
  const [savingId, setSavingId] = useState(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState(null);

  const load = useCallback(async () => {
    try { setAccounts(await getJSON("/staff/reception")); }
    catch (err) { notify(err.message); }
    finally { setLoading(false); }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  function startEdit(a) {
    setEditingId(a.id);
    setEditValues({ name: a.name || "", username: a.username || "", password: "" });
  }

  async function saveEdit(id) {
    setSavingId(id);
    try {
      const payload = { name: editValues.name.trim(), username: editValues.username.trim() };
      if (editValues.password.trim()) payload.password = editValues.password;
      await putJSON(`/staff/reception/${id}`, payload);
      setEditingId(null);
      await load();
    } catch (err) { notify(err.message); }
    finally { setSavingId(null); }
  }

  async function setActive(a, active) {
    setSavingId(a.id);
    try { await putJSON(`/staff/reception/${a.id}`, { active }); await load(); }
    catch (err) { notify(err.message); }
    finally { setSavingId(null); setConfirmDeactivate(null); }
  }

  const editInvalid = !editValues.name.trim() || editValues.username.trim().length < 3
    || (editValues.password.trim() && editValues.password.trim().length < 6);

  return <div className="admin-tab-body">
    <div className="info-note">Reception staff log in with these credentials. Change the username or password from <b>Edit</b>. <b>Deactivate</b> blocks the login immediately (even if they are already signed in) and you can turn it back on any time.</div>
    <div className="table-wrap">
      <table className="data-table">
        <thead><tr><th>Reception account</th><th>Login</th><th>Password</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
          {loading && <tr><td colSpan={5}>Loading reception accounts…</td></tr>}
          {!loading && accounts.length === 0 && <tr><td colSpan={5}>No reception accounts found.</td></tr>}
          {accounts.map(a => <tr key={a.id}>
            <td>{editingId === a.id
              ? <input value={editValues.name} onChange={e => setEditValues(v => ({ ...v, name: e.target.value }))} />
              : <strong>{a.name}</strong>}</td>
            <td>{editingId === a.id
              ? <div className="login-edit-fields"><input value={editValues.username} placeholder="Username" onChange={e => setEditValues(v => ({ ...v, username: e.target.value }))} /></div>
              : <code>{a.username}</code>}</td>
            <td>{editingId === a.id
              ? <div className="login-edit-fields"><input type="text" value={editValues.password} placeholder="New password (optional)" onChange={e => setEditValues(v => ({ ...v, password: e.target.value }))} minLength={6} /></div>
              : <code>{a.login_password || "Not set"}</code>}</td>
            <td><span className={`badge ${a.active ? "badge-attended" : "badge-no_show"}`}>{a.active ? "Active" : "Inactive"}</span></td>
            <td><div className="row-actions">
              {editingId === a.id
                ? <><button className="btn-mini btn-good" onClick={() => saveEdit(a.id)} disabled={savingId === a.id || editInvalid}>{savingId === a.id ? "Saving…" : "Save"}</button><button className="btn-mini" onClick={() => setEditingId(null)}>Cancel</button></>
                : <button className="btn-mini" onClick={() => startEdit(a)}>Edit</button>}
              {a.active
                ? <button className="btn-mini btn-bad" disabled={savingId === a.id} onClick={() => setConfirmDeactivate(a)}>Deactivate</button>
                : <button className="btn-mini btn-good" disabled={savingId === a.id} onClick={() => setActive(a, true)}>Activate</button>}
            </div></td>
          </tr>)}
        </tbody>
      </table>
    </div>
    {confirmDeactivate && (
      <div className="confirm-modal-backdrop" role="dialog" aria-modal="true" onClick={() => setConfirmDeactivate(null)}>
        <div className="confirm-card" onClick={e => e.stopPropagation()}>
          <div className="confirm-card-head">
            <strong>Deactivate {confirmDeactivate.name}?</strong>
            <span>This reception login will stop working right away.</span>
          </div>
          <div className="confirm-card-body">
            <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-soft)" }}>
              <code>{confirmDeactivate.username}</code> won't be able to sign in until you activate it again.
            </p>
          </div>
          <div className="confirm-card-actions" style={{ display: "flex", gap: 10 }}>
            <button className="btn-mini" style={{ flex: 1 }} onClick={() => setConfirmDeactivate(null)}>Cancel</button>
            <button className="btn-primary" style={{ flex: 1 }} onClick={() => setActive(confirmDeactivate, false)} disabled={savingId === confirmDeactivate.id}>Yes, deactivate</button>
          </div>
        </div>
      </div>
    )}
  </div>;
}
function SlotsTab({ doctors, notify }) {
  const [date, setDate] = useState(todayISO());
  const [slots, setSlots] = useState([]);
  const [timeByDoctor, setTimeByDoctor] = useState({});
  const [savingDoctor, setSavingDoctor] = useState(null);
  const [search, setSearch] = useState("");
  const [bulkDoctor, setBulkDoctor] = useState(null); // doctor object the "Add slots" popup is open for

  const loadSlots = useCallback(async () => {
    if (!date) return;
    try { setSlots(await getJSON(`/slots?date=${date}&all=true`)); }
    catch (err) { notify(err.message); }
  }, [date, notify]);
  useEffect(() => { loadSlots(); }, [loadSlots]);

  function doctorSlots(id) { return slots.filter(s => Number(s.doctor_id) === Number(id)); }

  async function addSlot(id) {
    const time = timeByDoctor[id] || "10:00";
    setSavingDoctor(id);
    try {
      await postJSON("/slots", { doctor_id: Number(id), date, time });
      setTimeByDoctor(v => ({ ...v, [id]: "" }));
      await loadSlots();
    } catch (err) { notify(err.message); } finally { setSavingDoctor(null); }
  }

  async function removeSlot(id) {
    try { await deleteJSON(`/slots/${id}`); await loadSlots(); }
    catch (err) { notify(err.message); }
  }

  const visible = doctors.filter(d => d.active && `${d.name} ${d.specialization || ""}`.toLowerCase().includes(search.toLowerCase()));

  return <div className="admin-tab-body">
    <div className="calendar-toolbar">
      <div><h2>Clinic calendar</h2><p>Pick a date and manage each active doctor's given slots.</p></div>
      <div className="calendar-controls">
        <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        <div className="search-with-filter">
          <input className="doctor-search" placeholder="Search doctors…" value={search} onChange={e => setSearch(e.target.value)} />
          <FilterIcon className="search-filter-icon" />
        </div>
      </div>
    </div>
    <div className="doctor-slot-list">
      {visible.map(doctor => {
        const items = doctorSlots(doctor.id);
        return <section className="doctor-slot-card" key={doctor.id}>
          <div className="doctor-slot-head">
            <div><strong>{doctor.name}</strong><span>{doctor.specialization}</span></div>
            <span className="slot-count">{items.length} slots</span>
          </div>
          <div className="slot-row">
            {items.length === 0 && <span className="cell-sub">No slots given for this date.</span>}
            {items.map(s => <div key={s.id} className={`slot-tile ${s.status === "booked" ? "slot-booked" : ""}`}>
              <strong>{formatTime(s.time)}</strong>
              <span>{s.status === "booked" ? "Booked" : "Open"}</span>
              {s.status !== "booked" && <button className="btn-mini btn-bad" onClick={() => removeSlot(s.id)}>Remove</button>}
            </div>)}
          </div>
          <div className="slot-add-row">
            <input type="time" value={timeByDoctor[doctor.id] || ""} onChange={e => setTimeByDoctor(v => ({ ...v, [doctor.id]: e.target.value }))} />
            <button className="btn-primary" onClick={() => addSlot(doctor.id)} disabled={savingDoctor === doctor.id}>
              {savingDoctor === doctor.id ? "Adding…" : "Add slot"}
            </button>
            <button type="button" className="btn-mini btn-add-slots" onClick={() => setBulkDoctor(doctor)}>+ Add slots</button>
          </div>
        </section>;
      })}
    </div>
    {bulkDoctor && (
      <AddSlotsModal
        doctor={bulkDoctor}
        date={date}
        existingTimes={new Set(doctorSlots(bulkDoctor.id).map(s => String(s.time).slice(0, 5)))}
        onClose={() => setBulkDoctor(null)}
        onCreated={loadSlots}
        notify={notify}
      />
    )}
  </div>;
}
function FeedbackTab({notify}){const [feedback,setFeedback]=useState([]);const [loading,setLoading]=useState(true);useEffect(()=>{getJSON("/feedback").then(setFeedback).catch(e=>notify(e.message)).finally(()=>setLoading(false))},[notify]);if(loading)return <div className="empty-state">Loading feedback…</div>;if(!feedback.length)return <div className="empty-state">No patient feedback submitted yet.</div>;return <div className="feedback-grid">{feedback.map(f=><div key={f.id} className="feedback-card"><div className="feedback-head"><Stars rating={f.rating}/><span className="cell-sub">{formatDate(f.created_at)}</span></div>{f.comment&&<p className="feedback-comment">"{f.comment}"</p>}<div className="feedback-meta"><span>{f.patient_name}</span><span>·</span><span>{f.doctor_name}</span></div></div>)}</div>}

export default function Admin(){const [tab,setTab]=useState("doctors");const [doctors,setDoctors]=useState([]);const [error,setError]=useState("");const reloadDoctors=useCallback(async()=>setDoctors(await getJSON("/doctors?all=true")),[]);useEffect(()=>{reloadDoctors().catch(e=>setError(e.message))},[reloadDoctors]);const [searchParams,setSearchParams]=useSearchParams();const openAdd=searchParams.get("add")==="doctor";const clearOpenAdd=useCallback(()=>{setTab("doctors");setSearchParams({},{replace:true})},[setSearchParams]);return <Shell title="Admin Panel" subtitle="Manage doctors, individual logins, calendar slots and feedback">{error&&<div className="banner banner-error">{error}</div>}<div className="tabs">{TABS.map(t=><button key={t.id} className={`tab-button${tab===t.id?" active":""}`} onClick={()=>setTab(t.id)}>{t.label}</button>)}</div><div className="panel">{tab==="doctors"&&<DoctorsTab doctors={doctors} reload={reloadDoctors} notify={setError} openAdd={openAdd} onOpenAddHandled={clearOpenAdd}/>} {tab==="slots"&&<SlotsTab doctors={doctors} notify={setError}/>} {tab==="reception"&&<ReceptionTab notify={setError}/>} {tab==="feedback"&&<FeedbackTab notify={setError}/>}</div></Shell>}
