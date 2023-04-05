// Copyright (c) 2023 Jose-Luis Landabaso - https://bitcoinerlab.com
// Distributed under the MIT software license

/*
 * Important notes:
 *
 * Differently to the other playgrounds, this one has been designed exclussively
 * to be run on a browser-like environment to be run on:
 * https://bitcoinerlab.com/guides/multisig-fallback-timelock
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
import type { BIP32Interface } from 'bip32';
import { generateMnemonic, mnemonicToSeedSync } from 'bip39';
// @ts-ignore
import { encode as olderEncode } from 'bip68';
const signers = descriptors.signers;

const { Descriptor, BIP32 } = descriptors.DescriptorsFactory(secp256k1);
const FAUCET = 'https://bitcoinfaucet.uo1.net';

//JSON to pretty-string format:
const JSONf = (json: object) =>
  `<pre style="white-space:pre-wrap;overflow-wrap:break-word;">${JSON.stringify(
    json,
    null,
    '  '
  )}</pre>`;

//Shows results on the browser:
const Log = (message: string) => {
  const logsEl = document.getElementById('logs');
  logsEl!.innerHTML += `<p style="overflow-wrap:break-word;">${message}</p>`;
  logsEl!.lastElementChild?.scrollIntoView();
};
let run = 0;
declare global {
  interface Window {
    start: () => void;
    reset: () => void;
  }
}
window.reset = () => {
  localStorage.clear();
  window.location.reload();
};
document.body.innerHTML = `<div id="logs"></div><div>
<p><a href="javascript:start();">Run</a>&nbsp;&nbsp;&nbsp;&nbsp;
<a href="javascript:reset();">Reset mnemonics</a></p>
</div>`;

// =============================================================================
// The program starts here
// =============================================================================
//Set FALLBACK_RECOVERY to true if not using Custodial+User cooperation:
const FALLBACK_RECOVERY = false;
const isTestnet = true; //Change it to false, for mainnet
const POLICY = (time: number) =>
  `or(10@and(pk(@USER),pk(@CUSTODIAL)),and(older(${time}),pk(@FALLBACK)))`;
const BLOCKS = 2; //Number of blocks for the older() expression: ~20 minutes.
//Origin can be any path you like. F.ex, use /48'/0'/0'/2' for musig, maninnet,
//1st account & native segwit (read BIP48 for the details).
//For this "multisig-fallback-timelock" example we chose a random non-standard origin:
const ORIGIN_PATH = "/69420'";
//Now we must choose the speciffic path of the key within the origin.
//F.ex, the first internal address in mu-sig would have been: /0/0
//For the sake of keeping this simple, we will assume only one address per seed:
const KEY_PATH = '/0';
//This is the address that will get the funds after spending or fallback
const FINAL_ADDRESS = isTestnet
  ? 'tb1q4280xax2lt0u5a5s9hd4easuvzalm8v9ege9ge' //Testnet address
  : '3FYsjXPy81f96odShrKQoAiLFVmt6Tjf4g'; //Mainnet address
const FEE = 300; //The vsize of this tx will be ~147 vbytes. Pay ~2 sats/vbyte

const EXPLORER = `https://blockstream.info/${isTestnet ? 'testnet' : ''}`;
const network = isTestnet ? networks.testnet : networks.bitcoin;
//Try to retrieve the mnemonics from the browsers storage. If not there, then
//create some random mnemonics (or assign any mnemonic we choose)
const storedMnemonics = localStorage.getItem('mnemonics');
const mnemonics = storedMnemonics
  ? JSON.parse(storedMnemonics)
  : {
      //Here is where you would set the mnemonics with quotes or
      //using generateMnemonic() to create random ones:
      '@USER': generateMnemonic(),
      '@CUSTODIAL': 'oil oil oil oil oil oil oil oil oil oil oil oil',
      '@FALLBACK': generateMnemonic()
    };
//Store them now in the browsers storage:
localStorage.setItem('mnemonics', JSON.stringify(mnemonics));

Log(`Policy: ${POLICY(olderEncode({ blocks: BLOCKS }))}`);
Log(`Mnemonics 🤫: ${JSONf(mnemonics)}`);
const { miniscript } = compilePolicy(POLICY(olderEncode({ blocks: BLOCKS })));
Log(`Compiled miniscript: ${miniscript}`);

const keyExpressions: { [key: string]: string } = {};
const masterNodes: { [key: string]: BIP32Interface } = {};
const pubKeys: { [key: string]: Buffer } = {};
for (const key in mnemonics) {
  const mnemonic = mnemonics[key];
  const masterNode = BIP32.fromSeed(mnemonicToSeedSync(mnemonic), network);
  masterNodes[key] = masterNode;
  keyExpressions[key] = descriptors.keyExpressionBIP32({
    masterNode,
    originPath: ORIGIN_PATH,
    keyPath: KEY_PATH
  });
  pubKeys[key] = masterNode.derivePath(`m${ORIGIN_PATH}${KEY_PATH}`).publicKey;
}

Log(`Key expressions: ${JSONf(keyExpressions)}`);
//Let's replace the pub key @VARIABLES with their respective key expressions:
const isolatedMiniscript = miniscript.replace(
  /(@\w+)/g,
  (match, key) => keyExpressions[key] || match
);
const descriptorExpression = `wsh(${isolatedMiniscript})`;
Log(`Descriptor: ${descriptorExpression}`);
let signersPubKeys;
if (FALLBACK_RECOVERY) {
  Log(
    `This test assumes the FALLBACK_RECOVERY mechanism.
     You'll need to wait for the timelock to expire to access the funds.`
  );
  signersPubKeys = [pubKeys['@FALLBACK']];
} else {
  Log(`This test assumes normal @USER & @CUSTODIAL cooperation.`);
  signersPubKeys = [pubKeys['@CUSTODIAL'], pubKeys['@USER']];
}
Log(
  `You can change this behaviour by settting variable
  FALLBACK_RECOVERY = true / false.`
);
const descriptor = new Descriptor({
  expression: descriptorExpression,
  network,
  signersPubKeys: signersPubKeys as Buffer[]
});
const walletAddress = descriptor.getAddress();
Log(`Wallet address: ${walletAddress}`);
window.start = async () => {
  Log(`========== RUN ${run} @ ${new Date().toLocaleTimeString()} ==========`);
  const currentBlockHeight = parseInt(
    await (await fetch(`${EXPLORER}/api/blocks/tip/height`)).text()
  );
  Log(`Current block height: ${currentBlockHeight}`);
  run++;
  Log(`Let's check if the Wallet has funds...`);
  const utxo = await (
    await fetch(`${EXPLORER}/api/address/${walletAddress}/utxo`)
  ).json();
  if (utxo?.[0]) {
    Log(`Yes! Successfully funded. Now, let's move the funds.`);
    const txHex = await (
      await fetch(`${EXPLORER}/api/tx/${utxo?.[0].txid}/hex`)
    ).text();
    const inputValue = utxo[0].value;
    const psbt = new Psbt({ network });
    descriptor.updatePsbt({ psbt, txHex, vout: utxo[0].vout });
    //For the purpose of this guide, we add an output to send funds to hardcoded
    //addresses, which we don't care about, just to show how to use the API.
    //Don't forget to account for transaction fees!
    psbt.addOutput({ address: FINAL_ADDRESS, value: inputValue - FEE });
    if (FALLBACK_RECOVERY) {
      Log(`Signing with the FALLBACK key...`);
      signers.signBIP32({ psbt, masterNode: masterNodes['@FALLBACK']! });
    } else {
      Log(`Signing with the USER key...`);
      signers.signBIP32({ psbt, masterNode: masterNodes['@USER']! });
      Log(`Now, the PSBT (signed by the USER) would be sent to the custodial:`);
      Log(psbt.toBase64());
      Log(`Now, the custodial would give the signed PSBT back to the user to be
          finalized and pushed to the network.`);
      signers.signBIP32({ psbt, masterNode: masterNodes['@CUSTODIAL']! });
    }
    //Finalize the tx (compute & add the scriptWitness) & push to the blockchain
    descriptor.finalizePsbtInput({ index: 0, psbt });
    const spendTx = psbt.extractTransaction();
    Log(`Pushing the tx...`);
    const spendTxPushResult = await (
      await fetch(`${EXPLORER}/api/tx`, {
        method: 'POST',
        body: spendTx.toHex()
      })
    ).text();
    if (spendTxPushResult.match('non-BIP68-final')) {
      Log(`The miners rejected this tx because it's timelocked.`);
      Log(`<a href="javascript:start();">Try again in a few blocks!</a>`);
    } else {
      const txId = spendTx.getId();
      Log(
        `Successfully pushed! <a target=_blank href="${EXPLORER}/tx/${txId}">
        Check progress here.</a>`
      );
    }
  } else {
    if (isTestnet)
      Log(
        `Not yet! You can use <a href="${FAUCET}" target=_blank>${FAUCET}</a> to
        fund ${walletAddress}.`
      );
    else Log(`Not yet! You still need to send some sats to ${walletAddress}.`);
    Log(`Note: If you already sent funds, you may need to wait until a miner
        processes it.`);
    Log(`Fund it, wait a bit so that it is mined and
      <a href="javascript:start()">try again</a>.`);
  }
};
