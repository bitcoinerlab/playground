// Copyright (c) 2025 Jose-Luis Landabaso - https://bitcoinerlab.com
// Distributed under the MIT software license
//
// Package policy details important to our case:
// - Package RBF replacement is limited to 1‑parent‑1‑child (parent must spent
//   confirmed outputs).
// - Each tx is validated individually first (v2 vs v3 rules differ; see below)
// - Not all‑or‑nothing: partial acceptance is possible; mining isn’t atomic.
//
// What’s different (TRUC vs non‑TRUC)
// - v3 (TRUC): can be 0‑fee, and has extra relay rules (only v3 can spend
//      unconfirmed v3, size limits, sibling eviction, etc.).
// - v2 (non‑TRUC): must meet standard static minrelay fee. A 0‑fee v2 parent
//      is rejected even in a package.

//Package explained: https://github.com/bitcoin/bitcoin/blob/master/doc/policy/packages.md
//TRUC explained: https://bips.dev/431/
//guildeline for wallet devs from Sanders: https://bitcoinops.org/en/bitcoin-core-28-wallet-integration-guide/

//core 30 submit package limitations: https://bitcoincore.org/en/doc/30.0.0/rpc/rawtransactions/submitpackage/
//use op_return instrad of inscriptions? This way we can make sure the backup
//is processed (as a package) together with the vault: https://bitcoin.stackexchange.com/questions/126208/why-would-anyone-use-op-return-over-inscriptions-aside-from-fees

//FIXME: https://codesandbox.io/p/sandbox/github/bitcoinerlab/playground/tree/rewind2/descriptors/rewind2?file=%2Findex.ts&from-embed - this will fail
import './codesandboxFixes';
import { readFileSync, writeFileSync } from 'fs';
import {
  DescriptorsFactory,
  keyExpressionBIP32,
  scriptExpressions
} from '@bitcoinerlab/descriptors';
import { generateMnemonic, mnemonicToSeedSync } from 'bip39';
import { networks, type Network } from 'bitcoinjs-lib';
import * as secp256k1 from '@bitcoinerlab/secp256k1';
import { EsploraExplorer } from '@bitcoinerlab/explorer';
import {
  DiscoveryFactory,
  TxStatus,
  type DiscoveryInstance
} from '@bitcoinerlab/discovery';
import { dustThreshold } from '@bitcoinerlab/coinselect';

//FIXME: this still needs a mechanism to keep some margin for paying anchors
const BACKUP_TYPE = 'INSCRIPTION';
const FEE_RATE = 2.0;
const VAULT_GAP_LIMIT = 20;
const FAUCET_FETCH_RETRIES = 10;
const FAUCET_FETCH_DELAY_MS = 1500;
const SHIFT_FEES_TO_BACKUP_END = true;

export const getUtxosData = (
  utxos: Array<string>,
  network: Network,
  discovery: DiscoveryInstance
): UtxosData => {
  return utxos.map(utxo => {
    const [txId, strVout] = utxo.split(':');
    const vout = Number(strVout);
    if (!txId || isNaN(vout) || !Number.isInteger(vout) || vout < 0)
      throw new Error(`Invalid utxo ${utxo}`);
    const descriptorAndIndex = discovery.getDescriptor({ utxo });
    if (!descriptorAndIndex) throw new Error(`Unmatched ${utxo}`);
    const txHex = discovery.getTxHex({ txId });
    // It's free getting the tx from discovery (memoized). Pass it down:
    const tx = discovery.getTransaction({ txId });
    return {
      ...descriptorAndIndex,
      output: new Output({ ...descriptorAndIndex, network }),
      tx,
      txHex,
      vout
    };
  });
};

