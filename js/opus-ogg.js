// Compression de l'audio en qualité « voix » (Opus, mono, ~24 kbit/s) dans un fichier Ogg.
// Sert au partage dans un espace collaboratif : ~11 Mo par heure au lieu de ~60 Mo.
// Utilise l'encodeur du navigateur (WebCodecs AudioEncoder) ; rien n'est envoyé pour l'encodage.

export const canEncodeOpus = () => typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined';

// CRC des pages Ogg (polynôme 0x04C11DB7, sans réflexion)
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0;
  for (let i = 0; i < bytes.length; i++) c = ((c << 8) ^ CRC[((c >>> 24) ^ bytes[i]) & 255]) >>> 0;
  return c >>> 0;
}

/** Une page Ogg contenant des paquets entiers. */
function oggPage(packets, { granule, serial, seq, bos = false, eos = false }) {
  const lacing = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) { lacing.push(255); n -= 255; }
    lacing.push(n);
  }
  const bodyLen = packets.reduce((a, p) => a + p.length, 0);
  const page = new Uint8Array(27 + lacing.length + bodyLen);
  const v = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53], 0); // « OggS »
  page[4] = 0;
  page[5] = (bos ? 2 : 0) | (eos ? 4 : 0);
  v.setUint32(6, granule % 0x100000000, true);
  v.setUint32(10, Math.floor(granule / 0x100000000), true);
  v.setUint32(14, serial, true);
  v.setUint32(18, seq, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let o = 27 + lacing.length;
  for (const p of packets) { page.set(p, o); o += p.length; }
  v.setUint32(22, crc32(page), true);
  return page;
}

function opusHead(sampleRate, preSkip = 312) {
  const h = new Uint8Array(19);
  const v = new DataView(h.buffer);
  h.set([...'OpusHead'].map((c) => c.charCodeAt(0)), 0);
  h[8] = 1; // version
  h[9] = 1; // mono
  v.setUint16(10, preSkip, true);
  v.setUint32(12, sampleRate, true);
  v.setInt16(16, 0, true);
  h[18] = 0;
  return h;
}

function opusTags() {
  const vendor = new TextEncoder().encode('Transcripteur IA');
  const t = new Uint8Array(8 + 4 + vendor.length + 4);
  const v = new DataView(t.buffer);
  t.set([...'OpusTags'].map((c) => c.charCodeAt(0)), 0);
  v.setUint32(8, vendor.length, true);
  t.set(vendor, 12);
  v.setUint32(12 + vendor.length, 0, true);
  return t;
}

/**
 * Encode un son mono en Ogg/Opus.
 * @param {Float32Array} pcm échantillons mono
 * @param {{sampleRate?: number, bitrate?: number, onProgress?: (v: number) => void}} o
 * @returns {Promise<Blob>} audio/ogg
 */
export async function encodeOggOpus(pcm, { sampleRate = 16000, bitrate = 24000, onProgress } = {}) {
  if (!canEncodeOpus()) throw new Error('Ce navigateur ne sait pas compresser l’audio (WebCodecs indisponible).');
  const packets = [];
  let head = null;
  let failure = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      const b = new Uint8Array(chunk.byteLength);
      chunk.copyTo(b);
      packets.push({ data: b, dur: chunk.duration || 20000 });
      if (!head && meta?.decoderConfig?.description) head = new Uint8Array(meta.decoderConfig.description);
    },
    error: (e) => { failure = e; },
  });
  enc.configure({ codec: 'opus', sampleRate, numberOfChannels: 1, bitrate });
  const step = sampleRate * 10; // 10 s par bloc
  for (let i = 0; i < pcm.length; i += step) {
    const part = pcm.subarray(i, Math.min(pcm.length, i + step));
    enc.encode(new AudioData({ format: 'f32', sampleRate, numberOfFrames: part.length, numberOfChannels: 1, timestamp: Math.round((i / sampleRate) * 1e6), data: part }));
    // Laisse respirer la page et évite d'empiler trop de travail dans l'encodeur
    if (enc.encodeQueueSize > 20) await new Promise((r) => setTimeout(r, 0));
    onProgress?.(Math.min(0.99, i / pcm.length));
  }
  await enc.flush();
  enc.close();
  if (failure) throw failure;
  const serial = (Math.random() * 0xffffffff) >>> 0;
  if (!head || head.length < 19 || String.fromCharCode(...head.slice(0, 8)) !== 'OpusHead') head = opusHead(sampleRate);
  const preSkip = new DataView(head.buffer, head.byteOffset).getUint16(10, true);
  const pages = [oggPage([head], { granule: 0, serial, seq: 0, bos: true }), oggPage([opusTags()], { granule: 0, serial, seq: 1 })];
  let granule = preSkip;
  let seq = 2;
  for (let i = 0; i < packets.length; i += 50) {
    const group = packets.slice(i, i + 50);
    for (const p of group) granule += Math.round((p.dur / 1e6) * 48000);
    pages.push(oggPage(group.map((p) => p.data), { granule, serial, seq: seq++, eos: i + 50 >= packets.length }));
  }
  onProgress?.(1);
  return new Blob(pages, { type: 'audio/ogg; codecs=opus' });
}
