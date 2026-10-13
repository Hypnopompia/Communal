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
  | { screen: 'settings'; tab?: SettingsTab };

export type SettingsTab = 'account' | 'devices' | 'hubs' | 'network' | 'bandwidth' | 'storage';

export const NavCtx = createContext<(r: Route) => void>(() => undefined);
export const useNav = () => useContext(NavCtx);
