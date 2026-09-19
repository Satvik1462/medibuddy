import { useEffect, useState, useCallback } from "react";
import { getJSON, formatDate, formatTime, cleanMedicalSummary, initials, bookingSourceLabel } from "../lib/api";

const STATUS_LABEL = { booked: "Booked", arrived: "Arrived", attended: "Attended", no_show: "No-show" };

function SourceTag({ source }) {
  const label = bookingSourceLabel(source);
  return <span className={`badge-source badge-source-${label.toLowerCase()}`}>{label}</span>;
}

export default function PatientLookup() {
  const [mobile, setMobile] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Default view: every booking to date (doctor-scoped on the backend).
  const [bookings, setBookings] = useState([]);

  // Search view: one patient's history, once a mobile number is searched.
  const [patient, setPatient] = useState(null);
  const [history, setHistory] = useState([]);
  const [searched, setSearched] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await getJSON("/patients/history");
      setBookings(Array.isArray(data.bookings) ? data.bookings : []);
    } catch (err) {
      setError(err.message || "Could not fetch bookings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  async function lookup(e) {
    e?.preventDefault();
    const digits = String(mobile || "").replace(/\D/g, "").slice(-10);
    if (digits.length !== 10) {
      setError("Please enter a valid 10-digit mobile number.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const data = await getJSON(`/patients/history?phone=${digits}`);
      setPatient(data.patient || null);
      setHistory(Array.isArray(data.history) ? data.history : []);
      setSearched(true);
      if (!data.found) setError("Is mobile number se koi patient record nahi mila.");
    } catch (err) {
      setError(err.message || "Could not fetch history");
      setPatient(null);
      setHistory([]);
    } finally {
      setLoading(false);
    }
  }

  function clearSearch() {
    setMobile("");
    setSearched(false);
    setPatient(null);
    setHistory([]);
    setError("");
  }

  return (
    <div className="panel panel-inner patient-lookup-panel">
      <div className="panel-head">
        <div>
          <h2>Patient history by mobile number</h2>
          <p>All bookings to date are shown below — search a mobile number to narrow to one patient.</p>
        </div>
      </div>
      <form className="patient-lookup-form" onSubmit={lookup} style={{ marginBottom: 10 }}>
        <input
          placeholder="10-digit mobile number"
          value={mobile}
          onChange={(e) => setMobile(e.target.value)}
          inputMode="numeric"
        />
        <button className="btn-primary" type="submit" disabled={loading}>
          {loading ? "Searching…" : "Search"}
        </button>
        {searched && (
          <button type="button" className="btn-mini" onClick={clearSearch} disabled={loading}>
            Clear
          </button>
        )}
      </form>
      {error && <div className="lookup-error">{error}</div>}

      {searched ? (
        patient ? (
          <div className="history-list">
            <div className="cell-sub" style={{ marginBottom: 4 }}>
              {patient.name} · {patient.phone} · {history.length} visit{history.length === 1 ? "" : "s"}
            </div>
            {history.length === 0 ? (
              <div className="empty-state">No appointment history yet for this patient.</div>
            ) : (
              history.map((item) => (
                <div className="history-item" key={item.appointment_id}>
                  <div>
                    <b>{item.doctor_name || "Doctor"}</b> · {item.specialization || ""} ·{" "}
                    <span className={`badge badge-${item.status}`}>{STATUS_LABEL[item.status] || item.status}</span>{" "}
                    <SourceTag source={item.booking_source} />
                  </div>
                  <div>
                    {item.date ? formatDate(item.date) : "—"} {item.time ? `· ${formatTime(item.time)}` : ""}
                  </div>
                  {item.chat_summary && <div className="cell-sub">{cleanMedicalSummary(item.chat_summary)}</div>}
                </div>
              ))
            )}
          </div>
        ) : (
          !loading && <div className="empty-state">Is mobile number se koi patient record nahi mila.</div>
        )
      ) : loading ? (
        <div className="empty-state">Loading bookings…</div>
      ) : bookings.length === 0 ? (
        <div className="empty-state">No bookings yet.</div>
      ) : (
        <div className="history-list">
          <div className="cell-sub" style={{ marginBottom: 4 }}>
            {bookings.length} booking{bookings.length === 1 ? "" : "s"} to date
          </div>
          {bookings.map((item) => (
            <div className="history-item" key={item.appointment_id}>
              <div>
                <span className="avatar-chip" style={{ marginRight: 8 }}>{initials(item.patient_name)}</span>
                <b>{item.patient_name}</b> · {item.phone} · <b>{item.doctor_name || "Doctor"}</b>{" "}
                {item.specialization ? `(${item.specialization})` : ""} ·{" "}
                <span className={`badge badge-${item.status}`}>{STATUS_LABEL[item.status] || item.status}</span>{" "}
                <SourceTag source={item.booking_source} />
              </div>
              <div>
                {item.date ? formatDate(item.date) : "—"} {item.time ? `· ${formatTime(item.time)}` : ""}
              </div>
              {item.chat_summary && <div className="cell-sub">{cleanMedicalSummary(item.chat_summary)}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
