import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAuth } from './auth';
import { Dashboard } from './pages/Dashboard';
import { Login } from './pages/Login';
import { Settings } from './pages/Settings';

export function App() {
  return (
    <AuthProvider>
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
          path="/settings"
          element={
            <RequireAuth>
              <Settings />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </AuthProvider>
  );
}
