import { useEffect, useState, useCallback } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import Shell from "../components/Shell";
import AppointmentsTable from "../components/AppointmentsTable";
import { FilterIcon } from "../components/icons";
import { getJSON, postJSON } from "../lib/api";
import { getStaff } from "../lib/auth";

const TABS = [
  { key: "today", label: "Today" },
  { key: "upcoming", label: "Upcoming" },
  { key: "past", label: "Older" },
];

const STATUS_FILTER_LABEL = { arrived: "Waiting (arrived)", no_show: "No-shows", booked: "Booked", attended: "Attended" };

export default function Appointments() {
  const staff = getStaff();
  const isDoctor = staff?.role === "doctor";
  // Admin has all reception powers (mark arrived / no-show, doctor filter, ...).
  const isReception = staff?.role === "reception" || staff?.role === "admin";
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [doctorFilter, setDoctorFilter] = useState("all");
  const [doctorSearch, setDoctorSearch] = useState("");
  const [doctors, setDoctors] = useState([]);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);

  // Appointments list — driven by the Today / Upcoming / Older tabs.
  // "tab" and "status" can arrive pre-set via the URL (?tab=today&status=arrived)
  // — this is how the Dashboard's stat cards (Today / Waiting / No-shows)
  // deep-link straight into a filtered view here.
  const [tab, setTab] = useState(() => searchParams.get("tab") || "today");
  const [statusFilter, setStatusFilter] = useState(() => searchParams.get("status") || "all");
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatingId, setUpdatingId] = useState(null);

  const load = useCallback(async () => {
    try {
      // A tab of "all" (used by the "No-shows · all-time" stat card) isn't
      // one of the visible Today/Upcoming/Older chips — the backend simply
      // returns every appointment in scope when range isn't one it knows.
      const [apptData, doctorData] = await Promise.all([
        getJSON(`/appointments?range=${tab}`), getJSON("/doctors")
      ]);
      setAppointments(apptData); setDoctors(doctorData); setError("");
    } catch (err) { setError(err.message || "Could not reach the server"); }
    finally { setLoading(false); }
  }, [tab]);

  useEffect(() => { load(); const id = setInterval(load, 15000); return () => clearInterval(id); }, [load]);

  function clearStatusFilter() {
    setStatusFilter("all");
    navigate("/appointments", { replace: true });
  }

  async function markStatus(id, status) {
    setUpdatingId(id);
    try { await postJSON(`/appointments/${id}/status`, { status }); await load(); }
    catch (err) { setError(err.message || "Could not update status"); }
    finally { setUpdatingId(null); }
  }

  const filtered = appointments
    .filter(a => doctorFilter === "all" || Number(a.doctor_id) === Number(doctorFilter))
    .filter(a => statusFilter === "all" || a.status === statusFilter);
  const searchedDoctors = doctors.filter(d => !doctorSearch.trim() || `${d.name} ${d.specialization || ""}`.toLowerCase().includes(doctorSearch.toLowerCase()));

  const tabSubtitle = {
    today: "Today's appointments.",
    upcoming: "Appointments booked for future dates, soonest first.",
    past: "Past appointments, most recent first.",
    all: "Every appointment in scope, most recent first.",
  }[tab];

  const appointmentsPanel = (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h2>{isDoctor ? "My Appointments" : "Appointments"}</h2>
          <p>{isDoctor ? `Only appointments assigned to your doctor profile are shown. ${tabSubtitle}` : tabSubtitle}</p>
        </div>
        <div className="panel-controls">
          {isReception && <>
            <div className="search-with-filter">
              <input className="doctor-search" placeholder="Search doctors…" value={doctorSearch} onChange={e => setDoctorSearch(e.target.value)} />
              <FilterIcon className="search-filter-icon" />
            </div>
            <div className="select-with-filter">
              <FilterIcon className="select-filter-icon" />
              <select value={doctorFilter} onChange={e => setDoctorFilter(e.target.value)}>
                <option value="all">All doctors</option>
                {searchedDoctors.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
          </>}
        </div>
      </div>
      <div className="appointment-tabs">
        {TABS.map(t => (
          <button
            key={t.key}
            type="button"
            className={`chip-btn${tab === t.key ? " chip-btn-active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}

        <div className="status-filter-wrap">
          <button
            type="button"
            className={`chip-btn status-filter-btn${statusFilter !== "all" ? " chip-btn-active status-filter-chip" : ""}`}
            onClick={() => setStatusMenuOpen(open => !open)}
            aria-expanded={statusMenuOpen}
          >
            <FilterIcon />
            {statusFilter !== "all" ? `Filter: ${STATUS_FILTER_LABEL[statusFilter] || statusFilter}` : "Filter"}
            {statusFilter !== "all" && (
              <span
                className="status-filter-clear"
                onClick={(e) => { e.stopPropagation(); clearStatusFilter(); setStatusMenuOpen(false); }}
              >
                ✕
              </span>
            )}
          </button>
          {statusMenuOpen && (
            <div className="status-filter-menu">
              <button
                type="button"
                className={statusFilter === "all" ? "active" : ""}
                onClick={() => { setStatusFilter("all"); setStatusMenuOpen(false); }}
              >
                All statuses
              </button>
              {Object.entries(STATUS_FILTER_LABEL).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={statusFilter === key ? "active" : ""}
                  onClick={() => { setStatusFilter(key); setStatusMenuOpen(false); }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {loading ? <div className="empty-state">Loading appointments…</div> : (
        <AppointmentsTable
          appointments={filtered}
          isDoctor={isDoctor}
          isReception={isReception}
          updatingId={updatingId}
          onMarkStatus={markStatus}
          emptyLabel={
            statusFilter !== "all"
              ? `No ${(STATUS_FILTER_LABEL[statusFilter] || statusFilter).toLowerCase()} appointments here.`
              : tab === "upcoming" ? "No upcoming appointments." : tab === "past" ? "No older appointments." : "No appointments for today yet."
          }
        />
      )}
    </div>
  );

  return (
    <Shell
      title={isDoctor ? "My Appointments" : "Appointments"}
      subtitle={isDoctor ? "Your consultation queue, with a medical-only patient complaint summary." : "Mark patients arrived at reception, or mark no-show."}
    >
      {error && <div className="banner banner-error">{error}</div>}
      {appointmentsPanel}
    </Shell>
  );
}
