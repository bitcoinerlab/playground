const REWINDBITCOIN_INSCRIPTION_NUMBER = 123456;
const LOCK_BLOCKS = 2;
const P2A_SCRIPT = Buffer.from('51024e73', 'hex');
const VAULT_PURPOSE = 1073;
export const WPKH_DUST_THRESHOLD = 294;
const MIN_RELAY_FEE_RATE = 0.1;

const VAULT_OUTPUT_INDEX = 0;
const BACKOUT_OUTPUT_INDEX = 1;

const uniqueSorted = (values: number[]) =>
  values
    .filter((value, index, array) => array.indexOf(value) === index)
    .sort((a, b) => a - b);

//////////////////////
// Trigger (134–135 vB):
// 1 P2WPKH input, 2 outputs (P2A + P2WSH).
// - Stripped size: 107 bytes
//   - Version (4) + vin (1) + input (41) + vout (1) + outputs (56) + locktime (4)
//   - Outputs = P2A (13) + P2WSH (43)
// - Witness size: 108–111 bytes
//   - Marker/flag 2
//   - Stack items: sig (70–73 bytes) + 1 len + pubkey (33 bytes) + 1 len + count (1)
// - Weight: 536–539 wu → vsize = 134–135 vB
//////////////////////
const TRIGGER_TX_VBYTES = [134, 135];
const TRIGGER_TX_SERIALIZED_BYTES = [215, 216, 217, 218];

//////////////////////
// Panic (139–140 vB):
// 1 P2WSH input, 2 outputs (P2A + addr).
// - Stripped size: 95 bytes
//  - Version (4) + vin (1) + input (41) + vout (1) + outputs (44) + locktime (4)
//  - Outputs = P2A (13) + P2WPKH (31)
// - Witness size: 176–179 bytes
//  - Marker/flag 2
//  - Stack items: sig (70–73 bytes) + 1 len + pubkey (33 bytes) + 1 len + selector (1 byte) + 1 len + witnessScript (65 bytes) + 1 len + count (1)
// - Weight: 556–559 wu → vsize = 139–140 vB
//////////////////////
const PANIC_TX_VBYTES = [139, 140];
const PANIC_TX_SERIALIZED_BYTES = [271, 272, 273, 274];

const VAULT_ENTRY_BYTES = uniqueSorted(
  TRIGGER_TX_SERIALIZED_BYTES.flatMap(triggerBytes =>
    PANIC_TX_SERIALIZED_BYTES.map(panicBytes => 3 + triggerBytes + panicBytes)
  )
);
const VAULT_CONTENT_BYTES = VAULT_ENTRY_BYTES.map(bytes => bytes + 3);
const P2WPKH_WITNESS_BYTES = [108, 109, 110, 111];

/**
 * Estimated vbytes for the backup tx (1 P2WPKH input, 1 OP_RETURN output).
 *
 * - Trigger tx size: 215–218 bytes (107 stripped + 108–111 witness).
 * - Panic tx size: 271–274 bytes (95 stripped + 176–179 witness).
 * - Serialized entry size: 1 (version) + 1 (trigger len) + trigger + 1 (panic len) + panic = 489–495 bytes.
 * - OP_RETURN payload: 3 ("REW") + entry = 492–498 bytes → OP_PUSHDATA2.
 * - Script size: 1 (OP_RETURN) + 1 (OP_PUSHDATA2) + 2 (len) + payload = 496–502 bytes.
 * - Stripped tx size: 4 + 1 + 41 + 1 + output(8 + 1 + script) + 4 = 556–562 bytes.
 * - Witness size: 108–111 bytes (marker/flag + count + sig(70–73) + pubkey).
 * - vbytes = ceil((stripped*4 + witness) / 4) = 583–590 vB.
 */
const OP_RETURN_SCRIPT_BYTES = VAULT_CONTENT_BYTES.map(bytes => bytes + 4);
const OP_RETURN_OUTPUT_BYTES = OP_RETURN_SCRIPT_BYTES.map(bytes => bytes + 9);
const OP_RETURN_STRIPPED_BYTES = OP_RETURN_OUTPUT_BYTES.map(
  bytes => bytes + 51
);
const OP_RETURN_BACKUP_TX_VBYTES = uniqueSorted(
  OP_RETURN_STRIPPED_BYTES.flatMap(strippedBytes =>
    P2WPKH_WITNESS_BYTES.map(witnessBytes =>
      Math.ceil((strippedBytes * 4 + witnessBytes) / 4)
    )
  )
);

