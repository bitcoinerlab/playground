const LOCK_BLOCKS = 2;
const P2A_SCRIPT = Buffer.from('51024e73', 'hex');
const VAULT_PURPOSE = 1073;
const MIN_RELAY_FEE_RATE = 0.1;

export type BackupType = 'INSCRIPTION' | 'OP_RETURN_TRUC' | 'OP_RETURN_V2';
export const BACKUP_TYPES: BackupType[] = [
  'OP_RETURN_V2',
  'OP_RETURN_TRUC',
  'INSCRIPTION'
];
export const DEFAULT_BACKUP_TYPE: BackupType = 'OP_RETURN_V2';

const VAULT_OUTPUT_INDEX = 0;
const BACKUP_OUTPUT_INDEX = 1;
const ANCHOR_RESERVE_OUTPUT_INDEX = 2;

export type UtxosData = Array<{
  tx: Transaction;
  txHex: string;
  vout: number;
  output: OutputInstance;
}>;

import {
  networks,
  Psbt,
  Transaction,
  type Network,
  payments
} from 'bitcoinjs-lib';
import {
  INSCRIPTION_BACKUP_TX_VBYTES,
  INSCRIPTION_COMMIT_BACKUP_TX_VBYTES,
  INSCRIPTION_REVEAL_BACKUP_TX_VBYTES,
  INSCRIPTION_REVEAL_GARBAGE_BYTES,
  OP_RETURN_BACKUP_TX_VBYTES,
  PANIC_TX_VBYTES,
  INSCRIPTION_CONTENT_TYPE,
  TRIGGER_TX_VBYTES
} from './vaultSizes';
// @ts-ignore
import { encode as olderEncode } from 'bip68';
import {
  signers,
  type OutputInstance,
  DescriptorsFactory,
  keyExpressionBIP32
} from '@bitcoinerlab/descriptors';
const { Output, parseKeyExpression } = DescriptorsFactory(secp256k1);
import type { BIP32Interface } from 'bip32';
import { encode as encodeVarInt, encodingLength } from 'varuint-bitcoin';
import { compilePolicy } from '@bitcoinerlab/miniscript';
import { InscriptionsFactory } from './inscriptions';
import { getManagedChacha, getSeedDerivedCipherKey } from './cipher';
import * as secp256k1 from '@bitcoinerlab/secp256k1';
import { coinselect, dustThreshold, maxFunds } from '@bitcoinerlab/coinselect';
const { Inscription } = InscriptionsFactory(secp256k1);

const getInscriptionCommitOutputBackupPath = (
  network: Network,
  index: number
): string => {
  const coinType = network === networks.bitcoin ? "0'" : "1'";
  return `m/86'/${coinType}/0'/9/${index}`;
};

export const getVaultOriginPath = (network: Network) =>
  `/${VAULT_PURPOSE}'/${network === networks.bitcoin ? 0 : 1}'/0'`;

export const getBackupDescriptor = ({
  masterNode,
  network,
  index
}: {
  masterNode: BIP32Interface;
  network: Network;
  index: number | '*';
}) => {
  const keyPath = index === '*' ? '/*' : `/${index}`;
  const keyExpression = keyExpressionBIP32({
    masterNode,
    originPath: getVaultOriginPath(network),
    keyPath
  });
  return `wpkh(${keyExpression})`;
};

/**
 * Serializes a vault entry into a compact TLV-like format.
 * Format: [Version][TriggerLen][Trigger][PanicLen][Panic]
 */
const serializeVaultEntry = ({
  triggerTx,
  panicTx
}: {
  triggerTx: Buffer;
  panicTx: Buffer;
}) => {
  const ENTRY_VERSION = 1;
  const encVI = (n: number) => {
    const b = Buffer.allocUnsafe(encodingLength(n));
    encodeVarInt(n, b);
    return b;
  };

  return Buffer.concat([
    Buffer.from([ENTRY_VERSION]),
    encVI(triggerTx.length),
    triggerTx,
    encVI(panicTx.length),
    panicTx
  ]);
};

