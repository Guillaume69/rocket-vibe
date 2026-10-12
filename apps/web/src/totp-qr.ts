import { encode } from "uqr";

export const QUIET_ZONE = 4;

export interface QrMatrix {
  version: number;
  size: number;
  dark: boolean[][];
}

export function totpQr(uri: string): QrMatrix | null {
  if (!uri.startsWith("otpauth://totp/")) return null;
  const qr = encode(uri, { ecc: "M", border: QUIET_ZONE });
  return { version: qr.version, size: qr.size, dark: qr.data };
}

export function qrPath(matrix: QrMatrix): string {
  let path = "";
  matrix.dark.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x++;
      path += `M${start} ${y}h${x - start}v1h${start - x}z`;
    }
  });
  return path;
}
