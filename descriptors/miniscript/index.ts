// Copyright (c) 2023 Jose-Luis Landabaso - https://bitcoinerlab.com
// Distributed under the MIT software license

import * as secp256k1 from '@bitcoinerlab/secp256k1';
import * as descriptors from '@bitcoinerlab/descriptors';
import { compilePolicy } from '@bitcoinerlab/miniscript';
import { Psbt, networks } from 'bitcoinjs-lib';
import { generateMnemonic, mnemonicToSeedSync } from 'bip39';
// @ts-ignore
import { encode as afterEncode } from 'bip65';
import { readFileSync, writeFileSync } from 'fs';
import type { ECPairInterface } from 'ecpair';

const { Descriptor, BIP32, ECPair } = descriptors.DescriptorsFactory(secp256k1);

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

//JSON to pretty-string format:
const JSONf = (json: object) => JSON.stringify(json, null, '\t');

const EMERGENCY_RECOVERY = false;
const BLOCKS = 5;
const POLICY = (after: number) =>
  `or(pk(@emergencyKey),and(pk(@unvaultKey),after(${after})))`;
const WSH_ORIGIN_PATH = `/69420'/1'/0'`; //This can be any path you like.
const WSH_KEY_PATH = `/0/0`; //Choose any path.

Log(`This test data: ${JSONf({ EMERGENCY_RECOVERY, BLOCKS })}`);

let emergencyPair: ECPairInterface;
let unvaultMnemonic;
if (isWeb) {
  const emergencyWIF = localStorage.getItem('emergencyWIF');
  unvaultMnemonic = localStorage.getItem('unvaultMnemonic');
  if (!emergencyWIF || !unvaultMnemonic) {
    emergencyPair = ECPair.makeRandom();
    unvaultMnemonic = generateMnemonic();
    localStorage.setItem('emergencyWIF', emergencyPair.toWIF());
    localStorage.setItem('unvaultMnemonic', unvaultMnemonic);
  } else emergencyPair = ECPair.fromWIF(emergencyWIF);
} else {
  try {
    emergencyPair = ECPair.fromWIF(readFileSync('.emergencyWIF', 'utf8'));
    unvaultMnemonic = readFileSync('.unvaultMnemonic', 'utf8');
  } catch {
    emergencyPair = ECPair.makeRandom();
    unvaultMnemonic = generateMnemonic();
    writeFileSync('.emergencyWIF', emergencyPair.toWIF());
    writeFileSync('.unvaultMnemonic', unvaultMnemonic);
  }
}

const unvaultMasterNode = BIP32.fromSeed(
  mnemonicToSeedSync(unvaultMnemonic),
  network
);
Log(
  `Your secrets 🤫: ${JSONf({
    emergencyWIF: emergencyPair.toWIF(),
    unvaultMnemonic
  })}`
);

const start = async () => {
  const currentBlockHeight = parseInt(
    await (await fetch(`${EXPLORER}/api/blocks/tip/height`)).text()
  );
  const after = afterEncode({ blocks: currentBlockHeight + BLOCKS });
  Log(`Policy: ${JSONf({ currentBlockHeight, policy: POLICY(after) })}`);
  //Now let's prepare the wsh utxo:
  const { miniscript, issane } = compilePolicy(POLICY(after));
  if (!issane) throw new Error(`Error: miniscript not sane`);
  const unvaultKey = unvaultMasterNode.derivePath(
    `m${WSH_ORIGIN_PATH}${WSH_KEY_PATH}`
  ).publicKey;
  const wshExpression = `wsh(${miniscript
    .replace(
      '@unvaultKey',
      descriptors.keyExpressionBIP32({
        masterNode: unvaultMasterNode,
        originPath: WSH_ORIGIN_PATH,
        keyPath: WSH_KEY_PATH
      })
    )
    .replace('@emergencyKey', emergencyPair.publicKey.toString('hex'))})`;
  const wshDescriptor = new Descriptor({
    expression: wshExpression,
    network,
    signersPubKeys: [EMERGENCY_RECOVERY ? emergencyPair.publicKey : unvaultKey]
  });
  const wshAddress = wshDescriptor.getAddress();
  const psbt = new Psbt({ network });
  Log(`Fund your vault. Let's first check if it's been already funded...`);
  const utxo = await (
    await fetch(`${EXPLORER}/api/address/${wshAddress}/utxo`)
  ).json();
  if (utxo?.[0]) {
    Log(`Successfully funded. Now let's spend the funds.`);
    const txHex = await (
      await fetch(`${EXPLORER}/api/tx/${utxo?.[0].txid}/hex`)
    ).text();
    const inputValue = utxo[0].value;
    wshDescriptor.updatePsbt({ psbt, txHex, vout: utxo[0].vout });
    //Send funds to any address: "abandon^11 about" mnemonic 1st/2nd pkh address
    //Be nice. Give the miners 1000 sats :)
    psbt.addOutput({
      address: EMERGENCY_RECOVERY
        ? 'mkpZhYtJu2r87Js3pDiWJDmPte2NRZ8bJV'
        : 'mzpbWabUQm1w8ijuJnAof5eiSTep27deVH',
      value: inputValue - 1000
    });

    //Now sign the PSBT with the BIP32 node (the software wallet)
    if (EMERGENCY_RECOVERY)
      descriptors.signers.signECPair({ psbt, ecpair: emergencyPair });
    else descriptors.signers.signBIP32({ psbt, masterNode: unvaultMasterNode });
    //Finalize the tx (compute & add the scriptWitness) & push to the blockchain
    wshDescriptor.finalizePsbtInput({ index: 0, psbt });
    const spendTx = psbt.extractTransaction();
    const spendTxPushResult = await (
      await fetch(`${EXPLORER}/api/tx`, {
        method: 'POST',
        body: spendTx.toHex()
      })
    ).text();
    Log(`Pushing: ${spendTx.toHex()}`);
    Log(`Tx pushed with result: ${spendTxPushResult}`);
    //You may get non-bip68 final now. You need to wait 5 blocks.
    if (
      spendTxPushResult.match('non-BIP68-final') ||
      spendTxPushResult.match('non-final')
    ) {
      Log(`Not final. You will need to wait up to ${BLOCKS} blocks.`);
      Log(`<a href="javascript:start();">Try again in a few blocks!</a>`);
    } else {
      const txId = spendTx.getId();
      Log(`Success. <a href="${EXPLORER}/tx/${txId}?expand">Check it!</a>`);
    }
  } else {
    Log(`Not yet! Use https://bitcoinfaucet.uo1.net to get some sats:`);
    Log(`${wshAddress}: ${utxo?.[0] ? 'Funded!' : 'NOT funded'}`);
    Log(`Fund them and <a href="javascript:start();">check again</a>.`);
  }
};
if (isWeb) (window as any).start = start;

if (isWeb) {
  document.body.innerHTML = `<div id="logs">
<a href="javascript:start();" id="start">Click to start!</a></div>`;
} else start();