const buildEncryptedVaultContent = async ({
  triggerTx,
  panicTx,
  masterNode,
  network,
  vaultIndex
}: {
  triggerTx: Buffer;
  panicTx: Buffer;
  masterNode: BIP32Interface;
  network: Network;
  vaultIndex: number;
}) => {
  const entry = serializeVaultEntry({ triggerTx, panicTx });
  const header = Buffer.from('REW'); // Magic
  const vaultPath = `m${getVaultOriginPath(network)}/${vaultIndex}`;
  const cipherKey = await getSeedDerivedCipherKey({ vaultPath, masterNode });
  const cipher = await getManagedChacha(cipherKey);
  const encryptedEntry = Buffer.from(cipher.encrypt(entry));
  return Buffer.concat([header, encryptedEntry]);
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

const coinselectVaultUtxosData = ({
  utxosData,
  vaultOutput,
  vaultedAmount,
  backupOutput,
  backupCost,
  anchorReserve = 0,
  anchorReserveOutput,
  changeOutput,
  feeRate
}: {
  utxosData: UtxosData;
  vaultOutput: OutputInstance;
  vaultedAmount: number | 'MAX_FUNDS';
  backupOutput?: OutputInstance;
  backupCost?: number;
  anchorReserve?: number;
  anchorReserveOutput?: OutputInstance;
  changeOutput: OutputInstance;
  feeRate: number;
}) => {
  const utxos = getOutputsWithValue(utxosData);
  if (!utxos.length) return 'NO_UTXOS';
  if (
    typeof vaultedAmount === 'number' &&
    vaultedAmount <= dustThreshold(vaultOutput)
  )
    return `VAULT OUT BELOW DUST: ${vaultedAmount} <= ${dustThreshold(vaultOutput)}`;
  if (backupOutput && backupCost !== undefined) {
    if (backupCost <= dustThreshold(backupOutput))
      return `BACKUP OUT BELOW DUST: ${backupCost} <= ${dustThreshold(backupOutput)}`;
  } else if (backupOutput || backupCost !== undefined) {
    throw new Error('backupOutput and backupCost must be provided together');
  }
  const shouldReserveAnchor = anchorReserve > 0;
  if (shouldReserveAnchor && !anchorReserveOutput)
    throw new Error('anchorReserveOutput required when anchorReserve is set');
  if (!shouldReserveAnchor && anchorReserveOutput)
    throw new Error(
      'anchorReserve must be set when anchorReserveOutput exists'
    );
  if (shouldReserveAnchor && anchorReserveOutput) {
    const dust = dustThreshold(anchorReserveOutput);
    if (anchorReserve <= dust)
      return `ANCHOR RESERVE BELOW DUST: ${anchorReserve} <= ${dust}`;
  }
  let coinselected;
  let targets;
  if (vaultedAmount === 'MAX_FUNDS') {
    targets = [];
    if (backupOutput && backupCost !== undefined)
      targets.push({ output: backupOutput, value: backupCost });
    if (shouldReserveAnchor && anchorReserveOutput)
      targets.push({ output: anchorReserveOutput, value: anchorReserve });

    coinselected = maxFunds({
      utxos,
      targets,
      remainder: vaultOutput,
      feeRate
    });
    if (!coinselected) return 'MAX_FUNDS COINSELECTOR FAILED';
    const vaultTarget = coinselected.targets.find(
      target => target.output === vaultOutput
    );
    if (!vaultTarget) throw new Error('Could not find vaultOutput');
    if (vaultTarget.value <= dustThreshold(vaultOutput))
      return `VAULT TARGET OUT BELOW DUST: ${vaultTarget.value} <= ${dustThreshold(vaultOutput)}`;
    // maxFunds returns targets with the remainder (vault output) last, while createVault expects the vault output first and backup second
    targets = [];
    targets[VAULT_OUTPUT_INDEX] = {
      output: vaultOutput,
      value: vaultTarget.value
    };
    if (backupOutput && backupCost !== undefined)
      targets[BACKUP_OUTPUT_INDEX] = {
        output: backupOutput,
        value: backupCost
      };
    if (shouldReserveAnchor && anchorReserveOutput)
      targets[ANCHOR_RESERVE_OUTPUT_INDEX] = {
        output: anchorReserveOutput,
        value: anchorReserve
      };
    vaultedAmount = vaultTarget.value;
  } else {
    targets = [];
    targets[VAULT_OUTPUT_INDEX] = { output: vaultOutput, value: vaultedAmount };
    if (backupOutput && backupCost !== undefined)
      targets[BACKUP_OUTPUT_INDEX] = {
        output: backupOutput,
        value: backupCost
      };
    if (shouldReserveAnchor && anchorReserveOutput)
      targets[ANCHOR_RESERVE_OUTPUT_INDEX] = {
        output: anchorReserveOutput,
        value: anchorReserve
      };

    coinselected = coinselect({
      utxos,
      targets,
      remainder: changeOutput,
      feeRate
    });
    if (!coinselected) return 'REGULAR COINSELECTOR FAILED';
    targets = coinselected.targets;
  }
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
    targets,
    vaultedAmount,
    utxosData: selectedUtxosData
  };
};

