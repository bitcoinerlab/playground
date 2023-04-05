// Copyright (c) 2023 Jose-Luis Landabaso - https://bitcoinerlab.com
// Distributed under the MIT software license

/*
 * This playground demonstrates how to create a multi-signature wallet, prompt
 * the user to fund the wallet, and spend from the wallet by sending funds to a
 * designated FINAL_ADDRESS.
 * There are two ways to spend from the wallet. In normal operation (when
 * FALLBACK_RECOVERY = false), a COSIGNER must cooperate with the USER and sign
 * the transaction. However, after a specified number of blocks have passed, the
 * user can use a FALLBACK key to spend the funds. This simulates a scenario
 * where the COSIGNER is uncooperative, out of service, out of business, or has
 * become a bad actor.
 *
 * To simplify this example, only the first unspent transaction output (UTXO) of
 * the first address of the wallet is considered. Looping over all  addresses
 * and UTXOs is left as an exercise for the user.
 * Additionally, we won't differentiate between internal or external addresses.
 *
 * The code below includes boilerplate initialization code and some helper
 * functions. To set up the program, jump to the "SETTINGS" block. To read
 * the code, go to the "THE PROGRAM STARTS HERE" block.
 *
 * Unlike the other playgrounds, this one is designed to be run exclusively on a
 * browser-like environment, specifically at
 * https://bitcoinerlab.com/guides/multisig-fallback-timelock.
 */

// =============================================================================
// BOILERPLATE (initalization, helper functions...):
// =============================================================================
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
const JSONf = (json: object) => {
  const jsonString = JSON.stringify(json, null, ' ');
  const firstKeyI = jsonString.indexOf('{');
  const lastKeyI = jsonString.lastIndexOf('}');
  const trimmedJsonString = jsonString.substring(firstKeyI + 3, lastKeyI);
  return `<code style="white-space:pre-line;overflow-wrap:break-word;">
  ${trimmedJsonString}</code>`;
};

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
document.body.innerHTML = `<div style="font-size:0.95em;" id="logs"></div><div>
<p style="padding-bottom:50px;"><a href="javascript:start();">Run</a>
&nbsp;&nbsp;&nbsp;&nbsp;<a href="javascript:reset();">Reset mnemonics</a></p>
</div>`;

// =============================================================================
// SETTINGS (edit to your convenience):
// =============================================================================
// Set FALLBACK_RECOVERY to true to simulate a scenario where the COSIGNER is
// uncooperative, out of service or out of business:
const FALLBACK_RECOVERY = false;
const isTestnet = true; //Change it to false, for mainnet. AT YOUR OWN RISK!!!
const POLICY = (time: number) =>
  `or(9@and(pk(@USER),pk(@COSIGNER)),and(older(${time}),pk(@FALLBACK)))`;
const BLOCKS = 2; //Number of blocks for the older() expression: ~20 minutes.
//ORIGIN_PATH can be any path you like. F.ex, ORIGIN_PATH= /48'/0'/0'/2' for
//multisig, maninnet, 1st account & native segwit (read BIP48 for the details).
//For this "multisig-fallback-timelock" example we chose a non-standard origin:
const ORIGIN_PATH = "/69420'";
//Now we must choose the speciffic path of the key within the origin.
//F.ex, the first external address in multisig would have been: /0/0
//For the sake of keeping this simple, we will assume only one external address:
const KEY_PATH = '/0';
//Set the address that will get the funds when spending from the wallet:
const FINAL_ADDRESS = isTestnet
  ? 'tb1q4280xax2lt0u5a5s9hd4easuvzalm8v9ege9ge' //Testnet address
  : '3FYsjXPy81f96odShrKQoAiLFVmt6Tjf4g'; //Mainnet address
const FEE = 300; //The vsize of this tx will be ~147 vbytes. Pay ~2 sats/vbyte
//Set the mnemonics with quotes or generateMnemonic() to create random ones:
const USER_MNEMONIC = generateMnemonic();
const COSIGNER_MNEMONIC = 'oil oil oil oil oil oil oil oil oil oil oil oil';
const FALLBACK_MNEMONIC = generateMnemonic();
// =============================================================================
// END OF SETTINGS
// =============================================================================

