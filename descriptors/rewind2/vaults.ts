const FEE = 500; //FIXME: dynamic - also duplicated on index.ts and vaults.ts - better use FEE_RATE
const REWINDBITCOIN_INSCRIPTION_NUMBER = 123456;
const LOCK_BLOCKS = 2;
const P2A_SCRIPT = Buffer.from('51024e73', 'hex');

export type UtxosData = Array<{
  tx: Transaction;
  txHex: string;
  vout: number;
  output: OutputInstance;
}>;

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
import { coinselect, dustThreshold } from '@bitcoinerlab/coinselect';
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

const getOutputsWithValue = (utxosData: UtxosData) =>
  utxosData.map(utxo => {
    const out = utxo.tx.outs[utxo.vout];
    if (!out) throw new Error('Invalid utxo');
    return { output: utxo.output, value: out.value };
  });
const coinselectUtxosData = ({
  utxosData,
  targetOutput,
  changeOutput,
  targetValue,
  feeRate
}: {
  utxosData: UtxosData;
  targetOutput: OutputInstance;
  serviceOutput?: OutputInstance;
  changeOutput: OutputInstance;
  targetValue: number;
  feeRate: number;
}) => {
  const utxos = getOutputsWithValue(utxosData);
  if (!utxos.length) return;
  if (targetValue <= dustThreshold(targetOutput)) return;
  const coinselected = coinselect({
    utxos,
    targets: [{ output: targetOutput, value: targetValue }],
    remainder: changeOutput,
    feeRate
  });
  if (!coinselected) return;
  const selectedUtxosData =
    coinselected.utxos.length === utxosData.length
      ? utxosData
      : coinselected.utxos.map(utxo => {
          const utxoData = utxosData[utxos.indexOf(utxo)];
          if (!utxoData) throw new Error('Invalid utxoData');
          return utxoData;
        });
  return {
    vsize: coinselected.vsize,
    fee: coinselected.fee,
    targets: coinselected.targets,
    utxosData: selectedUtxosData
  };
};

//FIXME: pass here the randomMasterNode
export const createVault = ({
  vaultedAmount,
  unvaultKey,
  feeRate,
  utxosData,
  masterNode,
  coldAddress,
  changeDescriptorWithIndex,
  network
}: {
  vaultedAmount: number;
  /** The unvault key expression that must be used to create triggerDescriptor */
  unvaultKey: string;
  feeRate: number;
  utxosData: UtxosData;
  masterNode: BIP32Interface;
  coldAddress: string;
  changeDescriptorWithIndex: { descriptor: string; index: number };
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
  const changeOutput = new Output({ ...changeDescriptorWithIndex, network });
  // Run the coinselector
  const selected = coinselectUtxosData({
    utxosData,
    targetValue: vaultedAmount,
    targetOutput: vaultOutput,
    changeOutput,
    feeRate
  });
  if (!selected) return 'COINSELECT_ERROR';
  const vaultUtxosData = selected.utxosData;
  const vaultTargets = selected.targets;
  const vaultMiningFee = selected.fee;
  if (vaultTargets[0]?.output !== vaultOutput)
    throw new Error("coinselect first output should be the vault's output");
  if (vaultTargets.length > 2)
    throw new Error('coinselect ouputs should be vault and fee at most');
  const psbtVault = new Psbt({ network });

  //Add the inputs to psbtVault:
  const vaultFinalizers = [];
  for (const utxoData of vaultUtxosData) {
    const { output, vout, txHex } = utxoData;
    // Add the utxo as input of psbtVault:
    const inputFinalizer = output.updatePsbtAsInput({
      psbt: psbtVault,
      txHex,
      vout
    });
    vaultFinalizers.push(inputFinalizer);
  }
  for (const target of vaultTargets) {
    target.output.updatePsbtAsOutput({
      psbt: psbtVault,
      value: target.value
    });
  }
  //Sign
  signers.signBIP32({ psbt: psbtVault, masterNode });
  //Finalize
  vaultFinalizers.forEach(finalizer => finalizer({ psbt: psbtVault }));
  const txVault = psbtVault.extractTransaction(true);
  if (txVault.virtualSize() > selected.vsize)
    throw new Error('vsize larger than coinselected estimated one');
  const feeRateVault = vaultMiningFee / txVault.virtualSize();
  if (feeRateVault < 1) return 'UNKNOWN_ERROR';

  //////////////////////
  // Trigger:
  //////////////////////
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

export const createBackup = ({
  backupIndex,
  feeRate,
  masterNode,
  utxosData,
  psbtTrigger,
  psbtPanic,
  psbtVault,
  network,
  changeDescriptorWithIndex,
  tag
}: {
  backupIndex: number;
  feeRate: number;
  masterNode: BIP32Interface;
  /** to pay for the inscription **/
  utxosData: UtxosData;
  psbtTrigger: Psbt;
  psbtPanic: Psbt;
  psbtVault: Psbt;
  network: Network;
  changeDescriptorWithIndex: { descriptor: string; index: number };
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
