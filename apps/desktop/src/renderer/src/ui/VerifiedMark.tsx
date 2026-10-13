import { Icon } from './icons';

/** Shown after the name of someone this user verified by comparing safety codes. */
export function VerifiedMark({ on }: { on: boolean | undefined }) {
  if (!on) return null;
  return (
    <span title="Verified: you compared safety codes" style={{ display: 'inline-flex' }}>
      <Icon
        name="shield"
        size={14}
        style={{ color: 'var(--online)', verticalAlign: '-2px', marginLeft: 4 }}
        aria-label="Verified"
      />
    </span>
  );
}
