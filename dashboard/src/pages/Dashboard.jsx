import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import Shell from "../components/Shell";
import AppointmentsTable from "../components/AppointmentsTable";
import { getJSON, postJSON, todayISO, formatDate, formatTime, cleanMedicalSummary, initials, bookingSourceLabel } from "../lib/api";
import { getStaff } from "../lib/auth";

const STATUS_LABEL = { booked: "Booked", arrived: "Arrived", attended: "Attended", no_show: "No-show" };

function SourceTag({ source }) {
  const label = bookingSourceLabel(source);
  return <span className={`badge-source badge-source-${label.toLowerCase()}`}>{label}</span>;
}

function StatCard({ label, value, tone, hint, to }) {
  const className = `stat-card${tone ? ` tone-${tone}` : ""}${to ? " stat-card-clickable" : ""}`;
  const content = <><span className="stat-label">{label}</span><strong className="stat-value">{value}</strong>{hint && <span className="stat-hint">{hint}</span>}</>;
  return to
    ? <Link to={to} className={className}>{content}</Link>
    : <div className={className}>{content}</div>;
}

export default function Dashboard() {
  const staff = getStaff();
  const isDoctor = staff?.role === "doctor";
  // Admin has all reception powers (mark arrived / no-show, doctor filter, ...).
  const isReception = staff?.role === "reception" || staff?.role === "admin";
  const [appointments, setAppointments] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatingId, setUpdatingId] = useState(null);
  const [navPopup, setNavPopup] = useState(null); // null | "appointments" | "patients"
  const [navAppointments, setNavAppointments] = useState([]);
  const [navPatients, setNavPatients] = useState([]);
  const [navPatientSearch, setNavPatientSearch] = useState("");
  const [navLoading, setNavLoading] = useState(false);
  const [navError, setNavError] = useState("");

  const load = useCallback(async () => {
    try {
      const [apptData, statsData] = await Promise.all([
        getJSON(`/appointments?date=${todayISO()}`), getJSON("/stats/summary")
      ]);
      setAppointments(apptData); setStats(statsData); setError("");
    } catch (err) { setError(err.message || "Could not reach the server"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); const id = setInterval(load, 15000); return () => clearInterval(id); }, [load]);

  async function markStatus(id, status) {
    setUpdatingId(id);
    try { await postJSON(`/appointments/${id}/status`, { status }); await load(); }
    catch (err) { setError(err.message || "Could not update status"); }
    finally { setUpdatingId(null); }
  }

  // Appointments button → full appointment details (patient, doctor, time,
  // status, chat summary) — same data the Appointments page shows.
  async function openAppointmentsPopup() {
    setNavPopup("appointments");
    setNavLoading(true);
    setNavError("");
    try {
      const data = await getJSON("/appointments");
      setNavAppointments(data);
    } catch (err) {
      setNavError(err.message || "Could not load appointments");
    } finally {
      setNavLoading(false);
    }
  }

  // Patients button → a simple directory: just each patient's name and
  // mobile number, one row per patient (deduped by phone).
  async function openPatientsPopup() {
    setNavPopup("patients");
    setNavPatientSearch("");
    setNavLoading(true);
    setNavError("");
    try {
      const data = await getJSON("/patients/history");
      const bookings = Array.isArray(data.bookings) ? data.bookings : [];
      const byPhone = new Map();
      bookings.forEach(b => { if (!byPhone.has(b.phone)) byPhone.set(b.phone, b); });
      setNavPatients(Array.from(byPhone.values()));
    } catch (err) {
      setNavError(err.message || "Could not load patients");
    } finally {
      setNavLoading(false);
    }
  }

  function closeNav() { setNavPopup(null); }

  const filteredNavPatients = navPatients.filter(p => {
    const q = navPatientSearch.trim().toLowerCase();
    if (!q) return true;
    return (p.patient_name || "").toLowerCase().includes(q) || (p.phone || "").includes(q);
  });

  // Completed/no-show appointments leave the dashboard queue immediately.
  const activeAppointments = appointments.filter(a => a.status === "booked" || a.status === "arrived");
  const preview = activeAppointments.slice(0, 5);

  return <Shell title={isDoctor ? "Doctor Dashboard" : "Reception Dashboard"} subtitle={isDoctor ? "Today's snapshot — open My Appointments for the full queue." : "Today's snapshot — open Appointments or Patients for the full view."}>
    {error && <div className="banner banner-error">{error}</div>}
    <div className="stat-row">
      <StatCard label="Today" value={stats ? stats.today_appointments : "—"} hint="appointments" to="/appointments?tab=today" />
      <StatCard label="Waiting" value={activeAppointments.filter(a => a.status === "arrived").length} tone="good" hint="arrived" to="/appointments?tab=today&status=arrived" />
      <StatCard label="No-shows" value={stats ? stats.no_show : "—"} tone="bad" hint="all-time" to="/appointments?tab=all&status=no_show" />
      <StatCard label="Active doctors" value={stats ? stats.active_doctors : "—"} to={staff?.role === "admin" ? "/admin" : undefined} />
      <StatCard label="Avg rating" value={stats ? `${stats.avg_rating || 0} ★` : "—"} hint="patient feedback" />
    </div>

    <div className="panel">
      <div className="panel-head">
        <div>
          <h2>{isDoctor ? "Today's queue" : "Today's appointments"}</h2>
          <p>Showing the first 5 for today. Head to {isDoctor ? "My Appointments" : "Appointments"} for the full list and actions.</p>
        </div>
        <div className="panel-controls">
          <button type="button" className="btn-mini" onClick={openAppointmentsPopup}>{isDoctor ? "My Appointments" : "Appointments"} →</button>
          {!isDoctor && <button type="button" className="btn-mini" onClick={openPatientsPopup}>Patients →</button>}
        </div>
      </div>
      {loading ? <div className="empty-state">Loading appointments…</div> : (
        <AppointmentsTable
          appointments={preview}
          isDoctor={isDoctor}
          isReception={isReception}
          updatingId={updatingId}
          onMarkStatus={markStatus}
          emptyLabel="No appointments for today yet."
          fullListTo="/appointments"
          fullListLabel={isDoctor ? "Go to My Appointments →" : "Go to Appointments →"}
        />
      )}
    </div>

    {navPopup === "appointments" && (
      <div className="confirm-modal-backdrop" role="dialog" aria-modal="true" onClick={closeNav}>
        <div className="confirm-card nav-data-card" onClick={e => e.stopPropagation()}>
          <div className="confirm-card-head">
            <strong>{isDoctor ? "My Appointments" : "Appointments"}</strong>
            <span>Full list, read-only.</span>
          </div>
          <div className="confirm-card-body nav-data-body">
            {navError && <div className="banner banner-error">{navError}</div>}
            {navLoading ? (
              <div className="empty-state">Loading…</div>
            ) : navAppointments.length === 0 ? (
              <div className="empty-state">No appointments yet.</div>
            ) : (
              <div className="history-list">
                {navAppointments.map(a => (
                  <div className="history-item" key={a.id}>
                    <div>
                      <span className="avatar-chip" style={{ marginRight: 8 }}>{initials(a.patient_name)}</span>
                      <b>{a.patient_name}</b> · {a.phone}
                      {!isDoctor && <> · <b>{a.doctor_name}</b>{a.specialization ? ` (${a.specialization})` : ""}</>}
                      {" · "}<span className={`badge badge-${a.status}`}>{STATUS_LABEL[a.status] || a.status}</span>{" "}
                      <SourceTag source={a.booking_source} />
                    </div>
                    <div>{a.date ? formatDate(a.date) : "—"} {a.time ? `· ${formatTime(a.time)}` : ""}</div>
                    {a.chat_summary && <div className="cell-sub">{cleanMedicalSummary(a.chat_summary)}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="confirm-card-actions">
            <Link className="btn-mini" style={{ width: "100%", display: "block", textAlign: "center" }} to="/appointments" onClick={closeNav}>
              Go to {isDoctor ? "My Appointments" : "Appointments"} →
            </Link>
          </div>
          <div className="confirm-card-actions">
            <button className="btn-mini" style={{ width: "100%" }} onClick={closeNav}>Close</button>
          </div>
        </div>
      </div>
    )}

    {navPopup === "patients" && (
      <div className="confirm-modal-backdrop" role="dialog" aria-modal="true" onClick={closeNav}>
        <div className="confirm-card nav-data-card" onClick={e => e.stopPropagation()}>
          <div className="confirm-card-head">
            <strong>Patients</strong>
            <span>Name and mobile number, read-only.</span>
          </div>
          <div className="confirm-card-body nav-data-body">
            {navError && <div className="banner banner-error">{navError}</div>}
            {navLoading ? (
              <div className="empty-state">Loading…</div>
            ) : navPatients.length === 0 ? (
              <div className="empty-state">No patients yet.</div>
            ) : (
              <>
                <input
                  className="nav-data-search"
                  placeholder="Search by name or mobile number…"
                  value={navPatientSearch}
                  onChange={e => setNavPatientSearch(e.target.value)}
                />
                <div className="nav-data-count">{filteredNavPatients.length} of {navPatients.length} patients</div>
                {filteredNavPatients.length === 0 ? (
                  <div className="empty-state">No patients match "{navPatientSearch}".</div>
                ) : (
                  <div className="history-list">
                    {filteredNavPatients.map(p => (
                      <div className="history-item" key={p.phone}>
                        <div>
                          <span className="avatar-chip" style={{ marginRight: 8 }}>{initials(p.patient_name)}</span>
                          <b>{p.patient_name}</b> <SourceTag source={p.booking_source} />
                        </div>
                        <div className="cell-sub"><a href={`tel:${p.phone}`}>{p.phone}</a></div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <div className="confirm-card-actions">
            <Link className="btn-mini" style={{ width: "100%", display: "block", textAlign: "center" }} to="/patients" onClick={closeNav}>
              Go to Patients →
            </Link>
          </div>
          <div className="confirm-card-actions">
            <button className="btn-mini" style={{ width: "100%" }} onClick={closeNav}>Close</button>
          </div>
        </div>
      </div>
    )}
  </Shell>;
}
