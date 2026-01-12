// Copyright (c) 2025 Jose-Luis Landabaso - https://bitcoinerlab.com
// Distributed under the MIT software license

//core 30 submit package limitations: https://bitcoincore.org/en/doc/30.0.0/rpc/rawtransactions/submitpackage/
//use op_return instrad of inscriptions? This way we can make sure the backup
//is processed (as a package) together with the vault: https://bitcoin.stackexchange.com/questions/126208/why-would-anyone-use-op-return-over-inscriptions-aside-from-fees
//
//TODO: use OP_RETURN:
/*import * as bitcoin from 'bitcoinjs-lib';

const network = bitcoin.networks.bitcoin; // or testnet

const psbt = new bitcoin.Psbt({ network });

const data = Buffer.from('hello world', 'utf8');

const embed = bitcoin.payments.embed({ data: [data] });

psbt.addOutput({
  script: embed.output,
  value: 0
});
*/
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

//FIXME: this still needs a mechanism to keep some margin for not to spend from the wallet: the max expected fee in future for (trigger+panic) x nActiveVaults
const FEE_RATE = 2.0;
const MIN_VAULT_RATIO = 2 / 3; // This is a hard limit we impose. Don't let people vault funds if the unvaulted amount (after backup and fees) will be below 2/3 of the vaulted amount.
const WPKH_DUST_THRESHOLD = 294;
const vaultFee = Math.ceil(Math.max(...VAULT_TX_VBYTES.withChange) * FEE_RATE);
const backupValue = Math.ceil(Math.max(...BACKUP_TX_VBYTES) * FEE_RATE);
const VAULT_GAP_LIMIT = 20;
const FAUCET_FETCH_RETRIES = 10;
const FAUCET_FETCH_DELAY_MS = 1500;

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

const getNextVaultIndex = ({
  discovery,
  descriptor
}: {
  discovery: DiscoveryInstance;
  descriptor: string;
}) => {
  const { txoMap } = discovery.getUtxosAndBalance({
    descriptor,
    txStatus: TxStatus.ALL
  });
  const usedIndices = new Set<number>();
  for (const indexedDescriptor of Object.values(txoMap)) {
    const indexPart = indexedDescriptor.split('~')[1];
    if (!indexPart || indexPart === 'non-ranged') continue;
    const parsedIndex = Number.parseInt(indexPart, 10);
    if (!Number.isNaN(parsedIndex)) usedIndices.add(parsedIndex);
  }
  let nextIndex = 0;
  while (usedIndices.has(nextIndex)) nextIndex += 1;
  return nextIndex;
};

//const EXPLORER = `https://tape.rewindbitcoin.com/explorer`;
const ESPLORA_API = `https://tape.rewindbitcoin.com/api`;
const FAUCET_API = `https://tape.rewindbitcoin.com/faucet`;
const explorer = new EsploraExplorer({ url: ESPLORA_API });
const network = networks.regtest;
const { Discovery } = DiscoveryFactory(explorer, network);

const { wpkhBIP32 } = scriptExpressions;
const { Output, BIP32 } = DescriptorsFactory(secp256k1);

import type { Output } from 'bitcoinjs-lib/src/transaction';
import { isWeb, JSONf, Log } from './utils';
import {
  BACKUP_TX_VBYTES,
  VAULT_TX_VBYTES,
  //createInscriptionBackup,
  createOpReturnBackup,
  createVault,
  getBackupDescriptor,
  type UtxosData
} from './vaults';

const start = async () => {
  await explorer.connect();
  const discovery = new Discovery();

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
  if (!descriptors[0]) throw new Error();
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  await discovery.fetch({ descriptors });
  const initialHistoryLength = discovery.getHistory({
    descriptors,
    txStatus: TxStatus.ALL
  }).length;

  // Check if the wallet already has confirmed funds
  let utxosAndBalance = discovery.getUtxosAndBalance({ descriptors });
  //const walletAddressInfo = await explorer.fetchAddress(walletAddress);
  Log(`🔍 Wallet balance: ${utxosAndBalance.balance}`);
  //let walletPrevTxId;

  let minVaultableAmount = Math.max(
    WPKH_DUST_THRESHOLD,
    Math.ceil(utxosAndBalance.balance * MIN_VAULT_RATIO)
  );
  let maxVaultableAmount = utxosAndBalance.balance - vaultFee - backupValue;

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

  utxosAndBalance = discovery.getUtxosAndBalance({ descriptors });
  minVaultableAmount = Math.max(
    WPKH_DUST_THRESHOLD,
    Math.ceil(utxosAndBalance.balance * MIN_VAULT_RATIO)
  );
  maxVaultableAmount = utxosAndBalance.balance - vaultFee - backupValue;

  if (maxVaultableAmount < minVaultableAmount)
    throw new Error(
      `Balance too low: vaultable amount ${maxVaultableAmount} < ratio target ${minVaultableAmount} or below dust threshold ${WPKH_DUST_THRESHOLD}.`
    );

  const utxosData = getUtxosData(utxosAndBalance.utxos, network, discovery);
  Log(`🔍 Updated wallet balance: ${utxosAndBalance.balance}`);

  const backupDescriptor = getBackupDescriptor({
    masterNode,
    network,
    index: '*'
  });
  await discovery.fetch({
    descriptor: backupDescriptor,
    gapLimit: VAULT_GAP_LIMIT
  });
  const vaultIndex = getNextVaultIndex({
    discovery,
    descriptor: backupDescriptor
  });

  const coldAddress = new Output({
    descriptor: wpkhBIP32({
      masterNode: emergencyMasterNode,
      network,
      account: 1,
      keyPath: '/0/0'
    }),
    network
  }).getAddress();
  const accounts = discovery.getUsedAccounts();
  const mainAccount = accounts[0];
  if (!mainAccount) throw new Error('Could not find the main account');
  const changeDescriptor = mainAccount.replace(/\/0\/\*/g, '/1/*');
  const changeDescriptorWithIndex = {
    descriptor: changeDescriptor,
    index: discovery.getNextIndex({
      descriptor: changeDescriptor
    })
  };
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
    coldAddress,
    changeDescriptorWithIndex,
    network,
    vaultIndex
  });
  if (typeof vault === 'string') throw new Error(vault);

  const {
    psbtVault,
    psbtTrigger,
    psbtPanic,
    backupOutputIndex,
    backupFee,
    randomMasterNode
  } = vault;

  const psbtBackup = createOpReturnBackup({
    psbtTrigger,
    psbtPanic,
    psbtVault,
    backupOutputIndex,
    backupFee,
    randomMasterNode,
    network
  });

  console.log(`
vault id: ${psbtVault.extractTransaction().getId()}
trigger id: ${psbtTrigger.extractTransaction().getId()}
backup id: ${psbtBackup.extractTransaction().getId()}
`);
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
