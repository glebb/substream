import type { ReactNode } from "react";

export function LoadingStatus({ children }: { children: ReactNode }) {
  return <div className="loading-status" role="status" aria-live="polite">
    <span className="loading-spinner" aria-hidden="true" />
    <p>{children}</p>
  </div>;
}
