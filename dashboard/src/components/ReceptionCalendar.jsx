import { useEffect, useState, useCallback } from "react";
import { getJSON, formatTime, todayISO, tomorrowISO } from "../lib/api";
import { FilterIcon } from "./icons";

export default function ReceptionCalendar({ date, setDate, search, setSearch, refreshKey }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!date) return;
    setLoading(true);
    try {
      const data = await getJSON(`/reception/calendar?date=${encodeURIComponent(date)}&search=${encodeURIComponent(search)}`);
      setRows(data);
      setError("");
    } catch (err) {
      setError(err.message || "Could not load calendar");
    } finally { setLoading(false); }
  }, [date, search, refreshKey]);

  useEffect(() => { load(); }, [load]);

  const grouped = rows.reduce((acc, row) => {
    const key = String(row.doctor_id);
    if (!acc[key]) acc[key] = { doctor_id: row.doctor_id, doctor_name: row.doctor_name, specialization: row.specialization, slots: [] };
    acc[key].slots.push(row);
    return acc;
  }, {});

  // Doctors alphabetically, slots time-ordered within each doctor — makes a
  // busy day scannable instead of showing them in whatever order the API returned.
  const doctorCards = Object.values(grouped)
    .map(doc => ({ ...doc, slots: [...doc.slots].sort((a, b) => String(a.time).localeCompare(String(b.time))) }))
    .sort((a, b) => a.doctor_name.localeCompare(b.doctor_name));

  const isToday = date === todayISO();
  const isTomorrow = date === tomorrowISO();

  return <div className="reception-calendar panel panel-inner">
    <div className="panel-head calendar-head">
      <div><h2>Doctor schedule</h2><p>Live view of today’s clinic timings and booked appointments.</p></div>
      <div className="calendar-controls">
        <div className="calendar-quick-dates">
          <button type="button" className={`chip-btn${isToday ? " chip-btn-active" : ""}`} onClick={() => setDate(todayISO())}>Today</button>
          <button type="button" className={`chip-btn${isTomorrow ? " chip-btn-active" : ""}`} onClick={() => setDate(tomorrowISO())}>Tomorrow</button>
        </div>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        <div className="search-with-filter">
          <input className="doctor-search" placeholder="Search doctors / specialization…" value={search} onChange={e => setSearch(e.target.value)} />
          <FilterIcon className="search-filter-icon" />
        </div>
        <button className="btn-mini" onClick={load}>Refresh</button>
      </div>
    </div>
    {error && <div className="banner banner-error">{error}</div>}
    {!error && <div className="calendar-legend">
      <span><i className="legend-dot legend-dot-open" /> Available</span>
      <span><i className="legend-dot legend-dot-booked" /> Booked</span>
    </div>}
    {loading ? <div className="empty-state">Loading calendar…</div> : doctorCards.length === 0 ? <div className="empty-state">No doctors or slots match this date/search.</div> :
      <div className="doctor-slot-list reception-slot-list">
        {doctorCards.map(doc => {
          const openCount = doc.slots.filter(slot => slot.status !== "booked").length;
          const bookedCount = doc.slots.length - openCount;
          const loadPct = doc.slots.length ? Math.round((bookedCount / doc.slots.length) * 100) : 0;
          return <section className="doctor-slot-card" key={doc.doctor_id}>
            <div className="doctor-slot-head">
              <div><strong>{doc.doctor_name}</strong><span>{doc.specialization || "General"}</span></div>
              <div className="doctor-slot-metrics">
                <span className="slot-count">{openCount} open</span>
                <span className="slot-count slot-count-muted">{bookedCount} booked</span>
              </div>
            </div>
            <div className="doctor-load-bar"><div className="doctor-load-fill" style={{ width: `${loadPct}%` }} /></div>
            <div className="slot-row">
              {doc.slots.map(slot => <div key={slot.id} className={`slot-tile ${slot.status === "booked" ? "slot-booked" : "slot-open"}`}>
                <strong>{formatTime(slot.time)}</strong>
                <span>{slot.status === "booked" ? `Booked · ${slot.patient_name || "Patient"}` : "Available"}</span>
                {slot.status === "booked" && slot.phone && <small>{slot.phone}</small>}
              </div>)}
            </div>
          </section>;
        })}
      </div>}
  </div>;
}
