// HPACK (RFC 7541) header decoding for the HTTP/2 client in http2.js.
// Only decoding needs the tables; we encode requests as plain literals.

// RFC 7541 Appendix A
const STATIC_TABLE = [
    [':authority', ''],
    [':method', 'GET'],
    [':method', 'POST'],
    [':path', '/'],
    [':path', '/index.html'],
    [':scheme', 'http'],
    [':scheme', 'https'],
    [':status', '200'],
    [':status', '204'],
    [':status', '206'],
    [':status', '304'],
    [':status', '400'],
    [':status', '404'],
    [':status', '500'],
    ['accept-charset', ''],
    ['accept-encoding', 'gzip, deflate'],
    ['accept-language', ''],
    ['accept-ranges', ''],
    ['accept', ''],
    ['access-control-allow-origin', ''],
    ['age', ''],
    ['allow', ''],
    ['authorization', ''],
    ['cache-control', ''],
    ['content-disposition', ''],
    ['content-encoding', ''],
    ['content-language', ''],
    ['content-length', ''],
    ['content-location', ''],
    ['content-range', ''],
    ['content-type', ''],
    ['cookie', ''],
    ['date', ''],
    ['etag', ''],
    ['expect', ''],
    ['expires', ''],
    ['from', ''],
    ['host', ''],
    ['if-match', ''],
    ['if-modified-since', ''],
    ['if-none-match', ''],
    ['if-range', ''],
    ['if-unmodified-since', ''],
    ['last-modified', ''],
    ['link', ''],
    ['location', ''],
    ['max-forwards', ''],
    ['proxy-authenticate', ''],
    ['proxy-authorization', ''],
    ['range', ''],
    ['referer', ''],
    ['refresh', ''],
    ['retry-after', ''],
    ['server', ''],
    ['set-cookie', ''],
    ['strict-transport-security', ''],
    ['transfer-encoding', ''],
    ['user-agent', ''],
    ['vary', ''],
    ['via', ''],
    ['www-authenticate', ''],
];

