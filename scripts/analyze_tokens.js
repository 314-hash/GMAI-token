import { ethers } from "ethers";
import fs from "fs";
import path from "path";

const RPC_URL = process.env.RPC_URL || "https://rpc.sidrachain.com";
const provider = new ethers.JsonRpcProvider(RPC_URL);

const FACTORY_ADDR = "0xCFE41fb5dA87916D84E7F22889087b4Ff7163cDE";
const ROUTER_ADDR = "0x35cAC72Db00e8dAC0e4f7F8A0F53D339E0cC23fb";
const WSDA_ADDR = "0xE4095a910209D7BE03B55D02F40d4554B1666182";

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)"
];
const factory = new ethers.Contract(FACTORY_ADDR, FACTORY_ABI, provider);

const rawInput = [
  "0xCFE41fb5dA87916D84E7F22889087b4Ff7163cDE",
  "0x35cAC72Db00e8dAC0e4f7F8A0F53D339E0cC23fb",
  "0xFB1267FB3b9BdbcE3a1C30A9B0A1454e14E81ACb",
  "0x6ee53D6218790f9A636914997B808C0F370305ee",
  "0x341C91030E46c5a178B815FB7F09E3aed6E2d4fa",
  "0xe183fec541DF53F6695230fA0b68CE8224389211",
  "0x0A453024CF058FE9430C8eE6062516f063bd2A4e",
  "0x0914BF761Af71F4A39DcE0E9ce71B7ed96c457E3",
  "0x526d91Cd3078433d4370e12A592996B87EE44567",
  "0xf25cE949ecC0CDDb9AA5C921BCe2036bDCB26D3c",
  "0x3A3dFbd0d6116f0D4ed26d1E2717c2c800aeeF58",
  "0x2cE9e7c168035D61cc3a3655949C147c063EeCc4",
  "0xa22fB6E8dE7c9Bd25B762676e5Ae858116E894F9",
  "0x2EcE60dAaC7d8A26C48e9161E6Bbe7106bfB9f05",
  "0x8341A6C6a084D5451Ba8b17b181DAcf113C86811",
  "0x9bA4035871119991fC7B420873345f9be92aF146",
  "0xDdf80B185B3fE5de80b35159E8496973B8e2dc8B",
  "0x9C9CC46ba9d4F7Bd90c0b46252962Fe3BFDC9ceE",
  "0x94a0827350eB9B513d3070719806138feA80026f",
  "0xE1a8FfD7280D5A278A9E8c6daFf6d391b59081B4",
  "0x8D4cAeb31c5ED58Ffd16345F5F1BFEc4e6FA1791",
  "0x60e55b05e56FE662d687fCCbC82e3F810D093084",
  "0x5162ac7E6BA188bBA91db039992A8C7e5dBc780d",
  "0x3Acd3c10d4C080ace3662153913833081684cBB8",
  "0xcA7965eEAa824362525D1BEA43450b425DaA5c6D",
  "0x9DBEbeC4B2A01Afe3A42D069aB07be9bf15e6746",
  "0x7FbFBC40AAaF885E2F5259093aD78e64B3d0F534",
  "0x983428b824D8462De6240bA19e790Bbf19703f33",
  "0x082A098Ad65354c243B04E880761C26E25CBbF72",
  "0x3dCEF48D84e9b9757E743F43a2F9D8cE0e033118",
  "0xAdD275d70B5133C4C5AF7343B138FdDC0Dc3411a",
  "0x9B61324f0beE10f4624FE6E75c60943b73125e81",
  "0x07046106bAaA7CBbEe8Aba60Ed0454dF374f857f",
  "0xF779943822CA0c9C8d5486aF78b9A001abc03b44",
  "0xf64E73D5884e3B1e1dfB746Da10784b85B0a1A71",
  "0xBCdA8739687C12EEc3206d8AEC80c32a3C545Ae9",
  "0x4E49C2C789CE0cFB32934B8ebe030425c973D6bc",
  "0x7e17671Cc36a62c80cAe98E1986c1e0A20bCe5b7",
  "0xef67c18431d943B3a05441805f95ECd02Ef6a204",
  "0x84Fb6Ad958a73a9e978C2bf00719b84D8b73304A",
  "0x6Ec4f5D382e2a4B4bFe498DD985CF564256d0B5C",
  "0x5c585f59dB18deF8C58315A030bD8d7493921573",
  "0x898Df005A844625C22d6bdf213612A458dd43a71",
  "0x828Df8009adD5279b9133c39955eE95bdCAAE476",
  "0xa9A40D3abF7072ae4c7D1909CF6Cd34168ae8259",
  "0x4b68FbA4080B60667D85a923E84B3214aed4b3A4",
  "0xa1647Ca9F4B8e564bD8351091A25425648d4a0C1",
  "0xfaeCbE5956a02e45Ee663922174F955ae78D0309",
  "0x6f93b12D320E2CaC5330b27b61c1665e01F72cbC",
  "0x8ebfC14A60FD6C249e038fa9fFCF05f39A87a17F",
  "0x5298ED19B27045E22058E1D58264c3D05958f457",
  "0xe787BfFC078A0231a038Be1Fb199B9c6FD1d511a",
  "0x10957d769b8B38Ba32f0236502193838E4480e16",
  "0x19Ce764Bb7F979B89c1c5D238Adc3cb0c40F2ff9",
  "0x9967f703888a2D6C6bd4E25DC6B51CBc410321Ee",
  "0x4cE5ef02F9aEbb80BB4e327F76DFb95eac1B69A6",
  "0x6685bBD1BB70a4f182458b745ee28425a68ad05f",
  "0x8add36cd5f8A877b66EF660380058fB20FB8EC60",
  "0x9B061c53f6e71ADb12e8F6AA75D1f218e6FA2E95",
  "0xF102009Cd862Fc714e01c46591c3DF10D097f7B9",
  "0x98fE0B3D55Ec8436dC09be01DBf918636B42395B",
  "0x3b57F3F72CAb9dAC888E372D2d69D5a14689236E",
  "0xC21a15e83d171E95621Fa979bE35B1c5ad954dbA",
  "0xcb13385a82565E2090B9275e49C5CBbdB1875aEA",
  "0x3f31BB70A3B44B7c5E789FaC6d42dBeaA9cbc571",
  "0xb12C8D26a9D419CBfE608D916DAf4eB37D2D3525",
  "0x8c12d43691829B08911155966cB1C8Ee5451d8F4",
  "0x0d3eC7134AC8708A891773B35329555C24a3bAd6",
  "0xd898fb8F18F953e4d0E248fc0F1446CFA1FE53E4",
  "0x2bC796588c45837b48C99eF3Ca6bc623f4Aab346",
  "0xB35ffbaD3090880Fb257B5f4cE759cbD94D38150",
  "0x068E5B1C385ea2647008F1694a35AAb5DDe642F2",
  "0xD156b66BF29e0c23b081641F8686EB4d604c5aB4",
  "0xCc0f40110389e9F0A0fdd04692571d089c5b6D04",
  "0xa082DB3d32368fA4df443b17E092b790530B64E0",
  "0x8f466C16E86d8dC833E5e422C709623D053fA08B",
  "0x4475529D727B2B99B4A4bf35A28e43B1Dc0E1749",
  "0x62BB34f84330075F0747623390F2c69A1B99749c",
  "0xB897daA056f114398739e4E8319b7882230A90BC",
  "0x4a188dC36c0fbF83C605DfF9ABfEd9F7E204d50d",
  "0x99c03AF034e5b471ADb0536be65632B12492f991",
  "0xfaFAFBfbb5A5BBb113f2fD93161F51634986538a",
  "0xbAB7e2200ae0659a23E44461d40972fdca02f3cB",
  "0xAbC6878f037Ed7fe0438f1D7ee9BF7233754b7a9",
  "0x430a8eeff93380FC1F1239d5f7f5D82c79f52858",
  "0x6fBEC0d1630CA255701c1f6d0975c2499567e74d",
  "0x60E271231604c2cdbDAdA3ccb0ef6B9Da43f61F6",
  "0x99eFd2f6eFA37242066eb2DF790245eDEAdf8633",
  "0x0DDC0c44251a98747b9e7dc165FDE86257876F79",
  "0x38A37F24E2fD61ae0481644025672fd946Df223e",
  "0xFaF4D08639965a86E344806a2621c81e59Ff95Df",
  "0x8783d18620AAF454809a6C8Eb53cbf507a567555",
  "0xFd88245B2294F833BD83245d4982c64f4B9D121D",
  "0x94A43335f907fDD50E1377a8E83A0A6c540E1482",
  "0xCa01526f9EbA721EFC65E5F70CE497393aF48020",
  "0x2220753cdfc706BC314B846CB0ef58C93ccf3e6e",
  "0xb0040F8B957329BFB2615dC081c1666540A153Bd",
  "0x576964927DF0Bc99884BA5CB09906B8d88ed3647",
  "0x29eFd6C06657bDA7A676ea181AFDf24D90449F56",
  "0x9ceaA0C6e28d876041F20E253a9b6A4328Bd1Ce6",
  "0x4Ae77f557c5aAcA450EeC79B929b5Cd06A8b8e6d",
  "0x166810b7d5056FedDB041B16F187Dc482d6Edc77",
  "0x81e14Aabb212DA94c5A5EC92C6c16190E5cA255D",
  "0xCd5A24dc493E79851AF8Ec423d7e669a61877f94",
  "0xF74106911432657a24b0D85257d40F24f801cc01",
  "0x7E5b98B0c3E763c801d0539e88Deac47508BaF22",
  "0xd2E1965A0e99c0259177E9AAf3CAeb36b790324B",
  "0x01Fb5666dCF3f0ECB990E2648b2fd8C90516A75e",
  "0xaAADd5D2BB88fBdaa426fFdb95b917B861fe94bB",
  "0x9A4439FA043C2Cfe37cEA47b5dCfb101addF1867",
  "0xcCA50D16C375E27a7c5750882aA39411881D2b43",
  "0xfDE1846486F556a97968fDc61b5Ae47f789c4284",
  "0x49c27873E134A62231C8867f7f5d6b9ebfd7AA78",
  "0xACe24317854D2eAa7078E3eA4A0d97e564b3B299",
  "0xC484EfcC64DBAAD797b9166bA4bFd0796Ddd2b5C",
  "0x4d8082dFBb5a6641a64BF26a716ED6D9b73dDa3A",
  "0x75791A9C2703C300AF7716c19fbC2d3Aa1C87fA0",
  "0xF6b27f2Ec781243240010C1b660103B3E4EDfF35",
  "0x943FaDc7ee72904Cc823782e487fD0438dd815e7",
  "0x4C0dc0137F59CD99EE5c33c830b0ad732f8084eC",
  "0xbE7360FE473E65a4AFee06c776440Ec2E807182f",
  "0xB78b9876e13Eca7cE630588C5C57E33b3f74A236",
  "0xbf1266d4064e57632364Fbfc971AdF44CDB65731",
  "0xa8163503008f4bdD384072Ac5A64F3e4ebE327fc",
  "0x5a85c2009711fFAC7387d718eD4634c63144b7C2",
  "0x83E8031302F0d859FaDa9786C54a5aD6afd8C11D",
  "0x37c23964b3Ae2EfC3203Fbb691368a2f67da20e6",
  "0xC0c728555C2C134425f26Fa2a83b1Feb93d88FE4",
  "0x35CFA566301D239823e13A922116e55aEDb37D2D",
  "0x72806D1FF69126ffAb4172D578ae3c3A258517B4",
  "0x894B4c9259258bfFFD3fa8c5914e98E94E2F98a9",
  "0x04E0A7503c64eF7a143B92B60B471BAEdC81CAb9",
  "0x40C2E8c885B2890562E8528Be6C9B85830bc04b6",
  "0xda3c72BEc67E5420a5A3be60F29D8fEf34124037",
  "0x926350D9DAFd0fd91f620C3Dbc0F590e4bE8681E",
  "0x05322f2356e8FfdC28c4a5e69d4FEebEbbB33649",
  "0xdb7387fe424C015C6ccE660b4c34eC60c10c3623",
  "0xF326e6bcE16911E59AFd455757550ee7A99c1663",
  "0x270934b21C61180b8169A5Dca2A2aaF3a6Cad70e",
  "0x8F2E99691855a5663beb39dEB9075f28b3dcc51b",
  "0xa9fc67e9e8709Deca98C60e82cCC37A25c75C695",
  "0x407b0710f9eb47D8596Ab315901D786b07e7e039",
  "0x263293E66E017Fa92E92ff594D69b1438dE0D32b",
  "0x00313151A7e74CE5108ad12c1B444ed7b458947c",
  "0x6EE5F24f8363F3C402bf26e0fE1E500bC4647057",
  "0xc4210BC7761b7EBc53F3F49358171a511fbCcAd2",
  "0xaF679EE7C181b1fEcb588245Bb8a0686eb051E3A",
  "0x4Ed722Fbc1DE078d3bd27588fc92f0cf7113BD63",
  "0x08d405d217499E28c464923EF7927E274fFb2E6d",
  "0x0f9dd10bB8fF1FB144a89b9e770f532Ad8a29A81",
  "0x5295B80C9c12655E5E73bd3FdE2b8acE53e1f4ec",
  "0xB4aC5dd62F700E271bffb52aeae1dba40135427f",
  "0xb589E359d36A393e5c9d75eafB54C89A1553ce00",
  "0x4AaEA5515050f656C5A1d2B334f0C73319c5F729",
  "0x1F5C988e93958Dde856EcdD9D23165D80A6F1FC4",
  "0xFA562367f407791FfDeFc3c3a3370e28f5D4034d",
  "0xF12744FEfB4CF5D87d656895c026712abb50Ec08",
  "0x9265D1C44AA6c00Cb810f3E407B40BB8c54A2E4b",
  "0x49bC92cA6472d7612A352fC93FEF9682B4b95676",
  "0xc1e3D68f2C214617c102313C9D23864e3eA1618f",
  "0x83f5a171717CF9B6E52Bc561e9BFB486B906cA89",
  "0xd3414Ed449244e3a5D3Ce4f9808a894D00d94f14",
  "0xdD33284DE1F565F23d1916148FF5E83743082CD3",
  "0x4765561e63914E72168bBd2A7e2ce72F9057ca04",
  "0xC64A0cB74253eDF1a6ac33438E91408F0A9143a3",
  "0x37fDD5227CfE29ffB5Ab1Df9348D545AE0e607E5",
  "0x64F21bC91D11531D88A16075d5E961d33f10B6eA"
];

