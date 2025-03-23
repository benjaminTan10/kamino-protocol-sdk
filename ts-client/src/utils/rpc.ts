import {
  AccountInfo,
  Commitment,
  Connection,
  GetProgramAccountsConfig,
  GetProgramAccountsResponse,
  PublicKey,
  SolanaJSONRPCError,
} from '@solana/web3.js';
import { Buffer } from 'buffer';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { ZSTDDecoder } from 'zstddec';

const decoder = new ZSTDDecoder();
(async () => {
  await decoder.init();
})();

/**
 * Uses zstd compression when fetching all accounts owned by a program for a smaller response size
 * Uses axios instead of node-fetch to work around a bug in node-fetch that causes subsequent requests with different encoding to fail
 * @param connection
 * @param programId
 * @param structSize - the size of the decompressed account data struct
 * @param configOrCommitment
 */
export async function getProgramAccounts(
  connection: Connection,
  programId: PublicKey,
  structSize: number,
  configOrCommitment?: GetProgramAccountsConfig | Commitment
): Promise<GetProgramAccountsResponse> {
  const programIdStr = programId.toBase58();
  const { commitment, config } = extractCommitmentFromConfig(configOrCommitment);
  const { encoding: _encoding, ...configWithoutEncoding } = config || {};
  // Use axios here to work around a bug in node fetch that causes subsequent requests with different encoding to fail
  // https://github.com/node-fetch/node-fetch/issues/1767
  const response = await axios.post(
    connection.rpcEndpoint,
    {
      method: 'getProgramAccounts',
      jsonrpc: '2.0',
      params: [
        programIdStr,
        {
          encoding: 'base64+zstd',
          commitment,
          ...configWithoutEncoding,
        },
      ],
      id: uuidv4(),
    },
    {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Cache-Control': 'no-cache',
      },
    }
  );

  const unsafeRes = response.data;
  if ('error' in unsafeRes) {
    throw new SolanaJSONRPCError(unsafeRes.error, `Failed to get accounts owned by program: ${[programIdStr]}`);
  }

  const res = unsafeRes as RpcResult;
  const deser = res.result.map(async (account) => ({
    account: await deserializeAccountInfo(account.account, structSize),
    pubkey: new PublicKey(account.pubkey),
  }));
  const x = await Promise.all(deser);
  return x as GetProgramAccountsResponse;
}

export async function getAccountOwner(connection: Connection, address: PublicKey): Promise<PublicKey> {
  const acc = await connection.getAccountInfo(address);
  if (acc == null) {
    throw Error(`Could not fetch mint ${address.toString()}`);
  }
  return acc.owner;
}

async function deserializeAccountInfo(accountInfo: AccountInfo<string[]>, size: number): Promise<AccountInfo<Buffer>> {
  const data = decoder.decode(Buffer.from(accountInfo.data[0], 'base64'), size);
  return {
    owner: accountInfo.owner,
    lamports: accountInfo.lamports,
    executable: accountInfo.executable,
    rentEpoch: accountInfo.rentEpoch,
    data: Buffer.from(data),
  };
}

function extractCommitmentFromConfig<TConfig>(
  commitmentOrConfig?: Commitment | ({ commitment?: Commitment } & TConfig)
) {
  let commitment: Commitment | undefined;
  let config: Omit<TConfig, 'commitment'> | undefined;
  if (typeof commitmentOrConfig === 'string') {
    commitment = commitmentOrConfig;
  } else if (commitmentOrConfig) {
    const { commitment: specifiedCommitment, ...specifiedConfig } = commitmentOrConfig;
    commitment = specifiedCommitment;
    config = specifiedConfig;
  }
  return { commitment, config };
}

interface RpcResult {
  jsonrpc: string;
  result: Result;
}

export type Result = readonly Readonly<{
  account: AccountInfo<string[]>;
  /** the account Pubkey as base-58 encoded string */
  pubkey: string;
}>[];
