// Copyright (c) 2025 Jose-Luis Landabaso - https://bitcoinerlab.com
// Distributed under the MIT software license

import './codesandboxFixes';
import { readFileSync, writeFileSync } from 'fs';
import * as descriptors from '@bitcoinerlab/descriptors';
import { generateMnemonic, mnemonicToSeedSync } from 'bip39';
import {
  networks,
  Psbt,
  Transaction,
  type Network,
  payments
} from 'bitcoinjs-lib';
import * as secp256k1 from '@bitcoinerlab/secp256k1';
import { EsploraExplorer } from '@bitcoinerlab/explorer';
import { InscriptionsFactory } from './inscriptions';
import { encode as encodeVarInt, encodingLength } from 'varuint-bitcoin';
import type { BIP32Interface } from 'bip32';

const REWINDBITCOIN_INSCRIPTION_NUMBER = 123456;
const LOCK_BLOCKS = 2;

const isWeb = typeof window !== 'undefined';
const Log = (message: string) => {
  const logsElement = isWeb && document.getElementById('logs');
  if (logsElement) {
    logsElement.innerHTML += `<p>${message}</p>`;
    logsElement?.lastElementChild?.scrollIntoView();
  }
  console.log(message.replace(/<[^>]*>?/gm, '')); //strip html tags
};
//JSON to pretty-string format:
const JSONf = (json: object) => JSON.stringify(json, null, '\t');

const P2A_SCRIPT = Buffer.from('51024e73', 'hex');
const EXPLORER = `https://tape.rewindbitcoin.com/explorer`;
const ESPLORA_API = `https://tape.rewindbitcoin.com/api`;
const FAUCET_API = `https://tape.rewindbitcoin.com/faucet`;
const explorer = new EsploraExplorer({ url: ESPLORA_API });
const { wpkhBIP32 } = descriptors.scriptExpressions;
const { Output, BIP32, parseKeyExpression } =
  descriptors.DescriptorsFactory(secp256k1);
const { Inscription } = InscriptionsFactory(secp256k1);
const network = networks.regtest;
const FEE = 500;
const BACKUP_FUNDING = 1500;

// @ts-ignore
import { encode as olderEncode } from 'bip68';
import { compilePolicy } from '@bitcoinerlab/miniscript';

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

