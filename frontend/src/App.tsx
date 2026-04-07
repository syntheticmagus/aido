import { useSocket } from './hooks/useSocket.ts';
import { useAppStore } from './stores/appStore.ts';
import { ConfigUpload } from './components/ConfigUpload.tsx';
import { Dashboard } from './components/Dashboard.tsx';

export function App() {
  useSocket(); // Initialize socket connection and register all event handlers

  const projectStatus = useAppStore((s) => s.projectStatus);
  const showDashboard = projectStatus !== 'idle';

  return showDashboard ? <Dashboard /> : <ConfigUpload />;
}