const getBackupCost = (backupType: BackupType, feeRate: number) => {
  if (backupType === 'INSCRIPTION')
    return Math.ceil(Math.max(...INSCRIPTION_BACKUP_TX_VBYTES) * feeRate);
  if (backupType === 'OP_RETURN_TRUC' || backupType === 'OP_RETURN_V2')
    return Math.ceil(Math.max(...OP_RETURN_BACKUP_TX_VBYTES) * feeRate);
  throw new Error('backupCost unset');
};

const getUtxosValue = (utxosData: UtxosData) =>
  utxosData.reduce((sum, utxo) => {
    const out = utxo.tx.outs[utxo.vout];
    if (!out) throw new Error('Invalid utxo');
    return sum + out.value;
  }, 0);

/**
 * Builds deterministic vault outputs and runs coin selection for them.
 *
 * Uses a randomly derived vault output, a deterministic backup output derived
 * from the vault index, and a wallet change output to compute the coinselector
 * for the requested vaulted amount. The backup cost is derived from the
 * backup type and fee rate.
 */
export const getVaultContext = ({
  masterNode,
  randomMasterNode,
  changeDescriptorWithIndex,
  anchorReserve = 0,
  anchorReserveDescriptorWithIndex,
  vaultIndex,
  backupType,
  feeRate,
  utxosData,
  vaultedAmount,
  shiftFeesToBackupEnd = false,
  network
}: {
  masterNode: BIP32Interface;
  randomMasterNode: BIP32Interface;
  changeDescriptorWithIndex: { descriptor: string; index: number };
  anchorReserve?: number;
  anchorReserveDescriptorWithIndex?: { descriptor: string; index: number };
  vaultIndex: number;
  backupType: BackupType;
  feeRate: number;
  vaultedAmount: number | 'MAX_FUNDS';
  utxosData: UtxosData;
  shiftFeesToBackupEnd?: boolean;
  network: Network;
}) => {
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
  const vaultOutput = new Output({ descriptor: `wpkh(${randomKey})`, network });
  const backupOutput = new Output({
    descriptor: getBackupDescriptor({ masterNode, network, index: vaultIndex }),
    network
  });
  const changeOutput = new Output({ ...changeDescriptorWithIndex, network });
  const shouldReserveAnchor = anchorReserve > 0;
  let anchorReserveOutput: OutputInstance | undefined;
  if (shouldReserveAnchor) {
    if (!anchorReserveDescriptorWithIndex)
      throw new Error('Missing anchorReserveDescriptorWithIndex');
    anchorReserveOutput = new Output({
      ...anchorReserveDescriptorWithIndex,
      network
    });
  } else if (anchorReserveDescriptorWithIndex)
    throw new Error('anchorReserve must be set when descriptor is provided');

  const backupCost = getBackupCost(backupType, feeRate);
  // Run the coinselector
  const selected = coinselectVaultUtxosData({
    utxosData,
    vaultOutput,
    vaultedAmount,
    backupOutput,
    backupCost,
    anchorReserve,
    ...(anchorReserveOutput ? { anchorReserveOutput } : {}),
    changeOutput,
    feeRate
  });

  let backupOutputValue = backupCost;
  if (shiftFeesToBackupEnd && typeof selected !== 'string') {
    const minRelayFeeRate =
      backupType === 'OP_RETURN_TRUC' ? 0 : MIN_RELAY_FEE_RATE;
    const minRelayFee = Math.ceil(selected.vsize * minRelayFeeRate);
    if (selected.fee < minRelayFee)
      throw new Error(
        `Coinselected fee (${selected.fee}) below min relay fee (${minRelayFee})`
      );
    const feeShift = selected.fee - minRelayFee;
    if (feeShift > 0) {
      backupOutputValue = backupCost + feeShift;
      const backupTargetIndex = selected.targets.findIndex(
        target => target.output === backupOutput
      );
      if (backupTargetIndex < 0)
        throw new Error('Backup output target not found');
      selected.targets = selected.targets.map((target, index) =>
        index === backupTargetIndex
          ? { ...target, value: backupOutputValue }
          : target
      );
      selected.fee = minRelayFee;
    }
  }

  return {
    randomKey,
    randomPubKey,
    vaultOutput,
    backupOutput,
    anchorReserveOutput,
    changeOutput,
    backupCost,
    backupOutputValue,
    selected
  };
};

