# Key management

XIVPlan does **not** use "login with a Nostr browser extension" (NIP-07). Instead, it generates a
secret key locally the first time it's needed and treats that key as the app's own identity —
closer to how a local-first app might generate a device id, except this one doubles as a
cryptographic signing key that also defines the user's public Nostr identity.

## Storage

```ts
const nostrStore = localforage.createInstance({ name: 'XIVPlan', storeName: 'nostr' });

export async function getOrCreateSecretKey(): Promise<Uint8Array> {
    const stored = await nostrStore.getItem<string>('sk');
    if (stored) return hexToBytes(stored);
    const sk = generateSecretKey();          // nostr-tools
    await nostrStore.setItem('sk', bytesToHex(sk));
    return sk;
}
```

- Stored as a hex string in an IndexedDB store (via `localforage`), under a namespaced instance
  (`name: 'XIVPlan'`) so it doesn't collide with other IndexedDB usage in the same origin.
- Never touches `localStorage` directly and is never sent anywhere except as the private input to
  `finalizeEvent`/`nip44.encrypt` — the raw bytes never leave the browser.
- Generated lazily, on first actual need (first publish, or first pubkey lookup), not on app load.

## Public key derivation

```ts
export async function getNostrPubkey(): Promise<string> {
    return getPublicKey(await getOrCreateSecretKey());
}
```

The pubkey **is** the account. Anyone who has it can query "list this pubkey's public plans" —
there is no separate username/handle concept layered on top (display names live per-plan, not
per-account).

## Reactive pubkey (for UI)

Because the key can be replaced (generate-new / import) without a page reload, a tiny pub/sub
store lets components re-render in place instead of polling:

```ts
export function subscribePubkey(fn: () => void): () => void;
export function getCachedPubkey(): string | undefined;
export async function refreshNostrPubkey(): Promise<string>; // fetch + broadcast to subscribers
```

`refreshNostrPubkey` is called once on mount (to populate the cache) and again after any key
change. This is the same "external store" pattern used for relay health/fetch-status — see
[03-relay-pool-and-consensus.md](03-relay-pool-and-consensus.md) — and pairs naturally with
React's `useSyncExternalStore`.

## Import / export / rotate

```ts
export async function generateNewKey(): Promise<void>;          // irreversible — replaces the stored key
export async function importSecretKey(text: string): Promise<void>; // accepts 64 hex chars
export async function exportSecretKeyBlob(): Promise<Blob>;      // hex string as a .txt Blob
```

- **Export** is just the raw 64-char hex secret key, wrapped in a `Blob` for download as a `.txt`
  file. This is the *only* backup mechanism — there is no recovery phrase, no account-recovery
  flow, no server-side copy. Losing this file means losing access to every private plan and the
  ability to update/delete previously-published public plans under that identity.
- **Import** validates the input is exactly 64 lowercase hex characters before storing it.
- Both import and generate-new call `refreshNostrPubkey()` afterward and reset any in-flight
  publish retry state (`_lastPublishedPlan = null` — see [04-publishing.md](04-publishing.md)),
  since a stashed retry signed under the old key would otherwise republish a data event under the
  new key while the already-published index event stays signed by the old one.

## npub / hex / URL-token interop

Users may need to share or paste their public key in several forms; the app normalizes all of
them to raw hex internally:

```ts
export function pubkeyToNpub(pubkey: string): string;      // hex -> npub1... (NIP-19)
export function parseInputPubkey(input: string): string;    // accepts npub, hex, URL segment, or full share URL
```

`parseInputPubkey` is deliberately permissive — it's used for "open someone else's public vault by
pasting X", and users will paste an npub, a raw hex string, just the pubkey segment out of a share
URL, or the entire share URL. See [07-sharing-and-urls.md](07-sharing-and-urls.md) for the URL
token format it also understands.

## Porting notes

- If the target app already has its own account/auth system, the natural adaptation is: generate
  this Nostr keypair once per account and store it server-side (or keep it client-only exactly as
  here) — but keep the "the key is the account" simplicity if there's no reason to add a mapping
  layer.
- Do not add NIP-07 extension support unless there's a real user request for it; it changes the
  security/UX model substantially (external signing, no local export) and none of the code here
  assumes it.
- The 64-hex-char raw import/export format is intentionally simple and framework-agnostic — safe
  to copy verbatim.
