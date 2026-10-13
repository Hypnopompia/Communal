/**
 * A person's identity disc. Its colour comes from their account fingerprint, so the same person
 * looks the same on every hub and every screen, and a changed key looks different.
 */
export function hueOf(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return (h >>> 0) % 360;
}

export function Disc({
  name,
  seed,
  size = 36,
  online,
}: {
  name: string;
  seed: string;
  size?: number;
  online?: boolean;
}) {
  const hue = hueOf(seed);
  const initial = [...name.trim()][0]?.toUpperCase() ?? '?';
  return (
    <span
      className="disc"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.44,
        background: `linear-gradient(135deg, hsl(${hue} 62% 52%), hsl(${(hue + 40) % 360} 58% 40%))`,
      }}
      aria-hidden="true"
    >
      {initial}
      {online && <span className="presence" />}
    </span>
  );
}