// Reveal tx vsize derivation (1 P2TR inscription input → 1 P2WPKH output).
// 1) Trigger serialized size = 215–218 bytes; panic serialized size = 271–274 bytes.
// 2) Entry = 1 (ver) + 1 (len) + trigger + 1 (len) + panic = 489–495 bytes.
// 3) Content = "REW"(3) + entry = 492–498 bytes.
// 4) Tapscript length = 103 (overhead) + content = 595–601 bytes.
// 5) Witness size (marker/flag + stack count + sig + tapscript + control block)
//    = 2 + 1 + 66 + (3 + tapscript) + 34 = 701–707 bytes.
// 6) Stripped size = 82 bytes → 328 wu.
// 7) Weight = 1029–1035 wu → vsize = 258–259 vB.
const INSCRIPTION_TAPSCRIPT_BYTES = VAULT_CONTENT_BYTES.map(
  bytes => bytes + 103
);
const INSCRIPTION_REVEAL_WITNESS_BYTES = INSCRIPTION_TAPSCRIPT_BYTES.map(
  bytes => bytes + 106
);
const INSCRIPTION_REVEAL_STRIPPED_BYTES = 82;
const INSCRIPTION_REVEAL_BACKUP_TX_VBYTES = uniqueSorted(
  INSCRIPTION_REVEAL_WITNESS_BYTES.map(witnessBytes =>
    Math.ceil((INSCRIPTION_REVEAL_STRIPPED_BYTES * 4 + witnessBytes) / 4)
  )
);

// Commit tx vsize derivation (1 P2WPKH input → 1 P2TR output).
// 1) Stripped size (non‑witness):
//    - version: 4
//    - vin count: 1
//    - input: 41 (prevout 36 + scriptLen 1 + sequence 4)
//    - vout count: 1
//    - output (P2TR): 8 (value) + 1 (script len) + 34 (script) = 43
//    - locktime: 4
//    → stripped = 4 + 1 + 41 + 1 + 43 + 4 = 94 bytes
// 2) Witness size for P2WPKH input (including segwit marker/flag):
//    - marker/flag: 2
//    - stack count: 1
//    - sig: 70–73 + 1 len
//    - pubkey: 33 + 1 len
//    → witness = 108–111 bytes
// 3) Weight = stripped*4 + witness = 94*4 + 108–111 = 484–487 wu
// 4) vsize = ceil(weight / 4) = ceil(484–487 / 4) = 121–122 vB
const INSCRIPTION_COMMIT_BACKUP_TX_VBYTES = [121, 122];

