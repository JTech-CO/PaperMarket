export type NotificationKind = 'IMPORTANT_DISCLOSURE' | 'DIVIDEND_RIGHT' | 'DIVIDEND_PAID' | 'SCHEDULED_FILLED' | 'ORDER_CANCELLED' | 'PRICE_THRESHOLD';
export interface NotificationOwner { readonly marketId: string; readonly accountId: string; readonly discordUserId: string }
export interface NotificationMeta { readonly tickNo: number; readonly marketVersion: number; readonly createdAt: string }
export interface PriceAlertView {
  readonly alertId: string; readonly listingId: string; readonly symbol: string;
  readonly direction: 'ABOVE' | 'BELOW'; readonly threshold: string;
  readonly enabled: boolean; readonly armed: boolean; readonly disabledReason: 'LISTING_RETIRED' | null;
}
export interface WatchListingView { readonly listingId: string; readonly symbol: string; readonly enabled: boolean }
export interface AlertSettingsView { readonly dmEnabled: boolean; readonly priceAlerts: readonly PriceAlertView[]; readonly watchlist: readonly WatchListingView[] }
export interface SaveAlertsInput {
  readonly dmEnabled?: boolean;
  readonly addPriceAlert?: { readonly listingId: string; readonly direction: 'ABOVE' | 'BELOW'; readonly threshold: string };
  readonly removePriceAlertId?: string;
  readonly watchListingId?: string;
  readonly unwatchListingId?: string;
}
export interface InboxItemView extends NotificationMeta {
  readonly notificationId: string; readonly kind: NotificationKind; readonly symbol: string | null;
  readonly title: string; readonly summary: string; readonly read: boolean;
}
export interface InboxView { readonly items: readonly InboxItemView[]; readonly unreadCount: number; readonly nextBeforeId: string | null }
export interface PersonalNotificationFact { readonly accountId: string; readonly eventId: string; readonly symbol: string | null; readonly title: string; readonly summary: string }
export interface NotificationBoundary extends NotificationMeta {
  readonly marketId: string;
  readonly listings: readonly { readonly listingId: string; readonly symbol: string; readonly name: string; readonly price: string; readonly active: boolean }[];
  readonly disclosures: readonly { readonly id: string; readonly kind: 'MACRO' | 'EARNINGS' | 'CORPORATE_ACTION' | 'EVENT'; readonly publishedTick: number; readonly listingId?: string|null; readonly symbol: string | null; readonly title: string; readonly summary: string; readonly important?: boolean }[];
  readonly rights?: readonly (PersonalNotificationFact & { readonly kind: 'DIVIDEND_RIGHT' | 'DIVIDEND_PAID' })[];
  readonly fills?: readonly PersonalNotificationFact[];
  readonly cancellations?: readonly PersonalNotificationFact[];
}
/** Internal runtime only. An authenticated command cannot select a DM recipient. */
export interface NotificationDelivery {
  readonly jobId: string; readonly leaseToken: string; readonly discordUserId: string;
  readonly guildId: string; readonly notification: InboxItemView; readonly attempts: number;
}
