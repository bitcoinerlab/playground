// Copyright (c) 2023 Jose-Luis Landabaso - https://bitcoinerlab.com
// Distributed under the MIT software license

import './codesandboxFixes.js';
import * as secp256k1 from '@bitcoinerlab/secp256k1';
import * as descriptors from '@bitcoinerlab/descriptors';
import { mnemonicToSeedSync } from 'bip39';
import { Psbt, networks } from 'bitcoinjs-lib';
const { pkhBIP32, wpkhBIP32 } = descriptors.scriptExpressions;
const { Output, BIP32 } = descriptors.DescriptorsFactory(secp256k1);
const network = networks.testnet;
const EXPLORER = 'https://blockstream.info/testnet';
const FEE = 500;

//Let's create our software wallet with this mnemonic:
const MNEMONIC =
  'drum turtle globe inherit autumn flavor ' +
  'slice illness sniff distance carbon elder';
const masterNode = BIP32.fromSeed(mnemonicToSeedSync(MNEMONIC), network);

//We started with 1679037 sats in moovc1JqGrz4v6FA2U8ks8ZqjSwjv3yRKQ
//You can verify it in a block explorer: https://tinyurl.com/mu82nmzw
const TXID = 'ee02b5a12c2f22e892bed376781fc9ed435f0d192a1b67ca47a7190804d8e868';

//Let's calculate the Legacy address where we sent some initial money to play:
const legacyOutput = new Output({
  descriptor: pkhBIP32({ masterNode, network, account: 0, keyPath: '/0/1' }),
  network
});
console.log(`We start with:`, { address: legacyOutput.getAddress(), TXID });

//Let's get the utxo info (txHex & vout) of the initial tx to the Legacy address
(async () => {
  const txHex = await (await fetch(`${EXPLORER}/api/tx/${TXID}/hex`)).text();
  const txJson = (await (await fetch(`${EXPLORER}/api/tx/${TXID}`)).json()) as {
    vout: { scriptpubkey: string; value: number }[];
  };
  const txOuts = txJson.vout;
  const vout = txOuts.findIndex(
    txOut =>
      txOut.scriptpubkey === legacyOutput.getScriptPubKey().toString('hex')
  );
  const initialValue = txOuts[vout]!.value; //This must be: 1679037
  console.log('This is the utxo to spend :', { txHex, vout, initialValue });

  //Define the Segwit descriptor where we will move the funds:
  const segwitOutput = new Output({
    descriptor: wpkhBIP32({ masterNode, network, account: 0, keyPath: '/1/0' }),
    network
  });

  //Let's create a transaction (Partially Signed Bitcoin Transaction) now:
  const psbt = new Psbt({ network });
  //Use the Legacy descriptor to update the transaction with the input info:
  const legacyInputFinalizer = legacyOutput.updatePsbtAsInput({
    psbt,
    vout,
    txHex
  });
  //Now add our Segwit address as the new output & give some FEE to the miners
  const finalValue = initialValue - FEE;
  segwitOutput.updatePsbtAsOutput({ psbt, value: finalValue });
  const finalAddress = segwitOutput.getAddress();
  console.log('Move the funds to:', { finalAddress, finalValue });

  //Sign the transaction, finalize it and submit it to the miners:
  descriptors.signers.signBIP32({ psbt, masterNode });
  legacyInputFinalizer({ psbt });
  const spendTx = psbt.extractTransaction();
  //When you try this, it won't be accepted (again), indeed.
  const spendTxPushResult = await (
    await fetch(`${EXPLORER}/api/tx`, { method: 'POST', body: spendTx.toHex() })
  ).text();

  console.log({ tx: spendTx.toHex(), spendTxPushResult });
  console.log(`Tx pushed:`, { url: `${EXPLORER}/tx/${spendTx.getId()}` });
})();
