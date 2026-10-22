const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((char, i) => [char, i]));

export function decodeBase58(input: string): Uint8Array | null {
  if (input.length === 0) return null;
  const bytes: number[] = [];

  for (const char of input) {
    const value = INDEX.get(char);
    if (value === undefined) return null;
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  for (const char of input) {
    if (char !== '1') break;
    bytes.push(0);
  }

  return Uint8Array.from(bytes.reverse());
}

export function isSolanaAddress(input: string): boolean {
  return decodeBase58(input)?.length === 32;
}
