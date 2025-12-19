// Copyright (c) 2025 Jose-Luis Landabaso - https://bitcoinerlab.com
// Distributed under the MIT software license

import './codesandboxFixes';
import { readFileSync, writeFileSync } from 'fs';
import {
  DescriptorsFactory,
  scriptExpressions
} from '@bitcoinerlab/descriptors';
import { generateMnemonic, mnemonicToSeedSync } from 'bip39';
import { networks, Transaction } from 'bitcoinjs-lib';
import * as secp256k1 from '@bitcoinerlab/secp256k1';
import { EsploraExplorer } from '@bitcoinerlab/explorer';

const FEE = 500; //FIXME: dynamic - also duplicated on index.ts and vaults.ts
//FIXME: this still needs a mechanism to keep some margin for not to spend from the wallet: the max expected fee in future for (trigger+panic) x nActiveVaults

const EXPLORER = `https://tape.rewindbitcoin.com/explorer`;
const ESPLORA_API = `https://tape.rewindbitcoin.com/api`;
const FAUCET_API = `https://tape.rewindbitcoin.com/faucet`;
const explorer = new EsploraExplorer({ url: ESPLORA_API });
const { wpkhBIP32 } = scriptExpressions;
const { Output, BIP32 } = DescriptorsFactory(secp256k1);
const network = networks.regtest;

import type { Output } from 'bitcoinjs-lib/src/transaction';
import { isWeb, JSONf, Log } from './utils';
import {
  createBackupChain,
  createVaultChain,
  getNextBackupIndex
} from './vaults';

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

  const coldAddress = new Output({
    descriptor: wpkhBIP32({
      masterNode: emergencyMasterNode,
      network,
      account: 1,
      keyPath: '/0/0'
    }),
    network
  }).getAddress();
  const vaultChain = createVaultChain({
    walletUTXO,
    walletPrevTxHex,
    masterNode,
    coldAddress,
    network
  });

  const backupIndex = await getNextBackupIndex({
    masterNode,
    network,
    explorer
  });
  console.log(`Backup index tip: ${backupIndex}`);
  const backupChain = createBackupChain({
    backupIndex,
    masterNode,
    walletUTXO,
    psbtTrigger: vaultChain.psbtTrigger,
    psbtPanic: vaultChain.psbtPanic,
    psbtVault: vaultChain.psbtVault,
    fundingTxHex: vaultChain.psbtVault.extractTransaction().toHex(),
    fundingVout: 1,
    network,
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
