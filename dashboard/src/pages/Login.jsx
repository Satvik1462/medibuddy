import { useState } from "react";
import { useNavigate, useLocation, Link } from "react-router-dom";
import { login } from "../lib/auth";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const navigate = useNavigate();
  const location = useLocation();

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const staff = await login(username.trim(), password);
      const from = location.state?.from;
      // BUG FIX: /appointments, /patients and /manual-entry were missing from
      // these lists, so after a session expired on those pages the user was
      // always dumped back on the dashboard instead of where they were.
      const ALLOWED_BY_ROLE = {
        admin: ["/admin", "/reception", "/doctor-schedule", "/appointments", "/patients", "/manual-entry"],
        reception: ["/reception", "/doctor-schedule", "/appointments", "/patients", "/manual-entry"],
        doctor: ["/doctor", "/appointments", "/patients"],
      };
      if (from && (ALLOWED_BY_ROLE[staff.role] || []).includes(from)) {
        navigate(from, { replace: true });
        return;
      }
      if (staff.role === "admin") navigate("/admin", { replace: true });
      else if (staff.role === "reception") navigate("/reception", { replace: true });
      else navigate("/doctor", { replace: true });
    } catch (err) {
      setError(err.message || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <Link to="/" className="login-home-link">← Back to Home</Link>
        <div className="brand-orb small">
          <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 21s-7.5-4.6-10-9.3C.3 7.4 2.4 3.5 6.3 3.1c2-.2 3.9.8 5.7 2.6 1.8-1.8 3.7-2.8 5.7-2.6 3.9.4 6 4.3 4.3 8.6C19.5 16.4 12 21 12 21Z" />
          </svg>
        </div>
        <h1>Staff Login</h1>
        <p className="login-subtitle">Reception, Doctor and Admin sign-in for MedAssist console</p>

        {error && <div className="banner banner-error">{error}</div>}

        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>

        <button className="btn-primary" type="submit" disabled={loading}>
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
