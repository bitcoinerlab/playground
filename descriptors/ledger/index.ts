import * as secp256k1 from '@bitcoinerlab/secp256k1';
import * as descriptors from '@bitcoinerlab/descriptors';
import { compilePolicy } from '@bitcoinerlab/miniscript';
import { Psbt, networks } from 'bitcoinjs-lib';
import { mnemonicToSeedSync } from 'bip39';
// @ts-ignore
import { encode as olderEncode } from 'bip68';
const { Descriptor, BIP32 } = descriptors.DescriptorsFactory(secp256k1);

const network = networks.testnet;
const EXPLORER = 'https://blockstream.info/testnet';
const isWeb = typeof window !== 'undefined';
const Log = (message: string) => {
  const logsElement = isWeb && document.getElementById('logs');
  if (logsElement) {
    logsElement.innerHTML += `<p>${message}</p>`;
    logsElement.scrollTop = logsElement.scrollHeight;
  }
  console.log(message.replace(/<[^>]*>?/gm, '')); //strip html tags
};

//Ledger is stateless. We store state in localStorage. Deserialize it if found:
const ledgerStorage = isWeb && localStorage.getItem('ledger');
const ledgerState = ledgerStorage
  ? JSON.parse(ledgerStorage, (_key, value) =>
      value instanceof Object && value.type === 'Buffer'
        ? new Buffer(value.data)
        : value
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
const WSH_KEY_PATH = `/0/0`; //Same as above.

const SOFT_MNEMONIC = `abandon abandon abandon abandon abandon abandon abandon \
abandon abandon abandon abandon about`;
const masterNode = BIP32.fromSeed(mnemonicToSeedSync(SOFT_MNEMONIC), network);

let transport: any = null;
const start = async () => {
  if (!transport) {
    let Transport = await import(
      `@ledgerhq/hw-transport-${isWeb ? 'web' : 'node-'}hid`
    );
    //This while is to make it work both with typescript & compiled javascript
    while (Transport.default) Transport = Transport.default as any;
    try {
      transport = await Transport.create();
    } catch (err) {
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
    await transport.close();
    transport = null;
    Log(`Open the Bitcoin Test App, version >= 2.1.0 and \
<a href="javascript:start();">try again</a>.`);
    return;
  }
  Log(`Ledger successfully connected.`);
  const ledgerClient = new descriptors.ledger.AppClient(transport);

  const wpkhDescriptor = new Descriptor({
    expression: await descriptors.scriptExpressions.wpkhLedger({
      ledgerClient,
      ledgerState,
      network,
      account: 0,
      change: 0,
      index: 0
    }),
    network
  });
  const wpkhAddress = wpkhDescriptor.getAddress();

  //Now let's prepare the wsh utxo:
  const { miniscript, issane } = compilePolicy(POLICY);
  if (!issane) throw new Error(`Error: miniscript not sane`);
  const ledgerKeyExpression = await descriptors.keyExpressionLedger({
    ledgerClient,
    ledgerState,
    originPath: WSH_ORIGIN_PATH,
    keyPath: WSH_KEY_PATH
  });
  const softKeyExpression = descriptors.keyExpressionBIP32({
    masterNode,
    originPath: WSH_ORIGIN_PATH,
    keyPath: WSH_KEY_PATH
  });
  const wshExpression = `wsh(${miniscript
    .replace('@ledger', ledgerKeyExpression)
    .replace('@soft', softKeyExpression)})`;
  const wshDescriptor = new Descriptor({
    expression: wshExpression,
    network,
    preimages: [{ digest: `sha256(${DIGEST})`, preimage: PREIMAGE }]
  });
  const wshAddress = wshDescriptor.getAddress();

  //Now spend it:
  const psbt = new Psbt({ network });
  const psbtInputDescriptors: descriptors.DescriptorInterface[] = [];
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
    inputValue += wpkhUtxo[0].value;
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

    //Register Ledger policies of non-standard descriptors. Auto-skips if exists
    await descriptors.ledger.registerLedgerWallet({
      ledgerClient,
      ledgerState,
      descriptor: wshDescriptor,
      policyName: 'BitcoinerLab'
    });
    await descriptors.signers.signLedger({
      ledgerClient,
      ledgerState,
      psbt,
      descriptors: psbtInputDescriptors
    });
    //Now sign the PSBT with the BIP32 node (the software wallet)
    descriptors.signers.signBIP32({ psbt, masterNode });

    //Finalize the tx and submit it to the blockchain
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
    if (spendTxPushResult.match('non-BIP68-final')) {
      //You may get non-bip68 final now. You need to wait 5 blocks
      Log(`You still need to wait for a few more blocks (up to ${BLOCKS}).`);
      Log(`<a href="javascript:start();">Try again in a few blocks!</a>`);
    } else {
      const txId = spendTx.getId();
      Log(`SUCCESS! <a href="${EXPLORER}/tx/${txId}">Check the result.</a>`);
    }
  } else {
    Log(`Not yet! Use https://bitcoinfaucet.uo1.net to get some sats:`);
    Log(`${wpkhAddress}: ${wpkhUtxo?.[0] ? 'Funded!' : 'NOT funded'}`);
    Log(`${wshAddress}: ${wshUtxo?.[0] ? 'Funded!' : 'NOT funded'}`);
    Log(`Fund them and <a href="javascript:start();">check again</a>.`);
  }
  //Save to localStorage
  if (isWeb) localStorage.setItem('ledger', JSON.stringify(ledgerState));
};
if (isWeb) (window as any).start = start;

if (isWeb) {
  document.body.innerHTML = `<div id="logs">Connect a Ledger, open Bitcoin Test\
 2.1 App and <a href="javascript:start();" id="start">Click to start</a></div>`;
} else start();
