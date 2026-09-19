import { Navigate, Routes, Route } from "react-router-dom";
import Chat from "./pages/Chat";
import Dashboard from "./pages/Dashboard";
import DoctorSchedule from "./pages/DoctorSchedule";
import Appointments from "./pages/Appointments";
import Patients from "./pages/Patients";
import Admin from "./pages/Admin";
import ManualEntry from "./pages/ManualEntry";
import Login from "./pages/Login";
import CitizenLogin from "./pages/CitizenLogin";
import Landing from "./pages/Landing";
import { isCitizenLoggedIn } from "./lib/auth";
import ProtectedRoute from "./components/ProtectedRoute";

function CitizenOnly() { return isCitizenLoggedIn() ? <Chat /> : <Navigate to="/citizen-login" replace />; }
const STAFF_ROLES = ["doctor", "reception", "admin"];
function StaffDashboard() { return <ProtectedRoute roles={STAFF_ROLES}><Dashboard /></ProtectedRoute>; }
function StaffAppointments() { return <ProtectedRoute roles={STAFF_ROLES}><Appointments /></ProtectedRoute>; }
function StaffPatients() { return <ProtectedRoute roles={STAFF_ROLES}><Patients /></ProtectedRoute>; }

export default function App() {
  return <Routes>
    <Route path="/" element={<Landing />} />
    <Route path="/reception" element={<ProtectedRoute roles={["reception", "admin"]}><Dashboard /></ProtectedRoute>} />
    <Route path="/doctor" element={<ProtectedRoute roles={["doctor"]}><Dashboard /></ProtectedRoute>} />
    <Route path="/doctor-schedule" element={<ProtectedRoute roles={["reception", "admin"]}><DoctorSchedule /></ProtectedRoute>} />
    <Route path="/appointments" element={<StaffAppointments />} />
    <Route path="/manual-entry" element={<ProtectedRoute roles={["reception", "admin"]}><ManualEntry /></ProtectedRoute>} />
    <Route path="/patients" element={<StaffPatients />} />
    <Route path="/admin" element={<ProtectedRoute roles={["admin"]}><Admin /></ProtectedRoute>} />
    <Route path="/citizen-login" element={<CitizenLogin />} />
    <Route path="/citizen" element={<CitizenOnly />} />
    <Route path="/login" element={<Login />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>;
}
