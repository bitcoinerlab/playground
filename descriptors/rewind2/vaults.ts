const REWINDBITCOIN_INSCRIPTION_NUMBER = 123456;
const LOCK_BLOCKS = 2;
const P2A_SCRIPT = Buffer.from('51024e73', 'hex');
const VAULT_PURPOSE = 1073;
export const WPKH_DUST_THRESHOLD = 294;

const BACKOUT_OUTPUT_INDEX = 1;

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
import { coinselect, dustThreshold } from '@bitcoinerlab/coinselect';
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

/**
 * Estimated vbytes for the backup tx (1 P2WPKH input, 1 OP_RETURN output).
 *
 * - Trigger tx size: 217–219 bytes (107 stripped + 110–112 witness).
 * - Panic tx size: 269–271 bytes (95 stripped + 174–176 witness).
 * - Serialized entry size: 1 (version) + 1 (trigger len) + trigger + 1 (panic len) + panic.
 * - OP_RETURN payload: 3 ("REW") + entry = 492–496 bytes → OP_PUSHDATA2.
 * - Script size: 1 (OP_RETURN) + 1 (OP_PUSHDATA2) + 2 (len) + payload = 496–500 bytes.
 * - Stripped tx size: 4 + 1 + 41 + 1 + output(8 + 3 + script) + 4 = 558–562 bytes.
 * - Witness size: 109–111 bytes (segwit marker/flag + count + sig(71–73) + pubkey).
 * - vbytes = ceil((stripped*4 + witness) / 4) = 586–590 vB.
 */
export const OP_RETURN_BACKUP_TX_VBYTES = [586, 587, 588, 589, 590];

/**
 * Estimated vbytes for the vault tx (1 P2WPKH input, 2–3 P2WPKH outputs).
 *
 * - Without change (vault + backup outputs):
 *   - Stripped size: 4 + 1 + 41 + 1 + (31 * 2) + 4 = 113 bytes.
 *   - Witness size: 109–111 bytes (segwit marker/flag + count + sig(71–73) + pubkey).
 *   - vbytes = ceil((113*4 + 109–111) / 4) = 141 vB.
 * - With change (vault + backup + change outputs):
 *   - Stripped size: 4 + 1 + 41 + 1 + (31 * 3) + 4 = 144 bytes.
 *   - Witness size: 109–111 bytes.
 *   - vbytes = ceil((144*4 + 109–111) / 4) = 172 vB.
 */