export const createVault = ({
  vaultedAmount,
  unvaultKey,
  feeRate,
  utxosData,
  masterNode,
  randomMasterNode,
  coldAddress,
  changeDescriptorWithIndex,
  anchorReserve = 0,
  anchorReserveDescriptorWithIndex,
  vaultIndex,
  backupType,
  shiftFeesToBackupEnd = false,
  network
}: {
  vaultedAmount: number;
  /** The unvault key expression that must be used to create triggerDescriptor */
  unvaultKey: string;
  feeRate: number;
  utxosData: UtxosData;
  masterNode: BIP32Interface;
  randomMasterNode: BIP32Interface;
  coldAddress: string;
  changeDescriptorWithIndex: { descriptor: string; index: number };
  anchorReserve?: number;
  anchorReserveDescriptorWithIndex?: { descriptor: string; index: number };
  vaultIndex: number;
  backupType: BackupType;
  shiftFeesToBackupEnd?: boolean;
  network: Network;
}) => {
  const {
    randomKey,
    randomPubKey,
    vaultOutput,
    backupOutput,
    anchorReserveOutput,
    selected,
    backupCost,
    backupOutputValue
  } = getVaultContext({
    masterNode,
    randomMasterNode,
    changeDescriptorWithIndex,
    anchorReserve,
    ...(anchorReserveDescriptorWithIndex
      ? { anchorReserveDescriptorWithIndex }
      : {}),
    vaultIndex,
    backupType,
    feeRate,
    utxosData,
    vaultedAmount,
    shiftFeesToBackupEnd,
    network
  });
  if (typeof selected === 'string') return 'COINSELECT_ERROR: ' + selected;
  const vaultUtxosData = selected.utxosData;
  const vaultTargets = selected.targets;
  if (vaultTargets[VAULT_OUTPUT_INDEX]?.output !== vaultOutput)
    throw new Error("coinselect first output should be the vault's output");
  if (vaultTargets[BACKUP_OUTPUT_INDEX]?.output !== backupOutput)
    throw new Error('coinselect second output should be the backup output');
  const shouldReserveAnchor = anchorReserve > 0;
  if (
    shouldReserveAnchor &&
    vaultTargets[ANCHOR_RESERVE_OUTPUT_INDEX]?.output !== anchorReserveOutput
  )
    throw new Error('coinselect third output should be the anchor reserve');
  if (!shouldReserveAnchor && anchorReserveOutput)
    throw new Error('Unexpected anchor reserve output');
  if (shouldReserveAnchor && anchorReserveOutput) {
    const anchorTarget = vaultTargets[ANCHOR_RESERVE_OUTPUT_INDEX];
    if (!anchorTarget || anchorTarget.value !== anchorReserve)
      throw new Error('Invalid anchor reserve amount');
  }
  if (vaultTargets.length > (shouldReserveAnchor ? 4 : 3))
    throw new Error(
      'coinselect outputs should be vault, backup, anchor reserve, and change at most'
    );
  const psbtVault = new Psbt({ network });

  psbtVault.setVersion(backupType === 'OP_RETURN_TRUC' ? 3 : 2);

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
  const backupOutputIndex = vaultTargets.findIndex(
    target => target.output === backupOutput
  );
  if (backupOutputIndex !== BACKUP_OUTPUT_INDEX) return 'UNKNOWN_ERROR';
  if (backupOutputValue !== vaultTargets[backupOutputIndex]?.value)
    return 'UNKNOWN_ERROR';
  //Sign
  signers.signBIP32({ psbt: psbtVault, masterNode });
  //Finalize
  vaultFinalizers.forEach(finalizer => finalizer({ psbt: psbtVault }));
  const txVault = psbtVault.extractTransaction();
  const vaultVsize = txVault.virtualSize();
  if (vaultVsize > selected.vsize)
    throw new Error('vsize larger than coinselected estimated one');
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
  const triggerVsize = psbtTrigger.extractTransaction().virtualSize();
  if (!TRIGGER_TX_VBYTES.includes(triggerVsize))
    throw new Error(`Unexpected trigger vsize: ${triggerVsize}`);

  const psbtPanic = new Psbt({ network });
  psbtPanic.setVersion(3);
  psbtPanic.addOutput({ script: P2A_SCRIPT, value: 0 }); //vout: 0
  const panicInputFinalizer = triggerOutputPanicPath.updatePsbtAsInput({
    psbt: psbtPanic,
    txHex: psbtTrigger.extractTransaction().toHex(),
    vout: 1
  });
  const coldOutput = new Output({
    descriptor: `addr(${coldAddress})`,
    network
  });
  coldOutput.updatePsbtAsOutput({ psbt: psbtPanic, value: vaultedAmount });
  signers.signBIP32({
    psbt: psbtPanic,
    masterNode: randomMasterNode
  });
  panicInputFinalizer({ psbt: psbtPanic });
  const panicVsize = psbtPanic.extractTransaction().virtualSize();
  if (!PANIC_TX_VBYTES.includes(panicVsize))
    throw new Error(`Unexpected panic vsize: ${panicVsize}`);

  return {
    psbtVault,
    psbtTrigger,
    psbtPanic,
    backupCost,
    backupOutputValue,
    anchorReserveOutput,
    vaultUtxosData,
    randomMasterNode
  };
};

