const ETH_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

export function isValidAddress(address: string): boolean {
  return ETH_ADDRESS_REGEX.test(address);
}
