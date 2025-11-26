// Copyright (c) 2025 Jose-Luis Landabaso - https://bitcoinerlab.com
// Distributed under the MIT software license

import './codesandboxFixes';
import { readFileSync, writeFileSync } from 'fs';
import * as descriptors from '@bitcoinerlab/descriptors';
import { generateMnemonic, mnemonicToSeedSync } from 'bip39';
import { networks, Psbt, Transaction } from 'bitcoinjs-lib';
import * as secp256k1 from '@bitcoinerlab/secp256k1';
import { EsploraExplorer } from '@bitcoinerlab/explorer';
import { InscriptionsFactory } from './inscriptions';

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

const SIGNER_TYPE: 'ECPAIR' | 'BIP32' = 'ECPAIR';

const EXPLORER = `https://tape.rewindbitcoin.com/explorer`;
const ESPLORA_API = `https://tape.rewindbitcoin.com/api`;
const FAUCET_API = `https://tape.rewindbitcoin.com/faucet`;
const explorer = new EsploraExplorer({ url: ESPLORA_API });
const { wpkhBIP32 } = descriptors.scriptExpressions;
const { Output, BIP32, ECPair } = descriptors.DescriptorsFactory(secp256k1);
const { Inscription } = InscriptionsFactory(secp256k1);
const network = networks.regtest;
const FEE = 500;

const start = async () => {
  let mnemonic; //Let's create a basic wallet:
  if (isWeb) {
    mnemonic = localStorage.getItem('inscriptionsmnemonic');
    if (!mnemonic) {
      mnemonic = generateMnemonic();
      localStorage.setItem('inscriptionsmnemonic', mnemonic);
    }
  } else {
    try {
      mnemonic = readFileSync('.inscriptionsmnemonic', 'utf8');
    } catch {
      mnemonic = generateMnemonic();
      writeFileSync('.inscriptionsmnemonic', mnemonic);
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
  Log(
    `📫 Source address: <a href="${EXPLORER}/${sourceAddress}" target="_blank">${sourceAddress}</a>`
  );

  // Check if the wallet already has confirmed funds
  Log(`🔍 Checking existing balance...`);
  const sourceAddressInfo = await explorer.fetchAddress(sourceAddress);
  Log(`🔍 Wallet balance info: ${JSONf(sourceAddressInfo)}`);
  let fundingtTxId;

  if (sourceAddressInfo.balance + sourceAddressInfo.unconfirmedBalance < FEE) {
    Log(`💰 The wallet is empty. Let's request some funds...`);
    //New or empty wallet. Let's prepare the faucet request:
    const formData = new URLSearchParams();
    formData.append('address', sourceAddress);
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
    // Wallet has funds. Find the last transaction that actually pays to this script.
    const txHistory = await explorer.fetchTxHistory({ address: sourceAddress });
    const spkHex = sourceOutput.getScriptPubKey().toString('hex');

    for (const { txId } of txHistory.reverse()) {
      const tx = Transaction.fromHex(await explorer.fetchTx(txId));
      const vout = tx.outs.findIndex(o => o.script.toString('hex') === spkHex);
      if (vout !== -1) {
        fundingtTxId = txId;
        break;
      }
    }
  }

  let fundingTxHex = '';
  while (true) {
    // Ping the esplora for the txHex (may need to wait until the tx is indexed)
    try {
      fundingTxHex = await explorer.fetchTx(fundingtTxId);
      break;
    } catch (err) {
      void err;
      Log(
        `⏳ Waiting for the funding tx <a href="${EXPLORER}/${fundingtTxId}" target="_blank">${fundingtTxId}</a> to be indexed...`
      );
    }
    await new Promise(r => setTimeout(r, 1000)); //sleep 1s
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

  const inscriptionPair = ECPair.makeRandom();
  const inscriptionMasterNode = BIP32.fromSeed(
    mnemonicToSeedSync(generateMnemonic()),
    network
  );
  const inscriptionOutput = new Inscription({
    contentType: 'text/plain;charset=utf-8',
    content: Buffer.from('Hello world!'),
    ...(SIGNER_TYPE === 'ECPAIR'
      ? { internalPubKey: inscriptionPair.publicKey }
      : {
        bip32Derivation: {
          masterFingerprint: inscriptionMasterNode.fingerprint,
          path: "m/123'/0'/0'/0/0",
          pubkey:
            inscriptionMasterNode.derivePath("m/123'/0'/0'/0/0").publicKey
        }
      }),
    network
  });

  const commitPsbt = new Psbt({ network });
  const commitInputFinalizer = sourceOutput.updatePsbtAsInput({
    psbt: commitPsbt,
    vout: fundingVout,
    txHex: fundingTxHex
  });
  inscriptionOutput.updatePsbtAsOutput({
    psbt: commitPsbt,
    value: sourceValue - FEE
  }); //vout: 0

  descriptors.signers.signBIP32({ psbt: commitPsbt, masterNode });
  commitInputFinalizer({ psbt: commitPsbt });

  const commitTransaction = commitPsbt.extractTransaction();

  const revealPsbt = new Psbt({ network });
  const revealInputFinalizer = inscriptionOutput.updatePsbtAsInput({
    psbt: revealPsbt,
    vout: 0,
    txHex: commitTransaction.toHex()
  });
  //give back the money to ourselves
  sourceOutput.updatePsbtAsOutput({
    psbt: revealPsbt,
    value: sourceValue - 2 * FEE
  });
  if (SIGNER_TYPE === 'ECPAIR')
    descriptors.signers.signECPair({
      psbt: revealPsbt,
      ecpair: inscriptionPair
    });
  else
    descriptors.signers.signBIP32({
      psbt: revealPsbt,
      masterNode: inscriptionMasterNode
    });

  revealInputFinalizer({ psbt: revealPsbt });

  const revealTransaction = revealPsbt.extractTransaction();

  Log(`📦 Submitting commit...`);
  await explorer.push(commitTransaction.toHex());
  const commitTxId = commitTransaction.getId();
  while (true) {
    // Ping the esplora for the txHex (may need to wait until the tx is indexed)
    try {
      await explorer.fetchTx(commitTxId);
      break;
    } catch (err) {
      void err;
      Log(
        `⏳ Waiting for the commit tx <a href="${EXPLORER}/${commitTxId}" target="_blank">${commitTxId}</a> to be indexed...`
      );
    }
    await new Promise(r => setTimeout(r, 1000)); //sleep 1s
  }

  Log(`📦 Submitting reveal...`);
  await explorer.push(revealTransaction.toHex());
  Log(`
🎉 Hooray! You just executed the inscriptions playground

Commit tx: 
  <a href="${EXPLORER}/${commitTransaction.getId()}" target="_blank">${commitTransaction.getId()}</a>

Reveal tx:
  <a href="${EXPLORER}/${revealTransaction.getId()}" target="_blank">${revealTransaction.getId()}</a>
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
