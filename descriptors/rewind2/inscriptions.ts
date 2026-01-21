// Factory and class that emulate the style of
// @bitcoinerlab/descriptors Output, but for Taproot inscriptions
// Implements the functions used in coinselect

import {
  initEccLib,
  networks,
  type Network,
  Psbt,
  Transaction,
  payments,
  script as bscript,
  opcodes,
  type PsbtTxInput
} from 'bitcoinjs-lib';
import type { PsbtInput } from 'bip174/src/lib/interfaces';

interface PsbtInputExtended extends PsbtInput, PsbtTxInput {}
interface XOnlyPointAddTweakResult {
  parity: 1 | 0;
  xOnlyPubkey: Uint8Array;
}
interface TinySecp256k1Interface {
  isPoint(p: Uint8Array): boolean;
  pointCompress(p: Uint8Array, compressed?: boolean): Uint8Array;
  isPrivate(d: Uint8Array): boolean;
  pointFromScalar(d: Uint8Array, compressed?: boolean): Uint8Array | null;
  pointAddScalar(
    p: Uint8Array,
    tweak: Uint8Array,
    compressed?: boolean
  ): Uint8Array | null;
  privateAdd(d: Uint8Array, tweak: Uint8Array): Uint8Array | null;
  sign(h: Uint8Array, d: Uint8Array, e?: Uint8Array): Uint8Array;
  signSchnorr?(h: Uint8Array, d: Uint8Array, e?: Uint8Array): Uint8Array;
  verify(
    h: Uint8Array,
    Q: Uint8Array,
    signature: Uint8Array,
    strict?: boolean
  ): boolean;
  verifySchnorr?(h: Uint8Array, Q: Uint8Array, signature: Uint8Array): boolean;
  xOnlyPointAddTweak(
    p: Uint8Array,
    tweak: Uint8Array
  ): XOnlyPointAddTweakResult | null;
  isXOnlyPoint(p: Uint8Array): boolean;
  privateNegate(d: Uint8Array): Uint8Array;
}

import { encode, encodingLength } from 'varuint-bitcoin';

const encoder = new TextEncoder();
const MAX_TAPSCRIPT_ELEMENT_BYTES = 520;

function reverseBuffer(buffer: Buffer): Buffer {
  if (buffer.length < 1) return buffer;
  let j = buffer.length - 1;
  let tmp = 0;
  for (let i = 0; i < buffer.length / 2; i++) {
    tmp = buffer[i]!;
    buffer[i] = buffer[j]!;
    buffer[j] = tmp;
    j--;
  }
  return buffer;
}
/** Helper: convert full pubkey to x-only */
const toXOnly = (pubKey: Buffer): Buffer =>
  pubKey.length === 32 ? pubKey : pubKey.subarray(1, 33);

/** Helper: serialize witness stack into finalScriptWitness */
function witnessStackToScriptWitness(witness: Buffer[]): Buffer {
  let buffer = Buffer.allocUnsafe(0);

  function writeSlice(slice: Buffer): void {
    buffer = Buffer.concat([buffer, Buffer.from(slice)]);
  }

  function writeVarInt(i: number): void {
    const currentLen = buffer.length;
    const varintLen = encodingLength(i);

    buffer = Buffer.concat([buffer, Buffer.allocUnsafe(varintLen)]);
    encode(i, buffer, currentLen);
  }

  function writeVarSlice(slice: Buffer): void {
    writeVarInt(slice.length);
    writeSlice(slice);
  }

  function writeVector(vector: Buffer[]): void {
    writeVarInt(vector.length);
    vector.forEach(writeVarSlice);
  }

  writeVector(witness);

  return buffer;
}

function vectorSize(someVector: Buffer[]): number {
  const length = someVector.length;

  return (
    encodingLength(length) +
    someVector.reduce((sum, witness) => {
      return sum + varSliceSize(witness);
    }, 0)
  );
}

function varSliceSize(someScript: Buffer): number {
  const length = someScript.length;

  return encodingLength(length) + length;
}