export const VAULT_TX_VBYTES = {
  withoutChange: [141],
  withChange: [172]
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
  targetValue,
  backupOutput,
  backupCost,
  changeOutput,
  feeRate
}: {
  utxosData: UtxosData;
  targetOutput: OutputInstance;
  targetValue: number;
  backupOutput?: OutputInstance;
  backupCost?: number;
  changeOutput: OutputInstance;
  feeRate: number;
}) => {
  const utxos = getOutputsWithValue(utxosData);
  if (!utxos.length) return;
  if (targetValue <= dustThreshold(targetOutput)) return;
  if (backupOutput && backupCost !== undefined) {
    if (backupCost <= dustThreshold(backupOutput)) return;
  } else if (backupOutput || backupCost !== undefined) {
    throw new Error('backupOutput and backupCost must be provided together');
  }
  const targets = [{ output: targetOutput, value: targetValue }];
  if (backupOutput && backupCost !== undefined)
    targets.push({ output: backupOutput, value: backupCost });

  const coinselected = coinselect({
    utxos,
    targets,
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

  let backupCost;
  if (backupType === 'INSCRIPTION')
    backupCost = Math.ceil(
      Math.max(...INSCRIPTION_BACKUP_TX_VBYTES) * feeRate + WPKH_DUST_THRESHOLD
    );
  else if (backupType === 'OP_RETURN_TRUC' || backupType == 'OP_RETURN_V2')
    backupCost = Math.ceil(Math.max(...OP_RETURN_BACKUP_TX_VBYTES) * feeRate);

  if (backupCost === undefined) throw new Error('backupCost unset');
  // Run the coinselector
  const selected = coinselectUtxosData({
    utxosData,
    targetOutput: vaultOutput,
    targetValue: vaultedAmount,
    backupOutput,
    backupCost,
    changeOutput,
    feeRate
  });
  if (!selected) return 'COINSELECT_ERROR';
  const vaultUtxosData = selected.utxosData;
  const vaultTargets = selected.targets;
  const vaultMiningFee = selected.fee;
  if (vaultTargets[0]?.output !== vaultOutput)
    throw new Error("coinselect first output should be the vault's output");
  if (vaultTargets[1]?.output !== backupOutput)
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
  if (backupCost !== vaultTargets[backupOutputIndex]?.value)
    return 'UNKNOWN_ERROR';
  //Sign
  signers.signBIP32({ psbt: psbtVault, masterNode });
  //Finalize
  vaultFinalizers.forEach(finalizer => finalizer({ psbt: psbtVault }));
  const txVault = psbtVault.extractTransaction();
  const vaultVsize = txVault.virtualSize();
  if (vaultVsize > selected.vsize)
    throw new Error('vsize larger than coinselected estimated one');
  const expectedVaultVbytes =
    vaultTargets.length > 2
      ? VAULT_TX_VBYTES.withChange
      : VAULT_TX_VBYTES.withoutChange;
  if (!expectedVaultVbytes.includes(vaultVsize))
    throw new Error(`Unexpected vault vsize: ${vaultVsize}`);
  const feeRateVault = vaultMiningFee / txVault.virtualSize();
  if (feeRateVault < 1) return 'UNKNOWN_ERROR';

  //////////////////////
  // Trigger (135 vB):
  // 1 P2WPKH input, 2 outputs (P2A + P2WSH).
  // - Stripped size: 107 bytes
  //   - Version 4 + vin 1 + input 41 + vout 1 + outputs 56 + locktime 4
  //   - Outputs = P2A (13) + P2WSH (43)
  // - Witness size: 110–112 bytes
  //   - Marker/flag 2
  //   - Stack items: sig (73–75 incl. length) + pubkey (34 incl. length) + count (1)
  // - Weight: 538–540 wu → vsize = always 135 vB
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
  const triggerVsize = psbtTrigger.extractTransaction().virtualSize();
  if (triggerVsize !== 135)
    throw new Error(`Unexpected trigger vsize: ${triggerVsize}`);

  //////////////////////
  // Panic (139-140 vB):
  // 1 P2WSH input, 2 outputs (P2A + addr).
  // - Stripped size: 95 bytes
  //  - Version 4 + vin 1 + input 41 + vout 1 + outputs 44 + locktime 4
  //  - Outputs = P2A (13) + P2WPKH (31)
  //- Witness size: ~174–176 bytes
  //  - Marker/flag 2
  //  - Stack items: sig (73–75 incl. length) + selector (2) + witnessScript (≈96–98 incl. length) + count (1)
  //- Weight: ~554–558 wu → vsize = 139–140 vB
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
  if (panicVsize < 139 || panicVsize > 140)
    throw new Error(`Unexpected panic vsize: ${panicVsize}`);

  return {
    psbtVault,
    psbtTrigger,
    psbtPanic,
    backupCost,
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
  psbtVault.setVersion(backupType === 'OP_RETURN_TRUC' ? 3 : 2);

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

// Reveal tx vsize derivation (1 P2TR inscription input → 1 P2WPKH change output).
// 1) Trigger raw size = 217–219 bytes; panic raw size = 269–271 bytes.
// 2) Entry = 1 (ver) + 1 (len) + trigger + 1 (len) + panic = 489–493 bytes.
// 3) Content = "REW"(3) + entry = 492–496 bytes.
// 4) Tapscript length = 103 (overhead) + content = 595–599 bytes.
// 5) Witness vector size = 1 (count)
//    + (1+sig) + (3+tapscript) + (1+33 controlblock)
//    = 39 + sig + tapscript = 699–703 bytes (sig is 65 bytes).
// 6) Stripped size = 82 bytes → 328 wu.
// 7) Add marker/flag (2 bytes) to witness: total weight 1029–1033 wu.
// 8) vsize = ceil(weight/4) = 258–259 vB.
const INSCRIPTION_REVEAL_BACKUP_TX_VBYTES = [258, 259];

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
//    - sig: 71–73 + 1 len
//    - pubkey: 33 + 1 len
//    → witness = 108–111 bytes
// 3) Weight = stripped*4 + witness = 94*4 + 108–111 = 484–487 wu
// 4) vsize = ceil(weight / 4) = ceil(484–487 / 4) = 121–122 vB
const INSCRIPTION_COMMIT_BACKUP_TX_VBYTES = [121, 122];

export const INSCRIPTION_BACKUP_TX_VBYTES =
  INSCRIPTION_COMMIT_BACKUP_TX_VBYTES.flatMap(commitVbytes =>
    INSCRIPTION_REVEAL_BACKUP_TX_VBYTES.map(
      revealVbytes => commitVbytes + revealVbytes
    )
  ).filter((value, index, array) => array.indexOf(value) === index);

export const createInscriptionBackup = ({
  vaultIndex,
  feeRate,
  masterNode,
  psbtTrigger,
  psbtPanic,
  psbtVault,
  changeDescriptorWithIndex,
  network
}: {
  vaultIndex: number;
  feeRate: number;
  masterNode: BIP32Interface;
  psbtTrigger: Psbt;
  psbtPanic: Psbt;
  psbtVault: Psbt;
  changeDescriptorWithIndex: { descriptor: string; index: number };
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
  const backupInputValue = backupOut.value;

  const revealOutputValue = WPKH_DUST_THRESHOLD;
  const revealFee = Math.ceil(
    Math.max(...INSCRIPTION_REVEAL_BACKUP_TX_VBYTES) * feeRate
  );
  const targetValue = revealOutputValue + revealFee;

  const psbtCommit = new Psbt({ network });
  const commitInputFinalizer = backupOutput.updatePsbtAsInput({
    psbt: psbtCommit,
    txHex: vaultTx.toHex(),
    vout: BACKOUT_OUTPUT_INDEX
  });
  backupInscription.updatePsbtAsOutput({
    psbt: psbtCommit,
    value: targetValue
  });
  signers.signBIP32({ psbt: psbtCommit, masterNode });
  commitInputFinalizer({ psbt: psbtCommit });

  const commitTx = psbtCommit.extractTransaction();
  const commitFee = backupInputValue - targetValue;
  const commitVsize = commitTx.virtualSize();
  const minimumCommitFee = Math.ceil(commitVsize * feeRate);
  if (commitFee < minimumCommitFee)
    throw new Error('Insufficient vault backup output for commit fee');

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
  //TODO: here this will create a new utxo. also we can remove the original utxos
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
