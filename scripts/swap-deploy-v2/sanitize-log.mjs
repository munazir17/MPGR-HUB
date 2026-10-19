// Avoid putting a private RPC URL in persisted proof artifacts or PR comments.
let data=''; for await (const chunk of process.stdin) data+=chunk;
process.stdout.write(process.env.BASE_MAINNET_RPC_URL ? data.replaceAll(process.env.BASE_MAINNET_RPC_URL,'[BASE_RPC]') : data);
