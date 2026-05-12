import { type ReactNode } from 'react';

import { AppProvider } from '../contexts/AppContext';
import { ConfirmProvider } from '../components/ConfirmDialog';
import { ToastProvider } from '../contexts/ToastContext';

/**
 * Wraps children in the full provider stack the production app uses.
 * Most component tests need at least ToastProvider; anything that
 * dips into AppContext (Mods/Settings/Profiles views, DiagnosticBundle)
 * needs AppProvider too. ConfirmProvider is required by any view that
 * surfaces a destructive confirm modal.
 *
 * Use the granular providers directly if a test needs to isolate a
 * specific layer.
 */
export function AllProviders({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <AppProvider>{children}</AppProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
