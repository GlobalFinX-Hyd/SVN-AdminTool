/**
 * WebAuthn (passkey) helpers.
 * The API sends options as JSON with base64url byte fields (Fido2NetLib format); the browser wants
 * ArrayBuffers, and the API wants the resulting credential back as JSON. Hand-rolled rather than
 * PublicKeyCredential.parse*FromJSON, which older Safari lacks.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export function base64UrlToBuffer(value: string): ArrayBuffer {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export function bufferToBase64Url(buffer: ArrayBuffer | ArrayBufferView): string {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;
}

function descriptors(list: any[] | undefined): PublicKeyCredentialDescriptor[] | undefined {
  return list?.map((d) => ({ ...d, id: base64UrlToBuffer(d.id) }));
}

/** Drops nulls the server serialises for unset optional fields (browsers reject some of them). */
function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as T;
}

export function toCreationOptions(json: any): PublicKeyCredentialCreationOptions {
  return clean({
    ...json,
    challenge: base64UrlToBuffer(json.challenge),
    user: { ...json.user, id: base64UrlToBuffer(json.user.id) },
    excludeCredentials: descriptors(json.excludeCredentials),
    authenticatorSelection: json.authenticatorSelection ? clean(json.authenticatorSelection) : undefined,
    extensions: json.extensions ?? undefined,
    hints: undefined,
    attestationFormats: undefined,
  });
}

export function toRequestOptions(json: any): PublicKeyCredentialRequestOptions {
  return clean({
    ...json,
    challenge: base64UrlToBuffer(json.challenge),
    allowCredentials: json.allowCredentials?.length ? descriptors(json.allowCredentials) : undefined,
    extensions: json.extensions ?? undefined,
    hints: undefined,
  });
}

export function attestationToJson(cred: PublicKeyCredential): any {
  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: bufferToBase64Url(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
    response: {
      clientDataJSON: bufferToBase64Url(r.clientDataJSON),
      attestationObject: bufferToBase64Url(r.attestationObject),
      transports: typeof r.getTransports === 'function' ? r.getTransports() : [],
    },
  };
}

export function assertionToJson(cred: PublicKeyCredential): any {
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: bufferToBase64Url(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
    response: {
      clientDataJSON: bufferToBase64Url(r.clientDataJSON),
      authenticatorData: bufferToBase64Url(r.authenticatorData),
      signature: bufferToBase64Url(r.signature),
      userHandle: r.userHandle ? bufferToBase64Url(r.userHandle) : null,
    },
  };
}

/** A user cancelling the browser's passkey dialog is not an error to show. */
export function isPasskeyCancel(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === 'NotAllowedError' || name === 'AbortError';
}
