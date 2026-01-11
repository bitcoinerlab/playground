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

const FEE = 500; //FIXME: dynamic - also duplicated on index.ts and vaults.ts - better use FEE_RATE
//FIXME: this still needs a mechanism to keep some margin for not to spend from the wallet: the max expected fee in future for (trigger+panic) x nActiveVaults
const FEE_RATE = 2.0;
const BACKUP_FUNDING = 1500; //FIXME: dynamic
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

  if (utxosAndBalance.balance < FEE) {
    //FIXME: request enough funds for the whole backup+vault+fees
    Log(`💰 The wallet is empty. Let's request some funds...`);
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
  //TODO: FIXME: strategy here should have been:
  //is 1st: Create the vault and with the remaining
  //utxos then create the backups so that the utxos don't interfere.
  //however, wll need to know the expected backup sats needed so that we
  //make sure the backup makles it into the blockchain.
  //But this does not work since it's impossible to know the cost of the
  //backup in advance since it will be done with the remainint utxos.
  //Better do first a utxo-preselection for the backup using dummy pre-signed
  //txs. That's better. Then use those utxos for the final backup.
  const vault = createVault({
    vaultedAmount: utxosAndBalance.balance - FEE - BACKUP_FUNDING, //FIXME: this must be smarter than this
    unvaultKey,
    feeRate: FEE_RATE,
    utxosData,
    masterNode,
    coldAddress,
    changeDescriptorWithIndex, //FIXME: recompute it if the backup used the change already
    network,
    backupValue: BACKUP_FUNDING,
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
  } = vault; //FIXME: fix types later

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