export const createOpReturnBackup = async ({
  psbtTrigger,
  psbtPanic,
  psbtVault,
  vaultIndex,
  masterNode,
  backupType,
  network
}: {
  psbtTrigger: Psbt;
  psbtPanic: Psbt;
  psbtVault: Psbt;
  vaultIndex: number;
  masterNode: BIP32Interface;
  backupType: Exclude<BackupType, 'INSCRIPTION'>;
  network: Network;
}) => {
  if (backupType !== 'OP_RETURN_TRUC' && backupType !== 'OP_RETURN_V2')
    throw new Error(`Invalid backupType $backupType}`);
  const vaultTx = psbtVault.extractTransaction();
  const triggerTx = psbtTrigger.extractTransaction().toBuffer();
  const panicTx = psbtPanic.extractTransaction().toBuffer();
  const backupOutput = new Output({
    descriptor: getBackupDescriptor({ masterNode, network, index: vaultIndex }),
    network
  });

  const content = await buildEncryptedVaultContent({
    triggerTx,
    panicTx,
    masterNode,
    network,
    vaultIndex
  });

  const psbtBackup = new Psbt({ network }); // Use same network
  psbtBackup.setVersion(backupType === 'OP_RETURN_TRUC' ? 3 : 2);

  // Input: The output from the vault
  const backupInputFinalizer = backupOutput.updatePsbtAsInput({
    psbt: psbtBackup,
    txHex: vaultTx.toHex(),
    vout: BACKUP_OUTPUT_INDEX
  });

  // Output: OP_RETURN
  const embed = payments.embed({ data: [content] });
  if (!embed.output) throw new Error('Could not create embed output');
  psbtBackup.addOutput({
    script: embed.output,
    value: 0
  });

  signers.signBIP32({ psbt: psbtBackup, masterNode });
  backupInputFinalizer({ psbt: psbtBackup });
  const backupVsize = psbtBackup.extractTransaction().virtualSize();
  if (!OP_RETURN_BACKUP_TX_VBYTES.includes(backupVsize))
    throw new Error(`Unexpected backup vsize: ${backupVsize}`);

  return psbtBackup;
};

