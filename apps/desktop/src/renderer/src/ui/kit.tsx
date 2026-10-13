import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon } from './icons';
import { invalidate, type Topic } from '../query';

export function Dialog({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    // The first text field, else the chosen option, else the main action, else anything.
    [
      'input:not([type=radio]):not([type=checkbox]), select, textarea',
      'input[type=radio]:checked',
      'button.primary',
      'button',
    ]
      .map((sel) => ref.current?.querySelector<HTMLElement>(sel))
      .find(Boolean)
      ?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={`dialog${wide ? ' wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h2 style={{ flex: 1 }}>{title}</h2>
          <button className="btn quiet small" onClick={onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children && <div style={{ maxWidth: '60ch' }}>{children}</div>}
      {action}
    </div>
  );
}

export function ErrorNote({ error }: { error: Error | null | undefined }) {
  if (!error) return null;
  return (
    <div className="notice bad" role="alert">
      {error.message}
    </div>
  );
}

export function Progress({ value, done }: { value: number; done?: boolean }) {
  return (
    <div
      className={`progress${done ? ' done' : ''}`}
      role="progressbar"
      aria-valuenow={Math.round(value * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

// ── toasts ──

interface Toast {
  id: number;
  text: string;
  bad?: boolean;
}
const ToastCtx = createContext<(text: string, bad?: boolean) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, bad?: boolean) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, bad }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), bad ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.bad ? ' bad' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/**
 * Runs a change against the API: tracks that it's in progress, shows its error, refreshes the
 * given topics when it succeeds and optionally confirms it with a toast.
 */
export function useAction<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  o: {
    topics?: Topic[];
    done?: string | ((r: R) => string);
    onDone?: (r: R) => void;
    /** Report failures as a toast too, for actions started from places with no room for errors. */
    toastErrors?: boolean;
  } = {},
) {
  const toast = useToast();
  // The latest fn and options, so callers can pass inline closures.
  const latest = useRef({ fn, o });
  latest.current = { fn, o };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      setBusy(true);
      setError(null);
      const { fn, o } = latest.current;
      try {
        const r = await fn(...args);
        if (o.topics) invalidate(o.topics);
        if (o.done) toast(typeof o.done === 'string' ? o.done : o.done(r));
        o.onDone?.(r);
        return r;
      } catch (err) {
        setError(err as Error);
        if (o.toastErrors) toast((err as Error).message, true);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { run, busy, error, clearError: () => setError(null) };
}
