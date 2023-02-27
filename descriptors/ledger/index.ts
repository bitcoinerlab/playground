import * as secp256k1 from '@bitcoinerlab/secp256k1';
import * as descriptors from '@bitcoinerlab/descriptors';
import { compilePolicy } from '@bitcoinerlab/miniscript';
import { /*Psbt,*/ networks } from 'bitcoinjs-lib';
import { mnemonicToSeedSync } from 'bip39';
// @ts-ignore
import { encode as olderEncode } from 'bip68';

const { Descriptor, BIP32 } = descriptors.DescriptorsFactory(secp256k1);

const network = networks.testnet;
const ledgerState = {};
//const UTXO_VALUE = 1e4;
//const FEE = 1000;
const BLOCKS = 5;
const OLDER = olderEncode({ blocks: BLOCKS });
//const PREIMAGE =
//  '107661134f21fc7c02223d50ab9eb3600bc3ffc3712423a1e47bb1f9a9dbf55f';
const DIGEST =
  '6c60f404f8167a38fc70eaf8aa17ac351023bef86bcb9d1086a19afe95bd5333';

const POLICY = `\
and(and(and(pk(@ledger),pk(@soft)),older(${OLDER})),sha256(${DIGEST}))`;

const WSH_ORIGIN_PATH = `/69420'/1'/0'`; //This could be any random path.

const SOFT_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon about';
const masterNode = BIP32.fromSeed(mnemonicToSeedSync(SOFT_MNEMONIC), network);

const start = async () => {
  let Transport = await (typeof document !== 'undefined'
    ? import('@ledgerhq/hw-transport-webhid')
    : import('@ledgerhq/hw-transport-node-hid'));
  while (Transport.default) Transport = Transport.default as any;
  let transport;
  try {
    //@ts-ignore
    transport = await Transport.create();
    console.log(`Ledger successfully connected`);
  } catch (err) {
    throw new Error(`Error: Ledger device not detected`);
  }
  //Throw if not running Bitcoin Test >= 2.1.0
  await descriptors.ledger.assertLedgerApp({
    transport,
    name: 'Bitcoin Test',
    minVersion: '2.1.0'
  });
  const ledgerClient = new descriptors.ledger.AppClient(transport);

  const pkhExpression = await descriptors.scriptExpressions.pkhLedger({
    ledgerClient,
    ledgerState,
    network,
    account: 0,
    change: 0,
    index: 0
  });
  const pkhDescriptor = new Descriptor({ expression: pkhExpression, network });

  const ledgerKeyExpression = await descriptors.keyExpressionLedger({
    ledgerClient,
    ledgerState,
    originPath: WSH_ORIGIN_PATH,
    change: 0,
    index: 0
  });
  const softKeyExpression = descriptors.keyExpressionBIP32({
    masterNode,
    originPath: WSH_ORIGIN_PATH,
    change: 0,
    index: 0
  });
  const { miniscript, issane } = compilePolicy(POLICY);
  if (!issane) throw new Error(`Error: miniscript not sane`);
  const wshExpression = `wsh(${miniscript
    .replace('@ledger', ledgerKeyExpression)
    .replace('@soft', softKeyExpression)})`;
  const wshDescriptor = new Descriptor({ expression: wshExpression, network });

  console.log(
    `Fund ${pkhDescriptor.getAddress()} and ${wshDescriptor.getAddress()}`
  );
};

if (typeof document !== 'undefined') {
  document.body.innerHTML = `Connect your Ledger, open Bitcoin Test 2.1 App and:  
<a href="#" id="start">Click to start</a>`;
  document.getElementById('start')!.addEventListener('click', start);
} else start();

