// Minimal newline-JSON-RPC "server" for the relay test: answers initialize
// and tools/call (with its pid), and exits abruptly on a {method:"crash"}
// notification — the SSH-drop stand-in.
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'crash') process.exit(3);
    if (msg.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } }) + '\n');
    else if (msg.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { pid: process.pid, method: msg.method } }) + '\n');
  }
});
process.stdin.on('end', () => process.exit(0));