// RFC 7541 Appendix B: [code, bit length] for symbols 0..256
const HUFFMAN = [
    [0x1ff8, 13], [0x7fffd8, 23], [0xfffffe2, 28], [0xfffffe3, 28], [0xfffffe4, 28],
    [0xfffffe5, 28], [0xfffffe6, 28], [0xfffffe7, 28], [0xfffffe8, 28], [0xffffea, 24],
    [0x3ffffffc, 30], [0xfffffe9, 28], [0xfffffea, 28], [0x3ffffffd, 30], [0xfffffeb, 28],
    [0xfffffec, 28], [0xfffffed, 28], [0xfffffee, 28], [0xfffffef, 28], [0xffffff0, 28],
    [0xffffff1, 28], [0xffffff2, 28], [0x3ffffffe, 30], [0xffffff3, 28], [0xffffff4, 28],
    [0xffffff5, 28], [0xffffff6, 28], [0xffffff7, 28], [0xffffff8, 28], [0xffffff9, 28],
    [0xffffffa, 28], [0xffffffb, 28], [0x14, 6], [0x3f8, 10], [0x3f9, 10], [0xffa, 12],
    [0x1ff9, 13], [0x15, 6], [0xf8, 8], [0x7fa, 11], [0x3fa, 10], [0x3fb, 10], [0xf9, 8],
    [0x7fb, 11], [0xfa, 8], [0x16, 6], [0x17, 6], [0x18, 6], [0x0, 5], [0x1, 5], [0x2, 5],
    [0x19, 6], [0x1a, 6], [0x1b, 6], [0x1c, 6], [0x1d, 6], [0x1e, 6], [0x1f, 6], [0x5c, 7],
    [0xfb, 8], [0x7ffc, 15], [0x20, 6], [0xffb, 12], [0x3fc, 10], [0x1ffa, 13], [0x21, 6],
    [0x5d, 7], [0x5e, 7], [0x5f, 7], [0x60, 7], [0x61, 7], [0x62, 7], [0x63, 7], [0x64, 7],
    [0x65, 7], [0x66, 7], [0x67, 7], [0x68, 7], [0x69, 7], [0x6a, 7], [0x6b, 7], [0x6c, 7],
    [0x6d, 7], [0x6e, 7], [0x6f, 7], [0x70, 7], [0x71, 7], [0x72, 7], [0xfc, 8], [0x73, 7],
    [0xfd, 8], [0x1ffb, 13], [0x7fff0, 19], [0x1ffc, 13], [0x3ffc, 14], [0x22, 6], [0x7ffd, 15],
    [0x3, 5], [0x23, 6], [0x4, 5], [0x24, 6], [0x5, 5], [0x25, 6], [0x26, 6], [0x27, 6],
    [0x6, 5], [0x74, 7], [0x75, 7], [0x28, 6], [0x29, 6], [0x2a, 6], [0x7, 5], [0x2b, 6],
    [0x76, 7], [0x2c, 6], [0x8, 5], [0x9, 5], [0x2d, 6], [0x77, 7], [0x78, 7], [0x79, 7],
    [0x7a, 7], [0x7b, 7], [0x7ffe, 15], [0x7fc, 11], [0x3ffd, 14], [0x1ffd, 13],
    [0xffffffc, 28], [0xfffe6, 20], [0x3fffd2, 22], [0xfffe7, 20], [0xfffe8, 20],
    [0x3fffd3, 22], [0x3fffd4, 22], [0x3fffd5, 22], [0x7fffd9, 23], [0x3fffd6, 22],
    [0x7fffda, 23], [0x7fffdb, 23], [0x7fffdc, 23], [0x7fffdd, 23], [0x7fffde, 23],
    [0xffffeb, 24], [0x7fffdf, 23], [0xffffec, 24], [0xffffed, 24], [0x3fffd7, 22],
    [0x7fffe0, 23], [0xffffee, 24], [0x7fffe1, 23], [0x7fffe2, 23], [0x7fffe3, 23],
    [0x7fffe4, 23], [0x1fffdc, 21], [0x3fffd8, 22], [0x7fffe5, 23], [0x3fffd9, 22],
    [0x7fffe6, 23], [0x7fffe7, 23], [0xffffef, 24], [0x3fffda, 22], [0x1fffdd, 21],
    [0xfffe9, 20], [0x3fffdb, 22], [0x3fffdc, 22], [0x7fffe8, 23], [0x7fffe9, 23],
    [0x1fffde, 21], [0x7fffea, 23], [0x3fffdd, 22], [0x3fffde, 22], [0xfffff0, 24],
    [0x1fffdf, 21], [0x3fffdf, 22], [0x7fffeb, 23], [0x7fffec, 23], [0x1fffe0, 21],
    [0x1fffe1, 21], [0x3fffe0, 22], [0x1fffe2, 21], [0x7fffed, 23], [0x3fffe1, 22],
    [0x7fffee, 23], [0x7fffef, 23], [0xfffea, 20], [0x3fffe2, 22], [0x3fffe3, 22],
    [0x3fffe4, 22], [0x7ffff0, 23], [0x3fffe5, 22], [0x3fffe6, 22], [0x7ffff1, 23],
    [0x3ffffe0, 26], [0x3ffffe1, 26], [0xfffeb, 20], [0x7fff1, 19], [0x3fffe7, 22],
    [0x7ffff2, 23], [0x3fffe8, 22], [0x1ffffec, 25], [0x3ffffe2, 26], [0x3ffffe3, 26],
    [0x3ffffe4, 26], [0x7ffffde, 27], [0x7ffffdf, 27], [0x3ffffe5, 26], [0xfffff1, 24],
    [0x1ffffed, 25], [0x7fff2, 19], [0x1fffe3, 21], [0x3ffffe6, 26], [0x7ffffe0, 27],
    [0x7ffffe1, 27], [0x3ffffe7, 26], [0x7ffffe2, 27], [0xfffff2, 24], [0x1fffe4, 21],
    [0x1fffe5, 21], [0x3ffffe8, 26], [0x3ffffe9, 26], [0xffffffd, 28], [0x7ffffe3, 27],
    [0x7ffffe4, 27], [0x7ffffe5, 27], [0xfffec, 20], [0xfffff3, 24], [0xfffed, 20],
    [0x1fffe6, 21], [0x3fffe9, 22], [0x1fffe7, 21], [0x1fffe8, 21], [0x7ffff3, 23],
    [0x3fffea, 22], [0x3fffeb, 22], [0x1ffffee, 25], [0x1ffffef, 25], [0xfffff4, 24],
    [0xfffff5, 24], [0x3ffffea, 26], [0x7ffff4, 23], [0x3ffffeb, 26], [0x7ffffe6, 27],
    [0x3ffffec, 26], [0x3ffffed, 26], [0x7ffffe7, 27], [0x7ffffe8, 27], [0x7ffffe9, 27],
    [0x7ffffea, 27], [0x7ffffeb, 27], [0xffffffe, 28], [0x7ffffec, 27], [0x7ffffed, 27],
    [0x7ffffee, 27], [0x7ffffef, 27], [0x7fffff0, 27], [0x3ffffee, 26], [0x3fffffff, 30],
];

