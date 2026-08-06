import { stringToHex, concatHex } from "viem";

export const ERC8021_MAGIC_TAG = "0x8021" as const;
export const DEFAULT_PROJECT_TAG = "agentpay-ai";

export function appendAttributionTag(
  calldata: `0x${string}` = "0x",
  projectTag: string = DEFAULT_PROJECT_TAG
): `0x${string}` {
  const tagHex = stringToHex(projectTag);
  return concatHex([calldata, tagHex, ERC8021_MAGIC_TAG]);
}

export function verifyAttributionTag(
  data: string,
  expectedTag: string = DEFAULT_PROJECT_TAG
): boolean {
  if (!data || !data.startsWith("0x")) return false;
  const cleanData = data.toLowerCase();
  const magicMarker = "8021";
  if (!cleanData.endsWith(magicMarker)) return false;
  const tagHex = stringToHex(expectedTag).substring(2).toLowerCase();
  return cleanData.endsWith(tagHex + magicMarker);
}
