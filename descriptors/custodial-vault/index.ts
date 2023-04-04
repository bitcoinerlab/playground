// Copyright (c) 2023 Jose-Luis Landabaso - https://bitcoinerlab.com
// Distributed under the MIT software license

/*
 * Important notes:
 *
 * Differently to the other playgrounds, this one has been designed exclussively
 * to be run on a browser-like environment to be run on:
 * https://bitcoinerlab.com/guides/custodial-vault
 *
 * In order to simplify this example, only the first utxo of the first address
 * of each account is considered.
 * Looping over all the addresses and utxos is left as an excercise to the user.
 * Also, we won't differentiate between internal or external addresses.
 */

//The code below is just some boiler-plate initalizing stuff and some helper
//functions. Jump to the "The program starts here" block below

import * as secp256k1 from '@bitcoinerlab/secp256k1';
import * as descriptors from '@bitcoinerlab/descriptors';
import { compilePolicy } from '@bitcoinerlab/miniscript';
import { Psbt, networks } from 'bitcoinjs-lib';
import { generateMnemonic, mnemonicToSeedSync } from 'bip39';
// @ts-ignore
import { encode as olderEncode } from 'bip68';

const { Descriptor, BIP32 } = descriptors.DescriptorsFactory(secp256k1);

//JSON to pretty-string format:
const JSONf = (j: object) => `<pre>${JSON.stringify(j, null, '\t')}</pre>`;

//Shows results on the browser:
const Log = (message: string) => {
  const logsElement = document.getElementById('logs');
  logsElement!.innerHTML += `<p>${message}</p>`;
  logsElement!.lastElementChild?.scrollIntoView();
};
declare global {
  interface Window {
    start: () => void;
    reset: () => void;
  }
}
window.reset = () => {
  localStorage.clear();
  window.start();
};
document.body.innerHTML = `<div id="logs"></div><div>
<p><a href="javascript:start();">Run</a>&nbsp;&nbsp;&nbsp;&nbsp;
<a href="javascript:reset();">Reset mnemonics</a></p>
</div>`;

// =============================================================================
// The program starts here
// =============================================================================

const network = networks.testnet; //change it to "networks.bitcoin", for mainnet
const POLICY = (time: number) =>
  `or(and(pk(@MINE),pk(@CUSTODIAL)),and(older(${time}),pk(@FALLBACK)))`;
const BLOCKS = 5;
//Origin can be any path you like. F.ex, use /48'/0'/0'/2' for musig, maninnet,
//1st account & native segwit (read BIP48 for the details).
//For this "custodial-vault" example we choose any non-standard origin. F.ex.:
const ORIGIN_PATH = "/69420'";
//Now we must choose the speciffic path of the key within the origin.
//F.ex, the first internal address in mu-sig would have been: /0/0
//For the sake of keeping this simple, we will assume only one address per seed:
const KEY_PATH = '/0';

const EXPLORER = `https://blockstream.info/${
  network === networks.testnet ? 'testnet' : ''
}`;
window.start = () => {
  //Try to retrieve the mnemonics from the browsers storage. If not there, then
  //create some random mnemonics (or assign any mnemonic we choose)
  const storedMnemonics = localStorage.getItem('mnemonics');
  const mnemonics = storedMnemonics
    ? JSON.parse(storedMnemonics)
    : {
        //Here is where you would set the mnemonics.
        //Use generateMnemonic to create random ones or directly assign one:
        '@MINE': generateMnemonic(),
        '@CUSTODIAL': 'oil oil oil oil oil oil oil oil oil oil oil oil',
        '@FALLBACK': generateMnemonic()
      };
  //Store them now in the browsers storage:
  localStorage.setItem('mnemonics', JSON.stringify(mnemonics));

  Log(`The mnemonics 🤫: ${JSONf(mnemonics)}`);
  Log(`The policy: ${POLICY(olderEncode({ blocks: BLOCKS }))}`);
  const { miniscript } = compilePolicy(POLICY(olderEncode({ blocks: BLOCKS })));
  Log(`The compiled miniscript: ${miniscript}`);

  const keyExpressions: { [key: string]: string } = {};
  for (const key in mnemonics) {
    const mnemonic = mnemonics[key];
    keyExpressions[key] = descriptors.keyExpressionBIP32({
      masterNode: BIP32.fromSeed(mnemonicToSeedSync(mnemonic), network),
      originPath: ORIGIN_PATH,
      keyPath: KEY_PATH
    });
  }

  Log(`The key expressions: ${JSONf(keyExpressions)}`);
  console.log({
    compilePolicy,
    Psbt,
    Descriptor,
    ORIGIN_PATH,
    KEY_PATH,
    EXPLORER,
    POLICY,
    mnemonicToSeedSync,
    BLOCKS
  });
};

