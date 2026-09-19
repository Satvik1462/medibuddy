import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { isLoggedIn, getStaff, isCitizenLoggedIn } from "../lib/auth";

const OPTIONS = [
  {
    key: "citizen",
    title: "I'm a Patient",
    desc: "Book an appointment, check your visit history, or share feedback — sign in with your mobile number.",
    cta: "Continue as Patient",
    to: "/citizen-login",
    icon: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7" />
      </>
    ),
  },
  {
    key: "reception",
    title: "Reception / Staff",
    desc: "Manage bookings, mark arrivals and no-shows, and view the live doctor calendar.",
    cta: "Continue as Staff",
    to: "/login",
    icon: (
      <>
        <rect x="3" y="4.5" width="18" height="16" rx="2.5" />
        <path d="M8 2.5v4M16 2.5v4M3 9.5h18" />
      </>
    ),
  },
  {
    key: "doctor",
    title: "Doctor",
    desc: "See your consultation queue, patient complaint summaries, and mark visits as attended.",
    cta: "Continue as Doctor",
    to: "/login",
    icon: (
      <>
        <path d="M9 3v4a3 3 0 0 0 6 0V3" />
        <path d="M6 3v5a6 6 0 0 0 12 0V3" />
        <circle cx="18" cy="17" r="3.2" />
      </>
    ),
  },
];

export default function Landing() {
  const navigate = useNavigate();

  useEffect(() => {
    if (isCitizenLoggedIn()) { navigate("/citizen", { replace: true }); return; }
    if (isLoggedIn()) {
      const staff = getStaff();
      if (staff?.role === "admin") navigate("/admin", { replace: true });
      else if (staff?.role === "reception") navigate("/reception", { replace: true });
      else navigate("/doctor", { replace: true });
    }
  }, [navigate]);

  return (
    <div className="landing-screen">
      <div className="landing-brand">
        <div className="brand-orb small">
          <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 21s-7.5-4.6-10-9.3C.3 7.4 2.4 3.5 6.3 3.1c2-.2 3.9.8 5.7 2.6 1.8-1.8 3.7-2.8 5.7-2.6 3.9.4 6 4.3 4.3 8.6C19.5 16.4 12 21 12 21Z" />
          </svg>
        </div>
        <div>
          <strong>MedAssist</strong>
          <span>Clinic sign-in</span>
        </div>
      </div>

      <h1 className="landing-title">Kaise sign in karna hai?</h1>
      <p className="landing-subtitle">Choose how you'd like to continue.</p>

      <div className="landing-options">
        {OPTIONS.map((opt) => (
          <button key={opt.key} type="button" className="landing-card" onClick={() => navigate(opt.to)}>
            <span className="landing-card-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                {opt.icon}
              </svg>
            </span>
            <span className="landing-card-title">{opt.title}</span>
            <span className="landing-card-desc">{opt.desc}</span>
            <span className="landing-card-cta">{opt.cta} →</span>
          </button>
        ))}
      </div>
    </div>
  );
}
