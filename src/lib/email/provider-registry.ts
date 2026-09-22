import type { AccountProvider, ProviderInventoryItem, ProviderSetupDiscovery } from "./types";
import { providerAdapterFor } from "./provider-adapter";

const providers: readonly ProviderInventoryItem[] = [
  {
    id: "gmail",
    label: "Gmail",
    available: true,
    setupGuidance: "Connect a Google account to read mail and use the permissions you explicitly approve.",
    capabilities: {
      mailRead: true,
      readState: true,
      move: false,
      trash: true,
      spam: true,
      undo: true,
      send: true,
      threadedReply: true,
      attachments: true,
      unsubscribe: true,
      calendarRead: true,
      calendarWrite: true,
      pin: true,
      flag: true,
    },
  },
  {
    id: "microsoft",
    label: "Microsoft",
    available: true,
    setupGuidance: "Connect a Microsoft account to read mail and use the permissions you explicitly approve.",
    capabilities: {
      mailRead: true,
      readState: true,
      move: false,
      trash: true,
      spam: true,
      undo: true,
      send: true,
      threadedReply: true,
      attachments: true,
      unsubscribe: false,
      calendarRead: true,
      calendarWrite: true,
      pin: false,
      flag: true,
    },
  },
  {
    id: "standards",
    label: "Other inbox providers",
    available: false,
    presets: ["yahoo", "icloud", "fastmail", "zoho", "aol", "custom"],
    setupGuidance: "IMAP/SMTP provider setup is planned for v0.9. Ezra will not request server settings or passwords until its secure standards adapter is available.",
    capabilities: {
      mailRead: false,
      readState: false,
      move: false,
      trash: false,
      spam: false,
      undo: false,
      send: false,
      threadedReply: false,
      attachments: false,
      unsubscribe: false,
      calendarRead: false,
      calendarWrite: false,
      pin: false,
      flag: false,
    },
  },
];

export function listProviderInventory(): ProviderInventoryItem[] {
  return providers.map((provider) => ({
    ...provider,
    capabilities: { ...provider.capabilities },
  }));
}

export function discoverProvider(provider: AccountProvider): ProviderSetupDiscovery {
  const item = providers.find((candidate) => candidate.id === provider);
  if (!item || !item.available) throw new Error("That mail provider is not available for setup yet.");
  return providerAdapterFor(provider).discover();
}
