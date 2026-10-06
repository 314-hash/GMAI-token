import { startServer } from "./controller_server.js";
import { SwarmEngine } from "./loop_3buy_1sell_continuous.js";
import dotenv from "dotenv";

dotenv.config();

const args = process.argv.slice(2);
const hasCliFlags = args.some(a => a.startsWith("--"));

if (hasCliFlags) {
  // Direct CLI invocation mode
  console.log("⚡ Executing Swarm Engine directly in CLI mode...\n");
  import("./loop_3buy_1sell_continuous.js");
} else {
  // Launch Mission Control Web Dashboard server
  const PORT = Number(process.env.PORT || 3000);
  startServer(PORT);
}
