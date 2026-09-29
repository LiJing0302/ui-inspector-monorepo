import { createHash } from 'node:crypto';

import type { PixelTransformContract } from '../../types/acceptance';
import {
  PIXEL_COORDINATE_ORIGIN,
  PIXEL_SNAP_PROFILE,
  PIXEL_TRANSFORM_VERSION,
} from '../../types/acceptance';
import type { PixelRect, Rect } from '../../types/verify';

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function contractPayload(contract: Omit<PixelTransformContract, 'hash'>): string {
  return JSON.stringify(contract);
}

export function createPixelTransformContract(input: {
  basisWidth: number;
  viewportWidth: number;
  pixelWidth: number;
}): PixelTransformContract | null {
  if (!finitePositive(input.basisWidth) || !finitePositive(input.viewportWidth) || !finitePositive(input.pixelWidth)) {
    return null;
  }
  const contractWithoutHash = {
    version: PIXEL_TRANSFORM_VERSION,
    basisWidth: input.basisWidth,
    viewportWidth: input.viewportWidth,
    pixelRatio: input.pixelWidth / input.viewportWidth,
    snapProfile: PIXEL_SNAP_PROFILE,
    coordinateOrigin: PIXEL_COORDINATE_ORIGIN,
  } as const;
  return {
    ...contractWithoutHash,
    hash: `sha256:${createHash('sha256').update(contractPayload(contractWithoutHash)).digest('hex')}`,
  };
}

export function snapPhysical(value: number): number {
  return Math.round(value);
}

export function projectDesignValueToAppPixels(value: number, contract: PixelTransformContract): number {
  return snapPhysical(value * contract.viewportWidth / contract.basisWidth * contract.pixelRatio);
}

export function projectDesignRectToAppPixels(rect: Rect, contract: PixelTransformContract): PixelRect {
  const left = projectDesignValueToAppPixels(rect.x, contract);
  const top = projectDesignValueToAppPixels(rect.y, contract);
  const right = projectDesignValueToAppPixels(rect.x + rect.width, contract);
  const bottom = projectDesignValueToAppPixels(rect.y + rect.height, contract);
  return { x: left, y: top, width: right - left, height: bottom - top };
}
