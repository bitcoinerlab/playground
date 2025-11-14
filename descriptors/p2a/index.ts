// Copyright (c) 2025 Jose-Luis Landabaso - https://bitcoinerlab.com
// Distributed under the MIT software license

import './codesandboxFixes.js';

import { readFileSync, writeFileSync } from 'fs';
import * as descriptors from '@bitcoinerlab/descriptors';
import { generateMnemonic, mnemonicToSeedSync } from 'bip39';
import { networks, Psbt, Transaction } from 'bitcoinjs-lib';
import * as secp256k1 from '@bitcoinerlab/secp256k1';
import { EsploraExplorer } from '@bitcoinerlab/explorer';

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

const ESPLORA_API = `https://tape.rewindbitcoin.com/api`;
const FAUCET_API = `https://tape.rewindbitcoin.com/faucet`;
const explorer = new EsploraExplorer({ url: ESPLORA_API });
const { wpkhBIP32 } = descriptors.scriptExpressions;
const { Output, BIP32 } = descriptors.DescriptorsFactory(secp256k1);
const network = networks.regtest;
const FEE = 500;
const ANCHOR_VALUE = 0;
const P2A_SCRIPT = Buffer.from('51024e73', 'hex');

let mnemonic;
if (isWeb) {
  mnemonic = localStorage.getItem('p2amnemonic');
  if (!mnemonic) {
    mnemonic = generateMnemonic();
    localStorage.setItem('p2amnemonic', mnemonic);
  }
} else {
  try {
    mnemonic = readFileSync('.p2amnemonic', 'utf8');
  } catch {
    mnemonic = generateMnemonic();
    writeFileSync('.p2amnemonic', mnemonic);
  }
}
const masterNode = BIP32.fromSeed(mnemonicToSeedSync(mnemonic), network);

