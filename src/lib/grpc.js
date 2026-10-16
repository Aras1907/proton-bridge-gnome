// Minimal gRPC client for Proton Mail Bridge's frontend API (the one its own
// GUI uses), over our small HTTP/2 client, plus a tiny protobuf codec.
//
// Bridge writes grpcServerConfig.json with its socket, a per-run token and a
// per-run self-signed certificate. We only accept exactly that certificate.

import Gio from 'gi://Gio';

import {Http2Connection} from './http2.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');

const MAX_MESSAGE = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---- protobuf -------------------------------------------------------------

export class Writer {
    constructor() {
        this._parts = [];
    }

    _varint(n) {
        const out = [];
        while (n > 127) {
            out.push((n % 128) | 128);
            n = Math.floor(n / 128);
        }
        out.push(n);
        this._parts.push(Uint8Array.from(out));
    }

    _len(field, bytes) {
        this._varint(field * 8 + 2);
        this._varint(bytes.length);
        this._parts.push(bytes);
        return this;
    }

    string(field, value) {
        return value ? this._len(field, encoder.encode(value)) : this;
    }

    bytes(field, value) {
        return value?.length ? this._len(field, value) : this;
    }

    bool(field, value) {
        if (value) {
            this._varint(field * 8);
            this._varint(1);
        }
        return this;
    }

    finish() {
        const size = this._parts.reduce((n, p) => n + p.length, 0);
        const out = new Uint8Array(size);
        let offset = 0;
        for (const part of this._parts) {
            out.set(part, offset);
            offset += part.length;
        }
        return out;
    }
}

/** Decodes a message into {fieldNumber: [values]} (numbers or Uint8Arrays). */
export function decode(bytes) {
    const fields = {};
    let pos = 0;
    const varint = () => {
        let n = 0, mul = 1, b;
        do {
            if (pos >= bytes.length)
                throw new Error('Truncated protobuf');
            b = bytes[pos++];
            n += (b & 127) * mul;
            mul *= 128;
        } while (b & 128);
        return n;
    };
    while (pos < bytes.length) {
        const key = varint();
        const field = Math.floor(key / 8);
        let value;
        switch (key % 8) {
        case 0:
            value = varint();
            break;
        case 1:
            pos += 8;
            continue;
        case 2: {
            const len = varint();
            if (pos + len > bytes.length)
                throw new Error('Truncated protobuf');
            value = bytes.subarray(pos, pos + len);
            pos += len;
            break;
        }
        case 5:
            pos += 4;
            continue;
        default:
            throw new Error('Unsupported protobuf wire type');
        }
        (fields[field] ??= []).push(value);
    }
    return fields;
}

export const pb = {
    str: (m, f) => (m[f] ? decoder.decode(m[f][0]) : ''),
    strs: (m, f) => (m[f] ?? []).map(v => decoder.decode(v)),
    raw: (m, f) => m[f]?.[0] ?? null,
    int: (m, f) => m[f]?.[0] ?? 0,
    msg: (m, f) => (m[f] ? decode(m[f][0]) : null),
    msgs: (m, f) => (m[f] ?? []).map(v => decode(v)),
    /** For a oneof: [fieldNumber, decodedMessage] of the field that is set. */
    oneof: m => {
        const field = Object.keys(m).map(Number).find(f => m[f]?.[0] instanceof Uint8Array);
        return field ? [field, decode(m[field][0])] : [0, {}];
    },
};

/** google.protobuf.StringValue */
export const stringValue = s => new Writer().string(1, s).finish();

// ---- gRPC transport -----------------------------------------------------

export class GrpcError extends Error {
    constructor(code, message) {
        super(message || `gRPC status ${code}`);
        this.code = code;
    }
}

function frame(payload) {
    const out = new Uint8Array(5 + payload.length);
    new DataView(out.buffer).setUint32(1, payload.length);
    out.set(payload, 5);
    return out;
}

/** Splits a DATA byte stream into length-prefixed gRPC messages. */
class Deframer {
    constructor(onMessage) {
        this._onMessage = onMessage;
        this._buf = new Uint8Array();
    }

    push(chunk) {
        const buf = new Uint8Array(this._buf.length + chunk.length);
        buf.set(this._buf);
        buf.set(chunk, this._buf.length);
        let pos = 0;
        while (buf.length - pos >= 5) {
            const len = new DataView(buf.buffer, pos + 1, 4).getUint32(0);
            if (buf[pos] !== 0 || len > MAX_MESSAGE)
                throw new GrpcError(-1, 'Malformed gRPC message');
            if (buf.length - pos - 5 < len)
                break;
            this._onMessage(decode(buf.subarray(pos + 5, pos + 5 + len)));
            pos += 5 + len;
        }
        this._buf = buf.slice(pos);
    }
}

function checkStatus({headers, trailers}) {
    if (headers.get(':status') !== '200')
        throw new GrpcError(-1, `HTTP status ${headers.get(':status')}`);
    // Errors may also come as "Trailers-Only" responses, i.e. in the headers.
    const status = trailers.get('grpc-status') ?? headers.get('grpc-status');
    if (status !== '0') {
        const message = trailers.get('grpc-message') ?? headers.get('grpc-message') ?? '';
        throw new GrpcError(Number(status ?? 2), decodeURIComponent(message));
    }
}

export class BridgeClient {
    /**
     * Connects using Bridge's grpcServerConfig.json.
     *
     * @param {Gio.File} file
     * @param {Function} onClose - called when the connection ends
     */
    static async connect(file, onClose) {
        const [contents] = await file.load_contents_async(null);
        const config = JSON.parse(decoder.decode(contents));
        const h2 = await Http2Connection.open({
            socketPath: config.fileSocketPath || null,
            port: config.port,
            certificate: Gio.TlsCertificate.new_from_pem(config.cert, -1),
        }, onClose);
        return new BridgeClient(h2, config.token);
    }

    constructor(h2, token) {
        this._h2 = h2;
        this._headers = [
            ['content-type', 'application/grpc'],
            ['te', 'trailers'],
            ['server-token', token],
        ];
    }

    close() {
        this._h2.close();
    }

    /** Unary call; resolves with the decoded response message. */
    async call(method, payload = new Uint8Array()) {
        let result = {};
        const deframer = new Deframer(m => (result = m));
        const stream = this._h2.request(`/grpc.Bridge/${method}`, this._headers,
            frame(payload), data => deframer.push(data));
        checkStatus(await stream.done);
        return result;
    }

    /** Server-streaming call; onMessage(decoded) per message. Resolves when the stream ends. */
    async stream(method, payload, onMessage) {
        const deframer = new Deframer(onMessage);
        const stream = this._h2.request(`/grpc.Bridge/${method}`, this._headers,
            frame(payload), data => deframer.push(data));
        checkStatus(await stream.done);
    }
}
