const FEE = 500; //FIXME: dynamic - also duplicated on index.ts and vaults.ts
const REWINDBITCOIN_INSCRIPTION_NUMBER = 123456;
const LOCK_BLOCKS = 2;
const BACKUP_FUNDING = 1500; //FIXME: dynamic
const P2A_SCRIPT = Buffer.from('51024e73', 'hex');

import { Log } from './utils';
import { generateMnemonic, mnemonicToSeedSync } from 'bip39';
import {
  networks,
  Psbt,
  Transaction,
  type Network,
  payments
} from 'bitcoinjs-lib';
// @ts-ignore
import { encode as olderEncode } from 'bip68';
import {
  signers,
  type OutputInstance,
  DescriptorsFactory,
  keyExpressionBIP32
} from '@bitcoinerlab/descriptors';
const { Output, BIP32, parseKeyExpression } = DescriptorsFactory(secp256k1);
import type { BIP32Interface } from 'bip32';
import { encode as encodeVarInt, encodingLength } from 'varuint-bitcoin';
import { compilePolicy } from '@bitcoinerlab/miniscript';
import { InscriptionsFactory } from './inscriptions';
import * as secp256k1 from '@bitcoinerlab/secp256k1';
import type { Explorer } from '@bitcoinerlab/explorer';
const { Inscription } = InscriptionsFactory(secp256k1);

const getBackupPath = (network: Network, index: number): string => {
  const coinType = network === networks.bitcoin ? "0'" : "1'";
  return `m/86'/${coinType}/0'/9/${index}`;
};

/**
 * Serializes a single vault entry into RAF v1 TLV format.
 * Format: [Type 0x01][PayloadLen][VaultTxId][TriggerLen][Trigger][PanicLen][Panic][TagLen][Tag]
 */
const serializeVaultEntry = ({
  vaultTxId,
  triggerTx,
  panicTx,
  tag
}: {
  vaultTxId: Buffer;
  triggerTx: Buffer;
  panicTx: Buffer;
  tag?: string;
}) => {
  const tagBuffer = tag ? Buffer.from(tag, 'utf8') : Buffer.alloc(0);

  const encVI = (n: number) => {
    const b = Buffer.allocUnsafe(encodingLength(n));
    encodeVarInt(n, b);
    return b;
  };

  const payload = Buffer.concat([
    vaultTxId, // 32 bytes
    encVI(triggerTx.length),
    triggerTx,
    encVI(panicTx.length),
    panicTx,
    encVI(tagBuffer.length),
    tagBuffer
  ]);

  return Buffer.concat([
    Buffer.from([0x01]), // Type: Vault
    encVI(payload.length),
    payload
  ]);
};

const createTriggerDescriptor = ({
  unvaultKey,
  panicKey,
  lockBlocks
}: {
  unvaultKey: string;
  panicKey: string;
  lockBlocks: number;
}) => {
  const POLICY = (older: number) =>
    `or(pk(@panicKey),99@and(pk(@unvaultKey),older(${older})))`;
  const older = olderEncode({ blocks: lockBlocks });
  const { miniscript, issane } = compilePolicy(POLICY(older));
  if (!issane) throw new Error('Policy not sane');

  const triggerDescriptor = `wsh(${miniscript
    .replace('@unvaultKey', unvaultKey)
    .replace('@panicKey', panicKey)})`;
  return triggerDescriptor;
};