// =============================================================================
// THE PROGRAM STARTS HERE:
// =============================================================================
const EXPLORER = `https://blockstream.info/${isTestnet ? 'testnet' : ''}`;
const network = isTestnet ? networks.testnet : networks.bitcoin;
//Try to retrieve the mnemonics from the browsers storage. If not there, then
//create some random mnemonics (or assign any mnemonic we choose)
const storedMnemonics = localStorage.getItem('mnemonics');
const mnemonics = storedMnemonics
  ? JSON.parse(storedMnemonics)
  : {
      '@USER': USER_MNEMONIC,
      '@COSIGNER': COSIGNER_MNEMONIC,
      '@FALLBACK': FALLBACK_MNEMONIC
    };
//Store them now in the browsers storage:
localStorage.setItem('mnemonics', JSON.stringify(mnemonics));

Log(`Read the description of this playground in the header of the editor on
  the left.<br/>To change the settings, locate the SETTINGS section in the editor
  and modify the values as needed. The code will automatically recompile after
  editing.<br/>Click "Run" at the bottom to start.`);
Log(`Policy: <code>${POLICY(olderEncode({ blocks: BLOCKS }))}</code>`);
Log(`Mnemonics 🤫: ${JSONf(mnemonics)}`);
const { miniscript } = compilePolicy(POLICY(olderEncode({ blocks: BLOCKS })));
Log(`Compiled miniscript: <code>${miniscript}</code>`);

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
Log(`Descriptor: <code>${descriptorExpression}</code>`);
let signersPubKeys;
const behaviourMsg = `Change this behavior by editing the
  <code>FALLBACK_RECOVERY</code> setting.`;
if (FALLBACK_RECOVERY) {
  Log(`The code is currently set to use the <b>fallback recovery mechanism</b>.
      ${behaviourMsg} Wait for the timelock to expire to access the funds.`);
  signersPubKeys = [pubKeys['@FALLBACK']];
} else {
  Log(`The code is currently set to use <b>normal cooperation between USER and
      COSIGNER</b>. ${behaviourMsg}`);
  signersPubKeys = [pubKeys['@COSIGNER'], pubKeys['@USER']];
}
const descriptor = new Descriptor({
  expression: descriptorExpression,
  network,
  signersPubKeys: signersPubKeys as Buffer[]
});
const walletAddress = descriptor.getAddress();
Log(`Wallet address: ${walletAddress}`);
window.start = async () => {
  const currentBlockHeight = parseInt(
    await (await fetch(`${EXPLORER}/api/blocks/tip/height`)).text(),
    10
  );
  Log(`<b>===== RUN: #${run++} · BLOCK HEIGHT: ${currentBlockHeight} · 
      TIME: ${new Date().toLocaleTimeString()} =====</b>`);
  Log(`Let's check if the wallet has funds...`);
  const utxo = await (
    await fetch(`${EXPLORER}/api/address/${walletAddress}/utxo`)
  ).json();
  if (utxo?.[0]) {
    Log(`Yes, it's funded! Now, let's try to spend the funds from the wallet.`);
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
      Log(`A PSBT is now created and passed to the COSIGNER:`);
      Log(psbt.toBase64());
      Log(`The COSIGNER signs the PSBT...`);
      signers.signBIP32({ psbt, masterNode: masterNodes['@COSIGNER']! });
      Log(`Now, the COSIGNER passes back the signed PSBT to the USER to be
          finalized and pushed to the network.`);
      Log(`The USER signs the PSBT with their key...`);
      signers.signBIP32({ psbt, masterNode: masterNodes['@USER']! });
    }
    //Finalize the tx (compute & add the scriptWitness) & push to the blockchain
    Log(`Finalizing the tx (adding the witness) & pushing the transaction...`);
    descriptor.finalizePsbtInput({ index: 0, psbt });
    const spendTx = psbt.extractTransaction();
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
        Check the transaction here.</a>`
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
    Log(`Fund the wallet, wait a bit so that it is processed and
      <a href="javascript:start()">try again</a>.`);
  }
};
