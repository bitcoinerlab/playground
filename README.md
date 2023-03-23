# BitcoinerLab Playground

This repository contains a set of Playgrounds that serve as the foundation for the guides on the [BitcoinerLab Site](https://bitcoinerlab.com/guides).

You can either run the code on a sandboxed playground or locally by installing it.

## Running the Code on a Playground

To run the code in a playground, [visit the respective guide](https://bitcoinerlab.com/guides) and click the **SHOW PLAYGROUND** button.

Guides provide thorough explanations of how the code works.


## Running Locally

If you prefer to run the code locally, clone and run the [BitcoinerLab Playground repository](https://github.com/bitcoinerlab/playground) in your local machine.


For example:

```bash
git clone https://github.com/bitcoinerlab/playground.git
cd playground
npm install
npm run build
npm run descriptors/legacy2segwit
```

This will execute the code in `./descriptors/legacy2segwit/index.ts` and output the results.

The following guides are available:

- `descriptors/legacy2segwit`: Learn how to use the @bitcoinerlab set of libraries to program standard transactions.
- `descriptors/miniscript`: Learn how to use the @bitcoinerlab set of libraries to create a Timelocked Vault with an emergency escape path.
- `descriptors/ledger`: Learn how to use @bitcoinerlab to create transactions and sign them with Ledger devices
