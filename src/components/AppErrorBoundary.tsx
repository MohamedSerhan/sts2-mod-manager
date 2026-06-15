import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { logFrontendError } from '../hooks/useTauri';

function stringifyUnknown(value: unknown): string {
  if (value instanceof Error) {
    return value.stack || value.message;
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function reportFrontendError(scope: string, error: unknown, info?: string): void {
  const detail = [
    `[${scope}]`,
    stringifyUnknown(error),
    info,
  ].filter(Boolean).join('\n');
  void logFrontendError(detail).catch(() => {
    // Logging must never create a second crash path.
  });
}

export function RendererErrorReporter() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      reportFrontendError('window.error', event.error ?? event.message);
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      reportFrontendError('window.unhandledrejection', event.reason);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, []);

  return null;
}

type AppErrorBoundaryProps = {
  children: ReactNode;
  title: string;
  body: string;
  reloadLabel: string;
};

type AppErrorBoundaryState = {
  error: Error | null;
};

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportFrontendError('react.render', error, info.componentStack ?? undefined);
  }

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <div className="gf-app-crash-shell" role="alert">
        <div className="gf-app-crash-panel">
          <AlertTriangle size={24} aria-hidden />
          <div>
            <h1>{this.props.title}</h1>
            <p>{this.props.body}</p>
            <pre>{error.message}</pre>
            <button className="gf-btn gf-btn-primary" type="button" onClick={() => window.location.reload()}>
              <RotateCcw size={14} aria-hidden />
              {this.props.reloadLabel}
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export function LocalizedAppErrorBoundary({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <AppErrorBoundary
      title={t('app.crash.title')}
      body={t('app.crash.body')}
      reloadLabel={t('app.crash.reload')}
    >
      {children}
    </AppErrorBoundary>
  );
}
