// Copyright (c) 2023 Jose-Luis Landabaso - https://bitcoinerlab.com
// Distributed under the MIT software license

import './codesandboxFixes';
import * as ecc from '@bitcoinerlab/secp256k1';
import * as descriptors from '@bitcoinerlab/descriptors';
import { compilePolicy } from '@bitcoinerlab/miniscript';
import { Psbt, networks } from 'bitcoinjs-lib';
import { mnemonicToSeedSync } from 'bip39';
// @ts-ignore
import { encode as olderEncode } from 'bip68';
import { AppClient } from 'ledger-bitcoin';
const { Output, BIP32 } = descriptors.DescriptorsFactory(ecc);

const EXPLORER = 'https://tape.rewindbitcoin.com/explorer';
const ESPLORA_API = 'https://tape.rewindbitcoin.com/api';
const FAUCET = 'https://tape.rewindbitcoin.com';
const network = networks.regtest;
const isWeb = typeof window !== 'undefined';
const Log = (message: string) => {
  const logsElement = isWeb && document.getElementById('logs');
  if (logsElement) {
    logsElement.innerHTML += `<p>${message}</p>`;
    logsElement?.lastElementChild?.scrollIntoView();
  }
  console.log(message.replace(/<[^>]*>?/gm, '')); //strip html tags
};

//Ledger is stateless. We store state in localStorage. Deserialize it if found:
const ledgerStorage = isWeb && localStorage.getItem('ledger');
const ledgerState = ledgerStorage
  ? JSON.parse(ledgerStorage, (_key, val) =>
      //JSON.parse does not know how to deal with Buffers. Let's show it:
      val instanceof Object && val.type == 'Buffer' ? new Buffer(val.data) : val
    )
  : {};
console.log('ledgerState:', { ...ledgerState });
const BLOCKS = 5;
const OLDER = olderEncode({ blocks: BLOCKS });
const PREIMAGE =
  '107661134f21fc7c02223d50ab9eb3600bc3ffc3712423a1e47bb1f9a9dbf55f';
const DIGEST =
  '6c60f404f8167a38fc70eaf8aa17ac351023bef86bcb9d1086a19afe95bd5333';

const POLICY = `\
and(and(and(pk(@ledger),pk(@soft)),older(${OLDER})),sha256(${DIGEST}))`;

const WSH_ORIGIN_PATH = `/69420'/1'/0'`; //This can be any path you like.
const WSH_KEY_PATH = `/0/0`; //Choose any path.