export const createInscriptionBackup = async ({
  vaultIndex,
  feeRate,
  masterNode,
  psbtTrigger,
  psbtPanic,
  psbtVault,
  shiftFeesToBackupEnd = false,
  network
}: {
  vaultIndex: number;
  feeRate: number;
  masterNode: BIP32Interface;
  psbtTrigger: Psbt;
  psbtPanic: Psbt;
  psbtVault: Psbt;
  shiftFeesToBackupEnd?: boolean;
  network: Network;
}) => {
  const triggerTx = psbtTrigger.extractTransaction().toBuffer();
  const panicTx = psbtPanic.extractTransaction().toBuffer();
  const vaultTx = psbtVault.extractTransaction();

  const content = await buildEncryptedVaultContent({
    triggerTx,
    panicTx,
    masterNode,
    network,
    vaultIndex
  });

  const commitPath = getInscriptionCommitOutputBackupPath(network, vaultIndex);
  const commitNode = masterNode.derivePath(commitPath);

  const backupInscription = new Inscription({
    contentType: INSCRIPTION_CONTENT_TYPE,
    content,
    bip32Derivation: {
      masterFingerprint: masterNode.fingerprint,
      path: commitPath,
      pubkey: commitNode.publicKey
    },
    network
  });

  const backupOutput = new Output({
    descriptor: getBackupDescriptor({ masterNode, network, index: vaultIndex }),
    network
  });
  const backupOut = vaultTx.outs[BACKUP_OUTPUT_INDEX];
  if (!backupOut) throw new Error('Backup output not found in vault tx');
  const backupOutputValue = backupOut.value;
  const commitFeeRate = shiftFeesToBackupEnd ? MIN_RELAY_FEE_RATE : feeRate;
  const commitFeeTarget = Math.ceil(
    Math.max(...INSCRIPTION_COMMIT_BACKUP_TX_VBYTES) * commitFeeRate
  );
  const commitOutputValue = backupOutputValue - commitFeeTarget;
  if (commitOutputValue <= 0)
    throw new Error('Insufficient vault backup output for reveal fee');

  const psbtCommit = new Psbt({ network });
  const commitInputFinalizer = backupOutput.updatePsbtAsInput({
    psbt: psbtCommit,
    txHex: vaultTx.toHex(),
    vout: BACKUP_OUTPUT_INDEX
  });
  backupInscription.updatePsbtAsOutput({
    psbt: psbtCommit,
    value: commitOutputValue
  });
  signers.signBIP32({ psbt: psbtCommit, masterNode });
  commitInputFinalizer({ psbt: psbtCommit });

  const commitTx = psbtCommit.extractTransaction();
  const commitVsize = commitTx.virtualSize();

  const psbtReveal = new Psbt({ network });
  const revealInputFinalizer = backupInscription.updatePsbtAsInput({
    psbt: psbtReveal,
    txHex: commitTx.toHex(),
    vout: 0
  });
  const revealGarbage = Buffer.alloc(INSCRIPTION_REVEAL_GARBAGE_BYTES);
  const embed = payments.embed({ data: [revealGarbage] });
  if (!embed.output)
    throw new Error('Could not create reveal OP_RETURN output');
  psbtReveal.addOutput({ script: embed.output, value: 0 });
  // OP_RETURN payload keeps the reveal tx above the min relay size.
  signers.signBIP32({ psbt: psbtReveal, masterNode });
  revealInputFinalizer({ psbt: psbtReveal });

  const revealTx = psbtReveal.extractTransaction();
  const revealVsize = revealTx.virtualSize();
  if (!INSCRIPTION_REVEAL_BACKUP_TX_VBYTES.includes(revealVsize))
    throw new Error(`Unexpected inscription reveal vsize: ${revealVsize}`);
  if (!INSCRIPTION_COMMIT_BACKUP_TX_VBYTES.includes(commitVsize))
    throw new Error(`Unexpected inscription commit vsize: ${commitVsize}`);

  return { psbtCommit, psbtReveal };
};

