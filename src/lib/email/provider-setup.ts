import { providerAdapterFor, type ProviderSetupCapability, type ProviderSetupTest } from "./provider-adapter";
import type { AccountProvider } from "./types";

export type { ProviderSetupCapability, ProviderSetupTest } from "./provider-adapter";

export async function testProviderSetup(input: {
  provider: AccountProvider;
  capability: ProviderSetupCapability;
}): Promise<ProviderSetupTest> {
  return providerAdapterFor(input.provider).preflight(input.capability);
}
