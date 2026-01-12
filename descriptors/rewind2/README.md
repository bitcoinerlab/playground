# Rewind 2 Architecture

## Design Decision: OP_RETURN vs. Inscriptions

Rewind 2 utilizes `OP_RETURN` for storing backup data, prioritizing transaction reliability and atomicity over economic optimization (which might favor Inscriptions).

### Motivation: Atomicity

The primary goal is to ensure the **Vault Transaction** and the **Backup Transaction** are mined atomically. We must avoid a scenario where a Vault is created (funds locked) but the Backup fails to confirm, which would lead to a loss of data required to recover the funds.

To achieve this, the Vault and Backup transactions should ideally be submitted and mined as a package.

### Constraint: Bitcoin Core Package Relay Limits

To support package relay and potentially utilize TRUC (Topologically Restricted Until Confirmation) v3 transactions, we must adhere to Bitcoin Core's package limits.

#### Package Relay + TRUC Summary

Package policy details important to our case:

- Package RBF replacement is limited to 1-parent-1-child; parent must spend confirmed outputs.
- Each tx is validated individually first (v2 vs v3 rules differ; see below).
- Not all-or-nothing: partial acceptance is possible; mining isn't atomic.

What's different (TRUC vs non-TRUC):

- v3 (TRUC): parent can be 0-fee and has extra relay rules (only v3 can spend unconfirmed v3.
- v2 (non-TRUC): must meet standard static minrelay fee. A 0-fee v2 parent is rejected even in a package.

### Analysis

#### The Inscription Approach (Rejected)

Using Inscriptions for backups requires two transactions:

1.  **Commit Transaction**
2.  **Reveal Transaction**

If the Vault pays for the Backup (to ensure linkage/atomicity), the dependency chain becomes:
`Vault Tx` → `Commit Tx` → `Reveal Tx`

This results in a chain of **3 transactions**. This exceeds standard package relay limits for unconfirmed transaction chains (often limited to 2 for TRUC/V3 or specific package submission rules).

#### The OP_RETURN Approach (Selected)

Using `OP_RETURN` allows the backup to be contained within a single transaction (or potentially the Vault transaction itself). If implemented as a separate child transaction paid for by the Vault:
`Vault Tx` → `Backup Tx (OP_RETURN)`

Why the backup must be a descendant of the vault:

- The backup payload includes the trigger + panic transactions, which can only be constructed after the vault exists.
- In the minimal-funds case (e.g., only one UTXO), the vault must fund the backup output because there may be no other inputs available.

This results in a chain of **2 transactions**. This fits comfortably within package relay limits, allowing the Vault and Backup to be propagated and mined together reliably.

### Transaction Flow Diagram

```mermaid
flowchart LR
    U1[Prev Tx1]
    U2[Prev Tx2]
    U3[Prev Tx3]

    %% Package
    subgraph Package
        direction TB
        V[Vault Tx]
        B[Backup Tx]
    end

    T[Trigger Tx]
    C[Change UTXO]

    %% Fork node
    F(( ))
    style F fill:transparent,stroke:transparent

    %% UTXO N as borderless box
    UTXON[Becomes an UTXO after timelock]
    style UTXON fill:transparent,stroke:transparent

    %% Inputs
    U1 --> V
    U2 --> V
    U3 --> V

    %% Vault outputs
    V --> B
    V --> T
    V --> C
    style C fill:transparent,stroke:transparent

    %% Trigger Tx outputs
    T --> F
    T --> A_T[P2A]
    style A_T fill:transparent,stroke:transparent

    %% Forked outputs
    F --> P[Panic Tx<br/>*can be pushed before timelock*]
    F --> UTXON

    %% Panic Tx outputs
    P --> E[Emergency UTXO]
    style E fill:transparent,stroke:transparent
    P --> A_P[P2A]
    style A_P fill:transparent,stroke:transparent
```

## Vault Output Ordering

The **Vault Transaction** uses a deterministic output ordering so the wallet can
always identify vaults and enumerate how many exist.

- **Output 0**: The output that feeds the **Trigger Transaction**.
- **Output 1**: A deterministic "vault marker" output used to fund the
  **Backup Transaction**.

Each vault uses a unique index derived from the wallet seed. The marker output
is sent to a pubkey derived from the path `m/1073'/<network>'/0'/<index>`, where
`<network>` is `0` for mainnet and `1` for test networks, and `<index>` starts at
0 and increments for each new vault.

To create a new vault, the wallet scans these indices, detects which ones are
already used, and selects the next unused index. This lets the wallet discover
and count all vaults just by checking which deterministic vault paths have been
used, without any extra metadata.
