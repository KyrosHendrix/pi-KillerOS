import { mkdirSync, writeFileSync } from "node:fs";
import process from "node:process";

const args = process.argv.slice(2);
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
const sessionDirectory = valueAfter("--session-dir");
const sessionId = valueAfter("--session-id");
const name = valueAfter("--name");
mkdirSync(sessionDirectory, { recursive: true });
writeFileSync(`${sessionDirectory}/${sessionId}.jsonl`, JSON.stringify({ name, sessionId }));
process.stdout.write(`${JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: `child:${name}` }],
    stopReason: "stop",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  },
})}\n`);
