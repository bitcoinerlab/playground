# BitcoinerLab Playground

This repository contains a set of Playgrounds that serve as the foundation for the guides on the [BitcoinerLab Site](https://bitcoinerlab.com/guides).

You can either run the code on a sandboxed playground or locally by installing it.

**Note**: The code shown in these guides is in TypeScript, but a transpiled JavaScript version is automatically generated when building the sources.

## Running the Code on a Playground

To run the code in a playground, [visit the respective guide](https://bitcoinerlab.com/guides) and click the **SHOW PLAYGROUND** button.

All the guides provide thorough explanations of how the code works.

## Running Locally

If you prefer to run the code locally, clone and run the [BitcoinerLab Playground repository](https://github.com/bitcoinerlab/playground) on your local machine.

For example:

```bash
git clone https://github.com/bitcoinerlab/playground.git
cd playground
npm install
npm run descriptors/legacy2segwit
```

This will execute the code in `./descriptors/legacy2segwit/index.ts` and output the results.

### Implementation notes

- The playground code follows the `bitcoinjs-lib` v7 stack, so transaction and PSBT values are handled as `bigint`.
- Miniscript policy compilation is done via `@bitcoinerlab/miniscript-policies`.
- When deriving BIP44/BIP86 coin type from a `Network`, avoid object-reference checks and use field-based mainnet detection.

## Available Playgrounds

Below is the full list of playgrounds included in this repository, with links to their corresponding guides on the BitcoinerLab site.

### `descriptors/legacy2segwit`

**Guide**: [https://bitcoinerlab.com/guides/standard-transactions](https://bitcoinerlab.com/guides/standard-transactions)

Learn how to build standard Bitcoin transactions and migrate funds from Legacy to SegWit addresses using BitcoinerLab libraries.

```bash
npm run descriptors/legacy2segwit
```

### `descriptors/miniscript`

**Guide**: [https://bitcoinerlab.com/guides/miniscript-vault](https://bitcoinerlab.com/guides/miniscript-vault)

Learn how to build a vault using Miniscript with a timelock and an emergency escape path.
Learn how Miniscript descriptors work and how to build and compile policies.

```bash
npm run descriptors/miniscript
```

### `descriptors/ledger`

**Guide**: [https://bitcoinerlab.com/guides/ledger-programming](https://bitcoinerlab.com/guides/ledger-programming)

Learn how to sign transactions with Ledger hardware devices using BitcoinerLab Ledger helpers.
Covers transport selection (WebHID / NodeHID), derivation policies and multi-input signing flows.

```bash
npm run descriptors/ledger
```

### `descriptors/multisig-fallback-timelock`

**Guide**: [https://bitcoinerlab.com/guides/multisig-fallback-timelock](https://bitcoinerlab.com/guides/multisig-fallback-timelock)

Create a multisig with a time-delayed fallback path using Miniscript.
Useful for inheritance, recovery-wallet setups and collaborative custody.

```bash
npm run descriptors/multisig-fallback-timelock
```

### `descriptors/p2a`

**Guide**: [https://bitcoinerlab.com/guides/p2a](https://bitcoinerlab.com/guides/p2a)

Learn how to construct a **P2A (Pay-to-Anchor)** output and how these outputs are used as the anchor for **TRUC fee-bumping transactions**.

```bash
npm run descriptors/p2a
```

### `descriptors/inscriptions`

Learn how Taproot inscriptions can be built and signed as a stand-alone playground.

```bash
npm run descriptors/inscriptions
```

### `descriptors/rewind2`

**Guide**: [https://bitcoinerlab.com/guides/rewind2](https://bitcoinerlab.com/guides/rewind2)

Explore Rewind v2 vault flows, 0-fee TRUC trigger/panic with P2A fee bumping, and on-chain backup strategies (OP_RETURN/TRUC, v2, and inscriptions).

```bash
npm run descriptors/rewind2
```

## License

MIT License
(c) 2025 Jose-Luis Landabaso — [https://bitcoinerlab.com](https://bitcoinerlab.com)
