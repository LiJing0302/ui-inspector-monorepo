// H.264 Annex-B 解析 / avcC 构造 / WebCodecs 辅助。渲染层使用。

export interface Nalu {
  type: number;
  payload: Uint8Array;
}

function findStartCode(data: Uint8Array, from: number): number {
  const n = data.length;
  for (let i = from; i < n - 2; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) return i;
    if (i + 3 < n && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) return i;
  }
  return -1;
}

function stripStartCode(sub: Uint8Array): Uint8Array {
  if (sub.length >= 4 && sub[0] === 0 && sub[1] === 0 && sub[2] === 0 && sub[3] === 1) return sub.subarray(4);
  if (sub.length >= 3 && sub[0] === 0 && sub[1] === 0 && sub[2] === 1) return sub.subarray(3);
  return sub;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * scrcpy 的 configuration/data 包是完整的 Annex-B access unit。
 * 一次性切出一个包里的全部 NALU，避免把同一帧的 SPS/PPS/IDR 分开交给解码器。
 */
export function splitAnnexB(data: Uint8Array): Uint8Array[] {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const starts: { start: number; payloadStart: number }[] = [];
  let cursor = 0;
  while (cursor < bytes.length - 2) {
    const start = findStartCode(bytes, cursor);
    if (start === -1) break;
    const codeLength = bytes[start + 2] === 1 ? 3 : 4;
    starts.push({ start, payloadStart: start + codeLength });
    cursor = start + codeLength;
  }

  const nalus: Uint8Array[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    let end = i + 1 < starts.length ? starts[i + 1]!.start : bytes.length;
    while (end > starts[i]!.payloadStart && bytes[end - 1] === 0) end -= 1;
    if (end > starts[i]!.payloadStart) {
      nalus.push(bytes.subarray(starts[i]!.payloadStart, end));
    }
  }
  return nalus;
}

export function findParameterSets(data: Uint8Array): { sequenceParameterSet: Uint8Array; pictureParameterSet: Uint8Array } {
  let sequenceParameterSet: Uint8Array | null = null;
  let pictureParameterSet: Uint8Array | null = null;
  for (const nalu of splitAnnexB(data)) {
    const type = nalu[0]! & 0x1f;
    if (type === 7) sequenceParameterSet = nalu;
    if (type === 8) pictureParameterSet = nalu;
  }
  if (!sequenceParameterSet || !pictureParameterSet) {
    throw new Error('scrcpy configuration does not contain SPS/PPS');
  }
  return { sequenceParameterSet, pictureParameterSet };
}

export function hasKeyframe(data: Uint8Array): boolean {
  return splitAnnexB(data).some((nalu) => (nalu[0]! & 0x1f) === 5);
}

export function toLengthPrefixed(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  out[0] = (payload.length >> 24) & 0xff;
  out[1] = (payload.length >> 16) & 0xff;
  out[2] = (payload.length >> 8) & 0xff;
  out[3] = payload.length & 0xff;
  out.set(payload, 4);
  return out;
}

/** 批量：把整个 access unit 的 NALU 都转成 4 字节长度前缀 */
export function toLengthPrefixedAccessUnit(data: Uint8Array): Uint8Array {
  const nalus = splitAnnexB(data);
  if (nalus.length === 0) return data;
  const length = nalus.reduce((total, nalu) => total + 4 + nalu.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const nalu of nalus) {
    out[offset] = (nalu.length >> 24) & 0xff;
    out[offset + 1] = (nalu.length >> 16) & 0xff;
    out[offset + 2] = (nalu.length >> 8) & 0xff;
    out[offset + 3] = nalu.length & 0xff;
    out.set(nalu, offset + 4);
    offset += nalu.length + 4;
  }
  return out;
}

export function removeParameterSets(data: Uint8Array): Uint8Array {
  const nalus = splitAnnexB(data).filter((nalu) => {
    const type = nalu[0]! & 0x1f;
    return type !== 7 && type !== 8;
  });
  const length = nalus.reduce((total, nalu) => total + 4 + nalu.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const nalu of nalus) {
    out[offset] = (nalu.length >> 24) & 0xff;
    out[offset + 1] = (nalu.length >> 16) & 0xff;
    out[offset + 2] = (nalu.length >> 8) & 0xff;
    out[offset + 3] = nalu.length & 0xff;
    out.set(nalu, offset + 4);
    offset += nalu.length + 4;
  }
  return out;
}

export function concatAccessUnits(first: Uint8Array, second: Uint8Array): Uint8Array {
  const out = new Uint8Array(first.length + second.length);
  out.set(first, 0);
  out.set(second, first.length);
  return out;
}

/**
 * 流式切分 Annex-B：跨 chunk 的 NALU 自动拼接；保证只吐出「完整」的 NALU。
 */
export class H264Stream {
  private leftover: Uint8Array = new Uint8Array(0);

  feed(chunk: Uint8Array): Nalu[] {
    const data = this.leftover.length ? concat(this.leftover, chunk) : chunk;
    const nalus: Nalu[] = [];
    let i = 0;
    while (i < data.length - 2) {
      const sc = findStartCode(data, i);
      if (sc === -1) break;
      const isLong = data[sc + 2] === 1;
      const next = findStartCode(data, sc + (isLong ? 3 : 4));
      if (next === -1) {
        // 当前 NALU 还不完整，保留从它的起始码开始的部分到下次
        this.leftover = data.subarray(sc);
        return nalus;
      }
      const payload = stripStartCode(data.subarray(sc, next));
      const type = payload.length ? payload[0]! & 0x1f : -1;
      nalus.push({ type, payload });
      i = next;
    }
    this.leftover = new Uint8Array(0);
    return nalus;
  }
}

/** 从 SPS 推导 WebCodecs 需要的 codec string（如 avc1.640028） */
export function getCodecString(sps: Uint8Array): string {
  if (sps.length < 4) return 'avc1.42001e';
  const profile = sps[1]!;
  const constraint = sps[2]!;
  const level = sps[3]!;
  const h = (v: number): string => v.toString(16).padStart(2, '0');
  return `avc1.${h(profile)}${h(constraint)}${h(level)}`;
}

/** 构造 AVCDecoderConfigurationRecord（avcC 去掉 box 头），供 VideoDecoder.description 使用 */
export function buildAvcCDescription(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const out = new Uint8Array(7 + 2 + sps.length + 2 + pps.length);
  let p = 0;
  out[p++] = 1; // configurationVersion
  out[p++] = sps[1]!; // AVCProfileIndication
  out[p++] = sps[2]!; // profile_compatibility (constraint flags)
  out[p++] = sps[3]!; // AVCLevelIndication
  out[p++] = 0xfc; // 6 bits reserved(111111) + lengthSizeMinusOne(3)
  out[p++] = 0xe1; // 3 bits reserved(111) + numOfSequenceParameterSets(1)
  out[p++] = (sps.length >> 8) & 0xff;
  out[p++] = sps.length & 0xff;
  out.set(sps, p);
  p += sps.length;
  out[p++] = 1; // numOfPictureParameterSets
  out[p++] = (pps.length >> 8) & 0xff;
  out[p++] = pps.length & 0xff;
  out.set(pps, p);
  return out;
}
