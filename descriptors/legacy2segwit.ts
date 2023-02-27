import * as secp256k1 from '@bitcoinerlab/secp256k1';
import * as descriptors from '@bitcoinerlab/descriptors';
import { mnemonicToSeedSync } from 'bip39';
import { Psbt, networks } from 'bitcoinjs-lib';
const { pkhBIP32, wpkhBIP32 } = descriptors.scriptExpressions;
const { Descriptor, BIP32 } = descriptors.DescriptorsFactory(secp256k1);
const network = networks.testnet;
const FEE = 500;

//Let's create our software wallet with this mnemonic:
const MNEMONIC =
  'drum turtle globe inherit autumn flavor ' +
  'slice illness sniff distance carbon elder';
const masterNode = BIP32.fromSeed(mnemonicToSeedSync(MNEMONIC), network);

//Let's get the Legacy address where we know we have some initial money to play:
const descriptorLegacy = new Descriptor({
  expression: pkhBIP32({ masterNode, network, account: 0, keyPath: '/0/1' }),
  network
});
//See, we start with 1679037 sats in moovc1JqGrz4v6FA2U8ks8ZqjSwjv3yRKQ:
//https://tinyurl.com/mu82nmzw
const TXID = 'ee02b5a12c2f22e892bed376781fc9ed435f0d192a1b67ca47a7190804d8e868';
console.log(`We start with:`, { address: descriptorLegacy.getAddress(), TXID });

//Let's get the utxo info (txHex and vout) of the Legacy address.
const EXPLORER = 'https://blockstream.info/testnet';
const txHex = await (await fetch(`${EXPLORER}/api/tx/${TXID}/hex`)).text();
const txJson = (await (await fetch(`${EXPLORER}/api/tx/${TXID}`)).json()) as {
  vout: { scriptpubkey: string; value: number }[];
};
const txOuts = txJson.vout;
const vout = txOuts.findIndex(
  txOut =>
    txOut.scriptpubkey === descriptorLegacy.getScriptPubKey().toString('hex')
);
const initialValue = txOuts[vout]!.value; //1679037
console.log('This is the utxo to spend :', { txHex, vout, initialValue });

//Define the Segwit descriptor where we will move the sats above:
const descriptorSegwit = new Descriptor({
  expression: wpkhBIP32({ masterNode, network, account: 0, keyPath: '/1/0' }),
  network
});

//Let's create a transaction (Partially Signed Bitcoin Transaction) now:
const psbt = new Psbt({ network });
//Use the Legacy descriptor to update the transaction with the input info:
const legacyInputNumber = descriptorLegacy.updatePsbt({ psbt, vout, txHex });
//Now add our Segwit address as the new output & give some FEE to the miners
const finalValue = initialValue - FEE;
const finalAddress = descriptorSegwit.getAddress();
psbt.addOutput({ address: finalAddress, value: finalValue });
console.log('Move the funds to:', { finalAddress, finalValue });

//Sign the transaction, finalize it and submit it to the miners:
descriptors.signers.signBIP32({ psbt, masterNode });
descriptorLegacy.finalizePsbtInput({ psbt, index: legacyInputNumber });
const spendTx = psbt.extractTransaction();
//It won't be accepted (again) when you try, indeed.
const spendTxPushResult = await (
  await fetch('https://blockstream.info/testnet/api/tx', {
    method: 'POST',
    body: spendTx.toHex()
  })
).text();

console.log({ body: spendTx.toHex(), spendTxPushResult });
console.log(`Tx pushed:`, { url: `${EXPLORER}/tx/${spendTx.getId()}` });
