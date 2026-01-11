const CIPHER_ADDITIONAL_DATA = 'Rewind Bitcoin';
export const getManagedChacha = async (key: Uint8Array) => {
  //defer the load since this can really slow down initial loads in slow old
  //android devices.
  //const sodium = await import('react-native-libsodium');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sodium = require('sodium-javascript');

  return {
    encrypt: (message: string | Uint8Array) => {
      const nonce = sodium.randombytes_buf(
        sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
      );
      if (key.length !== sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
        throw new Error(
          `key length is ${key.length} != ${sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES}`
        );

      const rawCipherMessage =
        sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
          message,
          CIPHER_ADDITIONAL_DATA, //additional data that can be verified (this is not encoded)
          null, //secret nonce
          nonce, //public nonce
          key,
          'uint8array' //Result type
        );
      const cipherMessage = new Uint8Array(
        nonce.length + rawCipherMessage.length
      );
      cipherMessage.set(nonce, 0);
      cipherMessage.set(rawCipherMessage, nonce.length);
      return cipherMessage;
    },
    decrypt: (cipherMessage: Uint8Array) => {
      // Extract the nonce from the beginning of the cipherMessage
      const nonce = cipherMessage.slice(
        0,
        sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
      );

      // The actual encrypted message is the part after the nonce
      const encryptedMessage = cipherMessage.slice(
        sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
      );

      if (key.length !== sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES) {
        throw new Error(
          `key length is ${key.length} != ${sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES}`
        );
      }

      // Decrypt the message
      const decryptedMessage =
        sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
          null, // secret nonce is null since it wasn't used in encryption
          encryptedMessage, // the encrypted part of the message
          CIPHER_ADDITIONAL_DATA, // additional data for verification
          nonce, // public nonce
          key
        );

      return decryptedMessage;
    }
  };
};
