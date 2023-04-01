// Copyright (c) 2023 Jose-Luis Landabaso - https://bitcoinerlab.com
// Distributed under the MIT software license

//This is a solution to Lunaticoin challenge:
//https://twitter.com/lunaticoin/status/1642141720119853063

const FEE = 1000; //This should be enough
const MY_ADDRESS = '3FYsjXPy81f96odShrKQoAiLFVmt6Tjf4g'; //Put here your address
//This is the previous tx:
//https://blockstream.info/tx/1c4e43be5b6e503c7aba1a83ade6ae5a7408a5aeaf504ce7519caf681aa9398e?expand
//https://blockstream.info/api/tx/1c4e43be5b6e503c7aba1a83ade6ae5a7408a5aeaf504ce7519caf681aa9398e/hex
import * as secp256k1 from '@bitcoinerlab/secp256k1';
import * as descriptors from '@bitcoinerlab/descriptors';
import { compilePolicy } from '@bitcoinerlab/miniscript';
import { networks, Psbt } from 'bitcoinjs-lib';
import { mnemonicToSeedSync } from 'bip39';
const { Descriptor, BIP32 } = descriptors.DescriptorsFactory(secp256k1);

const network = networks.bitcoin;
const MNEMONIC =
  'winter task shrimp toast gas regular fan bundle dismiss crash violin inner';
const masterNode = BIP32.fromSeed(mnemonicToSeedSync(MNEMONIC), network);
const POLICY = `or(99@pk(panick),1@and(pk(unvault),older(10)))`;

const { miniscript } = compilePolicy(POLICY);
const finalMiniscript = miniscript
  .replace(
    'unvault',
    descriptors.keyExpressionBIP32({
      masterNode: masterNode,
      originPath: `/48'/0'/1'/2'`,
      keyPath: `/0/0`
    })
  )
  .replace(
    'panick',
    descriptors.keyExpressionBIP32({
      masterNode: masterNode,
      originPath: `/48'/0'/0'/2'`,
      keyPath: `/0/0`
    })
  );
const descriptor = new Descriptor({
  expression: `wsh(${finalMiniscript})`,
  signersPubKeys: [masterNode.derivePath(`m/48'/0'/0'/2'/0/0`).publicKey],
  network
});
console.log(`Let's create a Psbt that spends from: ${descriptor.getAddress()}`);
const psbt = new Psbt({ network });
descriptor.updatePsbt({
  psbt,
  txHex:
    '02000000000101c320e40e2495375461eaa9d19e522fe17bb2d5d605a3c5ee3b308a02c5001d780000000000feffffff0273111f02000000001600145193feffae91b55aee55790f8746d0cdd3e543d2a086010000000000220020a95633d613fd8e89c255e3e34e4c0d1ce401ac07026acefc3652816f60951e6202473044022029561fafd929cc71558e27e9c0bd4bf4bf0aecf2a43838f15ff5625b491fdb3e0220073e46f7dc7c49633992d6fc166c1c328fff6e778b7dd65721e3718d02bc2fe201210396c2490a9779545052c7a03b6e88823aa0f6122224c8cce2a211bcf293a6ac2800000000',
  vout: 1
});
psbt.addOutput({
  address: MY_ADDRESS,
  value: 100000 - FEE
});
descriptors.signers.signBIP32({ psbt, masterNode });
descriptor.finalizePsbtInput({ index: 0, psbt });
const spendTx = psbt.extractTransaction();
console.log('Paste text to: https://blockstream.info/tx/push', spendTx.toHex());
