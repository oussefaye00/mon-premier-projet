/** Journal sur stderr : stdout est réservé au protocole MCP (transport stdio). */
export function log(...args: unknown[]) {
  process.stderr.write(`[after-motion-mcp] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
}
