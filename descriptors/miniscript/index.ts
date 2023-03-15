// Copyright (c) 2023 Jose-Luis Landabaso - https://bitcoinerlab.com
// Distributed under the MIT software license

import * as secp256k1 from '@bitcoinerlab/secp256k1';
import * as descriptors from '@bitcoinerlab/descriptors';
import { compilePolicy } from '@bitcoinerlab/miniscript';
import { /*Psbt,*/ networks } from 'bitcoinjs-lib';
import { mnemonicToSeedSync } from 'bip39';
// @ts-ignore
import { encode as olderEncode } from 'bip68';
// @ts-ignore
import { encode as afterEncode } from 'bip65';
const { Descriptor, BIP32 } = descriptors.DescriptorsFactory(secp256k1);

const network = networks.testnet;
const EXPLORER = 'https://blockstream.info/testnet';
const isWeb = typeof window !== 'undefined';
const Log = (message: string) => {
  const logsElement = isWeb && document.getElementById('logs');
  if (logsElement) {
    logsElement.innerHTML += `<p>${message}</p>`;
    logsElement?.lastElementChild?.scrollIntoView();
  }
  console.log(message.replace(/<[^>]*>?/gm, '')); //strip html tags
};

const BLOCKS = 5;

const POLICY = (older: number, after: number) =>
  `or(and(pk(@olderKey),older(${older})),and(pk(@afterKey),after(${after})))`;

const WSH_ORIGIN_PATH = `/69420'/1'/0'`; //This can be any path you like.
const WSH_KEY_PATH = `/0/0`; //Choose any path.

const SOFT_MNEMONIC = `abandon abandon abandon abandon abandon abandon abandon \
abandon abandon abandon abandon about`;
const masterNode = BIP32.fromSeed(mnemonicToSeedSync(SOFT_MNEMONIC), network);

const start = async () => {
  const currentBlockHeight = parseInt(
    await (await fetch(`${EXPLORER}/api/blocks/tip/height`)).text()
  );

  Log(`${currentBlockHeight}`);

  const after = afterEncode({ blocks: currentBlockHeight + BLOCKS });
  const older = olderEncode({ blocks: BLOCKS }); //relative locktime (sequence)
  //Now let's prepare the wsh utxo:
  const { miniscript, issane } = compilePolicy(POLICY(older, after));
  console.log({
    Descriptor,
    miniscript,
    WSH_ORIGIN_PATH,
    WSH_KEY_PATH,
    masterNode
  });
  if (!issane) throw new Error(`Error: miniscript not sane`);
  /*
  const wshExpression = `wsh(${miniscript
    .replace('@ledger', ledgerKeyExpression)
    .replace('@soft', softKeyExpression)})`;
  const wshDescriptor = new Descriptor({
    expression: wshExpression,
    network,
    preimages: [{ digest: `sha256(${DIGEST})`, preimage: PREIMAGE }]
  });
  const wshAddress = wshDescriptor.getAddress();

  //Now, spend both wpkh and wsh utxos:
  const psbt = new Psbt({ network });
  const psbtInputDescriptors = [];
  Log(`Fund the utxos. Let's first check if they're already funded...`);
  const wpkhUtxo = await (
    await fetch(`${EXPLORER}/api/address/${wpkhAddress}/utxo`)
  ).json();
  const wshUtxo = await (
    await fetch(`${EXPLORER}/api/address/${wshAddress}/utxo`)
  ).json();
  if (wpkhUtxo?.[0] && wshUtxo?.[0]) {
    Log(`Successfully funded. Now let's spend them. Go to your Ledger now! You \
may need to register the Policy (only once) and then accept spending 2 utxos.`);
    let txHex = await (
      await fetch(`${EXPLORER}/api/tx/${wpkhUtxo?.[0].txid}/hex`)
    ).text();
    let inputValue = wpkhUtxo[0].value;
    let i = wpkhDescriptor.updatePsbt({ psbt, txHex, vout: wpkhUtxo[0].vout });
    psbtInputDescriptors[i] = wpkhDescriptor;
    txHex = await (
      await fetch(`${EXPLORER}/api/tx/${wshUtxo?.[0].txid}/hex`)
    ).text();
    inputValue += wshUtxo[0].value;
    i = wshDescriptor.updatePsbt({ psbt, txHex, vout: wshUtxo[0].vout });
    psbtInputDescriptors[i] = wshDescriptor;
    //We'll send the funds to one of our Ledger's internal (change) addresses:
    const finalAddress = new Descriptor({
      expression: await descriptors.scriptExpressions.wpkhLedger({
        ledgerClient,
        ledgerState,
        network,
        account: 0,
        change: 1,
        index: 0
      }),
      network
    }).getAddress();
    //Be nice. Give the miners 1000 sats :)
    psbt.addOutput({ address: finalAddress, value: inputValue - 1000 });

    //Now sign the PSBT with the BIP32 node (the software wallet)
    descriptors.signers.signBIP32({ psbt, masterNode });
    //Finalize the tx (compute & add the scriptWitness) & push to the blockchain
    descriptors.finalizePsbt({ psbt, descriptors: psbtInputDescriptors });
    const spendTx = psbt.extractTransaction();
    const spendTxPushResult = await (
      await fetch(`${EXPLORER}/api/tx`, {
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
      Log(`Success. <a href="${EXPLORER}/tx/${txId}?expand">Check it!</a>`);
    }
  } else {
    Log(`Not yet! Use https://bitcoinfaucet.uo1.net to get some sats:`);
    Log(`${wpkhAddress}: ${wpkhUtxo?.[0] ? 'Funded!' : 'NOT funded'}`);
    Log(`${wshAddress}: ${wshUtxo?.[0] ? 'Funded!' : 'NOT funded'}`);
    Log(`Fund them and <a href="javascript:start();">check again</a>.`);
  }
  */
};
if (isWeb) (window as any).start = start;

if (isWeb) {
  document.body.innerHTML = `<div id="logs">Connect a Ledger, open Bitcoin Test\
 2.1 App and <a href="javascript:start();" id="start">Click to start</a></div>`;
} else start();
