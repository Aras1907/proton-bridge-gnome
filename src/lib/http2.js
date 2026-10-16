// Just enough HTTP/2 (RFC 9113) over TLS for gRPC: one connection, client
// streams, flow-control replenishment, SETTINGS/PING/GOAWAY handling.
// libsoup is not used because it drops the HTTP/2 trailers gRPC relies on.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {HpackDecoder, encodeHeaders} from './hpack.js';

Gio._promisify(Gio.SocketClient.prototype, 'connect_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async');

const PREFACE = new TextEncoder().encode('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');
const MAX_FRAME = 16384;
const MAX_HEADER_BLOCK = 64 * 1024;

const Type = {
    DATA: 0, HEADERS: 1, RST_STREAM: 3, SETTINGS: 4, PUSH_PROMISE: 5,
    PING: 6, GOAWAY: 7, WINDOW_UPDATE: 8, CONTINUATION: 9,
};
const Flag = {END_STREAM: 0x1, ACK: 0x1, END_HEADERS: 0x4, PADDED: 0x8, PRIORITY: 0x20};

// TLS connection objects also implement GDtlsConnection, whose methods of the
// same name shadow the GTlsConnection/GIOStream ones, so call these explicitly.
function handshake(tls, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.TlsConnection.prototype.handshake_async.call(tls, GLib.PRIORITY_DEFAULT, cancellable,
            (obj, res) => {
                try {
                    resolve(Gio.TlsConnection.prototype.handshake_finish.call(obj, res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function frame(type, flags, id, payload = new Uint8Array()) {
    const out = new Uint8Array(9 + payload.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, payload.length << 8);
    out[3] = type;
    out[4] = flags;
    view.setUint32(5, id);
    out.set(payload, 9);
    return out;
}

function u32(value) {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value);
    return out;
}

function concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
}

export class Http2Connection {
    /**
     * @param {object} target
     * @param {string} [target.socketPath] - unix socket, or
     * @param {number} [target.port] - TCP port on 127.0.0.1
     * @param {Gio.TlsCertificate} target.certificate - the only certificate accepted
     * @param {Function} [onClose] - called once with the error that ended the connection
     */
    static async open({socketPath, port, certificate}, onClose) {
        const cancellable = new Gio.Cancellable();
        const address = socketPath
            ? Gio.UnixSocketAddress.new(socketPath)
            : Gio.InetSocketAddress.new_from_string('127.0.0.1', port);
        const base = await new Gio.SocketClient({timeout: 10}).connect_async(address, cancellable);
        // SocketClient's timeout also becomes the socket's I/O timeout. The event
        // stream is idle for long stretches, and Bridge quits when it drops.
        base.get_socket().set_timeout(0);

        const tls = Gio.TlsClientConnection.new(base, null);
        tls.set_advertised_protocols(['h2']);
        tls.connect('accept-certificate', (_conn, cert) => cert.is_same(certificate));
        await handshake(tls, cancellable);
        if (!tls.get_peer_certificate()?.is_same(certificate))
            throw new Error('Unexpected server certificate');
        if (tls.get_negotiated_protocol() !== 'h2')
            throw new Error('Server did not negotiate HTTP/2');

        const conn = new Http2Connection(tls, cancellable, onClose);
        conn._send(concat(PREFACE, frame(Type.SETTINGS, 0, 0, Uint8Array.from([0, 2, 0, 0, 0, 0]))));
        conn._readLoop();
        return conn;
    }

    constructor(io, cancellable, onClose) {
        this._io = io;
        this._in = io.get_input_stream();
        this._out = io.get_output_stream();
        this._cancellable = cancellable;
        this._onClose = onClose;
        this._hpack = new HpackDecoder();
        this._streams = new Map();
        this._nextId = 1;
        this._buf = new Uint8Array();
        this._writing = Promise.resolve();
        this._block = null;
    }

    get closed() {
        return !!this._error;
    }

    close(error = new Error('Connection closed')) {
        if (this._error)
            return;
        this._error = error;
        this._cancellable.cancel();
        for (const stream of this._streams.values())
            stream.reject(error);
        this._streams.clear();
        Gio.IOStream.prototype.close_async.call(this._io, GLib.PRIORITY_DEFAULT, null, (obj, res) => {
            try {
                Gio.IOStream.prototype.close_finish.call(obj, res);
            } catch {}
        });
        this._onClose?.(error);
    }

    /**
     * Sends a POST request with a complete body.
     *
     * @returns {{id: number, done: Promise<{headers: Map, trailers: Map}>}}
     */
    request(path, headers, body, onData) {
        if (this._error)
            return {id: 0, done: Promise.reject(this._error)};
        const id = this._nextId;
        this._nextId += 2;

        const stream = {id, onData, headers: null, trailers: null};
        stream.done = new Promise((resolve, reject) => {
            stream.resolve = resolve;
            stream.reject = reject;
        });
        this._streams.set(id, stream);

        const block = encodeHeaders([
            [':method', 'POST'],
            [':scheme', 'https'],
            [':path', path],
            [':authority', 'localhost'],
            ...headers,
        ]);
        if (block.length > MAX_FRAME || body.length > MAX_FRAME)
            throw new Error('Request too large');
        this._send(concat(
            frame(Type.HEADERS, Flag.END_HEADERS, id, block),
            frame(Type.DATA, Flag.END_STREAM, id, body)));
        return stream;
    }

    cancel(id) {
        if (this._streams.delete(id) && !this._error)
            this._send(frame(Type.RST_STREAM, 0, id, u32(0x8)));
    }

    _send(bytes) {
        this._writing = this._writing.then(async () => {
            let rest = bytes;
            while (rest.length && !this._error) {
                // eslint-disable-next-line no-await-in-loop
                const n = await this._out.write_bytes_async(new GLib.Bytes(rest),
                    GLib.PRIORITY_DEFAULT, this._cancellable);
                rest = rest.subarray(n);
            }
        }).catch(e => this.close(e));
    }

    async _read(n) {
        while (this._buf.length < n) {
            // eslint-disable-next-line no-await-in-loop
            const chunk = (await this._in.read_bytes_async(65536,
                GLib.PRIORITY_DEFAULT, this._cancellable)).toArray();
            if (!chunk.length)
                throw new Error('Connection closed by server');
            this._buf = this._buf.length ? concat(this._buf, chunk) : chunk;
        }
        const out = this._buf.subarray(0, n);
        this._buf = this._buf.subarray(n);
        return out;
    }

    async _readLoop() {
        try {
            for (;;) {
                // eslint-disable-next-line no-await-in-loop
                const head = await this._read(9);
                const view = new DataView(head.buffer, head.byteOffset, 9);
                const length = view.getUint32(0) >>> 8;
                const id = view.getUint32(5) & 0x7fffffff;
                if (length > MAX_FRAME)
                    throw new Error('Frame too large');
                // eslint-disable-next-line no-await-in-loop
                const payload = length ? (await this._read(length)).slice() : new Uint8Array();
                this._onFrame(head[3], head[4], id, payload);
            }
        } catch (e) {
            this.close(e);
        }
    }

    _onFrame(type, flags, id, payload) {
        if (this._block && type !== Type.CONTINUATION)
            throw new Error('Expected CONTINUATION frame');

        switch (type) {
        case Type.SETTINGS:
            if (!(flags & Flag.ACK))
                this._send(frame(Type.SETTINGS, Flag.ACK, 0));
            break;
        case Type.PING:
            if (!(flags & Flag.ACK))
                this._send(frame(Type.PING, Flag.ACK, 0, payload));
            break;
        case Type.GOAWAY:
            throw new Error('Server closed the connection (GOAWAY)');
        case Type.RST_STREAM: {
            const stream = this._streams.get(id);
            this._streams.delete(id);
            stream?.reject(new Error(`Stream reset (code ${new DataView(payload.buffer).getUint32(0)})`));
            break;
        }
        case Type.DATA: {
            if (payload.length) {
                // Hand the window straight back: we consume data as it arrives.
                this._send(concat(
                    frame(Type.WINDOW_UPDATE, 0, 0, u32(payload.length)),
                    flags & Flag.END_STREAM ? new Uint8Array()
                        : frame(Type.WINDOW_UPDATE, 0, id, u32(payload.length))));
            }
            let data = payload;
            if (flags & Flag.PADDED)
                data = payload.subarray(1, payload.length - payload[0]);
            const stream = this._streams.get(id);
            if (stream && data.length)
                stream.onData?.(data);
            if (flags & Flag.END_STREAM)
                this._end(id);
            break;
        }
        case Type.HEADERS: {
            let start = 0, end = payload.length;
            if (flags & Flag.PADDED) {
                start = 1;
                end -= payload[0];
            }
            if (flags & Flag.PRIORITY)
                start += 5;
            this._block = {id, flags, data: payload.slice(start, end)};
            if (flags & Flag.END_HEADERS)
                this._finishBlock();
            break;
        }
        case Type.CONTINUATION:
            if (!this._block || this._block.id !== id)
                throw new Error('Unexpected CONTINUATION frame');
            this._block.data = concat(this._block.data, payload);
            if (this._block.data.length > MAX_HEADER_BLOCK)
                throw new Error('Header block too large');
            if (flags & Flag.END_HEADERS)
                this._finishBlock();
            break;
        case Type.PUSH_PROMISE:
            throw new Error('Unexpected server push');
        // WINDOW_UPDATE, PRIORITY and unknown frames are ignored: requests are tiny.
        }
    }

    _finishBlock() {
        const {id, flags, data} = this._block;
        this._block = null;
        // Always decode, even for unknown streams, to keep HPACK state in sync.
        const headers = new Map(this._hpack.decode(data));
        const stream = this._streams.get(id);
        if (stream) {
            if (stream.headers)
                stream.trailers = headers;
            else
                stream.headers = headers;
        }
        if (flags & Flag.END_STREAM)
            this._end(id);
    }

    _end(id) {
        const stream = this._streams.get(id);
        if (!stream)
            return;
        this._streams.delete(id);
        stream.resolve({headers: stream.headers ?? new Map(), trailers: stream.trailers ?? new Map()});
    }
}
