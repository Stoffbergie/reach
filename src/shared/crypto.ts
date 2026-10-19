const textEncoder = new TextEncoder();

export function randomSessionCode(): string {
  const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
  let value = "";
  while (value.length < 8) {
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    for (const byte of bytes) {
      if (byte >= 248) continue;
      value += alphabet[byte % alphabet.length];
      if (value.length === 8) break;
    }
  }
  return value;
}

export function base64Encode(value: string): string {
  const bytes = textEncoder.encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