/** Content description for an inscription */
export interface InscriptionData {
  contentType: string;
  content: Buffer;
}

/** Build the TapScript leaf that carries the inscription */
function createInscriptionScript({
  xOnlyPublicKey,
  inscription
}: {
  xOnlyPublicKey: Buffer;
  inscription: InscriptionData;
}): (number | Buffer)[] {
  const protocolId = Buffer.from(encoder.encode('ord'));
  const contentChunks: Buffer[] = [];
  for (
    let offset = 0;
    offset < inscription.content.length;
    offset += MAX_TAPSCRIPT_ELEMENT_BYTES
  ) {
    const chunk = inscription.content.subarray(
      offset,
      offset + MAX_TAPSCRIPT_ELEMENT_BYTES
    );
    contentChunks.push(Buffer.from(chunk));
  }

  return [
    xOnlyPublicKey,
    opcodes['OP_CHECKSIG']!,
    opcodes['OP_0']!,
    opcodes['OP_IF']!,
    protocolId,
    1,
    1,
    Buffer.from(encoder.encode(inscription.contentType)),
    opcodes['OP_0']!,
    ...contentChunks,
    opcodes['OP_ENDIF']!
  ];
}

/**
 * Optional BIP32 derivation metadata that allows PSBT BIP32 signing.
 * This information is added to the PSBT input as `tapBip32Derivation`
 * so that signers like descriptors.signers.signBIP32 can use it.
 */
interface Bip32Derivation {
  /**
   * Master fingerprint of the BIP32 root key.
   */
  masterFingerprint: Buffer;

  /**
   * Absolute BIP32 path string, for example "m/86'/0'/0'/0/0".
   */
  path: string;

  /**
   * Full 33-byte compressed public key derived at `path`.
   */
  pubkey: Buffer;
}

/**
 * Factory similar in spirit to DescriptorsFactory:
 *
 *   export function InscriptionFactory(ecc: TinySecp256k1Interface) { ... }
 */
