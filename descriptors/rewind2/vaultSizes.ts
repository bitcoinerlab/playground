// @ts-ignore
import { encodingLength as pushdataEncodingLength } from 'pushdata-bitcoin';
import { encodingLength } from 'varuint-bitcoin';

const textEncoder = new TextEncoder();

const uniqueSorted = (values: number[]) =>
  values
    .filter((value, index, array) => array.indexOf(value) === index)
    .sort((a, b) => a - b);

export const INSCRIPTION_CONTENT_TYPE = 'application/vnd.rewindbitcoin';
const INSCRIPTION_CONTENT_TYPE_BYTES = textEncoder.encode(
  INSCRIPTION_CONTENT_TYPE
).length;
const INSCRIPTION_PROTOCOL_ID_BYTES = textEncoder.encode('ord').length;

// https://github.com/bitcoin/bitcoin/blob/22bde74d1d8f861323eabb8dc60401bbf1226544/src/policy/policy.h#L36
const MIN_STANDARD_TX_NONWITNESS_SIZE = 65;

const opReturnScriptBytes = (payloadBytes: number) =>
  1 + pushdataEncodingLength(payloadBytes) + payloadBytes;

const opReturnOutputBytes = (payloadBytes: number) => {
  const scriptBytes = opReturnScriptBytes(payloadBytes);
  // output value (sats) = fixed 8-byte value.
  return scriptBytes + 8 + encodingLength(scriptBytes);
};

const REVEAL_STRIPPED_BASE_BYTES =
  4 + // version
  1 + // input count
  41 + // input (prevout 36 + scriptLen 1 + sequence 4)
  encodingLength(1) + // output count (1 output)
  4; // locktime

// Minimum OP_RETURN payload that clears standard min-size policy.
export const INSCRIPTION_REVEAL_GARBAGE_BYTES = (() => {
  const minStandardStrippedBytes = MIN_STANDARD_TX_NONWITNESS_SIZE;
  for (let payloadBytes = 0; ; payloadBytes += 1) {
    const strippedBytes =
      REVEAL_STRIPPED_BASE_BYTES + opReturnOutputBytes(payloadBytes);
    if (strippedBytes >= minStandardStrippedBytes) return payloadBytes;
  }
})();

const inscriptionTapscriptBytes = (contentBytes: number) => {
  const pushXOnly = pushdataEncodingLength(32) + 32;
  const pushProtocolId =
    pushdataEncodingLength(INSCRIPTION_PROTOCOL_ID_BYTES) +
    INSCRIPTION_PROTOCOL_ID_BYTES;
  const pushContentType =
    pushdataEncodingLength(INSCRIPTION_CONTENT_TYPE_BYTES) +
    INSCRIPTION_CONTENT_TYPE_BYTES;
  const pushContent = pushdataEncodingLength(contentBytes) + contentBytes;

  return (
    pushXOnly +
    1 + // OP_CHECKSIG
    1 + // OP_0
    1 + // OP_IF
    pushProtocolId +
    1 + // OP_1
    1 + // OP_1
    pushContentType +
    1 + // OP_0
    pushContent +
    1 // OP_ENDIF
  );
};

const inscriptionRevealWitnessBytes = (tapscriptBytes: number) =>
  2 + // marker/flag
  1 + // stack count
  66 + // signature
  encodingLength(tapscriptBytes) +
  tapscriptBytes +
  34; // control block

//////////////////////
// Trigger (134–135 vB):
// 1 P2WPKH input, 2 outputs (P2A + P2WSH).
// - Stripped size: 107 bytes
//   - Version (4) + vin (1) + input (41) + vout (1) + outputs (56) + locktime (4)
//   - Outputs = P2A (13) + P2WSH (43)
// - Witness size: 108–111 bytes
//   - Marker/flag 2
//   - Stack items: sig (70–73 bytes) + 1 len + pubkey (33 bytes) + 1 len + count (1)
// - Weight: 536–539 wu → vsize = 134–135 vB
//////////////////////
export const TRIGGER_TX_VBYTES = [134, 135];
const TRIGGER_TX_SERIALIZED_BYTES = [215, 216, 217, 218];

//////////////////////
// Panic (139–140 vB):
// 1 P2WSH input, 2 outputs (P2A + addr).
// - Stripped size: 95 bytes
//  - Version (4) + vin (1) + input (41) + vout (1) + outputs (44) + locktime (4)
//  - Outputs = P2A (13) + P2WPKH (31)
// - Witness size: 176–179 bytes
//  - Marker/flag 2
//  - Stack items: sig (70–73 bytes) + 1 len + pubkey (33 bytes) + 1 len + selector (1 byte) + 1 len + witnessScript (65 bytes) + 1 len + count (1)
// - Weight: 556–559 wu → vsize = 139–140 vB
//////////////////////
export const PANIC_TX_VBYTES = [139, 140];
const PANIC_TX_SERIALIZED_BYTES = [271, 272, 273, 274];