export const createVaultChain = ({
  walletUTXO,
  walletPrevTxHex,
  masterNode,
  coldAddress,
  network
}: {
  walletUTXO: OutputInstance;
  walletPrevTxHex: string;
  masterNode: BIP32Interface;
  coldAddress: string;
  network: Network;
}) => {
  const randomMnemonic = generateMnemonic();

  const randomMasterNode = BIP32.fromSeed(
    mnemonicToSeedSync(randomMnemonic),
    network
  );
  const randomOriginPath = `/84'/${network === networks.bitcoin ? 0 : 1}'/0'`;
  const randomKeyPath = `/0/0`;
  const randomKey = keyExpressionBIP32({
    masterNode: randomMasterNode,
    originPath: randomOriginPath,
    keyPath: randomKeyPath
  });
  const randomPubKey = randomMasterNode.derivePath(
    `m${randomOriginPath}${randomKeyPath}`
  ).publicKey;
  const vaultOutput = new Output({
    descriptor: `wpkh(${randomKey})`,
    network
  });
  console.log(`Vault address: ${vaultOutput.getAddress()}`);
  const psbtVault = new Psbt({ network });
  const walletPrevTransaction = Transaction.fromHex(walletPrevTxHex);
  const walletPrevVout = walletPrevTransaction.outs.findIndex(
    txOut =>
      txOut.script.toString('hex') ===
      walletUTXO.getScriptPubKey().toString('hex')
  );
  const vaultFinalizer = walletUTXO.updatePsbtAsInput({
    psbt: psbtVault,
    txHex: walletPrevTxHex,
    vout: walletPrevVout
  });
  const backupFunding = BACKUP_FUNDING;

  if (!walletPrevTransaction.outs[walletPrevVout])
    throw new Error('Invalid vout');
  const walletBalance = walletPrevTransaction.outs[walletPrevVout].value;
  Log(`💎 Wallet balance (sats): ${walletBalance}`);
  const vaultedAmount = walletBalance - FEE - backupFunding;
  vaultOutput.updatePsbtAsOutput({
    psbt: psbtVault,
    value: vaultedAmount
  });
  walletUTXO.updatePsbtAsOutput({ psbt: psbtVault, value: backupFunding });
  signers.signBIP32({ psbt: psbtVault, masterNode });
  vaultFinalizer({ psbt: psbtVault });

  //////////////////////
  // Trigger:
  //////////////////////
  const unvaultKey = keyExpressionBIP32({
    masterNode,
    originPath: "/0'",
    keyPath: '/0'
  });
  const panicKey = randomKey;
  const triggerDescriptor = createTriggerDescriptor({
    unvaultKey,
    panicKey,
    lockBlocks: LOCK_BLOCKS
  });
  const triggerOutputPanicPath = new Output({
    descriptor: triggerDescriptor,
    network,
    signersPubKeys: [randomPubKey]
  });
  const { pubkey: unvaultPubKey } = parseKeyExpression({
    keyExpression: unvaultKey,
    network
  });
  if (!unvaultPubKey) throw new Error('Could not extract unvaultPubKey');

  const psbtTrigger = new Psbt({ network });
  psbtTrigger.setVersion(3);
  //Add the input (vaultOutput) to psbtTrigger as input:
  const triggerInputFinalizer = vaultOutput.updatePsbtAsInput({
    psbt: psbtTrigger,
    txHex: psbtVault.extractTransaction().toHex(),
    vout: 0
  });
  psbtTrigger.addOutput({ script: P2A_SCRIPT, value: 0 }); //vout: 0
  triggerOutputPanicPath.updatePsbtAsOutput({
    psbt: psbtTrigger,
    value: vaultedAmount //zero fee
  }); //vout: 1
  signers.signBIP32({
    psbt: psbtTrigger,
    masterNode: randomMasterNode
  });
  triggerInputFinalizer({ psbt: psbtTrigger });

  //////////////////////
  // Panic:
  //////////////////////

  const psbtPanic = new Psbt({ network });
  psbtPanic.setVersion(3);
  psbtPanic.addOutput({ script: P2A_SCRIPT, value: 0 }); //vout: 0
  const panicInputFinalizer = triggerOutputPanicPath.updatePsbtAsInput({
    psbt: psbtPanic,
    txHex: psbtTrigger.extractTransaction().toHex(),
    vout: 1
  });
  const coldOutput = new Output({
    descriptor: `addr(${coldAddress}`,
    network
  });
  coldOutput.updatePsbtAsOutput({ psbt: psbtPanic, value: vaultedAmount });
  signers.signBIP32({
    psbt: psbtPanic,
    masterNode: randomMasterNode
  });
  panicInputFinalizer({ psbt: psbtPanic });

  return { psbtVault, psbtTrigger, psbtPanic };
};

