//Adapted from https://github.com/fboucquez/ordinal-inscription-example-using-bitcoinjs-lib/blob/main/src/ordinals-bitcoinjs.js
import {
  opcodes,
  payments,
  script as bscript,
  Psbt,
  type Network,
  type Stack,
  type Payment
} from 'bitcoinjs-lib';
import * as secp256k1 from '@bitcoinerlab/secp256k1';
import * as descriptors from '@bitcoinerlab/descriptors';

const { ECPair } = descriptors.DescriptorsFactory(secp256k1);
const encoder = new TextEncoder();

import { encode, encodingLength } from 'varuint-bitcoin';

const toXOnly = (pubKey: Buffer) =>
  pubKey.length === 32 ? pubKey : pubKey.subarray(1, 33);

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

export interface Inscription {
  contentType: Buffer;
  content: Buffer;
  postage: number;
}

export function createTextInscription(args: {
  text: string;
  postage?: number;
}): Inscription {
  const { text, postage = 10000 } = args;

  const contentType = Buffer.from(encoder.encode('text/plain;charset=utf-8'));

  const content = Buffer.from(encoder.encode(text));

  return { contentType, content, postage };
}

/**
 * Ordinals inscription script (TapScript leaf)
 */
export function createInscriptionScript(args: {
  xOnlyPublicKey: Buffer;
  inscription: Inscription;
}): (number | Buffer)[] {
  const { xOnlyPublicKey, inscription } = args;

  const protocolId = Buffer.from(encoder.encode('ord'));

  return [
    xOnlyPublicKey,
    opcodes['OP_CHECKSIG']!,
    opcodes['OP_0']!,
    opcodes['OP_IF']!,
    protocolId,
    1,
    1,
    inscription.contentType,
    opcodes['OP_0']!,
    inscription.content,
    opcodes['OP_ENDIF']!
  ];
}

export interface CommitTxData {
  script: Stack;
  tapleaf: string;
  tpubkey: string;
  cblock: string;
  revealAddress: string;
  scriptTaproot: Payment;
  outputScript: Buffer;
}

export function createCommitTxData({
  publicKey,
  inscription,
  network
}: {
  publicKey: Buffer;
  inscription: Inscription;
  network: Network;
}): CommitTxData {
  const xOnlyPublicKey = toXOnly(publicKey);
  const script = createInscriptionScript({ xOnlyPublicKey, inscription });

  const outputScript = bscript.compile(script);
  const scriptTree = { output: outputScript, redeemVersion: 192 }; // 192 == 0xc0

  const scriptTaproot = payments.p2tr({
    internalPubkey: xOnlyPublicKey,
    scriptTree,
    redeem: scriptTree,
    network
  });

  if (!scriptTaproot.hash || !scriptTaproot.pubkey || !scriptTaproot.address)
    throw new Error('Invalid P2TR data');

  const tapleaf = scriptTaproot.hash.toString('hex');

  const revealAddress = scriptTaproot.address;
  const tpubkey = scriptTaproot.pubkey.toString('hex');
  if (!scriptTaproot.witness?.length) throw new Error();
  const controlBlock = scriptTaproot.witness[scriptTaproot.witness.length - 1];
  if (!controlBlock)
    throw new Error('Taproot control block missing in P2TR witness');

  return {
    script,
    tapleaf,
    tpubkey,
    cblock: controlBlock.toString('hex'),
    revealAddress,
    scriptTaproot,
    outputScript
  };
}

export async function createRevealTx({
  commitTxData,
  commitTxResult,
  toAddress,
  privateKey,
  amount,
  network
}: {
  commitTxData: CommitTxData;
  commitTxResult: { txId: string; sendUtxoIndex: number; sendAmount: number };
  toAddress: string;
  privateKey: Buffer;
  amount: number;
  network: Network;
}) {
  const { cblock, scriptTaproot, outputScript } = commitTxData;
  if (!scriptTaproot.output || !scriptTaproot.redeemVersion)
    throw new Error('Missing Taproot script metadata');

  const tapLeafScript = {
    leafVersion: scriptTaproot.redeemVersion,
    script: outputScript,
    controlBlock: Buffer.from(cblock, 'hex')
  };

  const keypair = ECPair.fromPrivateKey(privateKey, { network });

  const psbt = new Psbt({ network });

  psbt.addInput({
    hash: commitTxResult.txId,
    index: commitTxResult.sendUtxoIndex,
    witnessUtxo: {
      value: commitTxResult.sendAmount,
      script: scriptTaproot.output
    },
    tapLeafScript: [tapLeafScript]
  });

  psbt.addOutput({
    value: amount,
    address: toAddress
  });

  await psbt.signInputAsync(0, keypair);

  const signature = psbt.data.inputs[0]?.tapScriptSig?.[0]?.signature;
  if (!signature)
    throw new Error(
      'Taproot signature missing after signing: reveal PSBT is incomplete'
    );

  const customFinalizer = () => {
    const witness = [signature, outputScript, tapLeafScript.controlBlock];
    return {
      finalScriptWitness: witnessStackToScriptWitness(witness)
    };
  };

  psbt.finalizeInput(0, customFinalizer);

  const tx = psbt.extractTransaction();

  return {
    txId: tx.getId(),
    rawTx: tx.toBuffer().toString('hex'),
    inscriptionId: `${tx.getId()}i0`,
    virtualSize: tx.virtualSize(),
    signature
  };
}
