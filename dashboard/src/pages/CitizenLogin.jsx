import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { citizenLogin, requestCitizenOtp } from "../lib/auth";

export default function CitizenLogin() {
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState(1);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function sendOtp(e) {
    e.preventDefault(); setError(""); setLoading(true);
    try { await requestCitizenOtp(phone); setStep(2); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }
  async function verify(e) {
    e.preventDefault(); setError(""); setLoading(true);
    try { await citizenLogin(phone, otp); navigate("/citizen", { replace: true }); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }
  return <div className="login-screen">
    <form className="login-card" onSubmit={step === 1 ? sendOtp : verify}>
      <Link to="/" className="login-home-link">← Back to Home</Link>
      <div className="brand-orb small"><svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 21s-7.5-4.6-10-9.3C.3 7.4 2.4 3.5 6.3 3.1c2-.2 3.9.8 4.3 8.6C19.5 16.4 12 21 12 21Z" /></svg></div>
      <h1>Citizen Login</h1>
      <p className="login-subtitle">Login with your registered mobile number to book an appointment.</p>
      {error && <div className="banner banner-error">{error}</div>}
      <label>Mobile number
        <input value={phone} onChange={e => setPhone(e.target.value.replace(/\D/g, "").slice(-10))} inputMode="numeric" maxLength={10} placeholder="10-digit mobile number" required disabled={step === 2} />
      </label>
      {step === 2 && <label>OTP
        <input value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" maxLength={6} placeholder="Enter OTP" required autoFocus />
      </label>}
      <button className="btn-primary" type="submit" disabled={loading}>{loading ? "Please wait…" : step === 1 ? "Send OTP" : "Login & Continue"}</button>
      {step === 2 && <button type="button" className="login-back-link" onClick={() => {setStep(1);setOtp("");setError("");}}>Change mobile number</button>}
    </form>
  </div>;
}