const utf8 = new TextDecoder();

let huffmanTree = null;

function buildTree() {
    const root = [];
    HUFFMAN.forEach(([code, length], symbol) => {
        let node = root;
        for (let i = length - 1; i > 0; i--) {
            const bit = Math.floor(code / 2 ** i) % 2;
            node = node[bit] ??= [];
        }
        node[code % 2] = symbol;
    });
    return root;
}

function huffmanDecode(bytes) {
    huffmanTree ??= buildTree();
    const out = [];
    let node = huffmanTree;
    for (const byte of bytes) {
        for (let i = 7; i >= 0; i--) {
            const next = node[(byte >> i) & 1];
            if (next === undefined)
                throw new Error('Invalid Huffman code');
            if (typeof next === 'number') {
                if (next === 256)
                    throw new Error('Huffman EOS in string');
                out.push(next);
                node = huffmanTree;
            } else {
                node = next;
            }
        }
    }
    // Remaining bits are EOS padding (all ones), which we can ignore.
    return utf8.decode(Uint8Array.from(out));
}

export class HpackDecoder {
    constructor() {
        this._dynamic = [];
        this._size = 0;
        this._max = 4096;
    }

    /** @returns {Array<[string, string]>} */
    decode(buf) {
        let pos = 0;
        const int = bits => {
            const mask = 2 ** bits - 1;
            let value = buf[pos++] & mask;
            if (value < mask)
                return value;
            let shift = 1, b;
            do {
                if (pos >= buf.length)
                    throw new Error('Truncated HPACK integer');
                b = buf[pos++];
                value += (b & 127) * shift;
                shift *= 128;
            } while (b & 128);
            return value;
        };
        const str = () => {
            const huffman = buf[pos] & 0x80;
            const len = int(7);
            if (pos + len > buf.length)
                throw new Error('Truncated HPACK string');
            const bytes = buf.subarray(pos, pos + len);
            pos += len;
            return huffman ? huffmanDecode(bytes) : utf8.decode(bytes);
        };

        const headers = [];
        while (pos < buf.length) {
            const b = buf[pos];
            if (b & 0x80) {                       // indexed field
                headers.push(this._get(int(7)));
            } else if (b & 0x40) {                // literal, incremental indexing
                const index = int(6);
                const name = index ? this._get(index)[0] : str();
                const field = [name, str()];
                this._add(field);
                headers.push(field);
            } else if (b & 0x20) {                // dynamic table size update
                this._max = int(5);
                this._evict();
            } else {                              // literal, not / never indexed
                const index = int(4);
                const name = index ? this._get(index)[0] : str();
                headers.push([name, str()]);
            }
        }
        return headers;
    }

    _get(index) {
        const field = index <= STATIC_TABLE.length
            ? STATIC_TABLE[index - 1]
            : this._dynamic[index - STATIC_TABLE.length - 1];
        if (!field)
            throw new Error('Invalid HPACK index');
        return field;
    }

    _add(field) {
        this._dynamic.unshift(field);
        this._size += field[0].length + field[1].length + 32;
        this._evict();
    }

    _evict() {
        while (this._size > this._max && this._dynamic.length) {
            const [name, value] = this._dynamic.pop();
            this._size -= name.length + value.length + 32;
        }
    }
}

/** Encodes headers as literals without indexing or Huffman (always valid). */
export function encodeHeaders(headers) {
    const enc = new TextEncoder();
    const out = [];
    const int = (value, bits, prefix) => {
        const mask = 2 ** bits - 1;
        if (value < mask) {
            out.push(prefix | value);
            return;
        }
        out.push(prefix | mask);
        value -= mask;
        while (value >= 128) {
            out.push((value % 128) | 128);
            value = Math.floor(value / 128);
        }
        out.push(value);
    };
    for (const [name, value] of headers) {
        out.push(0);
        for (const s of [name, value]) {
            const bytes = enc.encode(s);
            int(bytes.length, 7, 0);
            out.push(...bytes);
        }
    }
    return Uint8Array.from(out);
}