const getChangeDescriptorWithIndex = (
  discovery: DiscoveryInstance,
  fallbackDescriptor: string
) => {
  const accounts = discovery.getUsedAccounts();
  const mainAccount = accounts[0];
  const changeDescriptor = mainAccount
    ? mainAccount.replace(/\/0\/\*/g, '/1/*')
    : fallbackDescriptor;
  if (!changeDescriptor) throw new Error('Missing change descriptor');
  return {
    descriptor: changeDescriptor,
    index: discovery.getNextIndex({ descriptor: changeDescriptor })
  };
};

//const EXPLORER = `https://tape.rewindbitcoin.com/explorer`;
const ESPLORA_API = `https://tape.rewindbitcoin.com/api`;
const FAUCET_API = `https://tape.rewindbitcoin.com/faucet`;
const explorer = new EsploraExplorer({ url: ESPLORA_API });
const network = networks.regtest;
const { Discovery } = DiscoveryFactory(explorer, network);

const { wpkhBIP32 } = scriptExpressions;
const { Output, BIP32 } = DescriptorsFactory(secp256k1);

import { isWeb, JSONf, Log } from './utils';
import {
  getVaultContext,
  createInscriptionBackup,
  createOpReturnBackup,
  createVault,
  getBackupDescriptor,
  type UtxosData
} from './vaults';

