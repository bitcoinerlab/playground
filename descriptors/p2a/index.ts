// Copyright (c) 2025 Jose-Luis Landabaso - https://bitcoinerlab.com
// Distributed under the MIT software license
import './codesandboxFixes';
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
const P2A_SCRIPT = Buffer.from('51024e73', 'hex');

const start = async () => {
  let mnemonic; //Let's create a basic wallet:
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
  Log(`🔐 This is your demo wallet (mnemonic):
${mnemonic}

⚠️ Save it only if you want. This is the TAPE testnet. 
Every reload reuses the same mnemonic for convenience.`);
  const masterNode = BIP32.fromSeed(mnemonicToSeedSync(mnemonic), network);
  const sourceOutput = new Output({
    descriptor: wpkhBIP32({ masterNode, network, account: 0, keyPath: '/0/0' }),
    network
  });
  const sourceAddress = sourceOutput.getAddress();
  Log(`📫 Source address: ${sourceAddress}`);

  // Check if the wallet already has confirmed funds
  Log(`🔍 Checking existing balance...`);
  const sourceAddressInfo = await explorer.fetchAddress(sourceAddress);
  Log(`🔍 Wallet balance info: ${JSONf(sourceAddressInfo)}`);
  let fundingtTxId;

  if (sourceAddressInfo.balance + sourceAddressInfo.unconfirmedBalance === 0) {
    Log(`💰 The wallet is empty. Let's request some funds...`);
    //New or empty wallet. Let's prepare the faucet request:
    const formData = new URLSearchParams();
    formData.append('address', sourceAddress);
    //Ask the faucet to forceConfirm this transaction. The TAPE testnet allows
    //mining after the request but with limits it to prevent abuse. Not guaranteed.
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
Please retry (max 2 faucet requests per IP/address per minute).`
      );
    fundingtTxId = faucetJson.txId;
  } else {
    Log(`💰 Existing balance detected. Skipping faucet.`);
    //Wallet with funds. We'll assume last tx is the one that received some sats,
    const txHistory = await explorer.fetchTxHistory({ address: sourceAddress });
    fundingtTxId = txHistory[txHistory.length - 1]?.txId;
  }

  let fundingTxHex = '';
  for (;;) {
    // Ping the esplora for the txHex (may need to wait until the tx is indexed)
    try {
      fundingTxHex = await explorer.fetchTx(fundingtTxId);
      break;
    } catch (err) {
      void err;
      Log(`⏳ Waiting for the funding transaction to be indexed...`);
    }
    await new Promise(r => setTimeout(r, 1000)); //sleep 1s
  }

  let firstAttempt = true;
  for (;;) {
    // Wait until the funding tx is in a block
    try {
      if (firstAttempt === true)
        Log(`⏳ Waiting for the funding transaction to be confirmed...

   TRUC + P2A rules require the funding transaction to be in a block.
   This may take a few minutes.

`);
      const sourceAddressInfo = await explorer.fetchAddress(sourceAddress);
      // Confirmed?
      if (sourceAddressInfo.unconfirmedTxCount === 0) {
        Log(`🔍 Funding transaction is confirmed: ${JSONf(sourceAddressInfo)}`);
        break;
      }
      // Not confirmed yet
      Log(`⏳ Still waiting for confirmation...`);
    } catch (err) {
      Log(`⏳ Something went wrong while waiting for confirmation: ${err}`);
    }
    await new Promise(r => setTimeout(r, firstAttempt ? 5000 : 10000)); //sleep 5/10s
    firstAttempt = false;
  }

  const fundingTransaction = Transaction.fromHex(fundingTxHex);
  const fundingVout = fundingTransaction.outs.findIndex(
    txOut =>
      txOut.script.toString('hex') ===
      sourceOutput.getScriptPubKey().toString('hex')
  );
  if (!fundingTransaction.outs[fundingVout]) throw new Error('Invalid vout');

  const sourceValue = fundingTransaction.outs[fundingVout].value;
  Log(`💎 Initial value (sats): ${sourceValue}`);
  // Create destination address (account 1)
  const destOutput = new Output({
    descriptor: wpkhBIP32({ masterNode, network, account: 1, keyPath: '/0/0' }),
    network
  });
  const destAddress = destOutput.getAddress();
  const destValue = sourceValue; // Look ma! no fee!!

  const parentPsbt = new Psbt({ network });
  parentPsbt.setVersion(3);
  const parentInputFinalizer = sourceOutput.updatePsbtAsInput({
    psbt: parentPsbt,
    vout: fundingVout,
    txHex: fundingTxHex
  });
  parentPsbt.addOutput({ script: P2A_SCRIPT, value: 0 }); //vout: 0
  destOutput.updatePsbtAsOutput({ psbt: parentPsbt, value: destValue }); //vout: 1

  descriptors.signers.signBIP32({ psbt: parentPsbt, masterNode });
  parentInputFinalizer({ psbt: parentPsbt });

  const childPsbt = new Psbt({ network });
  childPsbt.setVersion(3);

  const parentTransaction = parentPsbt.extractTransaction();

  childPsbt.addInput({
    hash: parentTransaction.getId(),
    index: 0,
    witnessUtxo: { script: P2A_SCRIPT, value: 0 }
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
  //give back the money to ourselves
  sourceOutput.updatePsbtAsOutput({ psbt: childPsbt, value: destValue - FEE });
  descriptors.signers.signBIP32({ psbt: childPsbt, masterNode });
  childInputFinalizer({ psbt: childPsbt });

  const childTransaction = childPsbt.extractTransaction();
  Log(
    `Parent txId: ${parentTransaction.getId()}, child txId: ${childTransaction.getId()}`
  );

  const pkgUrl = `${ESPLORA_API}/txs/package`;
  const pkgRes = await fetch(pkgUrl, {
    method: 'POST',
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
  document.body.innerHTML = `
<div id="logs" style="white-space: pre-wrap;font-family: monospace;">
  <a href="javascript:start();" id="start">Click to start!</a>
</div>
`;
} else start();
