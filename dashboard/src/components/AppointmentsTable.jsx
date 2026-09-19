import { useState } from "react";
import { Link } from "react-router-dom";
import { formatDate, formatTime, initials, cleanMedicalSummary, bookingSourceLabel } from "../lib/api";

const STATUS_LABEL = { booked: "Booked", arrived: "Arrived", attended: "Attended", no_show: "No-show" };

function SourceTag({ source }) {
  const label = bookingSourceLabel(source);
  return <span className={`badge-source badge-source-${label.toLowerCase()}`}>{label}</span>;
}

function ChatTranscriptModal({ appointment, onClose }) {
  const transcript = Array.isArray(appointment.chat_transcript) ? appointment.chat_transcript : [];
  return (
    <div className="confirm-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="confirm-card chat-transcript-card" onClick={e => e.stopPropagation()}>
        <div className="confirm-card-head">
          <strong>Chat with {appointment.patient_name}</strong>
          <span>Full conversation with the chatbot before this appointment was booked.</span>
        </div>
        <div className="confirm-card-body">
          {transcript.length === 0
            ? <p className="chat-transcript-empty">No chatbot conversation on record for this appointment (likely a manual/front-desk booking).</p>
            : transcript.map((m, i) => (
              <div key={i} className={`message-row ${m.role === "assistant" ? "assistant-row" : "user-row"}`}>
                <div className={`message ${m.role === "assistant" ? "assistant-message" : "user-message"}`}>{m.message}</div>
              </div>
            ))}
        </div>
        <div className="confirm-card-actions">
          <button className="btn-mini" style={{ width: "100%" }} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// Shared logic: which action buttons (if any) apply to this appointment,
// given the viewer's role. Used by both the table row and the detail modal
// so the two never fall out of sync.
function RowActions({ appointment: a, isDoctor, isReception, updatingId, onMarkStatus, size }) {
  const cls = size === "large" ? "btn-mini btn-mini-lg" : "btn-mini";
  if (a.status === "booked") {
    return (
      <div className="row-actions">
        <button className={`${cls} btn-good`} disabled={updatingId === a.id} onClick={() => onMarkStatus(a.id, "arrived")}>Arrived</button>
        <button className={`${cls} btn-bad`} disabled={updatingId === a.id} onClick={() => onMarkStatus(a.id, "no_show")}>No-show</button>
      </div>
    );
  }
  if (a.status === "arrived" && isDoctor) {
    return (
      <div className="row-actions">
        <button className={`${cls} btn-good`} disabled={updatingId === a.id} onClick={() => onMarkStatus(a.id, "attended")}>Attended</button>
        <button className={`${cls} btn-bad`} disabled={updatingId === a.id} onClick={() => onMarkStatus(a.id, "no_show")}>No-show</button>
      </div>
    );
  }
  if (a.status === "arrived" && isReception) {
    return (
      <div className="row-actions">
        <button className={`${cls} btn-bad`} disabled={updatingId === a.id} onClick={() => onMarkStatus(a.id, "no_show")}>No-show</button>
      </div>
    );
  }
  return <span className="cell-sub">No action available — {STATUS_LABEL[a.status] || a.status}.</span>;
}

// Shared card body (patient info + action buttons) used by both the plain
// detail popup and the dashboard's "preview" popup below — kept as a
// separate function (not one popup with a toggled button) so the two can
// diverge freely without fighting each other's markup.
function PatientDetailBody({ a, isDoctor, onViewChat, updatingId, isReception, onMarkStatus }) {
  const hasChat = Array.isArray(a.chat_transcript) && a.chat_transcript.length > 0;
  return (
    <>
      <div className="confirm-card-head">
        <span className="modal-eyebrow">Citizen Details</span>
        <strong>{a.patient_name}</strong> <SourceTag source={a.booking_source} />
        <span>{a.phone}</span>
      </div>
      <div className="confirm-card-body patient-detail-body">
        {!isDoctor && (
          <div className="detail-row">
            <label>Doctor</label>
            <div>{a.doctor_name}{a.specialization ? <span className="cell-sub"> · {a.specialization}</span> : null}</div>
          </div>
        )}
        <div className="detail-row">
          <label>Date &amp; time</label>
          <div>{formatDate(a.date)} · {formatTime(a.time)}</div>
        </div>
        <div className="detail-row">
          <label>Status</label>
          <div><span className={`badge badge-${a.status}`}>{STATUS_LABEL[a.status] || a.status}</span></div>
        </div>
        <div className="detail-row">
          <label>Problem / Chat summary</label>
          <div>
            {cleanMedicalSummary(a.chat_summary) || "No medical complaint recorded."}
            {hasChat && (
              <button type="button" className="view-chat-link" onClick={() => onViewChat(a)}>View full chat</button>
            )}
          </div>
        </div>
        <div className="detail-row">
          <label>Action</label>
          <RowActions appointment={a} isDoctor={isDoctor} isReception={isReception} updatingId={updatingId} onMarkStatus={onMarkStatus} size="large" />
        </div>
      </div>
    </>
  );
}

// Plain patient-detail popup — used on the full Appointments / My Appointments
// list. Just the details, Previous/Next through the current list, and Close.
function PatientDetailModal({ appointments, index, setIndex, isDoctor, isReception, updatingId, onMarkStatus, onViewChat, onClose }) {
  const a = appointments[index];
  if (!a) return null;
  return (
    <div className="confirm-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="confirm-card patient-detail-card" onClick={e => e.stopPropagation()}>
        <PatientDetailBody a={a} isDoctor={isDoctor} isReception={isReception} updatingId={updatingId} onMarkStatus={onMarkStatus} onViewChat={onViewChat} />
        <div className="confirm-card-actions patient-detail-nav">
          <button className="btn-mini" disabled={index <= 0} onClick={() => setIndex(index - 1)}>← Previous</button>
          <span className="cell-sub">{index + 1} / {appointments.length}</span>
          <button className="btn-mini" disabled={index >= appointments.length - 1} onClick={() => setIndex(index + 1)}>Next →</button>
        </div>
        <div className="confirm-card-actions">
          <button className="btn-mini" style={{ width: "100%" }} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// Dashboard's own "preview" popup for a patient name clicked from the
// 5-row preview table. No longer carries a "Go to full page" link —
// navigation to Appointments/Patients now happens via the panel's own
// quick-nav popup, not from inside a patient's detail card.
function PatientPreviewModal({ appointments, index, setIndex, isDoctor, isReception, updatingId, onMarkStatus, onViewChat, onClose }) {
  const a = appointments[index];
  if (!a) return null;
  return (
    <div className="confirm-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="confirm-card patient-detail-card" onClick={e => e.stopPropagation()}>
        <PatientDetailBody a={a} isDoctor={isDoctor} isReception={isReception} updatingId={updatingId} onMarkStatus={onMarkStatus} onViewChat={onViewChat} />
        <div className="confirm-card-actions patient-detail-nav">
          <button className="btn-mini" disabled={index <= 0} onClick={() => setIndex(index - 1)}>← Previous</button>
          <span className="cell-sub">{index + 1} / {appointments.length}</span>
          <button className="btn-mini" disabled={index >= appointments.length - 1} onClick={() => setIndex(index + 1)}>Next →</button>
        </div>
        <div className="confirm-card-actions">
          <button className="btn-mini" style={{ width: "100%" }} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

export default function AppointmentsTable({ appointments, isDoctor, isReception, updatingId, onMarkStatus, emptyLabel, readOnly, fullListTo, fullListLabel }) {
  const [chatFor, setChatFor] = useState(null);
  const [detailIndex, setDetailIndex] = useState(null);

  if (appointments.length === 0) {
    return <div className="empty-state">{emptyLabel || "No appointments for this date."}</div>;
  }

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Patient</th>
            {!isDoctor && <th>Doctor</th>}
            <th>Time</th>
            <th>Problem / Chat Summary</th>
            <th>Status</th>
            {!readOnly && <th>Action</th>}
          </tr>
        </thead>
        <tbody>
          {appointments.map((a, i) => (
            <tr key={a.id}>
              <td>
                <button type="button" className="cell-person cell-person-btn" onClick={() => setDetailIndex(i)}>
                  <span className="avatar-chip">{initials(a.patient_name)}</span>
                  <div><strong>{a.patient_name}</strong> <SourceTag source={a.booking_source} /><span className="cell-sub">{a.phone}</span></div>
                </button>
              </td>
              {!isDoctor && <td><strong>{a.doctor_name}</strong><span className="cell-sub">{a.specialization}</span></td>}
              <td><strong>{formatTime(a.time)}</strong><span className="cell-sub">{formatDate(a.date)}</span></td>
              <td className="summary-cell">
                {cleanMedicalSummary(a.chat_summary) || "No medical complaint recorded."}
                {Array.isArray(a.chat_transcript) && a.chat_transcript.length > 0 && (
                  <button type="button" className="view-chat-link" onClick={() => setChatFor(a)}>View full chat</button>
                )}
              </td>
              <td><span className={`badge badge-${a.status}`}>{STATUS_LABEL[a.status] || a.status}</span></td>
              {!readOnly && (
                <td>
                  <RowActions appointment={a} isDoctor={isDoctor} isReception={isReception} updatingId={updatingId} onMarkStatus={onMarkStatus} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {chatFor && <ChatTranscriptModal appointment={chatFor} onClose={() => setChatFor(null)} />}
      {detailIndex !== null && (
        fullListTo ? (
          <PatientPreviewModal
            appointments={appointments}
            index={detailIndex}
            setIndex={setDetailIndex}
            isDoctor={isDoctor}
            isReception={isReception}
            updatingId={updatingId}
            onMarkStatus={onMarkStatus}
            onViewChat={setChatFor}
            onClose={() => setDetailIndex(null)}
          />
        ) : (
          <PatientDetailModal
            appointments={appointments}
            index={detailIndex}
            setIndex={setDetailIndex}
            isDoctor={isDoctor}
            isReception={isReception}
            updatingId={updatingId}
            onMarkStatus={onMarkStatus}
            onViewChat={setChatFor}
            onClose={() => setDetailIndex(null)}
          />
        )
      )}
    </div>
  );
}
