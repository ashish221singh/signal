import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './auth';
import { CliApprove } from './pages/CliApprove';
import { Dashboard } from './pages/Dashboard';
import { EventDetail } from './pages/EventDetail';
import { Login } from './pages/Login';
import { Settings } from './pages/Settings';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/dashboard"
        element={
          <RequireAuth>
            <Dashboard />
          </RequireAuth>
        }
      />
      <Route
        path="/events/:eventName"
        element={
          <RequireAuth>
            <EventDetail />
          </RequireAuth>
        }
      />
      <Route
        path="/settings"
        element={
          <RequireAuth>
            <Settings />
          </RequireAuth>
        }
      />
      <Route
        path="/cli/approve"
        element={
          <RequireAuth>
            <CliApprove />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