//const start = async () => {
//  const currentBlockHeight = parseInt(
//    await (await fetch(`${EXPLORER}/api/blocks/tip/height`)).text()
//  );
//  const after = afterEncode({ blocks: currentBlockHeight + BLOCKS });
//  Log(`Current block height: ${currentBlockHeight}`);
//  //Now let's prepare the wsh utxo:
//  const { miniscript, issane } = compilePolicy(POLICY(after));
//  if (!issane) throw new Error(`Error: miniscript not sane`);
//  const unvaultKey = unvaultMasterNode.derivePath(
//    `m${ORIGIN_PATH}${KEY_PATH}`
//  ).publicKey;
//  const wshExpression = `wsh(${miniscript
//    .replace(
//      '@unvaultKey',
//      descriptors.keyExpressionBIP32({
//        masterNode: unvaultMasterNode,
//        originPath: ORIGIN_PATH,
//        keyPath: KEY_PATH
//      })
//    )
//    .replace('@emergencyKey', emergencyPair.publicKey.toString('hex'))})`;
//  const wshDescriptor = new Descriptor({
//    expression: wshExpression,
//    network,
//    signersPubKeys: [EMERGENCY_RECOVERY ? emergencyPair.publicKey : unvaultKey]
//  });
//  const wshAddress = wshDescriptor.getAddress();
//  Log(`Fund your vault. Let's first check if it's been already funded...`);
//  const utxo = await (
//    await fetch(`${EXPLORER}/api/address/${wshAddress}/utxo`)
//  ).json();
//  if (utxo?.[0]) {
//    Log(`Successfully funded. Now let's spend the funds.`);
//    const txHex = await (
//      await fetch(`${EXPLORER}/api/tx/${utxo?.[0].txid}/hex`)
//    ).text();
//    const inputValue = utxo[0].value;
//    const psbt = new Psbt({ network });
//    wshDescriptor.updatePsbt({ psbt, txHex, vout: utxo[0].vout });
//    //For the purpose of this guide, we add an output to send funds to hardcoded
//    //addresses, which we don't care about, just to show how to use the API. Don't
//    //forget to account for transaction fees!
//    psbt.addOutput({
//      address: EMERGENCY_RECOVERY
//        ? 'mkpZhYtJu2r87Js3pDiWJDmPte2NRZ8bJV'
//        : 'tb1q4280xax2lt0u5a5s9hd4easuvzalm8v9ege9ge',
//      value: inputValue - 1000
//    });
//
//    //Now sign the PSBT with the BIP32 node (the software wallet)
//    if (EMERGENCY_RECOVERY)
//      descriptors.signers.signECPair({ psbt, ecpair: emergencyPair });
//    else descriptors.signers.signBIP32({ psbt, masterNode: unvaultMasterNode });
//    //Finalize the tx (compute & add the scriptWitness) & push to the blockchain
//    wshDescriptor.finalizePsbtInput({ index: 0, psbt });
//    const spendTx = psbt.extractTransaction();
//    const spendTxPushResult = await (
//      await fetch(`${EXPLORER}/api/tx`, {
//        method: 'POST',
//        body: spendTx.toHex()
//      })
//    ).text();
//    Log(`Pushing: ${spendTx.toHex()}`);
//    Log(`Tx pushed with result: ${spendTxPushResult}`);
//    //You may get non-bip68 final now. You need to wait 5 blocks.
//    if (
//      spendTxPushResult.match('non-BIP68-final') ||
//      spendTxPushResult.match('non-final')
//    ) {
//      Log(`This means it's still TimeLocked and miners rejected the tx.`);
//      Log(`<a href="javascript:start();">Try again in a few blocks!</a>`);
//    } else {
//      const txId = spendTx.getId();
//      Log(`Success. <a href="${EXPLORER}/tx/${txId}?expand">Check it!</a>`);
//    }
//  } else {
//    Log(`Not yet! Use https://bitcoinfaucet.uo1.net to send some sats to:`);
//    Log(`${wshAddress} Fund it & <a href="javascript:start()">check again</a>`);
//  }
//};
