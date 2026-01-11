const CIPHER_ADDITIONAL_DATA = 'Rewind Bitcoin';
const SIGNING_MESSAGE = 'Satoshi Nakamoto'; //Can be any, but don't change it

import type { BIP32Interface } from 'bip32';
import { sha256 } from '@noble/hashes/sha2';
import { MessageFactory } from 'bitcoinjs-message';
import * as secp256k1 from '@bitcoinerlab/secp256k1';
const MessageAPI = MessageFactory(secp256k1);

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

/*
 *  const PURPOSE = 1073;
 *  const VAULT_PATH = `m/${PURPOSE}'/<network>'/0'/<index>`;
 *  const vaultPath = VAULT_PATH.replace(
 *      '<network>',
 *      network === networks.bitcoin ? '0' : '1'
 *    ).replace('<index>', index.toString());
 */

export const getSeedDerivedCipherKey = async ({
  vaultPath,
  masterNode
}: {
  vaultPath: string;
  masterNode: BIP32Interface;
}) => {
  const childNode = masterNode.derivePath(vaultPath);
  if (!childNode.privateKey) throw new Error('Could not generate a privateKey');

  const signature = MessageAPI.sign(
    SIGNING_MESSAGE,
    childNode.privateKey,
    true // assumes compressed
  );
  const cipherKey = sha256(signature);

  return cipherKey;
};
