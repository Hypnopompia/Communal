import { createContext, useContext } from 'react';

/** Where the app is. The Library carries the device and folder being browsed. */
export type Route =
  | { screen: 'library'; hub?: string; device?: string; path?: string }
  | { screen: 'search'; q?: string }
  | { screen: 'shares' }
  | { screen: 'people' }
  | { screen: 'transfers' }
  | { screen: 'subscriptions' }
  | { screen: 'activity' }
  | { screen: 'settings'; tab?: SettingsTab }
  /** Managing a hub this account administers (ADR 0020), reached from Settings › Hubs. */
  | { screen: 'manage'; hub: string; tab?: ManageTab };

export type SettingsTab =
  'account' | 'devices' | 'hubs' | 'network' | 'bandwidth' | 'downloads' | 'storage' | 'agents';

export type ManageTab = 'people' | 'connections' | 'log' | 'settings';

export const NavCtx = createContext<(r: Route) => void>(() => undefined);
export const useNav = () => useContext(NavCtx);
