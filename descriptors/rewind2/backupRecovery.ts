import { sha256 } from '@noble/hashes/sha2';
import {
  Transaction,
  payments,
  script as bscript,
  opcodes,
  type Network
} from 'bitcoinjs-lib';
import { decode as decodeVarInt } from 'varuint-bitcoin';
import { compare, concat, fromUtf8, toHex } from 'uint8array-tools';
import type { Explorer } from '@bitcoinerlab/explorer';
import { getManagedChacha, getSeedDerivedCipherKey } from './cipher';
import { getVaultOriginPath } from './vaults';
import type { BIP32Interface } from 'bip32';
import { Log, wait } from './utils';
import { DescriptorsFactory } from '@bitcoinerlab/descriptors';
import * as secp256k1 from '@bitcoinerlab/secp256k1';
const { Output } = DescriptorsFactory(secp256k1);

const REW_MAGIC = fromUtf8('REW');
const ORD_MARKER = fromUtf8('ord');
const spendingTxCache = new Map<
  string,
  { txHex: string; irreversible: boolean; blockHeight: number }
>();

const transactionFromHex = (txHex: string) => {
  const tx = Transaction.fromHex(txHex);
  return { tx, txId: tx.getId() };
};

const reverseBytes = (bytes: Uint8Array): Uint8Array => {
  const copy = Uint8Array.from(bytes);
  copy.reverse();
  return copy;
};

const getScriptHash = (script: Uint8Array) =>
  toHex(reverseBytes(sha256(script)));

const fetchSpendingTx = async (
  txHex: string,
  vout: number,
  explorer: Explorer
): Promise<
  { txHex: string; irreversible: boolean; blockHeight: number } | undefined
> => {
  const cacheKey = `${txHex}:${vout}`;
  const cachedResult = spendingTxCache.get(cacheKey);
  if (cachedResult && cachedResult.irreversible) return cachedResult;

  const { tx, txId } = transactionFromHex(txHex);
  const output = tx.outs[vout];
  if (!output) throw new Error('Invalid output when locating spending tx');
  const scriptHash = toHex(reverseBytes(sha256(output.script)));

  const history = await explorer.fetchTxHistory({ scriptHash });
  for (const txData of history) {
    const historyTxHex = await explorer.fetchTx(txData.txId);
    const { tx: historyTx } = transactionFromHex(historyTxHex);
    const found = historyTx.ins.some(input => {
      const inputPrevtxId = toHex(reverseBytes(input.hash));
      return inputPrevtxId === txId && input.index === vout;
    });
    if (found) {
      const spendingTx = {
        txHex: historyTxHex,
        irreversible: txData.irreversible,
        blockHeight: txData.blockHeight
      };
      spendingTxCache.set(cacheKey, spendingTx);
      return spendingTx;
    }
  }

  return;
};

const extractOpReturnPayload = (tx: Transaction) => {
  for (const output of tx.outs) {
    try {
      const embed = payments.embed({ output: output.script });
      const payload = embed.data?.[0];
      if (payload && compare(payload.subarray(0, 3), REW_MAGIC) === 0)
        return payload;
    } catch {
      continue;
    }
  }
  return;
};

const extractOrdinalPayload = (chunks: Array<number | Uint8Array>) => {
  for (let i = 0; i < chunks.length - 1; i += 1) {
    const item = chunks[i];
    if (item instanceof Uint8Array && compare(item, ORD_MARKER) === 0) {
      for (let j = i + 1; j < chunks.length - 1; j += 1) {
        if (chunks[j] === opcodes['OP_0']) {
          const payloadChunks: Uint8Array[] = [];
          for (let k = j + 1; k < chunks.length; k += 1) {
            const chunk = chunks[k];
            if (!chunk) break;
            if (typeof chunk === 'number') break;
            payloadChunks.push(chunk);
          }
          if (payloadChunks.length) return concat(payloadChunks);
        }
      }
    }
  }
  return;
};

const extractInscriptionPayload = (tx: Transaction) => {
  for (const input of tx.ins) {
    const witness = input.witness;
    if (!witness || witness.length < 2) continue;
    const tapscript = witness[witness.length - 2];
    if (!tapscript) continue;
    const decompiled = bscript.decompile(tapscript);
    if (!decompiled) continue;
    const payload = extractOrdinalPayload(decompiled);
    if (payload && compare(payload.subarray(0, 3), REW_MAGIC) === 0)
      return payload;
  }
  return;
};

const decodeVaultEntry = (payload: Uint8Array) => {
  let offset = 0;
  const version = payload[offset];
  if (version === undefined) throw new Error('Missing backup entry version');
  offset += 1;

  const triggerLenInfo = decodeVarInt(payload, offset);
  const triggerLen = triggerLenInfo.numberValue;
  if (triggerLen === null) throw new Error('Invalid trigger tx varint length');
  offset += triggerLenInfo.bytes;
  const triggerTx = payload.subarray(offset, offset + triggerLen);
  offset += triggerLen;

  const panicLenInfo = decodeVarInt(payload, offset);
  const panicLen = panicLenInfo.numberValue;
  if (panicLen === null) throw new Error('Invalid panic tx varint length');
  offset += panicLenInfo.bytes;
  const panicTx = payload.subarray(offset, offset + panicLen);

  return { version, triggerTx, panicTx };
};