/*


//Create the psbt that will spend the pkh and wsh outputs and send funds to FINAL_ADDRESS:

//Build the miniscript-based descriptor.
//POLICY will be: 'and(and(and(pk(@ledger),pk(@soft)),older(5)),sha256(6c60f404f8167a38fc70eaf8aa17ac351023bef86bcb9d1086a19afe95bd5333))'
//and miniscript: 'and_v(v:sha256(6c60f404f8167a38fc70eaf8aa17ac351023bef86bcb9d1086a19afe95bd5333),and_v(and_v(v:pk(@ledger),v:pk(@soft)),older(5)))'
const { miniscript, issane }: { miniscript: string; issane: boolean } =
  compilePolicy(POLICY);
if (!issane) throw new Error(`Error: miniscript not sane`);

let txHex: string;
let txId: string;
let vout: number;
let inputIndex: number;
//In this array, we will keep track of the descriptors of each input:
const psbtInputDescriptors: DescriptorInterface[] = [];

(async () => {
  let transport;
  try {
    transport = await Transport.create(3000, 3000);
  } catch (err) {
    throw new Error(`Error: Ledger device not detected`);
  }
  //Throw if not running Bitcoin Test >= 2.1.0
  await assertLedgerApp({
    transport,
    name: 'Bitcoin Test',
    minVersion: '2.1.0'
  });

  const ledgerClient = new AppClient(transport);
  //The Ledger is stateless. We keep state externally (keeps track of masterFingerprint, xpubs, wallet policies, ...)
  const ledgerState: LedgerState = {};

  //Let's create the utxos. First create a descriptor expression using a Ledger.
  //pkhExternalExpression will be something like this:
  //pkh([1597be92/44'/1'/0']tpubDCxfn3TkomFUmqNzKq5AEDS6VHA7RupajLi38JkahFrNeX3oBGp2C7SVWi5a1kr69M8GpeqnGkgGLdja5m5Xbe7E87PEwR5kM2PWKcSZMoE/0/0)
  const pkhExternalExpression: string = await pkhLedger({
    ledgerClient,
    ledgerState,
    network: NETWORK,
    account: 0,
    change: 0,
    index: 0
  });
  const pkhExternalDescriptor = new Descriptor({
    network: NETWORK,
    expression: pkhExternalExpression
  });
  //Fund this utxo. regtestUtils communicates with the regtest node manager on port 8080.
  ({ txId, vout } = await regtestUtils.faucet(
    pkhExternalDescriptor.getAddress(),
    UTXO_VALUE
  ));
  //Retrieve the tx from the mempool:
  txHex = (await regtestUtils.fetch(txId)).txHex;
  //Now add an input to the psbt. updatePsbt would also update timelock if needed (not in this case).
  inputIndex = pkhExternalDescriptor.updatePsbt({ psbt, txHex, vout });
  //Save the descriptor for later, indexed by its psbt input number.
  psbtInputDescriptors[inputIndex] = pkhExternalDescriptor;

  //Repeat the same for another pkh change address:
  const pkhChangeExpression = await pkhLedger({
    ledgerClient,
    ledgerState,
    network: NETWORK,
    account: 0,
    change: 1,
    index: 0
  });
  const pkhChangeDescriptor = new Descriptor({
    network: NETWORK,
    expression: pkhChangeExpression
  });
  ({ txId, vout } = await regtestUtils.faucet(
    pkhChangeDescriptor.getAddress(),
    UTXO_VALUE
  ));
  txHex = (await regtestUtils.fetch(txId)).txHex;
  inputIndex = pkhChangeDescriptor.updatePsbt({ psbt, txHex, vout });
  psbtInputDescriptors[inputIndex] = pkhChangeDescriptor;

  //Here we create the BIP32 software wallet that will be used to co-sign the 3rd utxo of this test:
  const masterNode = BIP32.fromSeed(mnemonicToSeedSync(SOFT_MNEMONIC), NETWORK);

  //Let's prepare the wsh utxo. First create the Ledger and Soft key expressions
  //that will be used to co-sign the wsh output.
  //First, create a ranged key expression (index: '*') using the software wallet
  //on the WSH_ORIGIN_PATH origin path.
  //We could have also created a non-ranged key expression by providing a number
  //to index.
  //softKeyExpression will be something like this:
  //[73c5da0a/69420'/1'/0']tpubDDB5ZuMuWmdzs7r4h58fwZQ1eYJvziXaLMiAfHYrAev3jFrfLtsYsu7Cp1hji8KcG9z9CcvHe1FfkvpsjbvMd2JTLwFkwXQCYjTZKGy8jWg/0/*
  const softKeyExpression: string = keyExpressionBIP32({
    masterNode,
    originPath: WSH_ORIGIN_PATH,
    change: 0,
    index: '*'
  });
  //Create the equivalent ranged key expression using the Ledger wallet.
  //ledgerKeyExpression will be something like this:
  //[1597be92/69420'/1'/0']tpubDCNNkdMMfhdsCFf1uufBVvHeHSEAEMiXydCvxuZKgM2NS3NcRCUP7dxihYVTbyu1H87pWakBynbYugEQcCbpR66xyNRVQRzr1TcTqqsWJsK/0/*
  //Since WSH_ORIGIN_PATH is a non-standard path, the Ledger will warn the user about this.
  const ledgerKeyExpression: string = await keyExpressionLedger({
    ledgerClient,
    ledgerState,
    originPath: WSH_ORIGIN_PATH,
    change: 0,
    index: '*'
  });

  //Now, we prepare the ranged miniscript descriptor expression for external addresses (change = 0).
  //expression will be something like this:
  //wsh(and_v(v:sha256(6c60f404f8167a38fc70eaf8aa17ac351023bef86bcb9d1086a19afe95bd5333),and_v(and_v(v:pk([1597be92/69420'/1'/0']tpubDCNNkdMMfhdsCFf1uufBVvHeHSEAEMiXydCvxuZKgM2NS3NcRCUP7dxihYVTbyu1H87pWakBynbYugEQcCbpR66xyNRVQRzr1TcTqqsWJsK/0/*),v:pk([73c5da0a/69420'/1'/0']tpubDDB5ZuMuWmdzs7r4h58fwZQ1eYJvziXaLMiAfHYrAev3jFrfLtsYsu7Cp1hji8KcG9z9CcvHe1FfkvpsjbvMd2JTLwFkwXQCYjTZKGy8jWg/0/*)),older(5))))
  const expression = `wsh(${miniscript
    .replace('@ledger', ledgerKeyExpression)
    .replace('@soft', softKeyExpression)})`;
  //Get the descriptor for index WSH_RECEIVE_INDEX. Here we need to pass the index because
  //we used range key expressions above. `index` is only necessary when using range expressions.
  //We also pass the PREIMAGE so that miniscriptDescriptor will be able to finalize the tx later (creating the scriptWitness)
  const miniscriptDescriptor = new Descriptor({
    expression,
    index: WSH_RECEIVE_INDEX,
    preimages: [{ digest: `sha256(${DIGEST})`, preimage: PREIMAGE }],
    network: NETWORK
  });
  //We can now fund the wsh utxo:
  ({ txId, vout } = await regtestUtils.faucet(
    miniscriptDescriptor.getAddress(),
    UTXO_VALUE
  ));
  txHex = (await regtestUtils.fetch(txId)).txHex;

  //Now add a the input to the psbt (including bip32 derivation info & sequence) and
  //set the tx timelock, if needed.
  //In this case the timelock won't be set since this is a relative-timelock
  //script (it will set the sequence in the input)
  inputIndex = miniscriptDescriptor.updatePsbt({ psbt, txHex, vout });
  //Save the descriptor, indexed by input index, for later:
  psbtInputDescriptors[inputIndex] = miniscriptDescriptor;

  //Now add an ouput. This is where we'll send the funds. We'll send them to
  //some random address that we don't care about in this test.
  psbt.addOutput({ address: FINAL_ADDRESS, value: UTXO_VALUE * 3 - FEE });

  //=============
  //Register Ledger policies of non-standard descriptors.
  //Registration is stored in ledgerState and is a necessary step before
  //signing with non-standard policies when using a Ledger wallet.
  //registerLedgerWallet internally takes all the necessary steps to register
  //the generalized Ledger format: a policy template finished with /** and its keyRoots.
  //So, even though this wallet policy is created using a descriptor representing
  //an external address, the policy will be used interchangeably with internal
  //and external addresses.
  await registerLedgerWallet({
    ledgerClient,
    ledgerState,
    descriptor: miniscriptDescriptor,
    policyName: 'BitcoinerLab'
  });

  //=============
  //Sign the psbt with the Ledger. The relevant wallet policy is automatically
  //retrieved from state by parsing the descriptors of each input and retrieving
  //the wallet policy that can sign it. Also a Default Policy is automatically
  //constructed when the input is of BIP 44, 49, 84 or 86 type.
  await signLedger({
    ledgerClient,
    ledgerState,
    psbt,
    descriptors: psbtInputDescriptors
  });
  //Now sign the PSBT with the BIP32 node (the software wallet)
  signBIP32({ psbt, masterNode });

  //=============
  //Finalize the psbt:
  //descriptors must be indexed wrt its psbt input number.
  //finalizePsbt uses the miniscript satisfier from @bitcoinerlab/miniscript to
  //create the scriptWitness among other things.
  finalizePsbt({ psbt, descriptors: psbtInputDescriptors });

  //Since the miniscript uses a relative-timelock, we need to mine BLOCKS before
  //broadcasting the tx so that it can be accepted by the network
  await regtestUtils.mine(BLOCKS);
  //Broadcast the tx:
  const spendTx = psbt.extractTransaction();
  const resultSpend = await regtestUtils.broadcast(spendTx.toHex());
  //Mine it
  await regtestUtils.mine(1);
  //Verify that the tx was accepted. This will throw if not ok:
  await regtestUtils.verify({
    txId: spendTx.getId(),
    address: FINAL_ADDRESS,
    vout: 0,
    value: UTXO_VALUE * 3 - FEE
  });

  console.log({
    result: resultSpend === null ? 'success' : resultSpend,
    psbt: psbt.toBase64(),
    tx: spendTx.toHex()
  });
})();
*/
