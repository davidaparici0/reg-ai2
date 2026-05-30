import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";

export function hashPassword(plain: string): Promise<string> {
  return argonHash(plain); // argon2id with library defaults
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argonVerify(hash, plain);
  } catch {
    return false; // malformed/garbage hash is simply "not valid"
  }
}

// Verify against a throwaway hash so login timing doesn't reveal whether an email
// exists (anti-enumeration). Always resolves; result is intentionally discarded.
let dummyHash: Promise<string> | undefined;
export async function verifyDummy(plain: string): Promise<void> {
  dummyHash ??= argonHash("timing-equalizer-not-a-real-password");
  try {
    await argonVerify(await dummyHash, plain);
  } catch {
    /* ignore */
  }
}