export const getNextBackupIndex = async ({
  masterNode,
  network,
  explorer
}: {
  masterNode: BIP32Interface;
  network: Network;
  explorer: Explorer;
}): Promise<number> => {
  let index = 0;
  while (true) {
    const path = getBackupPath(network, index);
    const pubkey = masterNode.derivePath(path).publicKey;

    // Predictable BIP86 address (Key-path spend)
    const { address } = payments.p2tr({
      internalPubkey: pubkey.subarray(1, 33), //to x-only
      network
    });

    if (!address) throw new Error('Could not derive address');

    Log(`Checking discovery marker at index ${index}: ${address}...`);
    const { txCount } = await explorer.fetchAddress(address);

    if (txCount === 0) {
      Log(`Next available backup index: ${index}`);
      return index;
    }
    index++;
  }
};

export const createBackupChain = ({
  backupIndex,
  psbtTrigger,
  psbtPanic,
  psbtVault,
  fundingTxHex,
  fundingVout,
  masterNode,
  walletUTXO,
  network,
  tag
}: {
  backupIndex: number;
  psbtTrigger: Psbt;
  psbtPanic: Psbt;
  psbtVault: Psbt;
  fundingTxHex: string;
  fundingVout: number;
  masterNode: BIP32Interface;
  /** to pay for the inscription **/
  walletUTXO: OutputInstance;
  network: Network;
  tag?: string;
}) => {
  const vaultTxId = psbtVault.extractTransaction().getHash();
  const triggerTx = psbtTrigger.extractTransaction().toBuffer();
  const panicTx = psbtPanic.extractTransaction().toBuffer();

  const entry = serializeVaultEntry({
    vaultTxId,
    triggerTx,
    panicTx,
    ...(tag ? { tag } : {})
  });
  const header = Buffer.from('REW\x01'); // Magic + Version 1
  const content = Buffer.concat([header, entry]);

  const backupPath = getBackupPath(network, backupIndex);
  const backupNode = masterNode.derivePath(backupPath);

  const backupInscription = new Inscription({
    contentType: `application/vnd.rewindbitcoin;readme=inscription:${REWINDBITCOIN_INSCRIPTION_NUMBER}`,
    content,
    bip32Derivation: {
      masterFingerprint: masterNode.fingerprint,
      path: backupPath,
      pubkey: backupNode.publicKey
    },
    network
  });

  const psbtCommit = new Psbt({ network });
  psbtCommit.setVersion(3);
  const commitInputFinalizer = walletUTXO.updatePsbtAsInput({
    psbt: psbtCommit,
    txHex: fundingTxHex,
    vout: fundingVout
  });
  const inscriptionValue = 1000;
  backupInscription.updatePsbtAsOutput({
    psbt: psbtCommit,
    value: inscriptionValue
  });
  signers.signBIP32({ psbt: psbtCommit, masterNode });
  commitInputFinalizer({ psbt: psbtCommit });

  const psbtReveal = new Psbt({ network });
  psbtReveal.setVersion(3);
  const revealInputFinalizer = backupInscription.updatePsbtAsInput({
    psbt: psbtReveal,
    txHex: psbtCommit.extractTransaction().toHex(),
    vout: 0
  });
  psbtReveal.addOutput({ script: P2A_SCRIPT, value: 0 });
  walletUTXO.updatePsbtAsOutput({
    psbt: psbtReveal,
    value: inscriptionValue - FEE
  });
  signers.signBIP32({ psbt: psbtReveal, masterNode });
  revealInputFinalizer({ psbt: psbtReveal });

  return { psbtCommit, psbtReveal };
};
