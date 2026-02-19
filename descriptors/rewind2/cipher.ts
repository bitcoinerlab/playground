const CIPHER_ADDITIONAL_DATA = 'Rewind Bitcoin';
const SIGNING_MESSAGE = 'Satoshi Nakamoto'; //Can be any, but don't change it

import type { BIP32Interface } from 'bip32';
import { sha256 } from '@noble/hashes/sha2';
import { MessageFactory } from '@bitcoinerlab/btcmessage';
import * as secp256k1 from '@bitcoinerlab/secp256k1';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import {
  managedNonce,
  randomBytes,
  utf8ToBytes
} from '@noble/ciphers/utils.js';
const MessageAPI = MessageFactory(secp256k1);
const CIPHER_ADDITIONAL_DATA_BYTES = utf8ToBytes(CIPHER_ADDITIONAL_DATA);

export const getManagedChacha = async (key: Uint8Array) => {
  const managedXChaCha = managedNonce(xchacha20poly1305, randomBytes);

  return {
    encrypt: (message: string | Uint8Array) => {
      const payload =
        typeof message === 'string' ? utf8ToBytes(message) : message;
      return managedXChaCha(key, CIPHER_ADDITIONAL_DATA_BYTES).encrypt(payload);
    },
    decrypt: (cipherMessage: Uint8Array) =>
      managedXChaCha(key, CIPHER_ADDITIONAL_DATA_BYTES).decrypt(cipherMessage)
  };
};

/*
 *  const PURPOSE = 1073;
 *  const VAULT_PATH = `m/${PURPOSE}'/<network>'/0'/<index>`;
 *  const vaultPath = VAULT_PATH.replace('<network>', coinTypeFromNetwork(network).toString())
 *    .replace('<index>', index.toString());
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
