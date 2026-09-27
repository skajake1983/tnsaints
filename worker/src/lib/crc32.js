/**
 * CRC-32 (IEEE 802.3, the zlib/PNG polynomial), as PayPal uses it in the
 * webhook signature: the signed string ends with the decimal CRC-32 of the
 * raw request body.
 *
 * Not a security primitive on its own — the RSA signature over the string is.
 * The CRC ties that signature to these exact body bytes.
 */

let table = null;

function makeTable() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}

/** Unsigned CRC-32 of the bytes (Uint8Array), e.g. crc32(bytes("123456789")) === 3421780262. */
export function crc32(bytes) {
  if (!table) table = makeTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
