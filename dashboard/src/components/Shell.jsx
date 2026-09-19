import { useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { getStaff, logout } from "../lib/auth";
import { initials } from "../lib/api";

const ROLE_LABEL = { admin: "Admin", reception: "Reception", doctor: "Doctor" };

const PULSE_PATH =
  "M0 20 H14 L20 6 L28 34 L36 14 L42 20 H60";

function PulseMark() {
  return (
    <svg className="pulse-mark" viewBox="0 0 60 40" fill="none">
      <path d={PULSE_PATH} stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const DASHBOARD_PATH_BY_ROLE = { doctor: "/doctor", reception: "/reception" };

function navItemsFor(role) {
  const dashboardPath = DASHBOARD_PATH_BY_ROLE[role] || "/reception";
  return [
    { to: "/admin", label: "Admin Panel", icon: "settings", roles: ["admin"] },
    // Admin has every reception page too (Dashboard, Doctor's schedule,
    // Appointments, Manual Entry, Patients) on top of the Admin Panel.
    { to: dashboardPath, label: role === "admin" ? "Reception Dashboard" : "Dashboard", icon: "grid", end: true, roles: ["doctor", "reception", "admin"] },
    { to: "/doctor-schedule", label: "Doctor's schedule", icon: "calendar", roles: ["reception", "admin"] },
    { to: "/appointments", label: "Appointments", icon: "calendar", roles: ["doctor", "reception", "admin"] },
    { to: "/manual-entry", label: "Manual Entry", icon: "plus", roles: ["reception", "admin"] },
    { to: "/patients", label: "Patients", icon: "users", roles: ["doctor", "reception", "admin"] },
    { to: "/admin?add=doctor", label: "Add Doctor", icon: "plus", roles: ["admin"] },
  ];
}

function Icon({ name }) {
  const paths = {
    grid: <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />,
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.36a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.64 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.64 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.64a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.36 9c.1.36.32.68.63.9.28.2.62.32 1 .34H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.76Z" />
      </>
    ),
    chat: <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />,
    plus: <path d="M12 5v14M5 12h14" />,
    calendar: (
      <>
        <rect x="3" y="4.5" width="18" height="16" rx="2.5" />
        <path d="M8 2.5v4M16 2.5v4M3 9.5h18" />
      </>
    ),
    users: (
      <>
        <circle cx="9" cy="8" r="3.4" />
        <path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" />
        <path d="M16.3 3.2a3.4 3.4 0 0 1 0 6.6" />
        <path d="M18.5 14.4c2.4.5 3.9 2.6 3.9 5.6" />
      </>
    ),
    logout: (
      <>
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <path d="M16 17l5-5-5-5" />
        <path d="M21 12H9" />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}

export default function Shell({ title, subtitle, children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const staff = getStaff();
  const navItems = navItemsFor(staff?.role).filter((item) => item.roles.includes(staff?.role));
  const [profileOpen, setProfileOpen] = useState(false);

  function handleLogout() {
    logout();
    navigate("/login", { replace: true });
  }

  // Qualification is stored as a comma-separated string, e.g. "MBBS, MS" —
  // split into individual badges for display.
  const qualifications = (staff?.qualification || "")
    .split(",")
    .map((q) => q.trim())
    .filter(Boolean);

  return (
    <div className="console">
      <aside className="console-sidebar">
        <div className="console-brand">
          <div className="brand-orb small">
            <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 21s-7.5-4.6-10-9.3C.3 7.4 2.4 3.5 6.3 3.1c2-.2 3.9.8 5.7 2.6 1.8-1.8 3.7-2.8 5.7-2.6 3.9.4 6 4.3 4.3 8.6C19.5 16.4 12 21 12 21Z" />
            </svg>
          </div>
          <div>
            <strong>MedAssist</strong>
            <span>Staff Console</span>
          </div>
        </div>

        <nav className="console-nav">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => {
                // NavLink ignores the query string, so "/admin" and
                // "/admin?add=doctor" both matched on /admin and Add Doctor
                // stayed blue whenever Admin Panel was open. Tell them apart
                // using the ?add=doctor param.
                const addDoctorActive = new URLSearchParams(location.search).get("add") === "doctor";
                let active = isActive;
                if (item.to === "/admin") active = isActive && !addDoctorActive;
                if (item.to === "/admin?add=doctor") active = isActive && addDoctorActive;
                return `console-nav-link${active ? " active" : ""}`;
              }}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="console-sidebar-footer">
          {staff && (
            <div className="console-staff-info">
              <span className="console-staff-name">{staff.name}</span>
              <span className="console-staff-role">{staff.role}</span>
            </div>
          )}
          <button className="console-logout" onClick={handleLogout}>
            <Icon name="logout" />
            <span>Log out</span>
          </button>
          <div className="console-live-row">
            <PulseMark />
            <span>Live · synced every 15s</span>
          </div>
        </div>
      </aside>

      <main className="console-main">
        <header className="console-topbar">
          <div>
            <h1>{title}</h1>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <div className="topbar-profile-wrap">
            <button
              type="button"
              className="topbar-profile topbar-profile-btn"
              onClick={() => setProfileOpen((open) => !open)}
              aria-expanded={profileOpen}
            >
              <span className="topbar-live"><i /> Live</span>
              <div className="topbar-avatar">
                {staff?.photo_url ? <img src={staff.photo_url} alt="" /> : initials(staff?.name || "MA")}
              </div>
              <div className="topbar-user"><strong>{staff?.name || "Staff"}</strong><span>{staff?.role || ""}</span></div>
            </button>

            {profileOpen && (
              <div className="header-popover profile-popover">
                <div className="popover-head">
                  <div className="profile-popover-identity">
                    <div className="topbar-avatar profile-avatar-lg">
                      {staff?.photo_url ? <img src={staff.photo_url} alt="" /> : initials(staff?.name || "MA")}
                    </div>
                    <div>
                      <strong>{staff?.name || "Staff"}</strong>
                      <span>{ROLE_LABEL[staff?.role] || staff?.role || ""}</span>
                      {qualifications.length > 0 && (
                        <div className="profile-quals">
                          {qualifications.map((q) => <span key={q} className="profile-qual-badge">{q}</span>)}
                        </div>
                      )}
                    </div>
                  </div>
                  <button onClick={() => setProfileOpen(false)}>×</button>
                </div>
                <div className="details-popover-grid">
                  <div><span>Username</span><b>{staff?.username || "—"}</b></div>
                  <div><span>Role</span><b>{ROLE_LABEL[staff?.role] || staff?.role || "—"}</b></div>
                  {staff?.role === "doctor" && (
                    <>
                      <div><span>Specialization</span><b>{staff?.specialization || "—"}</b></div>
                      <div><span>Qualification</span><b>{staff?.qualification || "—"}</b></div>
                    </>
                  )}
                </div>
                <button type="button" className="profile-logout-btn" onClick={handleLogout}>
                  <Icon name="logout" />
                  <span>Log out</span>
                </button>
              </div>
            )}
          </div>
        </header>
        <div className="console-content">{children}</div>
      </main>
    </div>
  );
}