const start = async () => {
  await explorer.connect();
  const discovery = new Discovery();

  const randomMnemonic = generateMnemonic();
  const randomMasterNode = BIP32.fromSeed(
    mnemonicToSeedSync(randomMnemonic),
    network
  );

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
  Log(`🔍 Fetching wallet...`);
  const descriptors = [
    wpkhBIP32({ masterNode, network, account: 0, keyPath: '/0/*' }),
    wpkhBIP32({ masterNode, network, account: 0, keyPath: '/1/*' })
  ];
  if (!descriptors[0] || !descriptors[1])
    throw new Error('Could not derive wallet descriptors');
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  await discovery.fetch({ descriptors });
  const initialHistoryLength = discovery.getHistory({
    descriptors,
    txStatus: TxStatus.ALL
  }).length;

  let utxosAndBalance = discovery.getUtxosAndBalance({ descriptors });
  let vaultMaxFundsContext = getVaultContext({
    vaultedAmount: 'MAX_FUNDS',
    feeRate: FEE_RATE,
    utxosData: getUtxosData(utxosAndBalance.utxos, network, discovery),
    masterNode,
    randomMasterNode,
    changeDescriptorWithIndex: getChangeDescriptorWithIndex(
      discovery,
      descriptors[1]
    ),
    vaultIndex: 0, //Dummmy value is ok just to grab vsize
    backupType: BACKUP_TYPE,
    shiftFeesToBackupEnd: SHIFT_FEES_TO_BACKUP_END,
    network
  });
  const minVaultableAmount = dustThreshold(vaultMaxFundsContext.vaultOutput);

  let coinselectedVaultMaxFunds = vaultMaxFundsContext.selected;

  let maxVaultableAmount;
  if (typeof coinselectedVaultMaxFunds === 'string') {
    Log(`The coinselector failed: ${coinselectedVaultMaxFunds}`);
    maxVaultableAmount = 0;
  } else maxVaultableAmount = coinselectedVaultMaxFunds.vaultedAmount;

  Log(`Backup type: ${BACKUP_TYPE}`);
  Log(`The backup will cost: ${vaultMaxFundsContext.backupCost}`);
  Log(`🔍 Wallet balance: ${utxosAndBalance.balance}`);
  Log(`🔍 Wallet UTXOs: ${utxosAndBalance.utxos.length}`);
  Log(`🔍 Wallet max vaultable amount: ${maxVaultableAmount}`);

  // Trigger tx pays zero fees, so unvaulted amount equals vaulted amount.
  if (maxVaultableAmount < minVaultableAmount) {
    Log(
      `💰 The wallet does not have enough funds. Let's request some funds...`
    );
    //New or empty wallet. Let's prepare the faucet request:
    const formData = new URLSearchParams();
    const newWalletOutput = new Output({
      descriptor: descriptors[0],
      index: discovery.getNextIndex({ descriptor: descriptors[0] }),
      network
    });
    formData.append('address', newWalletOutput.getAddress());
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
    for (let attempt = 1; attempt <= FAUCET_FETCH_RETRIES; attempt += 1) {
      await discovery.fetch({ descriptors });
      const history = discovery.getHistory({ descriptors });
      if (history.length > initialHistoryLength) {
        Log('✅ Faucet transaction detected.');
        break;
      }
      if (attempt < FAUCET_FETCH_RETRIES) {
        Log(
          `⏳ Waiting for faucet transaction... (${attempt}/${FAUCET_FETCH_RETRIES})`
        );
        await wait(FAUCET_FETCH_DELAY_MS);
      } else Log('⚠️ Faucet transaction not detected yet. Continuing.');
    }
  } else Log(`💰 Existing balance detected. Skipping faucet.`);

  //re-compute values after coinselect:
  utxosAndBalance = discovery.getUtxosAndBalance({ descriptors });
  vaultMaxFundsContext = getVaultContext({
    vaultedAmount: 'MAX_FUNDS',
    feeRate: FEE_RATE,
    utxosData: getUtxosData(utxosAndBalance.utxos, network, discovery),
    masterNode,
    randomMasterNode,
    changeDescriptorWithIndex: getChangeDescriptorWithIndex(
      discovery,
      descriptors[1]
    ),
    vaultIndex: 0, //Dummmy value is ok just to grab vsize
    backupType: BACKUP_TYPE,
    shiftFeesToBackupEnd: SHIFT_FEES_TO_BACKUP_END,
    network
  });
  coinselectedVaultMaxFunds = vaultMaxFundsContext.selected;
  if (typeof coinselectedVaultMaxFunds === 'string') {
    Log(`The coinselector failed: ${coinselectedVaultMaxFunds}`);
    maxVaultableAmount = 0;
  } else maxVaultableAmount = coinselectedVaultMaxFunds.vaultedAmount;

  if (maxVaultableAmount < minVaultableAmount)
    throw new Error(
      `Balance too low after coinselect: vaultable amount ${maxVaultableAmount} below dust threshold ${minVaultableAmount}.`
    );

  const utxosData = getUtxosData(utxosAndBalance.utxos, network, discovery);
  Log(`🔍 Updated wallet balance: ${utxosAndBalance.balance}`);
  Log(`🔍 Updated wallet UTXOs: ${utxosAndBalance.utxos.length}`);
  Log(`🔍 Updated wallet max vaultable amount: ${maxVaultableAmount}`);

  const backupDescriptor = getBackupDescriptor({
    masterNode,
    network,
    index: '*'
  });
  await discovery.fetch({
    descriptor: backupDescriptor,
    gapLimit: VAULT_GAP_LIMIT
  });
  const vaultIndex = discovery.getNextIndex({ descriptor: backupDescriptor });
  Log(`🔍 Number of Vaults found: ${vaultIndex}`);

  const coldAddress = new Output({
    descriptor: wpkhBIP32({
      masterNode: emergencyMasterNode,
      network,
      account: 1,
      keyPath: '/0/0'
    }),
    network
  }).getAddress();
  const changeDescriptorWithIndex = getChangeDescriptorWithIndex(
    discovery,
    descriptors[1]
  );
  const unvaultKey = keyExpressionBIP32({
    masterNode,
    originPath: "/0'",
    keyPath: '/0'
  });

  const vault = createVault({
    vaultedAmount: maxVaultableAmount, //Let's vault the max possible
    unvaultKey,
    feeRate: FEE_RATE,
    utxosData,
    masterNode,
    randomMasterNode,
    coldAddress,
    changeDescriptorWithIndex,
    vaultIndex,
    backupType: BACKUP_TYPE,
    shiftFeesToBackupEnd: SHIFT_FEES_TO_BACKUP_END,
    network
  });
  if (typeof vault === 'string') throw new Error(vault);

  const { psbtVault, psbtTrigger, psbtPanic } = vault;

  const vaultTx = psbtVault.extractTransaction();
  const vaultInputValue = vault.vaultUtxosData.reduce(
    (sum, utxo) => sum + (utxo.tx.outs[utxo.vout]?.value ?? 0),
    0
  );
  const vaultOutputValue = vaultTx.outs.reduce(
    (sum, out) => sum + out.value,
    0
  );
  const vaultFee = vaultInputValue - vaultOutputValue;
  Log(`💸 Vault tx fee (pure miner fee paid by the vault tx): ${vaultFee}`);
  Log(
    `📦 Backup funding output reserved inside the vault tx: ${vault.backupOutputValue}`
  );
  Log(
    `📦 Backup fee estimate (what the backup tx will burn later): ${vault.backupCost}`
  );

  if (BACKUP_TYPE === 'INSCRIPTION') {
    const inscriptionPsbts = createInscriptionBackup({
      vaultIndex,
      feeRate: FEE_RATE,
      psbtTrigger,
      psbtPanic,
      psbtVault,
      masterNode,
      changeDescriptorWithIndex,
      shiftFeesToBackupEnd: SHIFT_FEES_TO_BACKUP_END,
      network
    });
    const commitTx = inscriptionPsbts.psbtCommit.extractTransaction();
    const revealTx = inscriptionPsbts.psbtReveal.extractTransaction();
    Log(`📦 Submitting vault + commit + reveal txs sequentially...`);
    await explorer.push(vaultTx.toHex());
    await explorer.push(commitTx.toHex());
    await explorer.push(revealTx.toHex());

    Log(`
 vault tx id: ${vaultTx.getId()}
 commit tx id: ${commitTx.getId()}
 reveal tx id: ${revealTx.getId()}
 trigger tx id: ${psbtTrigger.extractTransaction().getId()}
 `);
  } else {
    const psbtBackup = createOpReturnBackup({
      psbtTrigger,
      psbtPanic,
      psbtVault,
      vaultIndex,
      masterNode,
      backupType: BACKUP_TYPE,
      network
    });

    const backupTx = psbtBackup.extractTransaction();
    if (BACKUP_TYPE === 'OP_RETURN_TRUC') {
      let firstAttempt = true;
      for (;;) {
        await discovery.fetch({ descriptors });
        const confirmedUtxos = discovery.getUtxosAndBalance({
          descriptors,
          txStatus: TxStatus.CONFIRMED
        }).utxos;
        const pendingUtxos = vault.vaultUtxosData.filter(
          utxo => !confirmedUtxos.includes(`${utxo.tx.getId()}:${utxo.vout}`)
        );
        if (pendingUtxos.length === 0) {
          Log(`🔍 All vault funding UTXOs are confirmed.`);
          break;
        }
        if (firstAttempt)
          Log(`

⛓️ TRUC rules require vault funding UTXOs to be confirmed.
⏳ Waiting for ${pendingUtxos.length} UTXO(s) to confirm...`);
        else
          Log(
            `⏳ Still waiting for ${pendingUtxos.length} UTXO(s) to confirm...`
          );
        await new Promise(r => setTimeout(r, firstAttempt ? 5000 : 10000));
        firstAttempt = false;
      }
    }
    Log(`📦 Submitting vault + backup as a package...`);
    const pkgUrl = `${ESPLORA_API}/txs/package`;
    const pkgRes = await fetch(pkgUrl, {
      method: 'POST',
      body: JSON.stringify([vaultTx.toHex(), backupTx.toHex()])
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
 vault tx id: ${vaultTx.getId()}
 backup tx id: ${backupTx.getId()}
 trigger tx id: ${psbtTrigger.extractTransaction().getId()}
 `);
  }

  explorer.close();
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
