// Minimal WebSocket server implementation using Node.js built-ins
const crypto = require('crypto');
const { EventEmitter } = require('events');

const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WebSocket extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.readyState = 1; // OPEN
    this._buffer = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      this._buffer = Buffer.concat([this._buffer, chunk]);
      this._processFrames();
    });

    socket.on('close', () => {
      this.readyState = 3;
      this.emit('close');
    });

    socket.on('error', (err) => {
      this.emit('error', err);
    });
  }

  _processFrames() {
    while (this._buffer.length >= 2) {
      const firstByte = this._buffer[0];
      const secondByte = this._buffer[1];
      const isMasked = !!(secondByte & 0x80);
      let payloadLen = secondByte & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this._buffer.length < 4) return;
        payloadLen = this._buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this._buffer.length < 10) return;
        // Use only lower 32 bits (reasonable for our use case)
        payloadLen = this._buffer.readUInt32BE(6);
        offset = 10;
      }

      const maskLen = isMasked ? 4 : 0;
      const totalLen = offset + maskLen + payloadLen;

      if (this._buffer.length < totalLen) return;

      const mask = isMasked ? this._buffer.slice(offset, offset + 4) : null;
      offset += maskLen;

      const payload = Buffer.alloc(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        payload[i] = isMasked
          ? this._buffer[offset + i] ^ mask[i % 4]
          : this._buffer[offset + i];
      }

      this._buffer = this._buffer.slice(totalLen);

      const opcode = firstByte & 0x0f;
      if (opcode === 0x8) {
        // Close frame
        this.readyState = 3;
        this.socket.destroy();
        return;
      } else if (opcode === 0x9) {
        // Ping -> Pong
        this._sendRaw(0xa, Buffer.alloc(0));
      } else if (opcode === 0x1 || opcode === 0x2) {
        // Text or Binary
        this.emit('message', payload);
      }
    }
  }

  _sendRaw(opcode, data) {
    const len = data.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    try {
      this.socket.write(Buffer.concat([header, data]));
    } catch (e) {
      // ignore write errors on closed sockets
    }
  }

  send(data) {
    if (this.readyState !== 1) return;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    this._sendRaw(0x1, payload);
  }

  close() {
    if (this.readyState !== 1) return;
    this.readyState = 2;
    this._sendRaw(0x8, Buffer.alloc(0));
    this.socket.end();
  }
}

class WebSocketServer extends EventEmitter {
  constructor({ server }) {
    super();
    server.on('upgrade', (req, socket, head) => {
      const key = req.headers['sec-websocket-key'];
      if (!key) { socket.destroy(); return; }

      const accept = crypto
        .createHash('sha1')
        .update(key + MAGIC)
        .digest('base64');

      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );

      const ws = new WebSocket(socket);
      this.emit('connection', ws, req);
    });
  }
}

module.exports = { WebSocketServer, WebSocket };
