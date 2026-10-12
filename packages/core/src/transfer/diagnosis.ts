import type { HubBody } from '@communal/protocol';

type Verdict = HubBody<'connect.failed'>;
export type Cause = Verdict['cause'];

/** A failed connection's diagnosis as kept on a transfer (HANDOFF §8, ADR 0011). */
export interface TransferDiagnosis {
  cause: Cause;
  easier_fix: Verdict['easier_fix'];
  you: Verdict['you'];
  them: Verdict['them'];
  /** The source it was about, and the hub that brokered (and diagnosed) it. */
  device?: string;
  hub?: string;
  at: number;
}

/** What the UI shows: the plain-language message, tips, and whose setup to point at. */
export interface Explained extends TransferDiagnosis {
  message: string;
  tips: string[];
  /** One line on where the fix is easier, or null when there's nothing to fix. */
  fix: string | null;
}

/** HANDOFF §8 table: user message and tips per cause. */
const TEXT: Record<Cause, { message: string; tips: string[] }> = {
  peer_offline: {
    message: "The owner's computer went offline.",
    tips: ["The download is queued and resumes by itself when they're back."],
  },
  both_restrictive_nat: {
    message: 'Neither network accepts incoming connections.',
    tips: [
      'Enable UPnP (or NAT-PMP) on either router.',
      "Or forward the app's UDP port (shown in Settings → Network) on one side.",
    ],
  },
  cgnat: {
    message: 'Your internet provider shares one public address among customers.',
    tips: [
      'Ask your provider for a public IPv4 address, or enable IPv6.',
      'Or have the other person forward a port on their router.',
    ],
  },
  udp_blocked: {
    message:
      'This network blocks the traffic the app needs (common on work, school or hotel Wi-Fi).',
    tips: ['Try another network.'],
  },
  os_firewall: {
    message: "The computer's firewall blocked the app.",
    tips: ['Allow the app in Windows Defender Firewall or the macOS firewall settings.'],
  },
};

const FIX: Record<Verdict['easier_fix'], string | null> = {
  you: 'The easier fix is on your side.',
  them: "The easier fix is on the owner's side: send them these tips.",
  either: 'Fixing it on either side is enough.',
  none: null,
};

export function explain(d: TransferDiagnosis): Explained {
  const t = TEXT[d.cause];
  let message = t.message;
  // The table's wording is from the point of view of whoever has the problem.
  if (d.cause === 'cgnat' && d.easier_fix === 'you')
    message = "The owner's internet provider shares one public address among customers.";
  if (d.cause === 'udp_blocked' && d.easier_fix === 'them')
    message = "The owner's network blocks the traffic the app needs.";
  if (d.cause === 'os_firewall')
    message =
      d.easier_fix === 'them'
        ? "The owner's firewall blocked the app."
        : d.easier_fix === 'you'
          ? "Your computer's firewall blocked the app."
          : message;
  return { ...d, message, tips: t.tips, fix: FIX[d.easier_fix] };
}

/** Picks the most useful of several sources' diagnoses: anything actionable beats offline. */
export function mostUseful(ds: TransferDiagnosis[]): TransferDiagnosis | undefined {
  return ds.find((d) => d.cause !== 'peer_offline') ?? ds[0];
}
