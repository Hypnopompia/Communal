# ADR 0014 — Devices, linking, revocation and recovery

- Status: accepted (M8)
- Date: 2026-10-12

HANDOFF §2, §4, §5 and §11 describe linking, revocation and recovery. ADR 0007 adds that one identity is used on every hub. This ADR fills in what the spec leaves open.

## Account identity on a device

- Core keeps the account identity in `<data>/account.json`: `user_id`, `root_pubkey` and this device's cert `chain`. The root device has an empty chain.
- Installs from before M8 have no `account.json`. Every device was a root device then, so a registered device with no file is migrated as its own root.
- The **root secret** is the first device's key. Only a device that holds it can export a recovery key. That's the first device, or a device restored from a recovery key, which keeps the secret in `root.key` (mode 0600; the desktop will use `safeStorage`). Linked devices never receive it.

## Linking (HANDOFF §2 "Adding a device")

1. The existing device sends `link.code.create`. The hub answers `link.code {code, expires_in: 600}`.
   - The code is 8 characters from `[0-9A-Z]` minus look-alikes, shown as `XXXX-XXXX`.
   - It is single use and expires after 10 minutes.
   - It belongs to the session that created it. If that session ends, the code is gone.
   - Codes live in hub memory, not in a `link_codes` table: both sessions must be live for the flow to work, so a hub restart ends it anyway.
   - Each session can hold at most 5 codes.
2. The new device sends `link.claim` on an unauthenticated session, with proof of possession. The hub answers `ok` and sends `link.request` to the device that made the code.
   - While a claim is pending, the auth timeout doesn't apply to the claiming session (it still has to ping).
   - A session gets 5 wrong codes, then the hub closes it.
3. The existing device shows the request, including the new device's `device_id`, which the new device also shows so the two can be compared. The user approves or denies.
   - On approval, the existing device sends `link.approve {request_id, cert, sealed}`.
   - The hub checks that the cert is signed by the approving device for its own account, and that the extended chain verifies against the hub's revocations.
   - Then it registers the device and sends `link.done {user_id, device_id, chain, sealed}` to the new device.
   - A denial, or the approving device going offline, sends `link.denied`.
4. The new device checks the chain itself: `chain[0].signer_pubkey` is the root, and `userId(root)` must equal `user_id`. Then it signs in with `auth` on the same session.

**`sealed`** is an encrypted bundle from the approving device to the new device: the list of the account's hubs (`url` + pinned `hub_pubkey`).

- Encryption: X25519 (both Ed25519 keys converted to Montgomery form) with an ephemeral sender key, a BLAKE3-derived key, and XChaCha20-Poly1305. The associated data binds the recipient's key.
- The hub forwards the bundle but can't read it, so linking doesn't tell a hub admin which other hubs the account uses.
- The new device then joins each listed hub automatically (ADR 0007: "linking brings a device onto every hub"), pinning the hub keys from the bundle.
- Hubs the account joins later are not pushed to existing devices. `hub add` on any device joins with the device's chain, and no new link is needed.

## Registering on a hub where the account already exists

ADR 0007 had `account.create` with an existing account return `conflict`. Now, when the account exists, `account.create` **adds the device** if its chain verifies to the account's root against that hub's revocations (an empty chain for the root device itself).

- The `display_name` is ignored in that case.
- The device takes the user's status (pending or active).

A cert chain is the same proof a link produces, so asking for a second approval per hub would add nothing.

## Revocation

- The hub must be able to check a revocation even when the signing device never joined that hub. So `device.revoke` and `device.revoked` carry `{revocation, chain}`, where `chain` is the signer's cert chain. This is called a **revocation proof**.
- Any signed-in device of the account may submit a proof. The signer need not be the submitter, which lets proofs be gossiped. A revoked signer is refused (ADR 0002).
- **The root device can't be revoked.** Revoking it would invalidate every chain in the account. A stolen root device (or a leaked recovery key) compromises the account, and there's no key rotation in v1 (see `docs/questions.md`).
- **The hub** stores every proof (`revocations` table, also for devices it has never seen). It then does the following:
  - marks the device revoked, along with every device whose chain runs through it
  - closes their sessions (4004) and publishes them offline at once
  - drops their index entries, tombstones, rules and watches, with no tombstones: a device leaving must never look like files being deleted (ADR 0013)
  - sends `device.revoked` to the account's other online devices
  - sends the account's proofs after each `welcome`, so a device that was offline catches up
- **Gossip.** Core stores every proof it has verified (`revocations` table in `index.db`, for any account). On each sign-in it sends its own account's proofs to that hub, and when it learns a new one it sends it to every hub. A revocation made while some hub was unreachable therefore reaches it later.
- **Peers check revocations** (ADR 0010 carried this forward). `connect.offer` and `connect.answer` carry the peer account's proofs (`from_revocations` / `to_revocations`).
  - The receiver verifies each proof, stores it, and checks the peer's chain against **everything it has stored** for that account.
  - So a hub that later omits a revocation can't bring a revoked device back for a peer that has seen the proof.
  - A device always knows its own account's revocations.

## Recovery (HANDOFF §4, ADR 0003)

- **Export** (Settings, or `communal recovery export`) needs the root secret.
  - The recovery file gains an optional plaintext `hubs: [{url, hub_pubkey}]`, written from the device's hub list. It isn't authenticated: a tampered list can only point the restore at the wrong hub, which can't do anything with the signatures it sees.
  - The word list carries no hubs, so restoring from words needs `--hub`.
- **Restore** (`communal restore`):
  1. Decrypt the root secret and check `userId(root)` against the file.
  2. Sign a cert for this device's fresh key with the root (chain of length 1).
  3. Send `account.restore` to each hub, which registers the device under the existing account. A hub that doesn't know the account answers `not_found`.
  4. Keep the root secret in `root.key`, so this device can export again.
- Lost devices are then revoked from the restored device. The old root device can't be revoked, as above.

## Not done in M8

- **Rules for another of your own devices** (managing a NAS from a laptop, ADR 0009) still needs an authenticated device-to-device command channel, because a hub must never be able to rewrite the uploader's authoritative rules. Carried forward.
- The desktop first-launch screens are part of M9. Core and the local API expose everything they need.
