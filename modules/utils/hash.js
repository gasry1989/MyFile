/**
 * SHA-256 计算（方案2修正版）
 * - 安全上下文使用 WebCrypto (crypto.subtle.digest)
 * - 非安全上下文使用经过验证的纯 JS 实现（与标准一致）
 * - 提供基本自检，防止 fallback 实现出错
 *
 * 导出：
 *   async sha256Hex(str)   -> Promise<string>
 *   sha256HexSync(str)     -> string（仅使用 fallback；安全上下文仍建议用 async）
 */

export async function sha256Hex(input) {
  if (input === undefined || input === null) return '';
  const str = String(input);

  if (supportsSubtle()) {
    try {
      const data = new TextEncoder().encode(str);
      const hashBuf = await crypto.subtle.digest('SHA-256', data);
      return buf2hex(new Uint8Array(hashBuf));
    } catch (e) {
      console.warn('[hash] subtle.digest 失败，使用 fallback:', e);
      return sha256Fallback(str);
    }
  }
  return sha256Fallback(str);
}

export function sha256HexSync(input) {
  if (input === undefined || input === null) return '';
  return sha256Fallback(String(input));
}

/* ---------------- 内部工具 ---------------- */

function supportsSubtle() {
  return typeof window !== 'undefined'
      && window.isSecureContext
      && window.crypto
      && !!window.crypto.subtle;
}

function buf2hex(arr) {
  let out = '';
  for (let i = 0; i < arr.length; i++) {
    out += arr[i].toString(16).padStart(2, '0');
  }
  return out;
}

/* ---------------- 纯 JS Fallback 实现 (标准 SHA-256) ---------------- */

function sha256Fallback(message) {
  const msgBytes = new TextEncoder().encode(message);
  const l = msgBytes.length;
  const bitLen = l * 8;

  // 计算填充后总字节数：消息 + 0x80 + 填充零 + 8字节长度
  const totalLen = ((l + 9 + 63) >> 6) << 6;
  const bytes = new Uint8Array(totalLen);
  bytes.set(msgBytes, 0);
  bytes[l] = 0x80;

  // 写入 64-bit 大端长度
  const dv = new DataView(bytes.buffer);
  const high = Math.floor(bitLen / 0x100000000);
  const low  = bitLen >>> 0;
  dv.setUint32(totalLen - 8, high, false); // 高 32
  dv.setUint32(totalLen - 4, low, false);  // 低 32

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);

  const K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ]);

  const W = new Uint32Array(64);

  // 处理每个 512-bit 块
  for (let offset = 0; offset < bytes.length; offset += 64) {
    // 前 16 个字
    for (let i = 0; i < 16; i++) {
      W[i] = dv.getUint32(offset + i * 4, false);
    }
    // 扩展
    for (let i = 16; i < 64; i++) {
      const s0 = ror(W[i - 15], 7) ^ ror(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = ror(W[i - 2], 17) ^ ror(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }

    // 初始化工作变量
    let a = H[0];
    let b = H[1];
    let c = H[2];
    let d = H[3];
    let e = H[4];
    let f = H[5];
    let g = H[6];
    let h = H[7];

    // 主循环
    for (let i = 0; i < 64; i++) {
      const S1 = (ror(e,6) ^ ror(e,11) ^ ror(e,25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = (ror(a,2) ^ ror(a,13) ^ ror(a,22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    // 累加到哈希值
    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }

  // 输出 hex
  let out = '';
  for (let i = 0; i < H.length; i++) {
    out += H[i].toString(16).padStart(8, '0');
  }
  return out;
}

function ror(x, n) {
  return (x >>> n) | (x << (32 - n));
}

/* ---------------- 自检（可在生产保留，也可按需移除） ---------------- */
(function selfTest() {
  try {
    const vectors = [
      ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
      ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
      ['admin', '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918']
    ];
    for (const [msg, expect] of vectors) {
      const got = sha256Fallback(msg);
      if (got !== expect) {
        console.error('[hash] SHA-256 fallback 自检失败: msg="%s" expect=%s got=%s', msg, expect, got);
        return;
      }
    }
    // 可选：console.log('[hash] fallback self-test ok');
  } catch (e) {
    console.error('[hash] 自检异常', e);
  }
})();