const INSCRIPTION_BACKUP_TX_VBYTES = uniqueSorted(
  INSCRIPTION_COMMIT_BACKUP_TX_VBYTES.flatMap(commitVbytes =>
    INSCRIPTION_REVEAL_BACKUP_TX_VBYTES.map(
      revealVbytes => commitVbytes + revealVbytes
    )
  )
);

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
  changeOutput,
  feeRate
}: {
  utxosData: UtxosData;
  vaultOutput: OutputInstance;
  vaultedAmount: number | 'MAX_FUNDS';
  backupOutput?: OutputInstance;
  backupCost?: number;
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
  let coinselected;
  let targets;
  if (vaultedAmount === 'MAX_FUNDS') {
    targets = [];
    if (backupOutput && backupCost !== undefined)
      targets.push({ output: backupOutput, value: backupCost });

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
      targets[BACKOUT_OUTPUT_INDEX] = {
        output: backupOutput,
        value: backupCost
      };
    vaultedAmount = vaultTarget.value;
  } else {
    targets = [];
    targets[VAULT_OUTPUT_INDEX] = { output: vaultOutput, value: vaultedAmount };
    if (backupOutput && backupCost !== undefined)
      targets[BACKOUT_OUTPUT_INDEX] = {
        output: backupOutput,
        value: backupCost
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

const getBackupCost = (
  backupType: 'OP_RETURN_TRUC' | 'OP_RETURN_V2' | 'INSCRIPTION',
  feeRate: number
) => {
  if (backupType === 'INSCRIPTION')
    return Math.ceil(
      Math.max(...INSCRIPTION_BACKUP_TX_VBYTES) * feeRate + WPKH_DUST_THRESHOLD //FIXME: WPKH_DUST_THRESHOLD cannot be assuned, since the wallet may be of other type...this one must match TAGrfgkjnfdgfgfdg
    );
  if (backupType === 'OP_RETURN_TRUC' || backupType === 'OP_RETURN_V2')
    return Math.ceil(Math.max(...OP_RETURN_BACKUP_TX_VBYTES) * feeRate);
  throw new Error('backupCost unset');
};

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
  vaultIndex: number;
  backupType: 'OP_RETURN_TRUC' | 'OP_RETURN_V2' | 'INSCRIPTION';
  feeRate: number;
  vaultedAmount: number | 'MAX_FUNDS';
  utxosData: UtxosData;
  shiftFeesToBackupEnd?: boolean;
  network: Network;
}) => {
  const randomOriginPath = `/84'/${network === networks.bitcoin ? 0 : 1}'/0'`; //FIXME: can 84 be assumed here?
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
  const backupCost = getBackupCost(backupType, feeRate);
  // Run the coinselector
  const selected = coinselectVaultUtxosData({
    utxosData,
    vaultOutput,
    vaultedAmount,
    backupOutput,
    backupCost,
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
  vaultIndex: number;
  backupType: 'OP_RETURN_TRUC' | 'OP_RETURN_V2' | 'INSCRIPTION';
  shiftFeesToBackupEnd?: boolean;
  network: Network;
}) => {
  const {
    randomKey,
    randomPubKey,
    vaultOutput,
    backupOutput,
    selected,
    backupCost,
    backupOutputValue
  } = getVaultContext({
    masterNode,
    randomMasterNode,
    changeDescriptorWithIndex,
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
  if (vaultTargets[BACKOUT_OUTPUT_INDEX]?.output !== backupOutput)
    throw new Error('coinselect second output should be the backup output');
  if (vaultTargets.length > 3)
    throw new Error(
      'coinselect outputs should be vault, backup, and change at most'
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
  if (backupOutputIndex !== BACKOUT_OUTPUT_INDEX) return 'UNKNOWN_ERROR';
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
    vaultUtxosData,
    randomMasterNode
  };
};

export const createOpReturnBackup = ({
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
  backupType: 'OP_RETURN_TRUC' | 'OP_RETURN_V2';
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

  const entry = serializeVaultEntry({
    triggerTx,
    panicTx
  });
  const header = Buffer.from('REW'); // Magic
  const content = Buffer.concat([header, entry]);

  const psbtBackup = new Psbt({ network }); // Use same network
  psbtBackup.setVersion(backupType === 'OP_RETURN_TRUC' ? 3 : 2);

  // Input: The output from the vault
  const backupInputFinalizer = backupOutput.updatePsbtAsInput({
    psbt: psbtBackup,
    txHex: vaultTx.toHex(),
    vout: BACKOUT_OUTPUT_INDEX
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

export const createInscriptionBackup = ({
  vaultIndex,
  feeRate,
  masterNode,
  psbtTrigger,
  psbtPanic,
  psbtVault,
  changeDescriptorWithIndex,
  shiftFeesToBackupEnd = false,
  network
}: {
  vaultIndex: number;
  feeRate: number;
  masterNode: BIP32Interface;
  psbtTrigger: Psbt;
  psbtPanic: Psbt;
  psbtVault: Psbt;
  changeDescriptorWithIndex: { descriptor: string; index: number };
  shiftFeesToBackupEnd?: boolean;
  network: Network;
}) => {
  const triggerTx = psbtTrigger.extractTransaction().toBuffer();
  const panicTx = psbtPanic.extractTransaction().toBuffer();
  const vaultTx = psbtVault.extractTransaction();

  const entry = serializeVaultEntry({
    triggerTx,
    panicTx
  });
  const header = Buffer.from('REW'); // Magic
  const content = Buffer.concat([header, entry]);

  const commitPath = getInscriptionCommitOutputBackupPath(network, vaultIndex);
  const commitNode = masterNode.derivePath(commitPath);

  const backupInscription = new Inscription({
    contentType: `application/vnd.rewindbitcoin;readme=inscription:${REWINDBITCOIN_INSCRIPTION_NUMBER}`,
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
  const backupOut = vaultTx.outs[BACKOUT_OUTPUT_INDEX];
  if (!backupOut) throw new Error('Backup output not found in vault tx');
  const backupOutputValue = backupOut.value;

  // NOTE: wallet balance will remain at least WPKH_DUST_THRESHOLD
  // (294 sats) because the reveal tx creates a dust change output that is
  // intentionally kept spendable.
  const revealOutputValue = WPKH_DUST_THRESHOLD; //FIXME: WPKH can be assumed always? this one must match TAGrfgkjnfdgfgfdg
  const commitFeeRate = shiftFeesToBackupEnd ? MIN_RELAY_FEE_RATE : feeRate;
  const commitFeeTarget = Math.ceil(
    Math.max(...INSCRIPTION_COMMIT_BACKUP_TX_VBYTES) * commitFeeRate
  );
  const commitOutputValue = backupOutputValue - commitFeeTarget;
  if (commitOutputValue <= revealOutputValue)
    throw new Error('Insufficient vault backup output for reveal fee');

  const psbtCommit = new Psbt({ network });
  const commitInputFinalizer = backupOutput.updatePsbtAsInput({
    psbt: psbtCommit,
    txHex: vaultTx.toHex(),
    vout: BACKOUT_OUTPUT_INDEX
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
  const changeOutput = new Output({ ...changeDescriptorWithIndex, network });
  changeOutput.updatePsbtAsOutput({
    psbt: psbtReveal,
    value: revealOutputValue
  });
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
