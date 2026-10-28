// getRandomValues is available on LAN HTTP; randomUUID requires a secure context.
export function newRequestId(source: Pick<Crypto, 'getRandomValues'> = globalThis.crypto) {
  return Array.from(source.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
}
