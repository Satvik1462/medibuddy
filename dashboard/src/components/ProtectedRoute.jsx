import { Navigate, useLocation } from "react-router-dom";
import { getStaff, isLoggedIn } from "../lib/auth";

// Wrap a staff-only page: <ProtectedRoute roles={["admin"]}><Admin /></ProtectedRoute>
// - Not logged in -> bounce to /login (remembers where they were headed)
// - Logged in but wrong role -> bounce to the doctor dashboard
export default function ProtectedRoute({ roles, children }) {
  const location = useLocation();

  if (!isLoggedIn()) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  const staff = getStaff();
  if (roles && !roles.includes(staff?.role)) {
    return <Navigate to="/" replace />;
  }

  return children;
}