export function InscriptionsFactory(ecc: TinySecp256k1Interface) {
  // Required for Taproot in bitcoinjs-lib
  initEccLib(ecc);

  /**
   * Inscription class, designed to feel like Output in @bitcoinerlab/descriptors
   * but specialized for a Taproot script path that carries an Ordinal-style inscription.
   */
  class Inscription {
    readonly contentType: string; //F.ex.: 'text/plain;charset=utf-8'
    readonly content: Buffer;
    readonly network: Network;

    // Private internal state
    #xOnlyPubKey: Buffer; // 32-byte x-only internal key
    #inscriptionScript: (number | Buffer)[];
    #outputScript: Buffer;
    #payment: ReturnType<typeof payments.p2tr>;
    #controlBlock: Buffer;
    #bip32Derivation?: Bip32Derivation;

    constructor({
      contentType,
      content,
      internalPubKey,
      network = networks.bitcoin,
      bip32Derivation
    }: {
      /**
       * MIME content type buffer, for example:
       * 'text/plain;charset=utf-8'
       */
      contentType: string;

      /**
       * Raw content of the inscription.
       */
      content: Buffer;

      /**
       * Internal Taproot public key (33-byte compressed or 32-byte x-only).
       * The x-only form is used inside the TapScript and in Taproot PSBT fields.
       * Pass either internalPubKey (for ECPair signing) or bip32Derivation
       */
      internalPubKey?: Buffer;

      /**
       * Bitcoin network.
       * @defaultValue networks.bitcoin
       */
      network?: Network;

      /**
       * Optional BIP32 derivation metadata that will be added to PSBT inputs,
       * enabling BIP32 signing with signers such as descriptors.signers.signBIP32.
       * Pass either internalPubKey (for ECPair signing) or bip32Derivation
       */
      bip32Derivation?: Bip32Derivation;
    }) {
      this.contentType = contentType;
      this.content = content;
      this.network = network;

      if (!internalPubKey && !bip32Derivation)
        throw new Error(
          'Pass either internalPubKey for single-key signing OR bip32Derivation.'
        );

      if (internalPubKey) this.#xOnlyPubKey = toXOnly(internalPubKey);
      else {
        if (!bip32Derivation)
          throw new Error(
            'Pass either internalPubKey for single-key signing OR bip32Derivation for BIP32 signing, but not both.'
          );
        const { pubkey } = bip32Derivation;

        if (!pubkey || pubkey.length !== 33) {
          throw new Error(
            'bip32Derivation.pubkey must be a 33-byte compressed key'
          );
        }
        this.#xOnlyPubKey = toXOnly(pubkey);
        this.#bip32Derivation = bip32Derivation;
      }

      this.#inscriptionScript = createInscriptionScript({
        xOnlyPublicKey: this.#xOnlyPubKey,
        inscription: {
          contentType: this.contentType,
          content: this.content
        }
      });

      this.#outputScript = bscript.compile(this.#inscriptionScript);

      const scriptTree = {
        output: this.#outputScript,
        redeemVersion: 0xc0 as const // ordinals-style leaf version
      };

      this.#payment = payments.p2tr({
        internalPubkey: this.#xOnlyPubKey,
        scriptTree,
        redeem: scriptTree,
        network: this.network
      });

      if (
        !this.#payment.output ||
        !this.#payment.hash ||
        !this.#payment.pubkey ||
        !this.#payment.witness?.length
      ) {
        throw new Error('Invalid Taproot inscription payment');
      }

      const last = this.#payment.witness[this.#payment.witness.length - 1];
      if (!last) {
        throw new Error('Taproot control block missing in P2TR witness');
      }

      this.#controlBlock = last;
    }

    /**
     * Similar style to Output.updatePsbtAsOutput:
     *
     *   inscription.updatePsbtAsOutput({ psbt, value });
     *
     * Adds an output that locks `value` sats into the Taproot script
     * that carries this inscription.
     */
    updatePsbtAsOutput({ psbt, value }: { psbt: Psbt; value: number }): void {
      if (!this.#payment.output) {
        throw new Error('Missing Taproot output script');
      }

      psbt.addOutput({
        script: this.#payment.output,
        value
      });
    }

    /**
     * Similar style to Output.updatePsbtAsInput:
     *
     *   const finalizer = inscription.updatePsbtAsInput({
     *     psbt,
     *     txHex, // or { txId, value }
     *     vout,
     *     rbf
     *   });
     *
     * Returns a finalizer function:
     *
     *   finalizer({ psbt, validate? });
     *
     * The finalizer expects that the input has already been signed
     * (for example via ECPair or BIP32 signers) and then builds the
     * finalScriptWitness for the TapScript inscription path.
     */
    updatePsbtAsInput({
      psbt,
      txHex,
      txId,
      value,
      vout,
      rbf
    }: {
      /**
       * PSBT to update.
       */
      psbt: Psbt;

      /**
       * Hex string of the previous transaction containing the UTXO.
       * If provided, value can be derived from the tx.
       */
      txHex?: string;

      /**
       * Id of the previous transaction.
       * Required if txHex is not provided.
       */
      txId?: string;

      /**
       * Value of the previous output in satoshis.
       * Required if txHex is not provided.
       */
      value?: number;

      /**
       * Index of the output being spent in the previous transaction.
       */
      vout: number;

      /**
       * Replace by fee flag.
       * If omitted or true, the sequence is set to enable RBF.
       * @defaultValue true
       */
      rbf?: boolean;
    }): ({ psbt, validate }: { psbt: Psbt; validate?: boolean }) => void {
      if (!this.#payment.output || !this.#payment.redeemVersion) {
        throw new Error('Missing Taproot script metadata');
      }

      let prevTxId: string;
      let prevValue: number;

      if (txHex) {
        const tx = Transaction.fromHex(txHex);
        prevTxId = tx.getId();
        const out = tx.outs[vout];
        if (!out) {
          throw new Error(`Output vout=${vout} not found in previous tx`);
        }
        prevValue = out.value;
      } else {
        if (!txId || value === undefined) {
          throw new Error('Provide either txHex or (txId and value)');
        }
        prevTxId = txId;
        prevValue = value;
      }

      const sequence = rbf === false ? 0xffffffff : 0xfffffffd; // suitable for RBF and relative timelocks

      const tapLeafScript = {
        leafVersion: this.#payment.redeemVersion,
        script: this.#outputScript,
        controlBlock: this.#controlBlock
      };

      const input: PsbtInputExtended = {
        hash: reverseBuffer(Buffer.from(prevTxId, 'hex')),
        index: vout,
        sequence,
        witnessUtxo: {
          value: prevValue,
          script: this.#payment.output
        },
        tapLeafScript: [tapLeafScript]
      };

      // For script-path spends we can still set tapInternalKey;
      // it is the same internal key used to build the P2TR output.
      input.tapInternalKey = this.#xOnlyPubKey;

      // Optionally add Taproot BIP32 derivation information for this input,
      // so a BIP32 signer (for example descriptors.signers.signBIP32)
      // can locate the right keys.
      if (this.#bip32Derivation) {
        const { masterFingerprint, path } = this.#bip32Derivation;

        input.tapBip32Derivation = [
          {
            masterFingerprint,
            path,
            pubkey: this.#xOnlyPubKey,
            leafHashes: []
          }
        ];
      }

      psbt.addInput(input);
      const inputIndex = psbt.data.inputs.length - 1;

      /**
       * Finalizer for this input.
       *
       * It expects that signatures are already present in tapScriptSig.
       * For example:
       *   - for single key, sign with ECPair or descriptors.signers.signECPair
       *   - for BIP32, call descriptors.signers.signBIP32({ psbt, masterNode })
       */
      const finalizer = ({
        psbt,
        validate = true
      }: {
        psbt: Psbt;
        validate?: boolean;
      }): void => {
        const input = psbt.data.inputs[inputIndex];
        const sig = input?.tapScriptSig?.[0]?.signature;
        if (!sig) {
          throw new Error(
            'Taproot signature missing. Sign the PSBT input before finalizing inscription input'
          );
        }

        const witness = [sig, this.#outputScript, this.#controlBlock];
        input.finalScriptWitness = witnessStackToScriptWitness(
          witness as Buffer[]
        );

        if (validate) {
          // Add additional validation logic here if desired.
        }
      };

      return finalizer;
    }

    inputWeight() {
      // Non-segwit: (txid:32) + (vout:4) + (sequence:4) + (script_len:1)
      const NON_WITNESS_WEIGHT = (32 + 4 + 4 + 1) * 4; // 164

      const sig = Buffer.alloc(64); // dummy Schnorr sig
      const witness = [sig, this.#outputScript, this.#controlBlock];

      const witnessBytes = vectorSize(witness);

      return NON_WITNESS_WEIGHT + witnessBytes;
    }

    outputWeight(): number {
      // (script_pubKey_length:1) + (p2t2(OP_1 OP_PUSH32 <schnorr_public_key>):34) + (amount:8)
      return 43 * 4;
    }

    isSegwit(): boolean | undefined {
      return true;
    }

    /**
     * Creates and returns an instance of bitcoinjs-lib
     * [`Payment`](https://github.com/bitcoinjs/bitcoinjs-lib/blob/master/ts_src/payments/index.ts)'s interface with the `scriptPubKey` of this `Output`.
     */
    getPayment() {
      return this.#payment;
    }
    /**
     * Returns the Bitcoin Address of this `Output`.
     */
    getAddress(): string {
      if (!this.#payment.address)
        throw new Error(`Error: could extract an address from the payment`);
      return this.#payment.address;
    }
    /**
     * Returns this `Output`'s scriptPubKey.
     */
    getScriptPubKey(): Buffer {
      if (!this.#payment.output)
        throw new Error(`Error: could extract output.script from the payment`);
      return this.#payment.output;
    }
  }

  return { Inscription };
}