export const createP2ACpfpChild = ({
  parentTx,
  parentVsize,
  anchorReserveUtxosData,
  anchorReserveOutput,
  masterNode,
  feeRate,
  network
}: {
  parentTx: Transaction;
  parentVsize: number;
  anchorReserveUtxosData: UtxosData;
  anchorReserveOutput: OutputInstance;
  masterNode: BIP32Interface;
  feeRate: number;
  network: Network;
}):
  | {
      psbt: Psbt;
      tx: Transaction;
      childVsize: number;
      targetFee: number;
      outputValue: number;
      reserveValue: number;
      warning?: string;
    }
  | string => {
  if (!anchorReserveUtxosData.length) return 'NO_ANCHOR_RESERVE_UTXOS';
  const reserveValue = getUtxosValue(anchorReserveUtxosData);

  const buildChild = (outputValue: number) => {
    const psbt = new Psbt({ network });
    psbt.setVersion(3);
    psbt.addInput({
      hash: parentTx.getId(),
      index: 0,
      witnessUtxo: { script: P2A_SCRIPT, value: 0 }
    });
    const anchorInputFinalizers = anchorReserveUtxosData.map(utxo =>
      utxo.output.updatePsbtAsInput({
        psbt,
        txHex: utxo.txHex,
        vout: utxo.vout
      })
    );
    anchorReserveOutput.updatePsbtAsOutput({ psbt, value: outputValue });
    signers.signBIP32({ psbt, masterNode });
    psbt.finalizeInput(0, () => ({
      finalScriptSig: Buffer.alloc(0),
      finalScriptWitness: Buffer.from([0x00])
    }));
    anchorInputFinalizers.forEach(finalizer => finalizer({ psbt }));
    const tx = psbt.extractTransaction();
    return { psbt, tx, vsize: tx.virtualSize() };
  };

  const provisional = buildChild(reserveValue);
  const targetFee = Math.ceil((parentVsize + provisional.vsize) * feeRate);
  const outputValue = reserveValue - targetFee;
  const dust = dustThreshold(anchorReserveOutput);
  if (outputValue <= dust)
    return `ANCHOR_CHANGE_BELOW_DUST: ${Math.max(outputValue, 0)} <= ${dust}`;
  const warningMessages = [];
  if (reserveValue < targetFee)
    warningMessages.push(
      `Anchor reserve (${reserveValue} sats) is below target fee (${targetFee} sats).`
    );
  const finalValue = Math.max(0, outputValue);
  const finalChild = buildChild(finalValue);
  const warning = warningMessages.length
    ? warningMessages.join(' ')
    : undefined;

  return {
    psbt: finalChild.psbt,
    tx: finalChild.tx,
    childVsize: finalChild.vsize,
    targetFee,
    outputValue: finalValue,
    reserveValue,
    ...(warning ? { warning } : {})
  };
};
