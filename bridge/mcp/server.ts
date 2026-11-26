import type { Readable, Writable } from 'node:stream';
import { maxRequestBytes } from '../helper/protocol.ts';
import { fields } from '../src/approval-input.ts';
import { callTool, tools, toolRequest, type HelperCall } from './tools.ts';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

type Id = number | string | null;
const rpcError = (id: Id, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

function requestId(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
}

async function respond(data: Buffer, call: HelperCall, credential: string) {
  let request: unknown;
  try { request = JSON.parse(decoder.decode(data)); } catch { return rpcError(null, -32700, 'Parse error'); }
  if (!fields(request, ['jsonrpc', 'method'], ['id', 'params']) || request.jsonrpc !== '2.0'
    || typeof request.method !== 'string' || (Object.hasOwn(request, 'id') && !requestId(request.id))) {
    return rpcError(null, -32600, 'Invalid request');
  }
  if (!requestId(request.id)) return; // Notifications, including notifications/initialized, have no reply.

  const { id, method, params } = request;
  const result = (body: unknown) => ({ jsonrpc: '2.0', id, result: body });
  const invalid = () => rpcError(id, -32602, 'Invalid parameters');
  switch (method) {
    case 'initialize':
      if (!fields(params, ['protocolVersion', 'capabilities', 'clientInfo'], ['_meta'])
        || typeof params.protocolVersion !== 'string'
        || !params.capabilities || typeof params.capabilities !== 'object' || Array.isArray(params.capabilities)
        || !fields(params.clientInfo, ['name', 'version'], ['title', 'description', 'icons', 'websiteUrl'])
        || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') return invalid();
      return result({
        protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'loom', version: '0.1.0' },
      });
    case 'ping': return result({});
    case 'tools/list':
      return params === undefined || fields(params, [], ['_meta']) ? result({ tools }) : invalid();
    case 'tools/call': {
      if (!fields(params, ['name'], ['arguments', '_meta']) || typeof params.name !== 'string') return invalid();
      if (!tools.some(tool => tool.name === params.name)) return rpcError(id, -32602, 'Unknown tool');
      const input = Object.hasOwn(params, 'arguments') ? params.arguments : {};
      const tool = toolRequest(params.name, input, credential);
      if (!tool) return invalid();
      return result(await callTool(call, tool));
    }
    default: return rpcError(id, -32601, 'Method not found');
  }
}

export async function serveMcp(input: Readable, output: Writable, call: HelperCall, credential: string) {
  const write = (reply: object) => new Promise<void>((resolve, reject) => {
    output.write(JSON.stringify(reply) + '\n', error => error ? reject(error) : resolve());
  });
  let chunks: Buffer[] = [];
  let length = 0;
  let oversized = false;

  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      const part = bytes.subarray(offset, newline === -1 ? bytes.length : newline);
      if (!oversized) {
        length += part.length;
        if (length > maxRequestBytes) {
          oversized = true;
          chunks = [];
        } else {
          chunks.push(part);
        }
      }
      if (newline === -1) break;
      const reply = oversized ? rpcError(null, -32600, 'Frame too large')
        : await respond(Buffer.concat(chunks, length), call, credential);
      if (reply) await write(reply);
      chunks = [];
      length = 0;
      oversized = false;
      offset = newline + 1;
    }
  }
  if (length > 0) await write(rpcError(null, -32700, 'Incomplete frame'));
}