const start = async () => {
  const sourceOutput = new Output({
    descriptor: wpkhBIP32({
      masterNode,
      network,
      account: 0,
      keyPath: '/0/0'
    }),
    network
  });
  const sourceAddress = sourceOutput.getAddress();

  const formData = new URLSearchParams();
  formData.append('address', sourceAddress);
  // Ask the faucet to mine this transaction. The TAPE testnet allows this,
  // but with limits to prevent abuse. Mining is not guaranteed.
  formData.append('forceConfirm', 'true');
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
Please wait a few seconds before requesting again (max 2 faucet requests per IP/address per minute).`
    );
  const faucetTxId = faucetJson.txId;
  let faucetTxHex = '';
  for (; ;) {
    // Ping the esplora server until the tx is indexed
    try {
      faucetTxHex = await explorer.fetchTx(faucetTxId);
      break;
    } catch (err) {
      Log(`⏳ Waiting for the faucet transaction to be indexed...`);
      void err;
    }
    await new Promise(r => setTimeout(r, 1000)); //sleep 1s
  }

  let attempt = 0;
  for (; ;) {
    // Wait until the funding tx is in a block
    try {
      const sourceAddressInfo = await explorer.fetchAddress(sourceAddress);

      // Confirmed?
      if (sourceAddressInfo.unconfirmedTxCount === 0) {
        Log(
          `🔍 Funding transaction is now confirmed: ${JSONf(sourceAddressInfo)}`
        );
        break;
      }

      // Not confirmed yet
      if (attempt === 0) {
        Log(`⏳ Waiting for the faucet transaction to be confirmed...

   TRUC + P2A rules require the funding transaction to be in a block.
   This may take a few minutes.

`);
      } else {
        const dots = '.'.repeat((attempt % 5) + 1);
        Log(`⏳ Still waiting for confirmation${dots}`);
      }
    } catch (err) {
      if (attempt === 0) {
        Log(
          `🔍 Funding transaction not visible yet. Waiting for explorer to index it...: ${err}`
        );
      } else {
        const dots = '.'.repeat((attempt % 5) + 1);
        Log(`🔍 Explorer hasn't indexed the tx yet${dots}`);
      }
    }

    await new Promise(r => setTimeout(r, attempt === 0 ? 5000 : 10000)); //sleep 5/10s
    attempt++;
  }

  const faucetTransaction = Transaction.fromHex(faucetTxHex);
  const faucetVout = faucetTransaction.outs.findIndex(
    txOut =>
      txOut.script.toString('hex') ===
      sourceOutput.getScriptPubKey().toString('hex')
  );
  if (faucetVout < 0) throw new Error('Matching sourceOutput not found');

  const sourceValue = faucetTransaction.outs[faucetVout]!.value;
  Log(`💎 Initial value (sats): ${sourceValue}`);
  // Create destination address (account 1)
  const destOutput = new Output({
    descriptor: wpkhBIP32({
      masterNode,
      network,
      account: 1,
      keyPath: '/0/0'
    }),
    network
  });
  const destAddress = destOutput.getAddress();
  const destValue = sourceValue - ANCHOR_VALUE; // no fee!!

  const parentPsbt = new Psbt({ network });
  parentPsbt.setVersion(3);
  const parentInputFinalizer = sourceOutput.updatePsbtAsInput({
    psbt: parentPsbt,
    vout: faucetVout,
    txHex: faucetTxHex
  });
  parentPsbt.addOutput({ script: P2A_SCRIPT, value: ANCHOR_VALUE }); //vout: 0
  destOutput.updatePsbtAsOutput({ psbt: parentPsbt, value: destValue }); //vout: 1

  descriptors.signers.signBIP32({ psbt: parentPsbt, masterNode });
  parentInputFinalizer({ psbt: parentPsbt });

  const childPsbt = new Psbt({ network });
  childPsbt.setVersion(3);

  const parentTransaction = parentPsbt.extractTransaction();

  childPsbt.addInput({
    hash: parentTransaction.getId(),
    index: 0,
    witnessUtxo: { script: P2A_SCRIPT, value: ANCHOR_VALUE }
  });
  childPsbt.finalizeInput(0, () => ({
    finalScriptSig: Buffer.alloc(0),
    finalScriptWitness: Buffer.from([0x00]) // empty item
  }));

  // This spends both outputs from the parent
  const childInputFinalizer = destOutput.updatePsbtAsInput({
    psbt: childPsbt,
    vout: 1,
    txHex: parentTransaction.toHex()
  });
  sourceOutput.updatePsbtAsOutput({
    psbt: childPsbt,
    value: destValue - FEE
  });
  descriptors.signers.signBIP32({ psbt: childPsbt, masterNode });
  childInputFinalizer({ psbt: childPsbt });

  const childTransaction = childPsbt.extractTransaction();
  Log(
    `Parent txId: ${parentTransaction.getId()}, child txId: ${childTransaction.getId()}`
  );

  const pkgUrl = `${ESPLORA_API}/txs/package`;
  const pkgRes = await fetch(pkgUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([parentTransaction.toHex(), childTransaction.toHex()])
  });

  if (pkgRes.status === 404) {
    throw new Error(
      `Package endpoint not available at ${pkgUrl}. Your Esplora instance likely doesn't support /txs/package`
    );
  }
  if (!pkgRes.ok) {
    const errText = await pkgRes.text();
    throw new Error(`Package submit failed (${pkgRes.status}): ${errText}`);
  }

  const pkgRespJson = await pkgRes.json();
  Log(`📦 Package response: ${JSONf(pkgRespJson)}`);

  const destInfo = await explorer.fetchAddress(destAddress);

  Log(`🔍 Destination info: ${JSONf(destInfo)}`);
};
if (isWeb) (window as unknown as { start: typeof start }).start = start;

if (isWeb) {
  document.body.innerHTML = `<div id="logs">
<a href="javascript:start();" id="start">Click to start!</a></div>`;
} else start();