const VAULT_ENTRY_BYTES = uniqueSorted(
  TRIGGER_TX_SERIALIZED_BYTES.flatMap(triggerBytes =>
    PANIC_TX_SERIALIZED_BYTES.map(
      panicBytes =>
        1 + //The version: [Version][TriggerLen][Trigger][PanicLen][Panic]
        encodingLength(triggerBytes) +
        triggerBytes +
        encodingLength(panicBytes) +
        panicBytes
    )
  )
);
// "REW" = 3-byte, plus XChaCha20-Poly1305 nonce (24) and tag (16).
const ENCRYPTION_OVERHEAD_BYTES = 24 + 16;
const VAULT_CONTENT_BYTES = VAULT_ENTRY_BYTES.map(
  bytes => bytes + 3 + ENCRYPTION_OVERHEAD_BYTES
);
const P2WPKH_WITNESS_BYTES = [108, 109, 110, 111];

const OP_RETURN_SCRIPT_BYTES = VAULT_CONTENT_BYTES.map(opReturnScriptBytes);
// output value (sats) = fixed 8-byte value.
const OP_RETURN_OUTPUT_BYTES = OP_RETURN_SCRIPT_BYTES.map(
  scriptBytes => scriptBytes + 8 + encodingLength(scriptBytes)
);

//The +51 is the fixed stripped (non‑witness) overhead for a 1‑input,
//1‑output transaction excluding the output itself:
//- 4 bytes version
//- 1 byte input count
//- 41 bytes input (prevout 36 + scriptLen 1 + sequence 4)
//- 1 byte output count
//- 4 bytes locktime
const OP_RETURN_BACKUP_TX_STRIPPED_BYTES = OP_RETURN_OUTPUT_BYTES.map(
  bytes => bytes + 51
);
export const OP_RETURN_BACKUP_TX_VBYTES = uniqueSorted(
  OP_RETURN_BACKUP_TX_STRIPPED_BYTES.flatMap(strippedBytes =>
    P2WPKH_WITNESS_BYTES.map(witnessBytes =>
      Math.ceil((strippedBytes * 4 + witnessBytes) / 4)
    )
  )
);

const INSCRIPTION_REVEAL_SCRIPT_BYTES = VAULT_CONTENT_BYTES.map(
  inscriptionTapscriptBytes
);
const INSCRIPTION_REVEAL_WITNESS_BYTES = INSCRIPTION_REVEAL_SCRIPT_BYTES.map(
  inscriptionRevealWitnessBytes
);
const INSCRIPTION_REVEAL_STRIPPED_BYTES =
  REVEAL_STRIPPED_BASE_BYTES +
  opReturnOutputBytes(INSCRIPTION_REVEAL_GARBAGE_BYTES);

export const INSCRIPTION_REVEAL_BACKUP_TX_VBYTES = uniqueSorted(
  INSCRIPTION_REVEAL_WITNESS_BYTES.map(witnessBytes =>
    Math.ceil((INSCRIPTION_REVEAL_STRIPPED_BYTES * 4 + witnessBytes) / 4)
  )
);

// Commit tx vsize derivation (1 P2WPKH input → 1 P2TR output).
// 1) Stripped size (non‑witness):
//    - version: 4
//    - vin count: 1
//    - input: 41 (prevout 36 + scriptLen 1 + sequence 4)
//    - vout count: 1
//    - output (P2TR): 8 (value) + 1 (script len) + 34 (script) = 43
//    - locktime: 4
//    → stripped = 4 + 1 + 41 + 1 + 43 + 4 = 94 bytes
// 2) Witness size for P2WPKH input (including segwit marker/flag):
//    - marker/flag: 2
//    - stack count: 1
//    - sig: 70–73 + 1 len
//    - pubkey: 33 + 1 len
//    → witness = 108–111 bytes
// 3) Weight = stripped*4 + witness = 94*4 + 108–111 = 484–487 wu
// 4) vsize = ceil(weight / 4) = ceil(484–487 / 4) = 121–122 vB
export const INSCRIPTION_COMMIT_BACKUP_TX_VBYTES = [121, 122];

export const INSCRIPTION_BACKUP_TX_VBYTES = uniqueSorted(
  INSCRIPTION_COMMIT_BACKUP_TX_VBYTES.flatMap(commitVbytes =>
    INSCRIPTION_REVEAL_BACKUP_TX_VBYTES.map(
      revealVbytes => commitVbytes + revealVbytes
    )
  )
);
