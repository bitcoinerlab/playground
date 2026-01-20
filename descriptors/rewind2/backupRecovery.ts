import { sha256 } from '@noble/hashes/sha2';
import {
  Transaction,
  payments,
  script as bscript,
  opcodes,
  type Network
} from 'bitcoinjs-lib';
import { decode as decodeVarInt } from 'varuint-bitcoin';
import type { Explorer } from '@bitcoinerlab/explorer';
import { getManagedChacha, getSeedDerivedCipherKey } from './cipher';
import { getVaultOriginPath } from './vaults';
import type { BIP32Interface } from 'bip32';
import { Log, wait } from './utils';
import { DescriptorsFactory } from '@bitcoinerlab/descriptors';
import * as secp256k1 from '@bitcoinerlab/secp256k1';
const { Output } = DescriptorsFactory(secp256k1);

const REW_MAGIC = Buffer.from('REW');
const ORD_MARKER = Buffer.from('ord');
const spendingTxCache = new Map<
  string,
  { txHex: string; irreversible: boolean; blockHeight: number }
>();

const transactionFromHex = (txHex: string) => {
  const tx = Transaction.fromHex(txHex);
  return { tx, txId: tx.getId() };
};

const getScriptHash = (script: Buffer) =>
  Buffer.from(sha256(script)).reverse().toString('hex');

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
  const scriptHash = Buffer.from(sha256(output.script))
    .reverse()
    .toString('hex');

  const history = await explorer.fetchTxHistory({ scriptHash });
  for (const txData of history) {
    const historyTxHex = await explorer.fetchTx(txData.txId);
    const { tx: historyTx } = transactionFromHex(historyTxHex);
    const found = historyTx.ins.some(input => {
      const inputPrevtxId = Buffer.from(input.hash).reverse().toString('hex');
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
      if (payload && payload.subarray(0, 3).equals(REW_MAGIC)) return payload;
    } catch {
      continue;
    }
  }
  return;
};

const extractOrdinalPayload = (chunks: Array<number | Buffer>) => {
  for (let i = 0; i < chunks.length - 1; i += 1) {
    const item = chunks[i];
    if (Buffer.isBuffer(item) && item.equals(ORD_MARKER)) {
      for (let j = i + 1; j < chunks.length - 1; j += 1) {
        if (chunks[j] === opcodes['OP_0'] && Buffer.isBuffer(chunks[j + 1])) {
          return chunks[j + 1] as Buffer;
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
    if (payload && payload.subarray(0, 3).equals(REW_MAGIC)) return payload;
  }
  return;
};

const decodeVaultEntry = (payload: Buffer) => {
  let offset = 0;
  const version = payload.readUInt8(offset);
  offset += 1;

  const triggerLen = decodeVarInt(payload, offset);
  offset += decodeVarInt.bytes;
  const triggerTx = payload.slice(offset, offset + triggerLen);
  offset += triggerLen;

  const panicLen = decodeVarInt(payload, offset);
  offset += decodeVarInt.bytes;
  const panicTx = payload.slice(offset, offset + panicLen);

  return { version, triggerTx, panicTx };
};

const decryptVaultEntry = async ({
  payload,
  vaultIndex,
  masterNode,
  network
}: {
  payload: Buffer;
  vaultIndex: number;
  masterNode: BIP32Interface;
  network: Network;
}) => {
  if (!payload.subarray(0, 3).equals(REW_MAGIC))
    throw new Error('Backup payload missing REW header');
  const vaultPath = `m${getVaultOriginPath(network)}/${vaultIndex}`;
  const cipherKey = await getSeedDerivedCipherKey({ vaultPath, masterNode });
  const cipher = await getManagedChacha(cipherKey);
  const decrypted = Buffer.from(cipher.decrypt(payload.subarray(3)));
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
    const vout = tx.outs.findIndex(out => out.script.equals(backupScript));
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

  Log(`🧾 Backup output spend located. Fetching payload...`);
  const spendingTxHex = spendingTx.txHex;
  const spendingTxObj = Transaction.fromHex(spendingTxHex);

  let payloadSource: 'op_return' | 'inscription' = 'op_return';
  let payload = extractOpReturnPayload(spendingTxObj);
  if (!payload) {
    Log(`🧭 Following inscription commit to reveal tx...`);
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
    `🧬 Backup payload located (${payloadSource}); decrypting and rebuilding parents...`
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