const SOFT_MNEMONIC = `abandon abandon abandon abandon abandon abandon abandon \
abandon abandon abandon abandon about`;
const masterNode = BIP32.fromSeed(mnemonicToSeedSync(SOFT_MNEMONIC), network);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let transport: any = null;
const start = async () => {
  if (!transport) {
    let Transport = await import(
      `@ledgerhq/hw-transport-${isWeb ? 'web' : 'node-'}hid`
    );
    //while-loop hack to make it work both for Typescript & compiled Javascript
    while (Transport.default) Transport = Transport.default;
    try {
      transport = await Transport.create();
    } catch (err) {
      void err;
      Log(`Not detected. Connect and <a href="javascript:start();">retry</a>.`);
      transport = null;
      return;
    }
  }
  try {
    //Throws if not running Bitcoin Test >= 2.1.0
    await descriptors.ledger.assertLedgerApp({
      transport,
      name: 'Bitcoin Test',
      minVersion: '2.1.0'
    });
  } catch (err) {
    void err;
    await transport.close();
    transport = null;
    Log(`Open the Bitcoin Test App, version >= 2.1.0 and \
<a href="javascript:start();">try again</a>.`);
    return;
  }
  Log(`Ledger ready. Now look at the device screen...`);
  const ledgerClient = new AppClient(transport);
  const ledgerManager = { ledgerClient, ledgerState, ecc, network };

  //Let's prepare the wpkh utxo:
  const wpkhOutput = new Output({
    descriptor: await descriptors.scriptExpressions.wpkhLedger({
      ledgerManager,
      account: 0,
      change: 0,
      index: 0
    }),
    network
  });
  const wpkhAddress = wpkhOutput.getAddress();

  //Now let's prepare the wsh utxo:
  const { miniscript, issane } = compilePolicy(POLICY);
  if (!issane) throw new Error(`Error: miniscript not sane`);
  const ledgerKeyExpression = await descriptors.keyExpressionLedger({
    ledgerManager,
    originPath: WSH_ORIGIN_PATH,
    keyPath: WSH_KEY_PATH
  });
  const softKeyExpression = descriptors.keyExpressionBIP32({
    masterNode,
    originPath: WSH_ORIGIN_PATH,
    keyPath: WSH_KEY_PATH
  });
  const wshDescriptor = `wsh(${miniscript
    .replace('@ledger', ledgerKeyExpression)
    .replace('@soft', softKeyExpression)})`;
  const wshOutput = new Output({
    descriptor: wshDescriptor,
    network,
    preimages: [{ digest: `sha256(${DIGEST})`, preimage: PREIMAGE }]
  });
  const wshAddress = wshOutput.getAddress();

  //Now, spend both wpkh and wsh utxos:
  const psbt = new Psbt({ network });
  const psbtInputFinalizers = [];
  Log(`Fund the utxos. Let's first check if they're already funded...`);
  const wpkhUtxo = await (
    await fetch(`${ESPLORA_API}/address/${wpkhAddress}/utxo`)
  ).json();
  const wshUtxo = await (
    await fetch(`${ESPLORA_API}/address/${wshAddress}/utxo`)
  ).json();
  if (wpkhUtxo?.[0] && wshUtxo?.[0]) {
    Log(`Successfully funded. Now let's spend them. Go to your Ledger now! You \
may need to register the Policy (only once) and then accept spending 2 utxos.`);
    let txHex = await (
      await fetch(`${ESPLORA_API}/tx/${wpkhUtxo?.[0].txid}/hex`)
    ).text();
    let inputValue = wpkhUtxo[0].value;
    psbtInputFinalizers.push(
      wpkhOutput.updatePsbtAsInput({ psbt, txHex, vout: wpkhUtxo[0].vout })
    );
    txHex = await (
      await fetch(`${ESPLORA_API}/tx/${wshUtxo?.[0].txid}/hex`)
    ).text();
    inputValue += wshUtxo[0].value;
    psbtInputFinalizers.push(
      wshOutput.updatePsbtAsInput({ psbt, txHex, vout: wshUtxo[0].vout })
    );
    //We'll send the funds to one of our Ledger's internal (change) addresses:
    const finalAddress = new Output({
      descriptor: await descriptors.scriptExpressions.wpkhLedger({
        ledgerManager,
        account: 0,
        change: 1,
        index: 0
      }),
      network
    }).getAddress();
    //Be nice. Give the miners 1000 sats :)
    psbt.addOutput({ address: finalAddress, value: inputValue - 1000 });

    //Register Ledger policies of non-standard descriptors. Auto-skips if exists
    await descriptors.ledger.registerLedgerWallet({
      ledgerManager,
      descriptor: wshDescriptor,
      policyName: 'BitcoinerLab'
    });
    //We can sign the tx with the Ledger.
    await descriptors.signers.signLedger({ ledgerManager, psbt });
    //Now sign the PSBT with the BIP32 node (the software wallet)
    descriptors.signers.signBIP32({ psbt, masterNode });
    //Finalize the tx (compute & add the scriptWitness) & push to the blockchain
    psbtInputFinalizers.forEach(inputFinalizer => inputFinalizer({ psbt }));
    const spendTx = psbt.extractTransaction();
    const spendTxPushResult = await (
      await fetch(`${ESPLORA_API}/tx`, {
        method: 'POST',
        body: spendTx.toHex()
      })
    ).text();
    console.log({ pushedHex: spendTx.toHex() });
    Log(`Tx pushed with result: ${spendTxPushResult}`);
    //You may get non-bip68 final now. You need to wait 5 blocks.
    if (spendTxPushResult.match('non-BIP68-final')) {
      Log(`You still need to wait for a few more blocks (up to ${BLOCKS}).`);
      Log(`<a href="javascript:start();">Try again in a few blocks!</a>`);
    } else {
      const txId = spendTx.getId();
      Log(
        `Success. <a href="${EXPLORER}/tx/${txId}?expand" target="_blank">Check it!</a>`
      );
    }
  } else {
    Log(`Not yet! Use ${FAUCET} to get some sats:`);
    Log(`${wpkhAddress}: ${wpkhUtxo?.[0] ? 'Funded!' : 'NOT funded'}`);
    Log(`${wshAddress}: ${wshUtxo?.[0] ? 'Funded!' : 'NOT funded'}`);
    Log(`Fund them and <a href="javascript:start();">check again</a>.`);
  }
  //Save ledgerState to localStorage
  if (isWeb) localStorage.setItem('ledger', JSON.stringify(ledgerState));
};
if (isWeb) (window as unknown as { start: typeof start }).start = start;

if (isWeb) {
  document.body.innerHTML = `<div id="logs">Connect a Ledger, open Bitcoin Test\
 2.1 App and <a href="javascript:start();" id="start">Click to start</a></div>`;
} else start();
