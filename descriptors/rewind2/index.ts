// Copyright (c) 2025 Jose-Luis Landabaso - https://bitcoinerlab.com
// Distributed under the MIT software license

//Learn more:
//Guide: https://bitcoinops.org/en/bitcoin-core-28-wallet-integration-guide/
//TRUC: https://bips.dev/431/
//TRUC PR: https://github.com/bitcoin/bitcoin/pull/28948
//P2A PR: https://github.com/bitcoin/bitcoin/pull/30352
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

const EXPLORER = `https://tape.rewindbitcoin.com/explorer`;
const ESPLORA_API = `https://tape.rewindbitcoin.com/api`;
const FAUCET_API = `https://tape.rewindbitcoin.com/faucet`;
const explorer = new EsploraExplorer({ url: ESPLORA_API });
const { wpkhBIP32 } = descriptors.scriptExpressions;
const { Output, BIP32 } = descriptors.DescriptorsFactory(secp256k1);
const network = networks.regtest;
const FEE = 500; //The fee for the package
const P2A_SCRIPT = Buffer.from('51024e73', 'hex');

// The TAPE testnet mines *exactly* every 10 minutes. Learn more: tape.rewindbitcoin.com
// Yes... deterministic blocks. Because it's my blockchain, my rules 😎
const estimateNextTapeBlock = () => {
  const now = new Date();
  const nextBlock = new Date(now); //clone it
  nextBlock.setMinutes(Math.ceil(now.getMinutes() / 10) * 10, 0, 0);
  if (nextBlock <= now) nextBlock.setMinutes(nextBlock.getMinutes() + 10);
  const delta = (nextBlock.getTime() - now.getTime()) / 1000;
  return `${Math.floor(delta / 60)}m ${Math.floor(delta % 60)}s`;
};

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

  const vaultPair = ECPair.makeRandom();
  const vaultOutput = new Output({
    descriptor: `wpkh(${vaultPair.publicKey.toString('hex')})`,
    network
  });

  // Create destination address (account 1)
  const destOutput = new Output({
    descriptor: wpkhBIP32({ masterNode, network, account: 1, keyPath: '/0/0' }),
    network
  });
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

  Log(`📦 Submitting parent + child as a package...

Bitcoin Core will validate them together as a 1P1C package.`);
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
  Log(`
🎉 Hooray! You just executed a TRUC (v3) + P2A fee bump:

🧑‍🍼 Parent tx (yes, the one with *zero fees*): 
  <a href="${EXPLORER}/${parentTransaction.getId()}" target="_blank">${parentTransaction.getId()}</a>

👶 Child tx (pays the actual fee):
  <a href="${EXPLORER}/${childTransaction.getId()}" target="_blank">${childTransaction.getId()}</a>
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