export const createTriggerDescriptor = ({
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

const start = async () => {
  let mnemonic; //Let's create a basic wallet:
  let emergencyMnemonic; //Let's create a cold wallet (emergency):
  if (isWeb) {
    mnemonic = localStorage.getItem('rew2mnemonic');
    emergencyMnemonic = localStorage.getItem('rew2coldmnemonic');
    if (!mnemonic || !emergencyMnemonic) {
      mnemonic = generateMnemonic();
      localStorage.setItem('rew2mnemonic', mnemonic);
      emergencyMnemonic = generateMnemonic();
      localStorage.setItem('rew2coldmnemonic', emergencyMnemonic);
    }
  } else {
    try {
      mnemonic = readFileSync('.rew2mnemonic', 'utf8');
      emergencyMnemonic = readFileSync('.rew2coldmnemonic', 'utf8');
    } catch {
      mnemonic = generateMnemonic();
      writeFileSync('.rew2mnemonic', mnemonic);
      emergencyMnemonic = generateMnemonic();
      writeFileSync('.rew2coldmnemonic', emergencyMnemonic);
    }
  }
  Log(`🔐 This is your demo wallet (mnemonic):
${mnemonic}
And this is your emergency mnemonic:
${emergencyMnemonic}

⚠️ Save it only if you want. This is the TAPE testnet. 
Every reload reuses the same mnemonic for convenience.`);
  const masterNode = BIP32.fromSeed(mnemonicToSeedSync(mnemonic), network);
  const emergencyMasterNode = BIP32.fromSeed(
    mnemonicToSeedSync(emergencyMnemonic),
    network
  );
  const walletUTXO = new Output({
    descriptor: wpkhBIP32({ masterNode, network, account: 0, keyPath: '/0/0' }),
    network
  });
  const walletAddress = walletUTXO.getAddress();
  Log(
    `📫 Wallet address: <a href="${EXPLORER}/${walletAddress}" target="_blank">${walletAddress}</a>`
  );

  // Check if the wallet already has confirmed funds
  Log(`🔍 Checking existing balance...`);
  const walletAddressInfo = await explorer.fetchAddress(walletAddress);
  Log(`🔍 Wallet balance info: ${JSONf(walletAddressInfo)}`);
  let walletPrevTxId;

  if (walletAddressInfo.balance + walletAddressInfo.unconfirmedBalance < FEE) {
    Log(`💰 The wallet is empty. Let's request some funds...`);
    //New or empty wallet. Let's prepare the faucet request:
    const formData = new URLSearchParams();
    formData.append('address', walletAddress);
    const faucetRes = await fetch(FAUCET_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString()
    });

    if (faucetRes.status !== 200) throw new Error('The faucet failed');
    const faucetJson = await faucetRes.json();
    Log(`🪣 Faucet response: ${JSONf(faucetJson)}`);

    if (faucetJson.ok !== true) throw new Error('The faucet failed');
    if (faucetJson.info === 'CACHED')
      throw new Error(
        `Faucet rate-limit: this address has already received sats recently.
Please retry (max 2 faucet requests per IP/address per minute).`
      );
    walletPrevTxId = faucetJson.txId;
  } else {
    Log(`💰 Existing balance detected. Skipping faucet.`);
    // Wallet has funds. Find the last transaction that actually pays to this script.
    const txHistory = await explorer.fetchTxHistory({ address: walletAddress });
    const spkHex = walletUTXO.getScriptPubKey().toString('hex');

    for (const { txId } of txHistory.reverse()) {
      const tx = Transaction.fromHex(await explorer.fetchTx(txId));
      const vout = tx.outs.findIndex(o => o.script.toString('hex') === spkHex);
      if (vout !== -1) {
        walletPrevTxId = txId;
        break;
      }
    }
  }

  let walletPrevTxHex = '';
  while (true) {
    // Ping the esplora for the txHex (may need to wait until the tx is indexed)
    try {
      walletPrevTxHex = await explorer.fetchTx(walletPrevTxId);
      break;
    } catch (err) {
      void err;
      Log(
        `⏳ Waiting for the walletPrev tx <a href="${EXPLORER}/${walletPrevTxId}" target="_blank">${walletPrevTxId}</a> to be indexed...`
      );
    }
    await new Promise(r => setTimeout(r, 1000)); //sleep 1s
  }

  const walletPrevTransaction = Transaction.fromHex(walletPrevTxHex);
  const walletPrevVout = walletPrevTransaction.outs.findIndex(
    txOut =>
      txOut.script.toString('hex') ===
      walletUTXO.getScriptPubKey().toString('hex')
  );
  if (!walletPrevTransaction.outs[walletPrevVout])
    throw new Error('Invalid vout');

  const walletBalance = walletPrevTransaction.outs[walletPrevVout].value;
  Log(`💎 Wallet balance (sats): ${walletBalance}`);

  const randomMnemonic = generateMnemonic();

  const randomMasterNode = BIP32.fromSeed(
    mnemonicToSeedSync(randomMnemonic),
    network
  );
  const randomOriginPath = `/84'/${network === networks.bitcoin ? 0 : 1}'/0'`;
  const randomKeyPath = `/0/0`;
  const randomKey = descriptors.keyExpressionBIP32({
    masterNode: randomMasterNode,
    originPath: randomOriginPath,
    keyPath: randomKeyPath
  });
  const randomPubKey = randomMasterNode.derivePath(
    `m${randomOriginPath}${randomKeyPath}`
  ).publicKey;

  const createVaultChain = () => {
    const vaultOutput = new Output({
      descriptor: `wpkh(${randomKey})`,
      network
    });
    console.log(`Vault address: ${vaultOutput.getAddress()}`);
    const psbtVault = new Psbt({ network });
    const vaultFinalizer = walletUTXO.updatePsbtAsInput({
      psbt: psbtVault,
      txHex: walletPrevTxHex,
      vout: walletPrevVout
    });
    const backupFunding = BACKUP_FUNDING;
    const vaultedAmount = walletBalance - FEE - backupFunding;
    vaultOutput.updatePsbtAsOutput({
      psbt: psbtVault,
      value: vaultedAmount
    });
    walletUTXO.updatePsbtAsOutput({ psbt: psbtVault, value: backupFunding });
    descriptors.signers.signBIP32({ psbt: psbtVault, masterNode });
    vaultFinalizer({ psbt: psbtVault });

    //////////////////////
    // Trigger:
    //////////////////////
    const unvaultKey = descriptors.keyExpressionBIP32({
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
    descriptors.signers.signBIP32({
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
      descriptor: wpkhBIP32({
        masterNode: emergencyMasterNode,
        network,
        account: 1,
        keyPath: '/0/0'
      }),
      network
    });
    coldOutput.updatePsbtAsOutput({ psbt: psbtPanic, value: vaultedAmount });
    descriptors.signers.signBIP32({
      psbt: psbtPanic,
      masterNode: randomMasterNode
    });
    panicInputFinalizer({ psbt: psbtPanic });

    return { psbtVault, psbtTrigger, psbtPanic };
  };

  const getNextBackupIndex = async (
    masterNode: BIP32Interface,
    network: Network
  ): Promise<number> => {
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

  const createBackupChain = ({
    index,
    psbtTrigger,
    psbtPanic,
    psbtVault,
    fundingTxHex,
    fundingVout,
    tag
  }: {
    index: number;
    psbtTrigger: Psbt;
    psbtPanic: Psbt;
    psbtVault: Psbt;
    fundingTxHex: string;
    fundingVout: number;
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

    const backupPath = getBackupPath(network, index);
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
    descriptors.signers.signBIP32({ psbt: psbtCommit, masterNode });
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
    descriptors.signers.signBIP32({ psbt: psbtReveal, masterNode });
    revealInputFinalizer({ psbt: psbtReveal });

    return { psbtCommit, psbtReveal };
  };

  const vaultChain = createVaultChain();

  const backupIndex = await getNextBackupIndex(masterNode, network);
  console.log(`Backup index tip: ${backupIndex}`);
  const backupChain = createBackupChain({
    index: backupIndex,
    psbtTrigger: vaultChain.psbtTrigger,
    psbtPanic: vaultChain.psbtPanic,
    psbtVault: vaultChain.psbtVault,
    fundingTxHex: vaultChain.psbtVault.extractTransaction().toHex(),
    fundingVout: 1,
    tag: 'My First Vault'
  });

  console.log(`
vault id: ${vaultChain.psbtVault.extractTransaction().getId()}
trigger id: ${vaultChain.psbtTrigger.extractTransaction().getId()}
commit id: ${backupChain.psbtCommit.extractTransaction().getId()}
reveal id: ${backupChain.psbtReveal.extractTransaction().getId()}
`);
};
if (isWeb) (window as unknown as { start: typeof start }).start = start;

if (isWeb) {
  document.body.style.marginBottom = '60px'; //prevent CodeSandbox UI from overlapping the logs
  document.body.innerHTML = `
<div id="logs" style="white-space: pre-wrap;font-family: monospace;">
  <a href="javascript:start();" id="start">Click to start!</a>
</div>
`;
} else start();
