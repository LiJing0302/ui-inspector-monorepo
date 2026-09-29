/**
 * 接收网卡的**自动挑选**（纯函数）。
 *
 * 这块原先在 `CaptureButton` 里是一个下拉框：只在 `addresses.length > 1` 时出现，
 * 让用户自己选「手机所在的那张网卡」，旁边还要补一句「虚拟网卡（docker / vmnet）
 * 的实际地址手机连不上」。
 *
 * 问题是这个选择无从验证：连接串里的地址手机连不上时，错误要到手机上才显形，
 * 排查成本全落在用户身上。而「哪张网卡对外可达」本身是有客观依据的 ——
 * 那就不要把它变成一道要人作答的题：
 * ① 先在物理网卡里找 `en*`（macOS 上 Wi-Fi / 有线就是 en0、en1…）；
 * ② 没有 en* 就取第一张物理网卡；
 * ③ 只剩虚拟网卡时才用虚拟网卡 —— 有总比没有好。
 *
 * 与 `scripts/verify-livekit.js` 里那段 mock 的选法（`name.startsWith('en') || [0]`）
 * 保持同一口径：同一条地址规则不要在脚本与 App 里各写一份。
 */

import type { NetworkAddress } from '@shared/ipc';

/** 不属于「手机能连上的那张网卡」的前缀：虚拟网卡 / 隧道 / 点对点 */
const VIRTUAL_PREFIX = /^(bridge|docker|vmnet|vnic|utun|awdl|llw|ap\d|tap|tun|veth|virbr|ham|anpi)/i;

/** 物理网卡命名约定：en0 = Wi-Fi，en1… = 有线 / Thunderbolt */
const PHYSICAL_NAME = /^en\d+$/i;

/**
 * 从网卡列表里挑出**接收地址**。
 *
 * 空列表返回 `''`（调用方据此禁用连接串与相关按钮），不做兜底假地址 ——
 * 一个连不上的地址比「没地址」更难排查。
 */
export function pickDefaultAddress(addresses: NetworkAddress[]): string {
  if (addresses.length === 0) return '';
  const physical = addresses.filter((item) => !VIRTUAL_PREFIX.test(item.name));
  const pool = physical.length > 0 ? physical : addresses;
  return (pool.find((item) => PHYSICAL_NAME.test(item.name)) ?? pool[0]).address;
}