const TOKENS_CONFIG_PATH = path.join(process.cwd(), "config", "tokens.json");
const configData = JSON.parse(fs.readFileSync(TOKENS_CONFIG_PATH, "utf8"));
const existingTokens = configData.tokens || [];
const existingMap = new Map();
existingTokens.forEach(t => {
  if (t.address) existingMap.set(t.address.toLowerCase(), t);
});

async function main() {
  const uniqueAddresses = Array.from(new Set(rawInput.map(a => a.toLowerCase())));
  console.log(`Input addresses: ${rawInput.length} total, ${uniqueAddresses.length} unique.`);

  const infrastructure = new Set([
    FACTORY_ADDR.toLowerCase(),
    ROUTER_ADDR.toLowerCase(),
    "0x64F21bC91D11531D88A16075d5E961d33f10B6eA".toLowerCase(), // GMAI Pool
    WSDA_ADDR.toLowerCase()
  ]);

  const candidateTokenAddrs = uniqueAddresses.filter(a => !infrastructure.has(a));
  console.log(`Candidate token contracts: ${candidateTokenAddrs.length}`);

  let alreadyInConfig = 0;
  let newTokensFound = 0;
  const newTokensList = [];

  const ERC20_ABI = [
    "function symbol() view returns (string)",
    "function name() view returns (string)",
    "function decimals() view returns (uint8)"
  ];

  // Batch resolve token info
  for (let i = 0; i < candidateTokenAddrs.length; i += 15) {
    const batch = candidateTokenAddrs.slice(i, i + 15);
    await Promise.all(batch.map(async (addr) => {
      if (existingMap.has(addr)) {
        alreadyInConfig++;
        return;
      }
      try {
        const c = new ethers.Contract(addr, ERC20_ABI, provider);
        const [symbol, name, decimals] = await Promise.all([
          c.symbol().catch(() => null),
          c.name().catch(() => null),
          c.decimals().catch(() => 18)
        ]);

        if (symbol) {
          // Check pools against WSDA in Pinetswap Factory
          const pools = {};
          for (const fee of [500, 3000, 10000]) {
            try {
              const p = await factory.getPool(addr, WSDA_ADDR, fee);
              if (p && p !== ethers.ZeroAddress) {
                pools[fee.toString()] = p;
              }
            } catch {}
          }

          newTokensList.push({
            symbol,
            name: name || symbol,
            address: addr,
            decimals: Number(decimals),
            pools,
            taxBps: 0
          });
          newTokensFound++;
        }
      } catch (err) {
        // Not an ERC20 or contract
      }
    }));
  }

  console.log(`\nResults:`);
  console.log(`• Already configured in tokens.json: ${alreadyInConfig}`);
  console.log(`• Newly discovered active tokens: ${newTokensFound}`);

  // Automatically add all new tokens to config/tokens.json if any
  if (newTokensList.length > 0) {
    for (const nt of newTokensList) {
      existingTokens.push(nt);
      existingMap.set(nt.address.toLowerCase(), nt);
    }
    configData.tokens = existingTokens;
    fs.writeFileSync(TOKENS_CONFIG_PATH, JSON.stringify(configData, null, 2), "utf8");
    console.log(`✅ Successfully injected ${newTokensList.length} new tokens into config/tokens.json!`);
    console.log(`New total tokens configured: ${existingTokens.length}`);
  }

  // Count active trading in recent blocks (1 minute ~ 20 blocks on Sidra)
  const latestBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latestBlock - 20); // Last ~1 minute
  console.log(`\nChecking trading activity in the last minute (Blocks ${fromBlock} to ${latestBlock})...`);

  const activeTokensIn1Min = new Set();
  let totalTxsIn1Min = 0;
  let targetTxsIn1Min = 0;

  for (let b = fromBlock; b <= latestBlock; b++) {
    const block = await provider.getBlock(b, true);
    if (!block || !block.prefetchedTransactions) continue;
    for (const tx of block.prefetchedTransactions) {
      totalTxsIn1Min++;
      if (tx.to && (tx.to.toLowerCase() === ROUTER_ADDR.toLowerCase() || infrastructure.has(tx.to.toLowerCase()))) {
        targetTxsIn1Min++;
      }
      // Check if tx is from or to any token
      for (const t of existingTokens) {
        if (tx.to && tx.to.toLowerCase() === t.address.toLowerCase()) {
          activeTokensIn1Min.add(t.symbol);
        }
        for (const poolAddr of Object.values(t.pools || {})) {
          if (tx.to && tx.to.toLowerCase() === poolAddr.toLowerCase()) {
            activeTokensIn1Min.add(t.symbol);
          }
        }
      }
    }
  }

  console.log(`\n📊 1-Minute Trading Frequency Statistics:`);
  console.log(`• Blocks checked (last 60s): ${latestBlock - fromBlock + 1} blocks`);
  console.log(`• Total On-Chain Transactions: ${totalTxsIn1Min}`);
  console.log(`• Total DEX Swap Interactions: ${targetTxsIn1Min}`);
  console.log(`• Distinct Tokens with Trades in 1 Min: ${activeTokensIn1Min.size}`);
  if (activeTokensIn1Min.size > 0) {
    console.log(`• Active Tokens: ${Array.from(activeTokensIn1Min).join(", ")}`);
  }
}

main().catch(console.error);