const decryptVaultEntry = async ({
  payload,
  vaultIndex,
  masterNode,
  network
}: {
  payload: Uint8Array;
  vaultIndex: number;
  masterNode: BIP32Interface;
  network: Network;
}) => {
  if (compare(payload.subarray(0, 3), REW_MAGIC) !== 0)
    throw new Error('Backup payload missing REW header');
  const vaultPath = `m${getVaultOriginPath(network)}/${vaultIndex}`;
  const cipherKey = await getSeedDerivedCipherKey({ vaultPath, masterNode });
  const cipher = await getManagedChacha(cipherKey);
  const decrypted = cipher.decrypt(payload.subarray(3));
  return decodeVaultEntry(decrypted);
};

export const fetchVaultParentsFromBackup = async ({
  vaultIndex,
  backupDescriptor,
  masterNode,
  network,
  explorer
}: {
  vaultIndex: number;
  backupDescriptor: string;
  masterNode: BIP32Interface;
  network: Network;
  explorer: Explorer;
}) => {
  const historyRetries = 10;
  const historyDelayMs = 1000;
  Log(`🔍 Retrieving backup payload from chain for vault #${vaultIndex}...`);
  const backupOutput = new Output({
    descriptor: backupDescriptor,
    index: vaultIndex,
    network
  });
  const backupScript = backupOutput.getScriptPubKey();
  const scriptHash = getScriptHash(backupScript);
  let history: Array<{
    txId: string;
    blockHeight: number;
    irreversible: boolean;
  }> = [];
  for (let attempt = 1; attempt <= historyRetries; attempt += 1) {
    history = await explorer.fetchTxHistory({ scriptHash });
    if (history.length) break;
    if (attempt < historyRetries) {
      Log(
        `⏳ Waiting for backup output history... (${attempt}/${historyRetries})`
      );
      await wait(historyDelayMs);
    }
  }
  if (!history.length) throw new Error('No backup history found yet');

  let vaultTxHex;
  let vaultVout = -1;
  for (const txData of history) {
    const txHex = await explorer.fetchTx(txData.txId);
    const { tx } = transactionFromHex(txHex);
    const vout = tx.outs.findIndex(
      out => compare(out.script, backupScript) === 0
    );
    if (vout >= 0) {
      vaultTxHex = txHex;
      vaultVout = vout;
      break;
    }
  }
  if (!vaultTxHex || vaultVout < 0)
    throw new Error('Backup funding tx not found for this vault');

  let spendingTx:
    | { txHex: string; irreversible: boolean; blockHeight: number }
    | undefined;
  for (let attempt = 1; attempt <= historyRetries; attempt += 1) {
    spendingTx = await fetchSpendingTx(vaultTxHex, vaultVout, explorer);
    if (spendingTx) break;
    if (attempt < historyRetries) {
      Log(
        `⏳ Waiting for backup output spend... (${attempt}/${historyRetries})`
      );
      await wait(historyDelayMs);
    }
  }
  if (!spendingTx)
    throw new Error('Backup output not spent yet; no backup tx found');

  Log(`🔍 Backup output spend located. Fetching payload...`);
  const spendingTxHex = spendingTx.txHex;
  const spendingTxObj = Transaction.fromHex(spendingTxHex);

  let payloadSource: 'op_return' | 'inscription' = 'op_return';
  let payload = extractOpReturnPayload(spendingTxObj);
  if (!payload) {
    Log(`🔍 Following inscription commit to reveal tx...`);
    let revealTx:
      | { txHex: string; irreversible: boolean; blockHeight: number }
      | undefined;
    for (let attempt = 1; attempt <= historyRetries; attempt += 1) {
      revealTx = await fetchSpendingTx(spendingTxHex, 0, explorer);
      if (revealTx) break;
      if (attempt < historyRetries) {
        Log(
          `⏳ Waiting for inscription reveal tx... (${attempt}/${historyRetries})`
        );
        await wait(historyDelayMs);
      }
    }
    if (!revealTx) throw new Error('Could not locate inscription reveal tx');
    payload = extractInscriptionPayload(Transaction.fromHex(revealTx.txHex));
    payloadSource = 'inscription';
  }

  if (!payload) throw new Error('Backup payload not found in chain data');

  Log(
    `🔐 Encrypted backup payload located (${payloadSource}); decrypting and recovering data...`
  );

  const { triggerTx, panicTx } = await decryptVaultEntry({
    payload,
    vaultIndex,
    masterNode,
    network
  });

  Log(`✅ Reconstructed trigger and panic transactions from backup.`);

  return {
    triggerTx: Transaction.fromBuffer(triggerTx),
    panicTx: Transaction.fromBuffer(panicTx)
  };
};
